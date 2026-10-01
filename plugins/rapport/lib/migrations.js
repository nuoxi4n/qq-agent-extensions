// 仅迁移未发布版本的本地试用数据，不暴露旧业务接口。
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validPoints } from './points.js';
import { eventKey, normalizeEvent, validateEvents } from './events.js';

const idOf = (scope, userId, messageId) => createHash('sha256').update(JSON.stringify([scope, userId, messageId])).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const checkActor = ({ scope, userId }) => {
  if (typeof scope !== 'string' || typeof userId !== 'string'
    || !/^(group|private):[1-9]\d{4,11}$/.test(scope) || !/^[1-9]\d{4,11}$/.test(userId)
    || (scope.startsWith('private:') && scope !== `private:${userId}`)) fail('INVALID_ARGUMENT', '投喂对象或会话无效。');
};
const messageOK = id => typeof id === 'string' && /^(?:-?\d+|local:[1-9]\d*)$/.test(id);

// 永久事件回执独立于每日 aiRated；重置成员不会删除回执或重新发奖。
export function validateFeedingEvents(events) {
  if (events === undefined) return;
  if (!events || typeof events !== 'object' || Array.isArray(events)) throw new Error('投喂回执格式错误');
  for (const [id, event] of Object.entries(events)) {
    const i = event?.input;
    if (!i || i.eventId !== id || id !== idOf(i.scope, i.userId, i.messageId) || !messageOK(i.messageId)
      || !['normal', 'ai'].includes(i.mode) || ![i.fixedGain, i.aiMaxGain].every(v => validPoints(v) && v > 0 && v <= 10)
      || !Number.isSafeInteger(i.at) || !Number.isSafeInteger(i.messageAt) || i.at < 0 || i.messageAt < 0
      || !['pending', 'rated', 'rejected'].includes(event.status)
      || !Array.isArray(event.messages) || !event.messages.includes(i.messageId) || event.messages.some(x => !messageOK(x))
      || (i.mode === 'normal' && event.status === 'pending')) throw new Error('投喂回执损坏');
    checkActor(i);
    if (event.status === 'rated' && (!validPoints(event.applied) || event.applied < 0 || event.applied > 10
      || !validPoints(event.requested) || event.requested < 0 || event.requested > 10
      || !validPoints(event.score) || Math.abs(event.score) > 100 || typeof event.reason !== 'string'
      || event.reason.length > 200 || !Number.isSafeInteger(event.ratedAt))) throw new Error('投喂评分回执损坏');
  }
}


export function migrateEvents(db) {
  if (db.feedingEvents === undefined) return;
  validateFeedingEvents(db.feedingEvents);
  validateEvents(db.integrationEvents);
  const merged = { ...db.integrationEvents };
  for (const event of Object.values(db.feedingEvents)) {
    const old = event.input;
    const input = normalizeEvent('feeding', { scope: old.scope, userId: old.userId, eventId: old.eventId,
      at: old.at, occurredAt: old.messageAt, messageId: old.messageId, mode: old.mode,
      fixedDelta: old.fixedGain, maxGain: old.aiMaxGain, maxLoss: 0, reason: '投喂互动' });
    const id = eventKey(input.consumer, input.scope, input.eventId);
    const migrated = { ...event, id, input };
    if (merged[id] && !isDeepStrictEqual(merged[id], migrated)) throw new Error('旧投喂回执与通用事件冲突，停止迁移');
    merged[id] = migrated;
  }
  validateEvents(merged);
  db.integrationEvents = merged;
  delete db.feedingEvents;
}
