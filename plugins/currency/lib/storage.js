import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { emptyState, restore, prepare, commit } from './ledger.js';
import { fail } from './validation.js';

export function defaultDataDirectory(pluginUrl, env = process.env) {
  if (env.QQ_AGENT_DATA_DIR) return path.resolve(env.QQ_AGENT_DATA_DIR);
  const rawProfile = (env.QQ_AGENT_PROFILE || '').trim();
  const profile = /^\d+$/.test(rawProfile) ? rawProfile : '';
  return fileURLToPath(new URL(`../../data${profile ? `-${profile}` : ''}/`, pluginUrl));
}

export function createStorage({ directory, io = fs, now = Date.now }) {
  let state = null, file, lockFile, lockToken;
  let reason = '';

  function open() {
    if (state) return;
    const dir = typeof directory === 'function' ? directory() : directory;
    io.mkdirSync(dir, { recursive: true });
    file = path.join(io.realpathSync(dir), 'currency.json');
    lockFile = `${file}.lock`;
    const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    try {
      // 不猜测旧锁是否失效；进程异常退出后由维护者核实并移除，防止双进程同时恢复。
      try { io.writeFileSync(lockFile, token, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if (error.code === 'EEXIST') fail('STORAGE_LOCKED', '货币数据正被占用或遗留了锁；确认没有实例使用后移除 currency.json.lock 再启用。');
        throw error;
      }
      lockToken = token;
      let parsed;
      try { parsed = JSON.parse(io.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') fail('CORRUPT_DATA', `无法读取货币数据：${error.message}`); }
      state = parsed === undefined ? emptyState() : restore(parsed);
      reason = '';
    } catch (error) {
      reason = error.message;
      close();
      throw error;
    }
  }

  function transact(input) {
    if (!state) fail('UNAVAILABLE', '货币存储尚未启用。');
    const result = prepare(state, input, now());
    if (result.replayed) return { ...structuredClone(result.receipt), replayed: true };
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      if (io.readFileSync(lockFile, 'utf8') !== lockToken) fail('STORAGE_LOCKED', '货币数据写锁已改变，停止写入。');
      const document = { pluginId: 'currency', version: 1, transactions: [...state.receipts, result.receipt] };
      fd = io.openSync(temp, 'wx');
      io.writeFileSync(fd, JSON.stringify(document), 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      io.renameSync(temp, file);
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      reason = '货币数据保存失败，未提交本次交易。';
      if (error.code === 'STORAGE_LOCKED') throw error;
      fail('STORAGE_ERROR', reason);
    } finally { try { io.unlinkSync(temp); } catch {} }
    // 文件替换成功后才改变可见余额；失败无需回滚，也不会在停用时补交。
    commit(state, result);
    reason = '';
    return { ...structuredClone(result.receipt), replayed: false };
  }

  function close() {
    state = null;
    if (lockToken) {
      try { if (io.readFileSync(lockFile, 'utf8') === lockToken) io.unlinkSync(lockFile); } catch {}
    }
    lockToken = null;
  }

  return { open, close, transact, get state() { return state; }, get reason() { return reason; } };
}
