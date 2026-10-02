import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImageCache } from '../../../skills/reply-meme/lib/cache.js';
import { createSource } from '../../../skills/reply-meme/lib/source.js';
import { setup, activate, dispose, hooks } from '../../../skills/reply-meme/index.js';
import { resolvePolicy } from '../../../skills/reply-meme/lib/policy.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
const item = n => ({ original: `https://img.aigengtu.com/meme/${n}.png`, preview: `https://img.aigengtu.com/0_preview/meme/${n}.webp`, title: '开心猫', story: '', category: 'DeepSeek娘' });
const raw = (...ids) => ({ gallery: { DeepSeek娘: { images: ids.map(n => ({ ...item(n), name: '开心猫' })) } } });
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-meme-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(dir)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('reply-meme-test-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('图片成功缓存可跨轮和重启复用，不再次联网', async t => {
  const dir = await directory(t);
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(png); };
  const cache = createImageCache(fetcher, dir);
  const first = await cache.prepare(item(1));
  assert.equal(first.cached, false);
  const before = calls;
  assert.equal((await cache.prepare(item(1))).cached, true);
  const restarted = createImageCache(fetcher, dir);
  assert.equal((await restarted.prepare(item(1))).cached, true);
  assert.equal(calls, before);
});

test('原图超时后使用并行预览，并取消原图请求', async t => {
  const dir = await directory(t);
  let aborted = false;
  const cache = createImageCache(async (url, { signal }) => {
    if (url.includes('0_preview')) return new Response(png);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
  }, dir, { timeoutMs: 30 });
  const result = await cache.prepare(item(1));
  assert.equal(result.usedPreview, true);
  assert.equal(aborted, true);
});

test('原图和预览失败保留原因，冷却内不重复下载', async t => {
  const dir = await directory(t);
  let calls = 0;
  const cache = createImageCache(async () => { calls++; return new Response('', { status: 404 }); }, dir);
  await assert.rejects(cache.prepare(item(1)), /HTTP 404/);
  assert.equal(cache.available(item(1)), false);
  await assert.rejects(cache.prepare(item(1)), /暂时跳过/);
  assert.equal(calls, 2);
});

test('并发准备同一素材合并下载，损坏缓存会重新校验和下载', async t => {
  const dir = await directory(t);
  let calls = 0;
  const cache = createImageCache(async () => { calls++; return new Response(png); }, dir);
  const [a, b] = await Promise.all([cache.prepare(item(1)), cache.prepare(item(1))]);
  assert.equal(calls, 2);
  assert.equal(a.file, b.file);
  await fs.writeFile(a.file, 'broken image');
  assert.equal((await cache.prepare(item(1))).cached, false);
  assert.equal(calls, 4);
});

test('取消准备不把素材记入失败冷却', async t => {
  const dir = await directory(t);
  const controller = new AbortController();
  const cache = createImageCache(async () => { controller.abort(); throw new Error('cancelled'); }, dir);
  await assert.rejects(cache.prepare(item(1), controller.signal), /取消/);
  assert.equal(cache.available(item(1)), true);
});

test('双地址同时挂起时共享一次等待窗口，超时后立即命中失败冷却', async t => {
  const dir = await directory(t);
  let calls = 0;
  const cache = createImageCache(async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, dir, { timeoutMs: 30 });
  await assert.rejects(cache.prepare(item(1)), /超时/);
  assert.equal(calls, 2);
  await assert.rejects(cache.prepare(item(1)), /暂时跳过/);
  assert.equal(calls, 2);
});

test('GIF 原图可用时不因预览更快而丢失动画格式', async t => {
  const dir = await directory(t);
  const gif = Buffer.alloc(24);
  gif.write('GIF89a'); gif.writeUInt16LE(100, 6); gif.writeUInt16LE(100, 8);
  const cache = createImageCache(async url => {
    if (url.includes('0_preview')) return new Response(png);
    await new Promise(resolve => setImmediate(resolve));
    return new Response(gif);
  }, dir);
  const image = await cache.prepare({ ...item(1), original: 'https://img.aigengtu.com/meme/1.gif' });
  assert.equal(image.format, 'gif');
  assert.equal(image.usedPreview, false);
});

test('过期但可用的图库索引立即返回，刷新在后台完成', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'gallery-cache.json'), JSON.stringify({ at: Date.now() - 20 * 60000, raw: raw(1) }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = createSource(async () => { await gate; return Response.json(raw(2)); }, dir);
  try {
    const cached = await source.load(15);
    assert.equal(cached.stale, true);
    assert.match(cached.items[0].original, /1\.png$/);
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.match(source.peek()[0].original, /2\.png$/);
});

test('默认索引一天内重复读取及重启均不联网', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'gallery-cache.json'), JSON.stringify({ at: Date.now() - 23 * 3600000, raw: raw(1) }));
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json(raw(2)); };
  const source = createSource(fetcher, dir);
  for (let i = 0; i < 3; i++) assert.equal((await source.load()).stale, false);
  assert.equal((await createSource(fetcher, dir).load()).stale, false);
  assert.equal(calls, 0);
});

test('一天以上的索引刷新失败时仍使用七天内缓存', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'gallery-cache.json'), JSON.stringify({ at: Date.now() - 2 * 24 * 3600000, raw: raw(1) }));
  let calls = 0;
  const source = createSource(async () => { calls++; return new Response('', { status: 503 }); }, dir);
  const result = await source.load();
  assert.equal(result.stale, true);
  assert.equal(result.items.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await source.load()).items.length, 1);
  assert.equal(calls, 1, '刷新失败后遵守退避，不在每次读取时重复请求');
});

test('工具失败后不提供假发送指引，排除失败候选并限制本轮尝试', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'gallery-cache.json'), JSON.stringify({ at: Date.now(), raw: raw(1, 2, 3, 4) }));
  const tools = {};
  let calls = 0;
  await setup({ config: () => ({}), registerTool: tool => { tools[tool.id] = tool; }, fetch: async () => { calls++; return new Response('', { status: 404 }); } },
    { cacheDir: dir });
  activate();
  t.after(dispose);
  const ctx = { chatKey: 'group:1', session: { id: 'one', status: 'running', sent: [] } };
  const list = JSON.parse((await tools.find_meme.execute(ctx)).content);
  const first = JSON.parse((await tools.find_meme.execute(ctx, { ids: list.candidates.slice(0, 3).map(x => x.id) })).content);
  assert.equal(first.prepared.length, 0);
  assert.match(first.next, /没有可发送的 ticket/);
  const before = calls;
  const stopped = JSON.parse((await tools.find_meme.execute(ctx, { ids: [list.candidates[3].id] })).content);
  assert.match(stopped.failures[0].reason, /最多尝试/);
  assert.equal(calls, before);
  const stoppedSearch = JSON.parse((await tools.find_meme.execute(ctx)).content);
  assert.deepEqual(stoppedSearch.candidates, []);
  assert.equal(calls, before, '达到上限后不再通过检索预取新图片');
  const messages = [];
  hooks['before-llm-messages']({ chatKey: 'group:1', sessionId: 'two', messages });
  assert.ok(!JSON.stringify(messages).includes(list.candidates[0].id));
  dispose();
});

test('缓存按文件数和字节数淘汰，同时移除过期孤立文件', async t => {
  const dir = await directory(t);
  const cache = createImageCache(async url => new Response(Buffer.concat([png, Buffer.from(url)])), dir,
    { maxFiles: 3, maxBytes: 250 });
  for (let n = 0; n < 8; n++) (await cache.prepare(item(n))).release();
  const imageDir = path.join(dir, 'images');
  let names = await fs.readdir(imageDir);
  assert.ok(names.length <= 3);
  const stats = await Promise.all(names.map(name => fs.stat(path.join(imageDir, name))));
  assert.ok(stats.reduce((sum, stat) => sum + stat.size, 0) <= 250);
  const orphan = path.join(imageDir, 'a'.repeat(64) + '.png');
  await fs.writeFile(orphan, png);
  const old = new Date(Date.now() - 72 * 3600000);
  await fs.utimes(orphan, old, old);
  cache.sweep();
  await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'image-cache.json'), 'utf8'));
  names = await fs.readdir(imageDir);
  assert.ok(Object.values(manifest.images).every(entry => names.includes(entry.name)));
});

test('超额淘汰保护所有有效 ticket 的图片，释放后恢复容量限制', async t => {
  const dir = await directory(t);
  const cache = createImageCache(async url => new Response(Buffer.concat([png, Buffer.from(url)])), dir, { maxFiles: 1 });
  const first = await cache.prepare(item(1));
  const same = await cache.prepare(item(1));
  const second = await cache.prepare(item(2));
  cache.sweep();
  assert.ok(await fs.stat(first.file));
  first.release();
  cache.sweep();
  assert.ok(await fs.stat(first.file), '另一张 ticket 尚未释放');
  same.release();
  await assert.rejects(fs.stat(first.file), { code: 'ENOENT' });
  assert.ok(await fs.stat(second.file));
  second.release();
  assert.equal((await fs.readdir(path.join(dir, 'images'))).length, 1);
});

test('全局并发最多两张素材，排队请求完成后正确释放槽位', async t => {
  const dir = await directory(t);
  let running = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createImageCache(async () => {
    running++; peak = Math.max(peak, running);
    await gate;
    running--;
    return new Response(png);
  }, dir);
  const work = Promise.all(Array.from({ length: 10 }, (_, i) => cache.prepare(item(i))));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, 4, '两张素材各有原图与预览两个请求');
  release();
  for (const image of await work) image.release();
  assert.ok(peak <= 4);
});

test('繁忙预取不入队，排队的正式请求可取消且不误记失败冷却', async t => {
  const dir = await directory(t);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createImageCache(async () => { calls++; await gate; return new Response(png); }, dir, { concurrency: 1 });
  const active = cache.prepare(item(1));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(cache.prepare(item(2), undefined, { prefetch: true }), /下载繁忙/);
  assert.equal(cache.available(item(2)), true);
  const controller = new AbortController();
  const waiting = cache.prepare(item(3), controller.signal);
  controller.abort();
  await assert.rejects(waiting, /取消/);
  assert.equal(cache.available(item(3)), true);
  assert.equal(calls, 2);
  release(); (await active).release();
});

test('连续检索十次只预取一张，停用后取消请求且不发送', async t => {
  const dir = await directory(t);
  const data = raw(...Array.from({ length: 20 }, (_, i) => i));
  data.gallery.DeepSeek娘.images.forEach((row, i) => { row.name = `猫${String.fromCharCode(65 + i)}开心`; });
  await fs.writeFile(path.join(dir, 'gallery-cache.json'), JSON.stringify({ at: Date.now(), raw: data }));
  const tools = {};
  let calls = 0;
  await setup({ config: () => ({}), registerTool: tool => { tools[tool.id] = tool; }, fetch: async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }, { cacheDir: dir });
  activate();
  try {
    const ctx = { chatKey: 'group:1', session: { id: 'bounded', status: 'running', sent: [] } };
    for (let i = 0; i < 10; i++) await tools.find_meme.execute(ctx, { keyword: `猫${String.fromCharCode(65 + i)}` });
    assert.equal(calls, 2);
  } finally { dispose(); await new Promise(resolve => setImmediate(resolve)); }
});

test('仅使用公开 api/ctx，仍要求下一轮模型决定发送且 hook 不联网', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'gallery-cache.json'), JSON.stringify({ at: Date.now(), raw: raw(1) }));
  const tools = {};
  let calls = 0, sent = 0;
  await setup({ config: () => ({}), registerTool: tool => { tools[tool.id] = tool; }, fetch: async () => { calls++; return new Response(png); } }, { cacheDir: dir });
  activate();
  try {
    const ctx = { chatKey: 'group:1', session: { id: 'public', status: 'running', sent: [] }, sender: { sendImage: async () => { sent++; return { message_id: 1 }; } } };
    const messages = [];
    hooks['before-llm-messages']({ ...ctx, messages });
    assert.equal(calls, 0);
    const candidates = JSON.parse(messages[0].content.split('\n').at(-1));
    const prepared = JSON.parse((await tools.find_meme.execute(ctx, { ids: [candidates[0].id] })).content);
    const args = { tickets: [prepared.prepared[0].ticket], mode: 'request' };
    assert.equal((await tools.send_meme.execute(ctx, args)).isError, true);
    hooks['after-response'](ctx);
    assert.equal((await tools.send_meme.execute(ctx, args)).isError, undefined);
    assert.equal(sent, 1);
    assert.equal((await tools.send_meme.execute(ctx, args)).isError, true);
  } finally { dispose(); }
  assert.equal(resolvePolicy({}).level, null);
  assert.equal(resolvePolicy({ intensity: '2 · 较积极' }).level, 2);
  assert.equal(resolvePolicy({ autoReply: false }).proactive, false);
});

test('所有模块导入仅指向技能自身文件或 Node 内置模块', async () => {
  const root = new URL('../../../skills/reply-meme/', import.meta.url);
  for (const file of ['index.js', ...((await fs.readdir(new URL('lib/', root))).filter(name => name.endsWith('.js')).map(name => 'lib/' + name))]) {
    const url = new URL(file, root);
    const text = await fs.readFile(url, 'utf8');
    assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/);
    for (const match of text.matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('node:')) continue;
      assert.ok(match[1].startsWith('.'));
      assert.ok(new URL(match[1], url).href.startsWith(root.href));
    }
  }
});
