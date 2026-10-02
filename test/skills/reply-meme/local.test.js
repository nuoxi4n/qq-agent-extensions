import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalSource } from '../../../skills/reply-meme/lib/local.js';
import { createImageCache } from '../../../skills/reply-meme/lib/cache.js';
import { selectionInfo } from '../../../skills/reply-meme/lib/metadata.js';
import { setup, activate, dispose, hooks, available } from '../../../skills/reply-meme/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
const remote = { original: 'https://img.aigengtu.com/meme/999.png', preview: 'https://img.aigengtu.com/0_preview/meme/999.webp', title: '开心', label: '开心', story: '', category: '' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-local-test-'));
  t.after(async () => {
    dispose();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('reply-local-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const localDir = path.join(root, 'local'), cacheDir = path.join(root, 'cache');
  await fs.mkdir(localDir); await fs.mkdir(cacheDir);
  return { localDir, cacheDir };
}
const run = async (tool, ctx, args) => JSON.parse((await tool.execute(ctx, args)).content);
async function runtime(config, cacheDir, fetcher) {
  const tools = {}, sent = [];
  await setup({ config: () => config, registerTool: t => { tools[t.id] = t; }, fetch: fetcher }, { cacheDir });
  activate();
  const ctx = { chatKey: 'group:local', session: { id: 'local', status: 'running', sent: [{ type: 'text', text: '开心' }] },
    sender: { sendImage: async (key, { file }) => { sent.push(await fs.readFile(file)); return { ok: true }; } } };
  return { tools, ctx, sent };
}

test('异常工具参数按官方契约返回 isError，不抛出或联网', async t => {
  const { localDir, cacheDir } = await fixture(t);
  const { tools, ctx } = await runtime({ localEnabled: true, localDirectory: localDir, networkEnabled: false }, cacheDir,
    async () => { throw new Error('不得联网'); });
  for (const tool of Object.values(tools)) {
    for (const args of [null, [], '开心', 1]) {
      const response = await tool.execute(ctx, args);
      assert.equal(response.isError, true);
      assert.match(JSON.parse(response.content).reason, /参数必须是对象/);
    }
  }
});

test('候选ID误用于发送时给出准确准备调用，纠正后可用reply发送且不重复文字', async t => {
  const { localDir, cacheDir } = await fixture(t);
  await fs.writeFile(path.join(localDir, '晚安_好梦.png'), png);
  const { tools, ctx, sent } = await runtime({ localEnabled: true, localDirectory: localDir, networkEnabled: false }, cacheDir,
    async () => { throw new Error('不得联网'); });
  const list = await run(tools.find_meme, ctx, { keyword: '晚安 睡觉 好梦' });
  const id = list.candidates[0].id;
  assert.match(list.next, /reply-meme__find_meme/);
  assert.match(list.next, /候选 id 不能/);
  const wrong = await tools.send_meme.execute(ctx, { tickets: [id], mode: 'reply' });
  assert.equal(wrong.isError, true);
  assert.match(JSON.parse(wrong.content).reason, /误把候选 id/);
  assert.ok(JSON.parse(wrong.content).reason.includes(JSON.stringify({ ids: [id] })));
  assert.equal(sent.length, 0);
  const ready = await run(tools.find_meme, ctx, { ids: [id] });
  assert.match(ready.next, /已发则勿重发/);
  const args = { tickets: [ready.prepared[0].ticket], mode: 'reply' };
  assert.equal((await run(tools.send_meme, ctx, args)).sent, 0, '仍需经过下一次模型响应');
  hooks['after-response'](ctx);
  assert.equal((await run(tools.send_meme, ctx, args)).sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(ctx.session.sent.filter(x => x.type === 'text').length, 1);
});

test('本地文件名索引支持多扩展名和单字，不递归；读取与缓存不改动原文件', async t => {
  const { localDir, cacheDir } = await fixture(t);
  for (const name of ['开心_02.JPG', '可爱.gif', '抱抱_安慰.webp', '哼.png', '12345678.jpeg', 'ignore.txt']) await fs.writeFile(path.join(localDir, name), png);
  await fs.mkdir(path.join(localDir, 'nested'));
  await fs.writeFile(path.join(localDir, 'nested', '不要扫描.png'), png);
  const source = createLocalSource(), items = await source.load(localDir);
  assert.equal(items.length, 5);
  assert.ok(items.some(i => i.title === '抱抱 安慰'));
  assert.equal(selectionInfo(items.find(i => i.title === '哼')).evidence, 'title');
  assert.equal(selectionInfo(items.find(i => i.title === '12345678')).evidence, 'unknown');
  await assert.rejects(source.load('relative'), /绝对路径/);
  const cache = createImageCache(() => { throw new Error('must not fetch'); }, cacheDir, { maxFiles: 0 });
  const item = items.find(i => i.title === '开心');
  const image = await cache.prepare(item);
  assert.notEqual(image.file, item.localFile);
  assert.deepEqual(await fs.readFile(image.file), png);
  image.release(); cache.sweep();
  assert.deepEqual(await fs.readFile(item.localFile), png);
  await fs.writeFile(item.localFile, Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(cache.prepare(item), /变更/);
  source.clear();
  assert.notEqual((await source.load(localDir)).find(i => i.title === '开心').original, item.original);
});

test('本地命中不联网，默认角色不排除本地；发送快照并阻止关闭图源后的凭据', async t => {
  const { localDir, cacheDir } = await fixture(t);
  const file = path.join(localDir, '开心.jpg'); await fs.writeFile(file, png);
  let calls = 0;
  const config = { localEnabled: true, localDirectory: localDir, networkEnabled: true, character: 'DeepSeek' };
  const { tools, ctx, sent } = await runtime(config, cacheDir, async () => { calls++; throw new Error('unexpected network'); });
  const list = await run(tools.find_meme, ctx, { keyword: '开心' });
  assert.equal(list.candidates.length, 1);
  const prep = await run(tools.find_meme, ctx, { ids: [list.candidates[0].id] });
  await fs.unlink(file);
  hooks['after-response'](ctx);
  config.localEnabled = false;
  assert.equal((await run(tools.send_meme, ctx, { tickets: [prep.prepared[0].ticket], mode: 'request' })).sent, 0);
  config.localEnabled = true;
  assert.equal((await run(tools.send_meme, ctx, { tickets: [prep.prepared[0].ticket], mode: 'request' })).sent, 1);
  assert.deepEqual(sent[0], png);
  assert.equal(calls, 0);
  config.localEnabled = false; config.networkEnabled = false;
  assert.equal(available(), false);
  assert.deepEqual((await run(tools.find_meme, ctx, { keyword: '开心' })).candidates, []);
});

test('本地未命中才回退网络，网络关闭时不请求；修改目录拒绝旧候选', async t => {
  const { localDir, cacheDir } = await fixture(t);
  await fs.writeFile(path.join(localDir, '抱抱.png'), png);
  let calls = 0;
  const config = { localEnabled: true, localDirectory: localDir, networkEnabled: false };
  const { tools, ctx } = await runtime(config, cacheDir, async url => {
    calls++;
    return String(url).includes('.json') ? Response.json({ gallery: { DeepSeek娘: { images: [{ ...remote, name: '开心' }] } } }) : new Response(png);
  });
  assert.deepEqual((await run(tools.find_meme, ctx, { keyword: '开心' })).candidates, []);
  assert.equal(calls, 0);
  const local = await run(tools.find_meme, ctx, { keyword: '抱抱' });
  config.localDirectory = cacheDir;
  assert.match((await run(tools.find_meme, ctx, { ids: [local.candidates[0].id] })).failures[0].reason, /变更/);
  config.networkEnabled = true;
  const result = await run(tools.find_meme, ctx, { keyword: '开心' });
  assert.equal(result.candidates.length, 1);
  assert.ok(calls > 0);
});

test('网络静态原图优先于更快预览；重启后按缓存标题检索并发送原字节，零网络请求', async t => {
  const { localDir, cacheDir } = await fixture(t);
  const original = Buffer.concat([png, Buffer.from('original bytes')]);
  const cache = createImageCache(async url => {
    if (url.includes('0_preview')) return new Response(png);
    await new Promise(resolve => setImmediate(resolve));
    return new Response(original);
  }, cacheDir);
  const image = await cache.prepare(remote);
  assert.equal(image.usedPreview, false);
  assert.deepEqual(await fs.readFile(image.file), original);
  image.release();
  let calls = 0;
  const { tools, ctx, sent } = await runtime({ localEnabled: true, localDirectory: localDir }, cacheDir, async () => { calls++; throw new Error('offline'); });
  const list = await run(tools.find_meme, ctx, { keyword: '开心' });
  assert.equal(list.candidates.length, 1);
  const prep = await run(tools.find_meme, ctx, { ids: [list.candidates[0].id] });
  hooks['after-response'](ctx);
  assert.equal((await run(tools.send_meme, ctx, { tickets: [prep.prepared[0].ticket], mode: 'request' })).sent, 1);
  assert.deepEqual(sent[0], original);
  assert.equal(calls, 0);
});
