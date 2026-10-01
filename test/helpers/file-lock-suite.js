import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export function lockTests(createFileLock, label) {
  function fixture(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-lock-'));
    const runtime = new EventEmitter(); runtime.pid = 10001;
    runtime.kill = pid => { if (pid === runtime.pid) return; throw Object.assign(new Error('dead'), { code: 'ESRCH' }); };
    const file = path.join(dir, `${label}.json.lock`), io = Object.create(fs);
    const lock = createFileLock({ io, runtime, ...options });
    t.after(() => {
      delete io.unlinkSync; delete io.readFileSync;
      lock.release();
      runtime.emit('exit', 0);
      const absolute = fs.realpathSync(dir);
      assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(absolute).startsWith('extension-lock-'));
      fs.rmSync(absolute, { recursive: true, force: true });
    });
    return { dir, file, io, runtime, lock };
  }
  test(`${label}：兼容旧 PID 锁，自动回收已退出进程且不改业务数据`, t => {
    const f = fixture(t), data = path.join(f.dir, `${label}.json`);
    fs.writeFileSync(data, 'preserve-data');
    fs.writeFileSync(f.file, JSON.stringify({ pid: 12345, token: 'legacy' }));
    fs.writeFileSync(`${f.file}.owner-12345-11111111-1111-1111-1111-111111111111`, 'partial');
    f.lock.acquire(f.file); f.lock.assertOwned();
    assert.equal(JSON.parse(fs.readFileSync(f.file)).pid, f.runtime.pid);
    assert.equal(fs.readdirSync(f.dir).filter(n => n.includes('.lock')).length, 2);
    assert.equal(fs.readFileSync(data, 'utf8'), 'preserve-data');
    f.runtime.emit('exit', 0);
    assert.deepEqual(fs.readdirSync(f.dir), [`${label}.json`]);
  });
  test(`${label}：活进程及自身另一实例的锁不能被抢占`, t => {
    const f = fixture(t);
    f.lock.acquire(f.file);
    const original = fs.readFileSync(f.file, 'utf8');
    const other = createFileLock({ runtime: f.runtime });
    assert.throws(() => other.acquire(f.file), { code: 'STORAGE_LOCKED' }); other.release();
    assert.equal(fs.readFileSync(f.file, 'utf8'), original); f.lock.assertOwned();
    assert.equal(f.runtime.listenerCount('exit'), 1);
  });
  test(`${label}：PID 不明确、损坏锁及无权探测时保留锁`, t => {
    const f = fixture(t);
    for (const content of ['broken', '{}', JSON.stringify({ pid: 0, token: 'old' }), JSON.stringify({ pid: '123', token: 'old' }), JSON.stringify({ pid: f.runtime.pid, token: 'old' })]) {
      fs.writeFileSync(f.file, content);
      assert.throws(() => f.lock.acquire(f.file), { code: 'STORAGE_LOCKED' });
      assert.equal(fs.readFileSync(f.file, 'utf8'), content);
      assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)]);
    }
    for (const code of ['EPERM', 'EACCES', 'EINVAL']) {
      const content = JSON.stringify({ pid: 12345, token: 'old' }); fs.writeFileSync(f.file, content);
      f.runtime.kill = () => { throw Object.assign(new Error('unknown'), { code }); };
      assert.throws(() => f.lock.acquire(f.file), { code: 'STORAGE_LOCKED' });
      assert.equal(fs.readFileSync(f.file, 'utf8'), content);
    }
  });
  test(`${label}：已声明的启动进程阻止其他进程清理旧主锁`, t => {
    const f = fixture(t), original = JSON.stringify({ pid: 12345, token: 'old' });
    const otherClaim = `${f.file}.owner-${f.runtime.pid}-11111111-1111-1111-1111-111111111111`;
    fs.writeFileSync(f.file, original); fs.writeFileSync(otherClaim, 'starting');
    assert.throws(() => f.lock.acquire(f.file), { code: 'STORAGE_LOCKED' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(fs.readFileSync(otherClaim, 'utf8'), 'starting');
  });
  test(`${label}：Windows 并发回收声明，消失后可继续，未消失则安全退让`, t => {
    const f = fixture(t);
    const stale = `${f.file}.owner-12345-11111111-1111-1111-1111-111111111111`;
    fs.writeFileSync(stale, 'stale');
    f.io.unlinkSync = file => {
      if (file !== stale) return fs.unlinkSync(file);
      throw Object.assign(new Error('delete pending'), { code: 'EPERM' });
    };
    assert.throws(() => f.lock.acquire(f.file), { code: 'STORAGE_LOCKED' });
    assert.deepEqual(fs.readdirSync(f.dir), [path.basename(stale)]);
    f.io.unlinkSync = file => {
      fs.unlinkSync(file);
      if (file === stale) throw Object.assign(new Error('already gone'), { code: 'EPERM' });
    };
    f.lock.acquire(f.file); f.lock.assertOwned();
  });
  test(`${label}：启动写入失败清理声明，修复后可立即重试`, t => {
    const f = fixture(t);
    f.io.writeFileSync = (fd, content, encoding) => {
      fs.writeFileSync(fd, content.slice(0, 5), encoding);
      throw Object.assign(new Error('disk error'), { code: 'EIO' });
    };
    assert.throws(() => f.lock.acquire(f.file), { code: 'EIO' });
    assert.deepEqual(fs.readdirSync(f.dir), []);
    delete f.io.writeFileSync;
    f.lock.acquire(f.file); f.lock.assertOwned();
  });
  test(`${label}：目录不支持硬链接时解释原因并清理声明`, t => {
    const f = fixture(t);
    f.io.linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    assert.throws(() => f.lock.acquire(f.file), error => error.code === 'ENOTSUP' && /硬链接/.test(error.message));
    assert.deepEqual(fs.readdirSync(f.dir), []);
  });
  for (const target of ['main', 'claim']) {
    test(`${label}：${target} 删除暂时失败后，同一实例可重新启用`, t => {
      const f = fixture(t);
      f.lock.acquire(f.file);
      let failOnce = true;
      f.io.unlinkSync = file => {
        if (failOnce && (target === 'main' ? file === f.file : file.includes('.owner-'))) {
          failOnce = false;
          throw Object.assign(new Error('temporary sharing violation'), { code: 'EPERM' });
        }
        fs.unlinkSync(file);
      };
      f.lock.release();
      assert.equal(fs.readdirSync(f.dir).length, 1);
      assert.throws(() => f.lock.assertOwned(), { code: 'STORAGE_LOCKED' });
      assert.equal(f.runtime.listenerCount('exit'), 1);
      f.lock.acquire(f.file); f.lock.assertOwned();
      assert.equal(fs.readdirSync(f.dir).length, 2);
      assert.equal(f.runtime.listenerCount('exit'), 1);
      f.lock.release();
      assert.deepEqual(fs.readdirSync(f.dir), []);
      assert.equal(f.runtime.listenerCount('exit'), 0);
    });
  }
  test(`${label}：重载的新实例可重试旧实例的清理，但不能抢占活实例`, t => {
    const f = fixture(t), other = createFileLock({ io: f.io, runtime: f.runtime });
    t.after(() => other.release());
    f.lock.acquire(f.file);
    f.io.unlinkSync = file => {
      if (file.includes('.owner-')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      fs.unlinkSync(file);
    };
    f.lock.release();
    assert.throws(() => other.acquire(f.file), { code: 'STORAGE_LOCKED' });
    assert.equal(fs.readdirSync(f.dir).length, 1);
    delete f.io.unlinkSync;
    other.acquire(f.file); other.assertOwned();
    assert.throws(() => f.lock.acquire(f.file), { code: 'STORAGE_LOCKED' });
    f.lock.release(); other.assertOwned();
    other.release();
    assert.deepEqual(fs.readdirSync(f.dir), []);
    assert.equal(f.runtime.listenerCount('exit'), 0);
  });
  test(`${label}：重复释放重试失败清理；退出清理不保存已停用实例的数据`, t => {
    let flushes = 0;
    const f = fixture(t, { beforeExit: () => { flushes++; } });
    for (const exit of [false, true]) {
      f.lock.acquire(f.file);
      f.io.unlinkSync = () => { throw Object.assign(new Error('busy'), { code: 'EACCES' }); };
      f.lock.release();
      assert.equal(fs.readdirSync(f.dir).length, 2);
      assert.equal(f.runtime.listenerCount('exit'), 1);
      delete f.io.unlinkSync;
      if (exit) f.runtime.emit('exit', 0); else f.lock.release();
      assert.deepEqual(fs.readdirSync(f.dir), []);
      assert.equal(f.runtime.listenerCount('exit'), 0);
      assert.equal(flushes, 0);
    }
  });
  test(`${label}：失败清理重试前主锁被替换，不能删除新持有者的锁`, t => {
    const f = fixture(t);
    f.lock.acquire(f.file);
    f.io.unlinkSync = () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
    f.lock.release();
    fs.unlinkSync(f.file);
    const replacement = JSON.stringify({ pid: f.runtime.pid, token: 'another-owner' });
    fs.writeFileSync(f.file, replacement);
    delete f.io.unlinkSync;
    f.lock.release();
    assert.equal(fs.readFileSync(f.file, 'utf8'), replacement);
    assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)]);
    assert.equal(f.runtime.listenerCount('exit'), 0);
  });
  test(`${label}：主锁暂时不可读时保留待清理记录，恢复后可再次启用`, t => {
    const f = fixture(t);
    f.lock.acquire(f.file);
    f.io.readFileSync = file => {
      if (file === f.file) throw Object.assign(new Error('cannot read owner'), { code: 'EACCES' });
      return fs.readFileSync(file, 'utf8');
    };
    f.lock.release();
    assert.ok(fs.existsSync(f.file));
    assert.throws(() => f.lock.acquire(f.file), { code: 'STORAGE_LOCKED' });
    delete f.io.readFileSync;
    f.lock.acquire(f.file); f.lock.assertOwned();
    f.lock.release();
    assert.deepEqual(fs.readdirSync(f.dir), []);
    assert.equal(f.runtime.listenerCount('exit'), 0);
  });
  test(`${label}：声明写入与随后的清理均失败，恢复后重试不遗留部分文件`, t => {
    const f = fixture(t);
    f.io.writeFileSync = (fd, content) => {
      fs.writeFileSync(fd, content.slice(0, 5));
      throw Object.assign(new Error('write failed'), { code: 'EIO' });
    };
    f.io.unlinkSync = () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
    assert.throws(() => f.lock.acquire(f.file), { code: 'EIO' });
    assert.equal(fs.readdirSync(f.dir).length, 1);
    delete f.io.writeFileSync; delete f.io.unlinkSync;
    f.lock.acquire(f.file); f.lock.assertOwned();
    assert.equal(fs.readdirSync(f.dir).length, 2);
    f.lock.release();
    assert.deepEqual(fs.readdirSync(f.dir), []);
  });
  test(`${label}：停用和重载清监听，退出保存失败仍释放锁，不接管信号`, t => {
    let flushes = 0;
    const f = fixture(t, { beforeExit: () => { flushes++; throw new Error('flush failed'); } });
    for (let i = 0; i < 15; i++) {
      f.lock.acquire(f.file); assert.equal(f.runtime.listenerCount('exit'), 1);
      f.lock.release(); assert.equal(f.runtime.listenerCount('exit'), 0);
    }
    f.lock.acquire(f.file);
    assert.equal(f.runtime.listenerCount('SIGINT'), 0); assert.equal(f.runtime.listenerCount('SIGTERM'), 0);
    f.runtime.emit('exit', 0);
    assert.equal(flushes, 1); assert.equal(f.runtime.listenerCount('exit'), 0);
    assert.deepEqual(fs.readdirSync(f.dir), []);
  });
  test(`${label}：锁内容或声明被改变后停止写入，退出不删除他人主锁`, t => {
    const f = fixture(t);
    f.lock.acquire(f.file);
    fs.writeFileSync(f.file, 'replacement');
    assert.throws(() => f.lock.assertOwned(), { code: 'STORAGE_LOCKED' });
    f.lock.release(); assert.equal(fs.readFileSync(f.file, 'utf8'), 'replacement');
    fs.unlinkSync(f.file); f.lock.acquire(f.file);
    const name = fs.readdirSync(f.dir).find(n => n.includes('.owner-'));
    fs.unlinkSync(path.join(f.dir, name));
    assert.throws(() => f.lock.assertOwned(), { code: 'STORAGE_LOCKED' });
    f.lock.release(); assert.deepEqual(fs.readdirSync(f.dir), []);
  });
}
