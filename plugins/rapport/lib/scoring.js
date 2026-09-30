// 消息去重、每日额度、冷却与累计计分。
import { createHash } from 'node:crypto';
import { cents, points, SCORE_MAX } from './points.js';

export function createScoring(services) {
  const {
    storage, lifecycle, assertRunning, ensureLoaded, currentSettings, chatKeyOf, normalizeEntry,
    unwrapList, getChat, DAY, warn, markDirty, flush, newRecord, applyDecay, isOwner, pinOwner,
    dayString, clamp, levelOf, ownerList, ownerPoints, isProtectedOwner
  } = services;

  const SEEN_KEEP = 4096; // 每个会话最多记住多少条"已处理"消息，防重复计分

  async function accumulate(payload = {}) {
    const epoch = lifecycle.epoch;
    assertRunning(epoch);
    ensureLoaded();
    let s = currentSettings();
    syncMode(s);
    const chatKey = chatKeyOf(payload);
    if (!chatKey) return { chatKey: '', counted: 0 };

    let selfId = String(payload.selfId || storage.db.meta?.selfId || '');

    const raws = [];

    // 1) 聊天记录（store 里存着全部入群消息，包括没触发机器人的那些）
    const store = payload.store;
    if (store && typeof store.recent === 'function') {
      const limit = 200; // 本地补扫窗口是内部实现参数，不要求用户配置
      try {
        const got = await store.recent(chatKey, { limit });
        raws.push(...unwrapList(got));
      } catch (error) {
        warn(`读取聊天记录失败（不影响本次对话）：${error?.message ?? error}`);
      }
    }

    assertRunning(epoch);
    s = currentSettings();
    syncMode(s);
    syncOwners();
    const chat = getChat(chatKey);
    // 2) 本轮触发消息（可能 store 还没落盘）
    raws.push(...unwrapList(payload.triggerEntries));

    const seen = new Set(Array.isArray(chat.seen) ? chat.seen : []);
    const ents = [];
    for (const raw of raws) {
      const ent = normalizeEntry(raw, selfId);
      if (!ent) continue;
      // 顺手学习"机器人自己的 QQ 号"，用于识别谁 @ 了机器人
      if (ent.isSelf && /^[1-9]\d{4,11}$/.test(ent.userId) && !/^[1-9]\d{4,11}$/.test(selfId)) {
        selfId = ent.userId;
        storage.db.meta.selfId = ent.userId;
      }
      ents.push(ent);
    }

    ents.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    const now = Date.now();
    let counted = 0;

    for (const ent of ents) {
      const key = ent.mid ? `m:${ent.mid}` : ent.localId ? `l:${ent.localId}`
        : `k:${ent.userId}:${ent.ts}:${createHash('sha256').update(ent.text).digest('hex').slice(0, 24)}`;
      const already = seen.has(key);
      if (!already) seen.add(key);

      if (ent.isSelf) {
        continue;
      }
      if (!/^[1-9]\d{4,11}$/.test(ent.userId) || already) {
        continue;
      }
      // 首次安装时不要把整个群历史灌进来：只记最近 24 小时内的消息
      if (!ent.ts || now - ent.ts > DAY || ent.ts > now + 60000 ||
          ent.ts <= (chat.resetAt || 0) || ent.ts <= (chat.resetUsers?.[ent.userId] || 0)) {
        continue;
      }

      const atBot = ent.atMe === true || (ent.atMe !== false && selfId && ent.ats.includes(String(selfId)));
      if (s.aiMode && (ent.mid || ent.localId)) {
        chat.aiEligible ||= [];
        chat.aiEligible.push({ key: `${ent.userId}:${ent.mid || `local:${ent.localId}`}`, at: ent.ts });
        chat.aiEligible = chat.aiEligible.filter(item => dayString(item.at) === dayString(now)).slice(-4096);
      }
      touchMember(chat, ent, ent.ts || now, s, { atBot });
      counted += 1;
    }

    chat.seen = [...seen].slice(-SEEN_KEEP);
    chat.lastScanAt = now;
    syncOwners();

    if (counted > 0 || storage.db.meta?.selfId) {
      markDirty();
    }
    flush();
    return { chatKey, counted };
  }

  function touchMember(chat, ent, now, s, { atBot = false } = {}) {
    const rec = chat.members[ent.userId] || (chat.members[ent.userId] = newRecord(now));
    if (!rec.firstSeen) rec.firstSeen = now;
    if (ent.name) rec.name = ent.name;
    rec.msgs = (Number(rec.msgs) || 0) + 1;
    applyDecay(rec, now, s); // 必须在更新 lastSeen 之前计算完整闲置期
    rec.lastSeen = Math.max(Number(rec.lastSeen) || 0, now);

    // 主人：分数恒定满级，不加分、不衰减、不播报
    if (isProtectedOwner(ent.userId, s)) {
      pinOwner(rec, s);
      return 0;
    }

    const dayKey = dayString(now);
    if (rec.dayKey && dayKey < rec.dayKey) return 0; // 晚到历史消息不能回滚当天额度
    if (rec.dayKey !== dayKey) {
      rec.dayKey = dayKey;
      rec.dayGain = 0;
      rec.dayLoss = 0;
      rec.aiRated = [];
    }

    // AI 模式只记录互动；切回普通模式不补算切换前的发言。
    if (s.aiMode || now < (storage.db.meta.scoringMode?.since || 0)) {
      rec.level = levelOf(rec.score, s).level;
      return 0;
    }

    let gain = cents(s.perMessage);
    if (atBot) gain += cents(s.atBotBonus);

    const room = Math.max(0, cents(s.dailyCap) - cents(rec.dayGain || 0));
    const cooldown = clamp(s.gainCooldownSeconds, 0, 3600) * 1000;
    const duplicateWindow = clamp(s.duplicateWindowMinutes, 0, 1440) * 60000;
    const textKey = createHash('sha256').update(ent.text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()).digest('hex').slice(0, 24);
    rec.recentContent = (Array.isArray(rec.recentContent) ? rec.recentContent : []).filter((v) => now - v.at < duplicateWindow);
    const duplicate = duplicateWindow > 0 && rec.recentContent.some((v) => v.key === textKey);
    const cooling = Boolean(rec.lastGainAt) && now - rec.lastGainAt < cooldown;
    const hasContent = Boolean(ent.text || ent.hasMedia) && !ent.isPoke;
    const applied = cooling || duplicate || !hasContent ? 0 : Math.min(gain, room, Math.max(0, cents(SCORE_MAX) - cents(rec.score)));
    if (applied > 0) {
      rec.lastGainAt = now;
      rec.recentContent.push({ key: textKey, at: now });
      rec.recentContent = rec.recentContent.slice(-200);
    }

    rec.score = points(cents(rec.score) + applied);
    rec.dayGain = points(cents(rec.dayGain || 0) + applied);

    rec.level = levelOf(rec.score, s).level;
    return points(applied);
  }

  function syncOwners() {
    if (!storage.db) return;
    const s = currentSettings();
    const owners = ownerList(s);
    const max = ownerPoints(s);
    const maxLevel = levelOf(max, s).level;
    for (const chat of Object.values(storage.db.chats || {})) {
      for (const [uid, rec] of Object.entries(chat?.members || {})) {
        if (isProtectedOwner(uid, s)) {
          rec.pinned = true;
          rec.score = max;
          rec.level = maxLevel;

        } else if (rec.pinned === true) {
          rec.pinned = false; // 被移出主人名单，分数保持当前值，恢复普通规则
        }
      }
    }
  }

  function syncMode(s = currentSettings(), now = Date.now()) {
    if (!storage.db) return;
    const previous = storage.db.meta.scoringMode;
    const next = { aiMode: s.aiMode, decayEnabled: s.decayEnabled, decayAfterDays: s.decayAfterDays, decayPerDay: s.decayPerDay };
    const changed = previous && Object.keys(next).some(key => next[key] !== previous[key]);
    const decayChanged = previous && ['decayEnabled', 'decayAfterDays', 'decayPerDay'].some(key => next[key] !== previous[key]);
    if (decayChanged) {
      for (const chat of Object.values(storage.db.chats)) for (const rec of Object.values(chat.members)) {
        applyDecay(rec, now, { ...s, ...previous });
        rec.decayAnchor = Math.max(now, rec.decayAnchor || 0);
      }
    }
    if (!previous || changed) {
      storage.db.meta.scoringMode = { ...next, since: !previous ? (s.aiMode ? now : 0) : previous.aiMode !== s.aiMode ? now : previous.since };
      markDirty();
    }
  }

  return { accumulate, syncOwners, syncMode };
}
