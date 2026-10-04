import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultCacheDir } from '../../../skills/reply-meme/lib/storage.js';
import { createImageCache } from '../../../skills/reply-meme/lib/cache.js';
import { createHistory } from '../../../skills/reply-meme/lib/history.js';
import { fingerprint } from '../../../skills/reply-meme/lib/image.js';

test('缓存按宿主数据目录隔离，遵循覆盖目录和数字profile，重启保持路径', () => {
  const root = path.resolve('host-a');
  const resolve = env => defaultCacheDir({ root, env });
  const main = resolve({});
  assert.equal(main, resolve({ QQ_AGENT_PROFILE: 'invalid' }));
  assert.equal(main, resolve({ QQ_AGENT_DATA_DIR: path.join(root, 'data'), QQ_AGENT_PROFILE: '2' }));
  assert.equal(resolve({ QQ_AGENT_PROFILE: '2' }), resolve({ QQ_AGENT_PROFILE: ' 2 ' }));
  assert.equal(resolve({ QQ_AGENT_PROFILE: '2' }), resolve({ QQ_AGENT_DATA_DIR: path.join(root, 'data-2') }));
  assert.notEqual(main, resolve({ QQ_AGENT_PROFILE: '2' }));
  assert.notEqual(resolve({ QQ_AGENT_PROFILE: '2' }), resolve({ QQ_AGENT_PROFILE: '3' }));
  assert.notEqual(main, defaultCacheDir({ root: path.resolve('host-b'), env: {} }));
  assert.notEqual(resolve({ QQ_AGENT_DATA_DIR: path.resolve('data-a') }), resolve({ QQ_AGENT_DATA_DIR: path.resolve('data-b') }));
  assert.equal(main, resolve({}), '不使用PID或随机目录，重启仍可复用缓存');
});

test('另一实例清理不会删除待发送图片，历史与冷却隔离且重启可复用', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-meme-storage-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(temp)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('reply-meme-storage-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'host');
  const dirA = defaultCacheDir({ root, temp, env: {} });
  const dirB = defaultCacheDir({ root, temp, env: { QQ_AGENT_PROFILE: '2' } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
  const fetcher = async () => new Response(png);
  const a = createImageCache(fetcher, dirA);
  const b = createImageCache(fetcher, dirB, { maxFiles: 0 });
  const item = { original: 'https://img.aigengtu.com/meme/1.png', title: '抱抱' };
  const held = await a.prepare(item);
  const other = await b.prepare(item);
  other.release();
  b.sweep();
  await assert.rejects(fs.access(other.file), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(held.file), png, '另一实例淘汰同一素材不能破坏有效凭据');

  const mark = { ...item, hash: held.hash, urlHash: fingerprint(item.original) };
  createHistory(dirA).mark('group:123', mark, true);
  const historyA = createHistory(dirA), historyB = createHistory(dirB);
  assert.equal(historyA.cooling('group:123', 60), true);
  assert.equal(historyA.seen('group:123', mark.urlHash), true);
  assert.equal(historyB.cooling('group:123', 60), false);
  assert.equal(historyB.seen('group:123', mark.urlHash), false);
  held.release();
  const restarted = createImageCache(() => { throw new Error('重启不应重新下载'); }, dirA);
  const reused = await restarted.prepare(item);
  assert.equal(reused.cached, true);
  reused.release();
});
