import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const host = process.env.QQ_AI_IMAGE_HOST_DIR;
test('官方宿主表单、设置路由与混合触发批：黑名单、热更新和请求者额度', {
  skip: !host && '设置 QQ_AI_IMAGE_HOST_DIR 后启用真实宿主检查'
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-image-host-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('ai-image-host-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.cpSync(fileURLToPath(new URL('../../../skills/ai-image/', import.meta.url)), path.join(root, 'skills/ai-image'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import vm from 'node:vm';
    import { pathToFileURL } from 'node:url';
    const source = file => pathToFileURL(path.join(process.env.QQ_AI_IMAGE_HOST_DIR, 'src', file));
    const { loadPlugins, unloadSkill } = await import(source('plugin-loader.js'));
    const { skillManager } = await import(source('skills/manager.js'));
    const { setSkillConfig, getSkillConfig } = await import(source('skills/config.js'));
    const { getTool } = await import(source('tool-registry.js'));
    const { createRoutes } = await import(source('routes.js'));
    const { ChatStore } = await import(source('store.js'));
    const { SessionRegistry } = await import(source('sessions.js'));
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=';
    let posts = 0;
    globalThis.fetch = async () => {
      posts++;
      return Response.json({ data: [{ b64_json: png }] });
    };
    const load = async () => {
      const result = await loadPlugins({ roots: { plugins: path.resolve('plugins'), skills: path.resolve('skills') }, log() {} });
      assert.deepEqual(result.failed, []);
      skillManager.activate('ai-image');
    };
    const routes = createRoutes({ readBody: async req => req, emit() {}, sanitizeConfig: () => ({}) });
    const route = routes.find(r => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.test('/api/skills/ai-image'));
    const save = settings => route.handler({
      req: { settings }, match: route.pattern.exec('/api/skills/ai-image'),
      json: (res, status, data) => { assert.equal(status, 200); return data; }
    });
    // 使用宿主真实渲染函数，检查输入框回填后保存整张表单的行为。
    const ui = fs.readFileSync(path.join(process.env.QQ_AI_IMAGE_HOST_DIR, 'ui/app/06-settings-render.js'), 'utf8');
    const sandbox = vm.createContext({ esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
    vm.runInContext(ui.slice(ui.indexOf('function renderSkillSettingsModal('), ui.indexOf('function openSkillSettings(')), sandbox);
    const saveForm = changes => {
      const settings = skillManager.settingsView('ai-image');
      const manifest = skillManager.registry.get('ai-image').manifest;
      const html = sandbox.renderSkillSettingsModal({ ...manifest, settings }).html;
      const input = html.match(/<input[^>]*data-key="blockedTerms"[^>]*>/)[0];
      settings.blockedTerms = input.match(/value="([^"]*)"/)[1]
        .replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      return save({ ...settings, ...changes });
    };
    setSkillConfig('ai-image', {
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-placeholder', blockedTerms: '禁词',
      dailyUserLimit: 0, dailyTotalLimit: 0, totalLimit: 0
    });
    const ctx = {
      chatKey: 'group:12345', session: { trigger: [{ id: 1, mid: 1, senderId: '55555' }], sent: [{ type: 'text', text: '我来画' }] },
      sender: { sendImage: async (key, image) => {
        if (image.file) {
          assert.ok(path.resolve(image.file).startsWith(path.resolve(os.tmpdir(), 'qq-agent-ai-image') + path.sep));
          fs.unlinkSync(image.file);
        }
        return { message_id: 1 };
      } }
    };
    const generate = (prompt, requestMessageId) => getTool('ai-image__gen').execute(ctx, { prompt, requestMessageId });
    try {
      await load();
      assert.equal(skillManager.settingsView('ai-image').blockedTerms, '禁词', '词表不应被脱敏');
      assert.match((await generate('禁词')).content, /黑名单/);
      await saveForm({ dailyTotalLimit: 1 });
      assert.equal(getSkillConfig('ai-image').blockedTerms, '禁词');
      assert.match((await generate('禁词')).content, /黑名单/, '仅改额度不能改变黑名单');
      await load();
      await saveForm({ model: 'changed-model' });
      assert.match((await generate('禁词')).content, /黑名单/, '重载后再次保存也必须保留黑名单');
      const first = await saveForm({ blockedTerms: '新禁词,另一个词' });
      assert.equal(first.settings.blockedTerms, '新禁词,另一个词');
      assert.equal(first.settings.apiKey, '******');
      await load();
      const reopened = skillManager.settingsView('ai-image');
      assert.equal(reopened.blockedTerms, '新禁词,另一个词');
      await saveForm({});
      assert.equal(getSkillConfig('ai-image').apiKey, 'test-placeholder');
      assert.match((await generate('新禁词')).content, /黑名单/);
      assert.equal(posts, 0);
      assert.equal((await generate('猫')).isError, undefined);
      assert.match((await generate('猫')).content, /全局每日/);
      assert.equal(posts, 1);
      await load();
      assert.match((await generate('猫')).content, /全局每日/);
      await saveForm({ blacklistEnabled: false, dailyTotalLimit: 0, totalLimit: 2 });
      await load();
      assert.equal(skillManager.settingsView('ai-image').blockedTerms, '新禁词,另一个词');
      assert.equal(skillManager.settingsView('ai-image').blacklistEnabled, false);
      assert.equal((await generate('新禁词')).isError, undefined);
      assert.match((await generate('猫')).content, /累计/);
      assert.equal(posts, 2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'ai-image-usage.json'), 'utf8')).total, 2);
      await saveForm({ blacklistEnabled: true });
      assert.match((await generate('新禁词')).content, /黑名单/);
      await saveForm({ blockedTerms: '', totalLimit: 3 });
      await load();
      assert.equal(skillManager.settingsView('ai-image').blockedTerms, '');
      assert.equal((await generate('新禁词')).isError, undefined);
      assert.equal(posts, 3);
      // 用宿主真实存储及会话生成 trigger 数组，复现一次唤醒包含多人的情况。
      await saveForm({ dailyUserLimit: 1, totalLimit: 0 });
      const store = new ChatStore();
      store.appendIncoming(ctx.chatKey, { mid: 101, senderId: '12345', text: '@机器人 画一只猫', atMe: true });
      store.appendIncoming(ctx.chatKey, { mid: 102, senderId: '67890', text: '今天吃什么' });
      ctx.session = new SessionRegistry().create({ chatKey: ctx.chatKey, trigger: store.drainUnread(ctx.chatKey) });
      ctx.session.sent.push({ type: 'text', text: '我来画' });
      ctx.selfId = '88888';
      assert.match((await generate('猫')).content, /requestMessageId/);
      assert.equal(posts, 3);
      assert.equal((await generate('猫', 101)).isError, undefined);
      assert.match((await generate('猫', 101)).content, /个人每日/);
      store.appendIncoming(ctx.chatKey, { mid: 103, senderId: '12345', text: '你好' });
      store.appendIncoming(ctx.chatKey, { mid: 104, senderId: '67890', text: '帮我画一只狗' });
      ctx.session.trigger = store.drainUnread(ctx.chatKey);
      assert.equal((await getTool('ai-image__gen').execute(ctx, { prompt: '狗', requestMessageId: 104 })).isError, undefined);
      assert.match((await getTool('ai-image__gen').execute(ctx, { prompt: '猫', requestMessageId: 101 })).content, /requestMessageId/);
      assert.equal(posts, 5);
      const usage = JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'ai-image-usage.json'), 'utf8'));
      assert.equal(usage.users['12345'], 1);
      assert.equal(usage.users['67890'], 1);
    } finally { unloadSkill('ai-image'); }
  `], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_AI_IMAGE_HOST_DIR: path.resolve(host), QQ_AGENT_DATA_DIR: path.join(root, 'data'), QQ_AGENT_PROFILE: '' }
  });
  assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
});
