import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cents, points, validPoints } from './points.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageOK = value => typeof value === 'string' && /^(?:-?\d+|local:[1-9]\d*)$/.test(value);
const deltaOK = value => validPoints(value) && Math.abs(value) <= 10;
export const EVENT_PERMISSIONS = ['recordEvent', 'rateEvent', 'bindMessage', 'decrease'];
export const eventKey = (consumer, scope, eventId) => createHash('sha256').update(JSON.stringify([consumer, scope, eventId])).digest('hex');
function consumerId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || value === 'rapport') fail('INVALID_ARGUMENT', 'consumer 必须是外部扩展 ID。');
  return value;
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail('INVALID_ARGUMENT', `${label}须为 1~${max} 字文本。`);
  return value;
}
function fields(args, allowed) {
  if (!object(args) || Object.keys(args).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT', '参数格式无效或包含未知字段。');
}
function actor(args) {
  if (!object(args) || typeof args.scope !== 'string' || typeof args.userId !== 'string'
    || !/^(group|private):[1-9]\d{4,11}$/.test(args.scope) || !/^[1-9]\d{4,11}$/.test(args.userId)
    || (args.scope.startsWith('private:') && args.scope !== `private:${args.userId}`)) fail('INVALID_ARGUMENT', '会话或成员无效。');
}
const eventFields = ['scope', 'userId', 'eventId', 'at', 'occurredAt', 'messageId', 'mode', 'fixedDelta', 'maxGain', 'maxLoss', 'reason'];
export function normalizeEvent(consumer, args) {
  fields(args, eventFields); actor(args); consumerId(consumer);
  const input = { consumer, scope: args.scope, userId: args.userId, eventId: text(args.eventId, '事件 ID', 160),
    at: args.at, occurredAt: args.occurredAt ?? args.at, messageId: args.messageId ?? null, mode: args.mode,
    fixedDelta: args.fixedDelta ?? 0, maxGain: args.maxGain ?? 10, maxLoss: args.maxLoss ?? 0,
    reason: text(args.reason, '事件说明', 200) };
  if (!Number.isSafeInteger(input.at) || input.at < 0 || input.at > 8640000000000000
    || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0 || input.occurredAt > input.at + 60000
    || (input.messageId !== null && !messageOK(input.messageId)) || !['normal', 'ai'].includes(input.mode)
    || ![input.fixedDelta, input.maxGain, input.maxLoss].every(deltaOK) || input.maxGain < 0 || input.maxLoss < 0) fail('INVALID_ARGUMENT', '事件时间、模式或分值无效；变化精度为 0.01，单次最多 10 分。');
  return input;
}
export function validateEvents(events) {
  if (events === undefined) return;
  if (!object(events)) throw new Error('好感度事件回执格式错误');
  for (const [key, event] of Object.entries(events)) {
    const { consumer, ...args } = event?.input || {};
    const input = normalizeEvent(consumer, args);
    if (!isDeepStrictEqual(input, event.input) || key !== eventKey(consumer, input.scope, input.eventId) || event.id !== key
      || !['pending', 'rated', 'rejected'].includes(event.status) || (input.mode === 'normal' && event.status === 'pending')
      || !Array.isArray(event.messages) || event.messages.some(id => !messageOK(id))
      || new Set(event.messages).size !== event.messages.length || (input.messageId !== null && !event.messages.includes(input.messageId))) throw new Error('好感度事件回执损坏');
    if (event.status === 'rated' && (!deltaOK(event.applied) || !deltaOK(event.requested)
      || !validPoints(event.score) || Math.abs(event.score) > 100 || !Number.isSafeInteger(event.ratedAt)
      || event.ratedAt < 0 || typeof event.reason !== 'string' || event.reason.length > 200)) throw new Error('好感度评分回执损坏');
  }
}
export function integrationPermissions(raw) {
  let permissions;
  try { permissions = JSON.parse(raw ?? '{}'); } catch { fail('INVALID_CONFIG', '好感度扩展接入权限须为合法 JSON。'); }
  if (!object(permissions)) fail('INVALID_CONFIG', '好感度扩展接入权限须为对象。');
  for (const [id, list] of Object.entries(permissions)) {
    try { consumerId(id); } catch { fail('INVALID_CONFIG', `扩展 ID ${id} 无效。`); }
    if (!Array.isArray(list) || list.some(p => !EVENT_PERMISSIONS.includes(p))) fail('INVALID_CONFIG', `扩展 ${id} 的好感度权限无效。`);
  }
  return permissions;
}

// 通用事件服务不认识任何具体玩法；消费方负责业务授权、交付及调用模型。
export function createEvents(services) {
  const { storage, lifecycle, assertRunning, currentSettings, syncMode, getChat, newRecord,
    applyDecay, isProtectedOwner, levelOf, dayString, readIntegrationPermissions } = services;
  const events = () => storage.db.integrationEvents || {};
  const permissions = () => integrationPermissions(readIntegrationPermissions());
  const allowed = consumer => { const map = permissions(); return Object.hasOwn(map, consumer) ? map[consumer] : []; };
  function claimed(scope, userId, messageId, exceptId) {
    return Object.values(events()).some(e => e.id !== exceptId && e.input.scope === scope && e.input.userId === userId
      && e.status !== 'rejected' && e.messages.includes(messageId));
  }
  function member(target, s, now) {
    const chat = getChat(target.scope), rec = chat.members[target.userId] ||= newRecord(now), day = dayString(now);
    if (rec.dayKey && rec.dayKey > day) fail('CLOCK_ROLLBACK', '系统日期早于好感度记账日期。');
    if (rec.dayKey !== day) { rec.dayKey = day; rec.dayGain = 0; rec.dayLoss = 0; rec.aiRated = []; }
    rec.pinned = isProtectedOwner(target.userId, s);
    applyDecay(rec, now, s);
    if (rec.pinned) rec.score = 100;
    rec.level = levelOf(rec.score, s).level;
    return { chat, rec };
  }
  function view(target, s, now) {
    const { rec } = member(target, s, now), protectedOwner = isProtectedOwner(target.userId, s);
    return { mode: s.aiMode ? 'ai' : 'normal', score: rec.score, level: rec.level, protectedOwner,
      remainingGain: protectedOwner ? 0 : points(Math.max(0, Math.min(cents(s.dailyCap) - cents(rec.dayGain || 0), 10000 - cents(rec.score)))),
      remainingLoss: protectedOwner ? 0 : points(Math.max(0, Math.min(cents(s.aiDailyLossCap) - cents(rec.dayLoss || 0), cents(rec.score) - cents(s.aiMinScore)))),
      aiMaxGain: s.aiMaxGain, aiMaxLoss: s.aiMaxLoss, minScore: s.aiMinScore };
  }
  function find(consumer, args) {
    actor(args); text(args.eventId, '事件 ID', 160);
    const event = events()[eventKey(consumer, args.scope, args.eventId)];
    if (!event || event.input.userId !== args.userId) fail('NOT_FOUND', '没有该来源和成员的事件回执。');
    return event;
  }
  function client(consumer, epoch) {
    const guard = () => { assertRunning(epoch); storage.ensureLoaded(); };
    const write = (method, fn) => (args = {}) => {
      try {
        guard();
        if (!allowed(consumer).includes(method)) fail('FORBIDDEN', `扩展 ${consumer} 未获 ${method} 权限，请配置好感度扩展接入权限。`);
        return storage.transaction(() => {
          const s = currentSettings(); syncMode(s);
          return { ok: true, ...fn(args, s, Date.now()) };
        });
      } catch (error) { return { ok: false, code: error.code || 'STORAGE_ERROR', message: error.message }; }
    };
    const canDecrease = () => {
      if (!allowed(consumer).includes('decrease')) fail('FORBIDDEN', `扩展 ${consumer} 未获 decrease 扣分权限。`);
    };
    return Object.freeze({
      apiVersion: 1, consumer,
      getState(args = {}) {
        try {
          guard(); fields(args, ['scope', 'userId']); actor(args);
          return storage.transaction(() => {
            const s = currentSettings(); syncMode(s);
            return { ok: true, ...view(args, s, Date.now()), permissions: [...allowed(consumer)] };
          });
        } catch (error) { return { ok: false, code: error.code || 'STORAGE_ERROR', message: error.message }; }
      },
      getEvent(args = {}) {
        try { guard(); fields(args, ['scope', 'userId', 'eventId']); return { ok: true, event: structuredClone(find(consumer, args)) }; }
        catch (error) { return { ok: false, code: error.code || 'STORAGE_ERROR', message: error.message }; }
      },
      recordEvent: write('recordEvent', (args, s, now) => {
        const input = normalizeEvent(consumer, args), id = eventKey(consumer, input.scope, input.eventId);
        if (input.at > now + 60000) fail('INVALID_ARGUMENT', '事件时间不能在未来。');
        if ((input.mode === 'normal' && input.fixedDelta < 0) || (input.mode === 'ai' && input.maxLoss > 0)) canDecrease();
        const previous = events()[id];
        if (previous) {
          if (!isDeepStrictEqual(previous.input, input)) fail('IDEMPOTENCY_CONFLICT', '同一来源的事件参数已经确定，不能改变。');
          return { event: structuredClone(previous) };
        }
        const { chat, rec } = member(input, s, now), state = view(input, s, now);
        let rejection = '';
        if (input.occurredAt <= Math.max(chat.resetAt || 0, chat.resetUsers?.[input.userId] || 0)) rejection = '事件早于好感度重置。';
        else if (state.mode !== input.mode) rejection = '当前评分模式已改变，事件未应用。';
        else if (state.protectedOwner) rejection = '该成员受主人固定满分保护。';
        else if (input.mode === 'normal' && (input.fixedDelta > state.remainingGain || -input.fixedDelta > state.remainingLoss)) rejection = '当前额度不足以完整应用固定分值。';
        else if (input.mode === 'ai' && (input.maxGain || input.maxLoss)
          && !(input.maxGain > 0 && state.remainingGain > 0) && !(input.maxLoss > 0 && state.remainingLoss > 0)) rejection = '当前可用评分额度不足。';
        else if (input.messageId && (rec.aiRated?.includes(`${input.userId}:${input.messageId}`) || claimed(input.scope, input.userId, input.messageId))) rejection = '关联互动已评分或被其他事件登记。';
        const event = { id, input, messages: input.messageId ? [input.messageId] : [], status: rejection ? 'rejected' : 'pending' };
        storage.db.integrationEvents ||= {};
        storage.db.integrationEvents[id] = event;
        if (rejection) event.reason = rejection;
        else if (input.mode === 'normal') apply(event, rec, input.fixedDelta, input.fixedDelta, input.reason, s, now);
        return { event: structuredClone(event) };
      }),
      bindMessage: write('bindMessage', args => {
        fields(args, ['scope', 'userId', 'eventId', 'messageId']);
        const event = find(consumer, args);
        if (!messageOK(args.messageId)) fail('INVALID_ARGUMENT', '关联消息编号无效。');
        if (event.status === 'rejected') fail('INVALID_EVENT', '未应用的事件不能占用互动消息。');
        const rec = storage.db.chats[args.scope]?.members?.[args.userId];
        if (!event.messages.includes(args.messageId) && (claimed(args.scope, args.userId, args.messageId, event.id)
          || (event.status === 'pending' && rec?.aiRated?.includes(`${args.userId}:${args.messageId}`)))) fail('ALREADY_RATED', '关联消息已被其他评分处理，请使用新的真实恢复请求。');
        if (!event.messages.includes(args.messageId)) event.messages.push(args.messageId);
        return { event: structuredClone(event) };
      }),
      rateEvent: write('rateEvent', (args, s, now) => {
        fields(args, ['scope', 'userId', 'eventId', 'delta', 'reason']);
        const event = find(consumer, args);
        if (event.input.mode !== 'ai' || event.status === 'rejected') fail('INVALID_MODE', '该事件无需 AI 评分。');
        if (!deltaOK(args.delta)) fail('INVALID_ARGUMENT', '变化须为 -10~10、最多两位小数。');
        text(args.reason, '评分理由', 200);
        if (args.delta < 0) { if (!event.input.maxLoss) fail('INVALID_ARGUMENT', '该事件不允许扣分。'); canDecrease(); }
        if (args.delta > 0 && !event.input.maxGain) fail('INVALID_ARGUMENT', '该事件不允许加分。');
        if (event.status === 'rated') {
          if (event.requested !== args.delta || event.reason !== args.reason) fail('IDEMPOTENCY_CONFLICT', '事件已评完，不能重新评分。');
          return { event: structuredClone(event) };
        }
        const { chat, rec } = member(event.input, s, now), state = view(event.input, s, now);
        const reset = event.input.occurredAt <= Math.max(chat.resetAt || 0, chat.resetUsers?.[args.userId] || 0);
        const limit = args.delta < 0 ? Math.min(event.input.maxLoss, s.aiMaxLoss, state.remainingLoss)
          : Math.min(event.input.maxGain, s.aiMaxGain, state.remainingGain);
        const delta = reset ? 0 : points(Math.sign(args.delta) * Math.min(Math.abs(cents(args.delta)), cents(limit))) || 0;
        apply(event, rec, delta, args.delta, args.reason, s, now);
        if (reset) event.note = '事件早于重置，待评记录已关闭为 0，不恢复旧分。';
        return { event: structuredClone(event) };
      })
    });
  }
  function apply(event, rec, delta, requested, reason, s, now) {
    rec.score = points(cents(rec.score) + cents(delta));
    if (delta > 0) rec.dayGain = points(cents(rec.dayGain || 0) + cents(delta));
    if (delta < 0) rec.dayLoss = points(cents(rec.dayLoss || 0) - cents(delta));
    rec.level = levelOf(rec.score, s).level;
    Object.assign(event, { status: 'rated', applied: delta, requested, reason, ratedAt: now, score: rec.score, level: rec.level });
  }
  return { claimed,
    available() { try { permissions(); return true; } catch (error) { return { ok: false, reason: error.message }; } },
    ownsTool(name) {
      if (typeof name !== 'string') return false;
      try { return Object.entries(permissions()).some(([id, list]) => list.some(p => p !== 'decrease') && name.startsWith(`${id.slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '_')}__`)); }
      catch { return false; }
    },
    provider: ({ consumer } = {}) => { consumerId(consumer); return lifecycle.running ? client(consumer, lifecycle.epoch) : undefined; }
  };
}
