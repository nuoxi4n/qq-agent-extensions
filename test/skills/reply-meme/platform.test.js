import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Optional real-platform contract test. It reads platform modules, but loads only
// a copied skill and uses isolated config/cache plus a fake OneBot transport.
const platform = process.env.QQ_AGENT_COMPAT_ROOT;
test('真实QQ Agent加载器、工具开关、hook、发送队列与重载契约', { skip: !platform }, async t => {
  const originalTemp = os.tmpdir();
  const directory = await fs.mkdtemp(path.join(originalTemp, 'reply-meme-platform-'));
  const previousFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR', 'QQ_AGENT_DATA_DIR'].map(key => [key, process.env[key]]));
  let unload;
  t.after(async () => {
    unload?.('reply-meme');
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(originalTemp));
    assert.ok(path.basename(directory).startsWith('reply-meme-platform-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = directory;
  process.env.QQ_AGENT_DATA_DIR = path.join(directory, 'data');
  const roots = { skills: path.join(directory, 'skills'), plugins: path.join(directory, 'plugins') };
  await fs.mkdir(roots.plugins, { recursive: true });
  await fs.cp(new URL('../../../skills/reply-meme/', import.meta.url), path.join(roots.skills, 'reply-meme'), { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  const raw = { gallery: { DeepSeek娘: { images: [{ name: 'DeepSeek娘『抱抱』表情包', original: 'https://img.aigengtu.com/meme/1.png' }] } } };
  await fs.mkdir(path.join(directory, 'qq-agent-reply-meme'));
  await fs.writeFile(path.join(directory, 'qq-agent-reply-meme/gallery-cache.json'), JSON.stringify({ at: Date.now(), raw }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
  let fetches = 0;
  globalThis.fetch = async url => {
    assert.equal(url, 'https://img.aigengtu.com/meme/1.png', '禁止真实联网或模型请求');
    fetches++;
    return new Response(png);
  };
  const moduleAt = file => import(pathToFileURL(path.join(platform, 'src', file)).href);
  const { loadPlugins, unloadSkill } = await moduleAt('plugin-loader.js');
  unload = unloadSkill;
  const { skillManager } = await moduleAt('skills/manager.js');
  const { getTool, listTools, getToolAvailability } = await moduleAt('tool-registry.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await moduleAt('config.js');
  const { SendQueue } = await moduleAt('sender.js');
  const { normalizeManifest } = await moduleAt('skills/manifest.js');
  const manifest = JSON.parse(await fs.readFile(path.join(roots.skills, 'reply-meme/skill.json'), 'utf8'));
  assert.deepEqual(normalizeManifest(manifest).problems, []);
  const config = structuredClone(DEFAULT_CONFIG);
  config.skills = { 'reply-meme': { enabled: true, cooldownSeconds: 60 } };
  setRuntimeConfig(config);
  const logs = [];
  const load = () => loadPlugins({ roots, log: line => logs.push(line) });
  const loaded = await load();
  assert.deepEqual(loaded.failed, []);
  assert.equal(loaded.loaded.length, 1);
  assert.equal(loaded.loaded[0].skill.manifest.description, manifest.description, '保留用户编写的描述');
  skillManager.activate('reply-meme'); // app.js activates after registration.
  assert.equal(skillManager.isActive('reply-meme').active, true);
  const availability = (extra = {}) => getToolAvailability('reply-meme__find_meme', { visionEnabled: false, searchEnabled: false, ...extra });
  assert.equal(availability().enabled, true, '纯文本模型与关闭联网搜索均可使用');
  assert.equal(availability({ toolsCfg: { enabled: false } }).enabled, false);
  assert.equal(availability({ toolsCfg: { categories: { sticker: false } } }).enabled, false);
  assert.equal(availability({ toolsCfg: { overrides: { 'reply-meme__find_meme': false } } }).enabled, false);
  const registered = listTools().filter(x => x.skillId === 'reply-meme');
  assert.deepEqual(registered.map(x => x.id).sort(), ['reply-meme__find_meme', 'reply-meme__send_meme']);
  const system = JSON.stringify(skillManager.getPromptSections({ chatKey: 'group:123' }));
  const archived = [], transport = [];
  const sender = new SendQueue({
    onebot: { async sendImage(kind, id, ref) {
      assert.equal(kind, 'group'); assert.equal(id, '123');
      assert.ok(ref.startsWith('file:///'));
      await fs.access(fileURLToPath(ref));
      transport.push(ref);
      return { message_id: 42 };
    } },
    store: { appendSelf: (...args) => archived.push(args) }
  });
  const session = { id: 'contract', status: 'running', sent: [{ type: 'text', text: '给你抱抱' }] };
  const hookContext = { chatKey: 'group:123', kind: 'group', chatId: '123', sessionId: session.id, visionEnabled: false };
  const messages = [{ role: 'system', content: '稳定前缀' }, { role: 'user', content: '抱抱' }];
  await skillManager.runHook('before-llm-messages', { ...hookContext, messages }); // no session in this hook
  assert.equal(fetches, 0);
  assert.equal(messages[0].content, '稳定前缀');
  const candidate = JSON.parse(messages.at(-1).content.split('\n').at(-1))[0];
  const ctx = { chatKey: hookContext.chatKey, kind: 'group', chatId: '123', session, sender }; // no sessionId in execute ctx
  const call = async (name, args) => {
    const result = await getTool(`reply-meme__${name}`).execute(ctx, args);
    assert.equal(typeof result.content, 'string');
    return JSON.parse(result.content);
  };
  await skillManager.runHook('after-response', { ...hookContext, session, response: {} });
  const prepared = await call('find_meme', { ids: [candidate.id] });
  const args = { tickets: [prepared.prepared[0].ticket], mode: 'reply' };
  assert.equal((await call('send_meme', args)).sent, 0, '同一个模型响应内不能直接发送新准备的图');
  await skillManager.runHook('after-response', { ...hookContext, session, response: {} });
  assert.equal((await call('send_meme', args)).sent, 1);
  assert.equal(transport.length, 1);
  assert.equal(archived.length, 1);
  assert.equal(session.sent.filter(x => x.type === 'image').length, 1);
  assert.equal(fetches, 1);
  assert.equal(JSON.stringify(skillManager.getPromptSections(hookContext)), system);
  assert.equal((await call('send_meme', args)).sent, 0, '凭据不会重复发图');
  config.skills['reply-meme'].enabled = false;
  skillManager.deactivate('reply-meme');
  assert.equal(availability().enabled, false);
  assert.deepEqual(skillManager.getPromptSections(hookContext), []);
  config.skills['reply-meme'].enabled = true;
  skillManager.activate('reply-meme');
  assert.equal(availability().enabled, true);
  assert.equal((await load()).failed.length, 0);
  skillManager.activate('reply-meme');
  assert.equal(listTools().filter(x => x.skillId === 'reply-meme').length, 2, '重载无孤儿或重复工具');
  assert.ok(!logs.some(line => /❌|⚠/.test(line)), logs.join('\n'));
  unloadSkill('reply-meme');
  assert.equal(listTools().filter(x => x.skillId === 'reply-meme').length, 0);
});
