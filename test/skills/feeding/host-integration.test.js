import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const host = process.env.QQ_CURRENCY_HOST_DIR;
test('官方宿主加载器：投喂双依赖、会话、评分、开关和重载', { skip: !host && '设置 QQ_CURRENCY_HOST_DIR 后启用真实宿主检查' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeding-host-test-'));
  t.after(() => {
    const absolute = fs.realpathSync(root);
    assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('feeding-host-test-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  for (const dir of ['plugins/currency', 'plugins/rapport', 'skills/feeding']) {
    fs.cpSync(fileURLToPath(new URL(`../../../${dir}/`, import.meta.url)), path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const source = file => pathToFileURL(path.join(process.env.QQ_CURRENCY_HOST_DIR,'src',file));
    const {loadPlugins,unloadSkill} = await import(source('plugin-loader.js'));
    const {skillManager} = await import(source('skills/manager.js'));
    const {setSkillConfig,setSkillEnabled} = await import(source('skills/config.js'));
    const {getTool,getToolAvailability} = await import(source('tool-registry.js'));
    const {SessionRegistry} = await import(source('sessions.js'));
    const parse = r => JSON.parse(r.content.split('\\n')[0]);
    setSkillConfig('currency',{integrationPermissions:JSON.stringify({funding:['credit'],feeding:['reserve','capture','release']})});
    setSkillConfig('rapport',{integrationPermissions:JSON.stringify({feeding:['recordEvent','rateEvent','bindMessage']}),aiMode:true,aiCooldownSeconds:0,decayEnabled:false});
    setSkillConfig('feeding',{cooldownSeconds:0,foodsJson:'broken'});
    const load = async () => {
      const r = await loadPlugins({roots:{plugins:path.resolve('plugins'),skills:path.resolve('skills')},log:()=>{}});
      assert.equal(r.failed.length,0,JSON.stringify(r.failed));
      for(const item of skillManager.list()) if(item.loaded && item.enabled) skillManager.activate(item.id);
    };
    await load();
    const sessions = new SessionRegistry();
    try {
      assert.equal(skillManager.isActive('feeding').active,false);
      setSkillConfig('feeding',{foodsJson:skillManager.registry.get('feeding').manifest.settings.foodsJson});
      assert.equal(skillManager.isActive('feeding').active,true);
      const api = () => skillManager.registry.get('feeding').api;
      const money = api().capability('currency.v1',{consumer:'funding'});
      assert.equal(money.credit({scope:'group:12345',userId:'10001',amount:100,requestId:'seed',reason:'测试'}).ok,true);
      const entry = {senderId:'10001',mid:'123',ts:Date.now(),text:'买个小饼干投喂你'};
      const session = sessions.create({chatKey:'group:12345',trigger:[entry]});
      const ctx = {chatKey:'group:12345',kind:'group',chatId:'12345',selfId:'88888',session,store:{recent:()=>[]},sender:{sendTextBatch(){assert.fail('不可代替模型发言')}}};
      await skillManager.runHook('before-context',{...ctx,triggerEntries:[entry]});
      assert.equal(getToolAvailability('feeding__feed',{runtimeContext:ctx}).enabled,true);
      const feed = () => parse(getTool('feeding__feed').execute(ctx,{messageId:'123',food:'饼干'}));
      const first = feed();
      assert.equal(first.paid,true,JSON.stringify(first)); assert.equal(first.ratingPending,true);
      const prompt = () => skillManager.registry.get('rapport').promptSections(ctx).map(s => s.content).join('\\n');
      assert.doesNotMatch(prompt(),/feeding__/);
      setSkillEnabled('feeding',false); skillManager.deactivate('feeding');
      assert.doesNotMatch(prompt(),/feeding__/);
      setSkillEnabled('feeding',true); skillManager.activate('feeding');
      const rated = parse(getTool('feeding__rate').execute(ctx,{messageId:'123',eventId:first.eventId,delta:0.07,reason:'友善投喂'}));
      assert.equal(rated.applied,0.07,JSON.stringify(rated));
      const old = api().capability('rapport.v1',{consumer:'feeding'});
      for(const id of ['currency','rapport']) {
        setSkillEnabled(id,false);
        assert.equal(skillManager.isActive('feeding').active,false);
        assert.equal(feed().ok,false);
        skillManager.deactivate(id); setSkillEnabled(id,true); skillManager.activate(id);
        assert.equal(skillManager.isActive('feeding').active,true);
      }
      assert.equal(old.getState({scope:ctx.chatKey,userId:'10001'}).ok,false);
      await load();
      assert.equal(feed().replayed,true);
      assert.equal(api().capability('currency.v1',{consumer:'feeding'}).balance({scope:ctx.chatKey,userId:'10001'}).balance,80);
      assert.equal(api().capability('rapport.v1',{consumer:'feeding'}).getState({scope:ctx.chatKey,userId:'10001'}).score,0.07);
      assert.equal(skillManager.registry.get('feeding').kind,'skill');
      assert.equal(skillManager.registry.get('rapport').kind,'plugin');
      assert.equal(session.sent.length,0);
      sessions.finish(session.id,'done');
      skillManager.deactivate('rapport');
      const rapportFile = path.join(process.env.QQ_AGENT_DATA_DIR,'rapport.json');
      const original = fs.readFileSync(rapportFile,'utf8');
      fs.writeFileSync(rapportFile,'{broken');
      // 官方管理器仅同步 try/catch 生命周期；初始化失败不能遗留 rejected Promise。
      skillManager.activate('rapport');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(skillManager.isActive('rapport').active,false);
      assert.equal(fs.readFileSync(rapportFile,'utf8'),'{broken');
      assert.match(skillManager.errors.get('rapport'),/读取好感度数据失败/);
      fs.writeFileSync(rapportFile,original);
      skillManager.activate('rapport');
      assert.equal(skillManager.isActive('rapport').active,true);
    } finally { unloadSkill('feeding'); unloadSkill('rapport'); unloadSkill('currency'); }
    assert.equal(getTool('feeding__feed'),null);
    assert.equal(fs.existsSync(path.join(process.env.QQ_AGENT_DATA_DIR,'rapport.json.lock')),false);
    assert.equal(fs.existsSync(path.join(process.env.QQ_AGENT_DATA_DIR,'feeding.json.lock')),false);
  `], { cwd: root, env: { ...process.env, QQ_CURRENCY_HOST_DIR: path.resolve(host), QQ_AGENT_DATA_DIR: path.join(root, 'data'), QQ_AGENT_PROFILE: '' },
    encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
});
