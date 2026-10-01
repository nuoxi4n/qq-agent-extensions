import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureFile = fileURLToPath(new URL('../../helpers/extension-process.js', import.meta.url));
const extensions = ['plugins/currency', 'plugins/rapport', 'skills/work', 'skills/feeding'];
const names = extensions.map(p => p.split('/')[1]);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-lifecycle-'));
  const peers = [];
  function start(mode = 'extensions', modulePath = '') {
    const child = spawn(process.execPath, [fixtureFile, mode, directory, modulePath], {
      cwd: root, env: { ...process.env, QQ_AGENT_DATA_DIR: directory, QQ_AGENT_PROFILE: '' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
    });
    let stderr = '', done = false, pending;
    const messages = [];
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => { if (pending) { pending.resolve(message); pending = undefined; } else messages.push(message); });
    child.on('error', error => { pending?.reject(error); pending = undefined; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => {
      done = true;
      pending?.reject(new Error(`子进程提前退出 ${code}/${signal}: ${stderr}`)); pending = undefined;
      resolve({ code, signal });
    }));
    function next() {
      if (messages.length) return Promise.resolve(messages.shift());
      if (done) return Promise.reject(new Error(`子进程已退出: ${stderr}`));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending = undefined; reject(new Error(`等待子进程超时: ${stderr}`)); }, 10000);
        pending = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
      });
    }
    async function stop(force = false) {
      if (!done) { if (force) child.kill('SIGKILL'); else child.send('exit'); }
      return closed;
    }
    const peer = { child, next, stop, request: message => { const response = next(); child.send(message); return response; } };
    peers.push(peer);
    return peer;
  }
  t.after(async () => {
    await Promise.all(peers.map(peer => peer.stop(true)));
    const absolute = fs.realpathSync(directory);
    assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('extension-lifecycle-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const locks = () => fs.readdirSync(directory).filter(name => name.includes('.lock'));
  const snapshot = () => Object.fromEntries(names.map(name => [name, JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'))]));
  return { directory, start, locks, snapshot };
}

function checkResult(result, replayed) {
  assert.deepEqual(result.available, Object.fromEntries(names.map(name => [name, true])));
  assert.equal(result.work.paid, true); assert.equal(result.work.replayed, replayed);
  assert.equal(result.feeding.paid, true); assert.equal(result.feeding.replayed, replayed);
  assert.equal(result.feeding.applied, 0.1);
  assert.equal(result.balance, 1000 + result.work.amount - 20);
}

test('四扩展的锁实现保持相同，独立发布不依赖其他扩展目录', () => {
  const copies = extensions.map(p => fs.readFileSync(path.join(root, p, 'lib/file-lock.js'), 'utf8'));
  for (const copy of copies) assert.equal(copy, copies[0]);
});

for (const retryCleanup of [false, true]) {
  test(`真实进程直接退出${retryCleanup ? '且删锁暂时失败' : '而不触发停用'}：四扩展全部清锁，重启不重复结算`, { timeout: 30000 }, async t => {
    const f = fixture(t), first = f.start(retryCleanup ? 'exit-cleanup-retry' : 'extensions');
    checkResult(await first.next(), false);
    const saved = f.snapshot();
    assert.equal(saved.work.records.length, 1); assert.equal(saved.feeding.records.length, 1);
    assert.equal(saved.rapport.chats['group:12345'].members['10001'].score, 0.1);
    assert.equal(f.locks().length, 8);
    assert.equal((await first.stop()).code, 0);
    assert.deepEqual(f.locks(), []);
    const second = f.start(); checkResult(await second.next(), true);
    assert.deepEqual(f.snapshot(), saved);
    await second.stop(); assert.deepEqual(f.locks(), []);
  });
}

for (const legacy of [false, true]) {
  test(`强制结束后回收${legacy ? '旧版 PID 锁' : '主锁与归属文件'}，保留四份数据并防重复结算`, { timeout: 30000 }, async t => {
    const f = fixture(t), first = f.start();
    checkResult(await first.next(), false);
    const saved = f.snapshot();
    await first.stop(true); assert.equal(f.locks().length, 8);
    if (legacy) {
      // 旧版本仅有相同 JSON 格式的主锁，没有归属文件。
      for (const name of f.locks().filter(name => name.includes('.owner-'))) fs.unlinkSync(path.join(f.directory, name));
      assert.equal(f.locks().length, 4);
    }
    const second = f.start(); checkResult(await second.next(), true);
    assert.deepEqual(f.snapshot(), saved);
    for (const name of names) assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, `${name}.json.lock`))).pid, second.child.pid);
    await second.stop(); assert.deepEqual(f.locks(), []);
  });
}

test('真实第二进程不能抢占四扩展，退出不删除第一进程锁或修改数据', { timeout: 30000 }, async t => {
  const f = fixture(t), first = f.start();
  checkResult(await first.next(), false);
  const saved = f.snapshot(), originalLocks = f.locks();
  const second = f.start('probe');
  assert.deepEqual((await second.next()).errors, Object.fromEntries(names.map(name => [name, 'STORAGE_LOCKED'])));
  await second.stop();
  assert.deepEqual(f.snapshot(), saved); assert.deepEqual(f.locks(), originalLocks);
  for (const name of names) assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, `${name}.json.lock`))).pid, first.child.pid);
  await first.stop(); assert.deepEqual(f.locks(), []);
});

test('真实多进程同时恢复遗留锁，四扩展均至多一个成功持有', { timeout: 30000 }, async t => {
  const f = fixture(t);
  for (const modulePath of extensions) {
    const crashed = f.start('lock', modulePath); await crashed.next();
    assert.equal((await crashed.request('acquire')).ok, true); await crashed.stop(true);
    const contenders = [0, 1, 2].map(() => f.start('lock', modulePath));
    await Promise.all(contenders.map(peer => peer.next()));
    const results = await Promise.all(contenders.map(peer => peer.request('acquire')));
    const winners = results.filter(result => result.ok).length;
    assert.ok(winners <= 1, JSON.stringify(results));
    for (const result of results.filter(result => !result.ok)) assert.equal(result.code, 'STORAGE_LOCKED', JSON.stringify(result));
    await Promise.all(contenders.map(peer => peer.stop()));
    // 同时启动可能相互看到声明而全部退让；随后单独启动必须能恢复。
    const retry = f.start('lock', modulePath); await retry.next();
    assert.equal((await retry.request('acquire')).ok, true);
    await retry.stop(); assert.deepEqual(f.locks(), []);
  }
});
