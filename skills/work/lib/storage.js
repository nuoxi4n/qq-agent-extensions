import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { fail, isObject, integer, text, MAX_AMOUNT } from './config.js';

export const eventId = (scope, userId, messageId) => createHash('sha256').update(JSON.stringify([scope, userId, messageId])).digest('hex');
export function defaultDataDirectory(pluginUrl, env = process.env) {
  if (env.QQ_AGENT_DATA_DIR) return path.resolve(env.QQ_AGENT_DATA_DIR);
  const raw = (env.QQ_AGENT_PROFILE || '').trim();
  return fileURLToPath(new URL(`../../data${/^\d+$/.test(raw) ? `-${raw}` : ''}/`, pluginUrl));
}

function restore(data) {
  try {
    if (!isObject(data) || data.pluginId !== 'work' || data.version !== 1 || !Array.isArray(data.records)) throw new Error('格式不匹配');
    const ids = new Set(), pending = new Set();
    const validMessageId = value => typeof value === 'string' && /^(?:-?\d+|local:[1-9]\d*)$/.test(value);
    let previousAt = 0;
    for (const record of data.records) {
      if (!isObject(record) || typeof record.scope !== 'string' || !/^(group|private):[1-9]\d{4,11}$/.test(record.scope)
        || typeof record.userId !== 'string' || !/^[1-9]\d{4,11}$/.test(record.userId) || !validMessageId(record.messageId)
        || record.id !== eventId(record.scope, record.userId, record.messageId) || ids.has(record.id)) throw new Error('记录身份或编号无效');
      ids.add(record.id);
      integer(record.at, '记录时间', previousAt, 8640000000000000); previousAt = record.at;
      if (record.selection !== null) text(record.selection, '原始职业选择', 40);
      if (!Array.isArray(record.recoveries)) throw new Error('缺少恢复请求记录');
      for (const request of record.recoveries) {
        if (!isObject(request) || !validMessageId(request.messageId)) throw new Error('恢复请求编号无效');
        if (request.selection !== null) text(request.selection, '恢复职业选择', 40);
        const alias = eventId(record.scope, record.userId, request.messageId);
        if (ids.has(alias)) throw new Error('请求消息重复关联');
        ids.add(alias);
      }
      if (!isObject(record.job) || !isObject(record.event)) throw new Error('职业或事件快照缺失');
      text(record.job.id, '职业编号', 40); text(record.job.name, '职业名称', 30); text(record.job.description, '职业背景', 400);
      integer(record.job.minReward, '最低收入', 1, MAX_AMOUNT);
      integer(record.job.maxReward, '最高收入', record.job.minReward, MAX_AMOUNT);
      text(record.event.id, '事件编号', 40); text(record.event.name, '事件名称', 30); text(record.event.prompt, '事件提示', 500);
      integer(record.event.minReward, '事件最低收入', record.job.minReward, record.job.maxReward);
      integer(record.event.maxReward, '事件最高收入', record.event.minReward, record.job.maxReward);
      integer(record.amount, '收入', record.event.minReward, record.event.maxReward);
      text(record.style, '风格', 400, true); integer(record.storyLength, '故事长度', 40, 300);
      text(record.currencyName, '货币名称', 20);
      if (record.reason !== `趣味打工：${record.job.name} · ${record.event.name}`) throw new Error('交易原因不匹配');
      if (!['pending', 'paid'].includes(record.status) || (record.status === 'paid' ? !/^[a-f0-9]{64}$/.test(record.receiptId) : record.receiptId !== null)) throw new Error('结算状态无效');
      const owner = `${record.scope}/${record.userId}`;
      if (pending.has(owner)) throw new Error('待结算记录后出现新打工');
      if (record.status === 'pending') pending.add(owner);
    }
    return data.records;
  } catch (error) { fail('CORRUPT_DATA', `打工数据校验失败：${error.message}。保留原文件，停止写入。`); }
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
    file = path.join(io.realpathSync(dir), 'work.json'); lockFile = `${file}.lock`;
    const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    try {
      try { io.writeFileSync(lockFile, token, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') fail('STORAGE_LOCKED', '打工数据被占用或存在遗留 work.json.lock；确认没有实例使用后再移除锁。'); throw error; }
      lockToken = token;
      let data;
      try { data = JSON.parse(io.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') fail('CORRUPT_DATA', `无法读取打工数据：${error.message}`); }
      records = data === undefined ? [] : restore(data);
    } catch (error) { close(); throw error; }
  }
  function save(next) {
    if (!records) fail('UNAVAILABLE', '打工存储尚未启用。');
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      assertWritable();
      fd = io.openSync(temp, 'wx');
      io.writeFileSync(fd, JSON.stringify({ pluginId: 'work', version: 1, records: next }), 'utf8');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(temp, file);
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (error.code === 'STORAGE_LOCKED') throw error;
      fail('STORAGE_ERROR', '打工记录保存失败；已保存的抽取结果会保留，恢复后继续原单。');
    } finally { try { io.unlinkSync(temp); } catch {} }
    records = next;
  }
  function assertWritable() {
    let token;
    try { token = io.readFileSync(lockFile, 'utf8'); } catch { /* 锁丢失或不可读都不能继续结算。 */ }
    if (!records || !lockToken || token !== lockToken) fail('STORAGE_LOCKED', '打工数据锁已变化或不可读取，停止写入和发奖。');
  }
  return { open, close, save, assertWritable, get records() { return records; } };
}
