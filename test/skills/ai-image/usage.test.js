import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { consumeUsage } from '../../../skills/ai-image/lib/usage.js';

const limits = { dailyUserLimit: 2, dailyTotalLimit: 3, totalLimit: 4 };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-image-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file: path.join(dir, 'usage.json'), now: new Date('2026-10-03T15:59:59Z') };
}

test('个人、全局日额度和累计额度持久化，拒绝请求不修改统计', t => {
  const options = fixture(t);
  consumeUsage(limits, '12345', 4, options);
  const state = consumeUsage(limits, '12345', 1, options);
  assert.equal(state.total, 2);
  assert.equal(state.totalImages, 5);
  assert.throws(() => consumeUsage(limits, '12345', 1, options), /个人每日/);
  consumeUsage(limits, '67890', 1, options);
  const before = fs.readFileSync(options.file, 'utf8');
  assert.throws(() => consumeUsage(limits, '99999', 1, options), /全局每日/);
  assert.equal(fs.readFileSync(options.file, 'utf8'), before);
  options.now = new Date('2026-10-03T16:00:00Z');
  const next = consumeUsage(limits, '12345', 1, options);
  assert.equal(next.day, '2026-10-04');
  assert.equal(next.dailyTotal, 1);
  assert.deepEqual(next.users, { '12345': 1 });
  assert.equal(next.total, 4);
  assert.equal(next.totalImages, 7);
  assert.throws(() => consumeUsage(limits, '67890', 1, options), /累计/);
});

test('关闭限制仍记录用量，重新开启立即按已有用量执行', t => {
  const options = fixture(t);
  const unlimited = { dailyUserLimit: 0, dailyTotalLimit: 0, totalLimit: 0 };
  for (let i = 0; i < 5; i++) consumeUsage(unlimited, '12345', 1, options);
  assert.throws(() => consumeUsage(limits, '12345', 1, options), /个人每日/);
  assert.throws(() => consumeUsage({ ...unlimited, totalLimit: 5 }, '67890', 1, options), /累计/);
});

test('损坏数据、锁冲突和日期回拨停止计数且保留原文件', t => {
  const options = fixture(t);
  consumeUsage(limits, '12345', 1, options);
  const before = fs.readFileSync(options.file, 'utf8');
  fs.mkdirSync(`${options.file}.lock`);
  assert.throws(() => consumeUsage(limits, '12345', 1, options), /锁/);
  assert.equal(fs.readFileSync(options.file, 'utf8'), before);
  fs.rmdirSync(`${options.file}.lock`);
  assert.throws(() => consumeUsage(limits, '12345', 1, { ...options, now: new Date('2026-10-02') }), /日期/);
  for (const value of ['{', 'null', JSON.stringify({ ...JSON.parse(before), total: -1 }), JSON.stringify({ ...JSON.parse(before), users: {} })]) {
    fs.writeFileSync(options.file, value);
    assert.throws(() => consumeUsage(limits, '12345', 1, options), /用量记录/);
    assert.equal(fs.readFileSync(options.file, 'utf8'), value);
    assert.equal(fs.existsSync(`${options.file}.lock`), false);
  }
});

test('独立进程并发抢占最后一个额度，重启后仍无法超额', async t => {
  const options = fixture(t);
  const url = new URL('../../../skills/ai-image/lib/usage.js', import.meta.url).href;
  const code = `import { consumeUsage } from ${JSON.stringify(url)};
    process.stdin.once('data', () => {
      try { consumeUsage({ dailyUserLimit: 0, dailyTotalLimit: 0, totalLimit: 1 }, '12345', 1,
        { file: process.argv[1], now: new Date('2026-10-03') }); process.exit(0); }
      catch { process.exit(2); }
    }); process.stdout.write('ready');`;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', code, options.file], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => children.forEach(child => child.kill()));
  const exits = children.map(child => new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  }));
  await Promise.all(children.map(child => new Promise(resolve => child.stdout.once('data', resolve))));
  children.forEach(child => child.stdin.end('go'));
  const codes = await Promise.all(exits);
  assert.equal(codes.filter(code => code === 0).length, 1);
  assert.ok(codes.every(code => code === 0 || code === 2));
  assert.equal(JSON.parse(fs.readFileSync(options.file, 'utf8')).total, 1);
  assert.throws(() => consumeUsage({ ...limits, totalLimit: 1 }, '67890', 1, options), /累计/);
});
