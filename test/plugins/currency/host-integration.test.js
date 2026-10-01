import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 可选真实宿主验证；普通离线测试不下载宿主、不接触已安装实例。
const host = process.env.QQ_CURRENCY_HOST_DIR;
test('真实 QQ Agent 加载器：能力依赖、配置修复、开关与重载恢复', { skip: !host && '设置 QQ_CURRENCY_HOST_DIR 后启用真实宿主检查' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-host-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('currency-host-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const currencyDir = path.join(root, 'plugins', 'currency');
  const consumerDir = path.join(root, 'skills', 'currency-client');
  fs.cpSync(fileURLToPath(new URL('../../../plugins/currency/', import.meta.url)), currencyDir, { recursive: true });
  fs.mkdirSync(consumerDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(consumerDir, 'skill.json'), JSON.stringify({
    id: 'currency-client', name: '测试消费方', version: '1.0.0', apiVersion: 1, category: 'utility',
    description: '真实宿主集成测试用', requires: ['currency.v1'], enabledByDefault: true
  }));
  fs.writeFileSync(path.join(consumerDir, 'index.js'), `
    export function setup(api) {
      api.registerTool({id:'read',name:'测试余额',category:'query',description:'集成测试读取余额',
        parameters:{type:'object',properties:{}},
        execute:async(ctx) => ({content:JSON.stringify(api.capability('currency.v1',{consumer:'currency-client'})?.balance({scope:ctx.chatKey,userId:'10001'}))})});
    }
  `);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const hostFile = name => pathToFileURL(path.join(process.env.QQ_CURRENCY_HOST_DIR, 'src', name));
    const {loadPlugins,unloadSkill} = await import(hostFile('plugin-loader.js'));
    const {skillManager} = await import(hostFile('skills/manager.js'));
    const {setSkillConfig,setSkillEnabled} = await import(hostFile('skills/config.js'));
    const {getTool} = await import(hostFile('tool-registry.js'));
    const roots = {plugins:path.resolve('plugins'),skills:path.resolve('skills')};
    const load = async() => {
      const result = await loadPlugins({roots,log:()=>{}});
      assert.equal(result.failed.length,0,JSON.stringify(result.failed));
      // 与 app.js 的 reloadSkills 一致：启用且加载成功的扩展才调用 activate。
      for (const item of skillManager.list()) if(item.enabled && item.loaded) skillManager.activate(item.id);
    };
    setSkillConfig('currency',{integrationPermissions:'{bad'});
    await load();
    try {
      assert.equal(skillManager.isActive('currency').active,false);
      assert.equal(skillManager.isActive('currency-client').active,false);
      const configured = {integrationPermissions:JSON.stringify({'currency-client':['credit']})};
      // 宿主保存设置不会再次 activate；修复配置必须当场恢复。
      setSkillConfig('currency',configured);
      assert.equal(skillManager.isActive('currency').active,true);
      assert.equal(skillManager.isActive('currency-client').active,true);
      const money = skillManager.registry.get('currency-client').api.capability('currency.v1',{consumer:'currency-client'});
      assert.equal(money.apiVersion,1);
      const args = {scope:'group:12345',userId:'10001',amount:100,requestId:'event:1',reason:'集成测试'};
      assert.equal(money.credit(args).ok,true);
      const tool = getTool('currency-client__read');
      assert.equal(JSON.parse((await tool.execute({chatKey:'group:12345'},{})).content).balance,100);
      // 即使开关已写入、生命周期回调尚未来得及执行，旧接口也不能写。
      setSkillEnabled('currency',false);
      assert.equal(money.credit({...args,requestId:'disabled'}).code,'UNAVAILABLE');
      assert.equal(skillManager.isActive('currency-client').active,false);
      skillManager.deactivate('currency');
      assert.equal(fs.existsSync(path.join(process.env.QQ_AGENT_DATA_DIR,'currency.json.lock')),false);
      setSkillEnabled('currency',true); skillManager.activate('currency');
      assert.equal(money.credit(args).code,'UNAVAILABLE');
      await load();
      const fresh = skillManager.registry.get('currency-client').api.capability('currency.v1',{consumer:'currency-client'});
      assert.equal(fresh.credit(args).receipt.replayed,true);
      assert.equal(fresh.balance({scope:args.scope,userId:args.userId}).balance,100);
      unloadSkill('currency');
      assert.equal(fresh.credit(args).code,'UNAVAILABLE');
      assert.equal(skillManager.isActive('currency-client').active,false);
    } finally { unloadSkill('currency-client'); unloadSkill('currency'); }
  `], { cwd: root, env: { ...process.env, QQ_CURRENCY_HOST_DIR: path.resolve(host), QQ_AGENT_DATA_DIR: path.join(root, 'data'), QQ_AGENT_PROFILE: '' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
});
