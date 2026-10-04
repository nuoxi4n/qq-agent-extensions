export function messageId(value, name) {
  if ((typeof value !== 'string' && !Number.isSafeInteger(value))
    || !/^#?-?\d+$/.test(String(value).trim())) {
    throw new Error(`${name} 必须是聊天记录中的 QQ 消息 id（#数字）`);
  }
  return String(value).trim().replace(/^#/, '');
}

// 当前官方宿主以 session.trigger 传递本轮消息数组；身份和选图共用这次解析。
export function resolveRequest(ctx, requestMessageId) {
  const trigger = ctx.session?.trigger;
  if (!Array.isArray(trigger) || (ctx.session.chatKey && ctx.session.chatKey !== ctx.chatKey)) {
    throw new Error('当前会话缺少有效的本轮消息，请检查宿主版本');
  }
  const eligible = entry => entry && !entry.self && !entry.recalled && !entry.isPoke
    && String(entry.senderId) !== String(ctx.selfId);
  let message;
  if (requestMessageId != null) {
    const mid = messageId(requestMessageId, 'requestMessageId');
    const matches = trigger.filter(entry => entry?.mid != null && String(entry.mid) === mid);
    if (matches.length !== 1 || !eligible(matches[0])) {
      throw new Error('requestMessageId 无法对应本轮有效请求消息，请使用当前请求者实际发言的消息 id');
    }
    message = matches[0];
  } else {
    const entries = trigger.filter(eligible);
    if (!entries.length || new Set(entries.map(entry => String(entry.senderId))).size !== 1) {
      throw new Error('无法唯一确定本轮生图用户，请用 requestMessageId 指定本轮提出生图要求的消息');
    }
    message = entries.at(-1);
  }
  const userId = String(message.senderId);
  if (!/^[1-9]\d{4,11}$/.test(userId)
    || (ctx.chatKey.startsWith('private:') && ctx.chatKey !== `private:${userId}`)) {
    throw new Error('无法确定本轮生图用户，发言者与当前会话不一致');
  }
  if (!Number.isSafeInteger(message.id) || message.id < 1) {
    throw new Error('请求消息缺少有效的本地序号，无法确定选图边界');
  }
  return { userId, message, trigger };
}
