// 每个插件实例独立持有数据；停用时可同步完成原子保存。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function createStorage(services) {
  const { pluginUrl, dayString, isObject, warn } = services;

  let db = null;
  let dbFile = '';
  let loaded = false;
  let dataError = '';
  let writeError = '';
  let dirty = false;
  const instanceId = randomUUID();

  function dataFilePath() {
    if (dbFile) return dbFile;
    const dir = process.env.QQ_AGENT_DATA_DIR || fileURLToPath(new URL('../../data/', pluginUrl));
    dbFile = path.join(dir, 'rapport.json');
    return dbFile;
  }

  function validateDatabase(parsed) {
    const bad = () => { throw new Error('好感度养成数据格式不匹配或已损坏（仅接受 rapport 的 version=1 数据）'); };
    if (!isObject(parsed) || parsed.pluginId !== 'rapport' || parsed.version !== 1 || !isObject(parsed.chats)) bad();
    if (parsed.meta !== undefined && !isObject(parsed.meta)) bad();
    if (parsed.meta?.overrides !== undefined && !isObject(parsed.meta.overrides)) bad();
    for (const [key, chat] of Object.entries(parsed.chats)) {
      if (!/^(group|private):[1-9]\d{4,11}$/.test(key) || !isObject(chat) || !isObject(chat.members)) bad();
      if (chat.seen !== undefined && (!Array.isArray(chat.seen) || chat.seen.some(x => typeof x !== 'string'))) bad();
      if (chat.resetUsers !== undefined && !isObject(chat.resetUsers)) bad();
      for (const [uid, rec] of Object.entries(chat.members)) {
        if (!/^[1-9]\d{4,11}$/.test(uid) || !isObject(rec) || !Number.isFinite(rec.score) || rec.score < 0) bad();
        if (rec.name !== undefined && typeof rec.name !== 'string') bad();
        if (rec.dayKey !== undefined && rec.dayKey !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(rec.dayKey)) bad();
        if (rec.pinned !== undefined && typeof rec.pinned !== 'boolean') bad();
        for (const field of ['score','msgs','firstSeen','lastSeen','dayGain','lastGainAt','decayAnchor','decayed']) {
          if (rec[field] !== undefined && (typeof rec[field] !== 'number' || !Number.isFinite(rec[field]) || rec[field] < 0)) bad();
        }
        if (rec.recentContent !== undefined && (!Array.isArray(rec.recentContent) || rec.recentContent.some(x => !isObject(x) || typeof x.key !== 'string' || !Number.isFinite(x.at)))) bad();
      }
    }
  }

  function ensureLoaded() {
    if (loaded && db) return db;
    let parsed = { pluginId: 'rapport', version: 1, meta: {}, chats: {} };
    try {
      parsed = JSON.parse(fs.readFileSync(dataFilePath(), 'utf8').replace(/^\uFEFF/, ''));
      validateDatabase(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        dataError = `读取好感度数据失败，已停止写入以保护原文件：${error.message}`;
        throw new Error(dataError);
      }
    }
    db = parsed;
    db.meta ||= {};
    db.meta.overrides ||= {};
    loaded = true;
    return db;
  }

  function getChat(chatKey) {
    const c = db.chats[chatKey] || (db.chats[chatKey] = { members: {}, seen: [], lastScanAt: 0 });
    if (!c.members || typeof c.members !== 'object') c.members = {};
    if (!Array.isArray(c.seen)) c.seen = [];
    return c;
  }

  function newRecord(now) {
    return {
      name: '',
      score: 0,
      level: 1,
      msgs: 0,
      firstSeen: now,
      lastSeen: now,
      dayKey: dayString(now),
      dayGain: 0,
      pinned: false
    };
  }

  function markDirty() {
    dirty = true;
  }

  function flush() {
    if (!dirty || !db || dataError) return;
    const file = dataFilePath();
    const tmp = `${file}.${process.pid}.${instanceId}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
      writeError = '';
    } catch (error) {
      writeError = `写入好感度数据失败，原文件保留：${error.message}`;
      warn(writeError);
      throw error;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function available() {
    const reason = dataError || writeError;
    return reason ? { ok: false, reason } : true;
  }

  function reset() {
    db = null;
    loaded = false;
    dataError = '';
    writeError = '';
    dirty = false;
  }

  return { get db() { return db; }, ensureLoaded, getChat, newRecord, markDirty, flush, available, reset };
}
