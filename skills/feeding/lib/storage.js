import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { fail, isObject, integer, text, gain, MAX_AMOUNT } from './config.js';

export const eventId = (scope, userId, messageId) => createHash('sha256').update(JSON.stringify([scope, userId, messageId])).digest('hex');
export function defaultDataDirectory(pluginUrl, env = process.env) {
  if (env.QQ_AGENT_DATA_DIR) return path.resolve(env.QQ_AGENT_DATA_DIR);
  const raw = (env.QQ_AGENT_PROFILE || '').trim();
  return fileURLToPath(new URL(`../../data${/^\d+$/.test(raw) ? `-${raw}` : ''}/`, pluginUrl));
}
function restore(data) {
  try {
    if (!isObject(data) || data.pluginId !== 'feeding' || data.version !== 1 || !Array.isArray(data.records)) throw new Error('格式不匹配');
    const ids = new Set();
    for (const r of data.records) {
      if (!isObject(r) || !/^(group|private):[1-9]\d{4,11}$/.test(r.scope) || !/^[1-9]\d{4,11}$/.test(r.userId)
        || !/^(?:-?\d+|local:[1-9]\d*)$/.test(r.messageId) || r.id !== eventId(r.scope, r.userId, r.messageId)
        || ids.has(r.id) || !['pending', 'paid', 'cancelled'].includes(r.status) || !['normal', 'ai'].includes(r.mode)
        || typeof r.rated !== 'boolean' || !Array.isArray(r.recoveries)) throw new Error('订单身份或状态无效');
      ids.add(r.id);
      integer(r.at, '时间', 0, 8640000000000000); integer(r.messageAt, '消息时间', 0, r.at + 60000);
      text(r.selection, '食物选择', 40); text(r.food.id, '食物编号', 40); text(r.food.name, '食物名称', 30);
      text(r.food.description, '食物描述', 250, true); text(r.food.reactionHint, '反应素材', 200, true);
      integer(r.food.price, '价格', 1, MAX_AMOUNT); gain(r.food.fixedGain); gain(r.aiMaxGain);
      integer(r.reactionLength, '反应长度', 20, 200); text(r.currencyName, '货币名称', 20);
      for (const request of r.recoveries) {
        if (!isObject(request) || !/^(?:-?\d+|local:[1-9]\d*)$/.test(request.messageId)) throw new Error('恢复记录无效');
        if (request.selection !== null) text(request.selection, '恢复选择', 40);
        const id = eventId(r.scope, r.userId, request.messageId);
        if (ids.has(id)) throw new Error('恢复消息重复');
        ids.add(id);
      }
    }
    return data.records;
  } catch (error) { fail('CORRUPT_DATA', `投喂数据校验失败：${error.message}。保留原文件，停止写入。`); }
}
export function createStorage({ directory, io = fs }) {
  let records = null, file, lockFile, lockToken;
  function close() {
    records = null;
    if (lockToken) { try { if (io.readFileSync(lockFile, 'utf8') === lockToken) io.unlinkSync(lockFile); } catch {} }
    lockToken = null;
  }
  function open() {
    if (records) return;
    const dir = typeof directory === 'function' ? directory() : directory;
    io.mkdirSync(dir, { recursive: true });
    file = path.join(io.realpathSync(dir), 'feeding.json'); lockFile = `${file}.lock`;
    const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    try {
      try { io.writeFileSync(lockFile, token, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') fail('STORAGE_LOCKED', '投喂数据被占用或有遗留 feeding.json.lock；确认没有实例使用后再移除锁。'); throw error; }
      lockToken = token;
      let data;
      try { data = JSON.parse(io.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') fail('CORRUPT_DATA', `无法读取投喂数据：${error.message}`); }
      records = data === undefined ? [] : restore(data);
    } catch (error) { close(); throw error; }
  }
  function assertWritable() {
    let token;
    try { token = io.readFileSync(lockFile, 'utf8'); } catch { /* 丢失锁时停止交易。 */ }
    if (!records || !lockToken || token !== lockToken) fail('STORAGE_LOCKED', '投喂数据锁已变化或不可读取，停止结算。');
  }
  function save(next) {
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      assertWritable();
      fd = io.openSync(temp, 'wx');
      io.writeFileSync(fd, JSON.stringify({ pluginId: 'feeding', version: 1, records: next }), 'utf8');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(temp, file);
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (error.code === 'STORAGE_LOCKED') throw error;
      fail('STORAGE_ERROR', '投喂记录保存失败；保留原订单，恢复时不会重复消费。');
    } finally { try { io.unlinkSync(temp); } catch {} }
    records = next;
  }
  return { open, close, save, assertWritable, get records() { return records; } };
}
