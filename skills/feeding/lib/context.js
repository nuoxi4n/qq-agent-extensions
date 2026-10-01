import { fail } from './config.js';

export function requester(ctx, requestedId, now) {
  const scope = ctx?.chatKey;
  if (typeof scope !== 'string' || !/^(group|private):[1-9]\d{4,11}$/.test(scope)
    || scope !== `${ctx.kind}:${ctx.chatId}` || (ctx.session?.chatKey && ctx.session.chatKey !== scope)) fail('INVALID_CONTEXT', '会话标识不一致。');
  if (!ctx.session || ['done', 'noreply', 'error', 'aborted'].includes(ctx.session.status) || ctx.proactive === true) fail('INVALID_CONTEXT', '需要本轮真实用户请求，不能主动替群友投喂。');
  const raw = ctx.session.triggerEntries ?? ctx.session.trigger;
  if (!Array.isArray(raw)) fail('INVALID_CONTEXT', '没有可靠的本轮消息。');
  const entries = raw.filter(entry => entry && !entry.self && !entry.recalled && !entry.isPoke && String(entry.senderId) !== String(ctx.selfId));
  if (!entries.length || new Set(entries.map(entry => String(entry.senderId))).size !== 1) fail('AMBIGUOUS_REQUESTER', '本轮发言者不唯一，请本人单独 @ 机器人提出请求。');
  const userId = String(entries[0].senderId);
  if (!/^[1-9]\d{4,11}$/.test(userId) || (ctx.kind === 'private' && userId !== String(ctx.chatId))) fail('INVALID_CONTEXT', '无法确定本轮实际操作人。');
  if (requestedId === undefined) return { scope, userId };
  const messageId = Number.isSafeInteger(requestedId) ? String(requestedId) : requestedId;
  if (typeof messageId !== 'string' || !/^(?:-?\d+|local:[1-9]\d*)$/.test(messageId)) fail('INVALID_CONTEXT', '需要本轮真实消息编号。');
  const matches = entries.filter(entry => String(entry.mid ?? `local:${entry.id}`) === messageId);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].ts) || matches[0].ts < now - 86400000 || matches[0].ts > now + 60000) fail('INVALID_CONTEXT', '消息编号或时间无效，请重新发起投喂。');
  return { scope, userId, messageId, messageAt: matches[0].ts };
}
