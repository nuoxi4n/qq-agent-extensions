// 统一解析 QQ Agent 存档及消息条目，不推测用户身份。
export function isScoreQuery(text) {
  const plain = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  return /^(?:请|帮我|查一下|查询|查看|查查|看看|看一下)*(?:我的|我|你的|你对我的|我们之间的)?(?:好感度排行榜|好感度排行|好感排行榜|好感排行|排行榜|好感度|好感)(?:是多少|多少|有多少|几分|是多少分|呢|啊|吗)*$/u.test(plain);
}

export function createMessages(services) {
  const { firstVal, toMs } = services;

  function normalizeEntry(raw, selfId = '') {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw.entry && typeof raw.entry === 'object' ? Object.assign({}, raw, raw.entry) : raw;
    const sender = e.sender && typeof e.sender === 'object' ? e.sender : null;

    const userId = String(
      firstVal([
        e.userId, e.user_id, e.senderId, e.senderUserId, e.fromUserId, e.qq,
        sender?.user_id, sender?.userId, sender?.id
      ]) ?? ''
    ).trim();

    const name = String(
      firstVal([e.groupCard, e.card, sender?.card, sender?.nickname, e.nickname, e.senderName, e.name, e.remark]) ?? ''
    ).trim();

    const ts = toMs(firstVal([e.timestamp, e.ts, e.time, e.at, e.createdAt, e.date, e.sendTime]));
    const mid = String(firstVal([e.messageId, e.message_id, e.mid]) ?? '').trim();
    const localId = String(firstVal([e.localId, e.id]) ?? '').trim();

    const { text, ats, hasReply, hasMedia } = extractContent(e);

    const selfRole = String(sender?.role ?? '');
    const isSelf =
      e.self === true || e.fromSelf === true || e.isSelf === true || e.outgoing === true || e.fromMe === true ||
      selfRole === 'self' || selfRole === 'owner_self' ||
      Boolean(selfId && userId && userId === String(selfId));

    if (!userId && !text && !hasMedia) return null;
    const replyMid = String(e.reply?.mid ?? e.reply?.messageId ?? e.reply?.message_id ??
      (Array.isArray(e.message) ? e.message.find((x) => x.type === 'reply')?.data?.id : '') ?? '');
    const cqReply = String(e.raw_message || e.text || '').match(/\[CQ:reply,id=([^,\]]+)/)?.[1];
    return { userId, name, ts, mid, localId, text, ats, hasReply, hasMedia, isSelf,
      atMe: typeof e.atMe === 'boolean' ? e.atMe : null, replyMid: replyMid || cqReply || '', isPoke: e.isPoke === true };
  }

  function extractContent(e) {
    let text = '';
    let hasReply = false;
    let hasMedia = false;
    const ats = [];

    const pushSeg = (seg) => {
      if (!seg || typeof seg !== 'object') return;
      const t = String(seg.type ?? '').toLowerCase();
      const d = seg.data && typeof seg.data === 'object' ? seg.data : {};
      if (t === 'text') {
        text += String(d.text ?? '');
      } else if (t === 'at') {
        const q = String(d.qq ?? d.id ?? d.userId ?? d.user_id ?? '').trim();
        if (q && q !== 'all') ats.push(q);
      } else if (t === 'reply') {
        hasReply = true;
      } else if (t) {
        hasMedia = true;
      }
    };

    const msg = firstVal([e.message, e.segments, e.content, e.text, e.raw_message]);
    if (Array.isArray(msg)) {
      for (const seg of msg) pushSeg(seg);
    } else if (typeof msg === 'string') {
      text += msg;
    } else {
      const t = firstVal([e.text, e.raw_message, e.content]);
      if (typeof t === 'string') text += t;
    }

    if (e.hasReply === true) hasReply = true;
    if (Array.isArray(e.media) && e.media.length) hasMedia = true;

    // CQ 码形式的 at / reply / 媒体
    for (const m of text.matchAll(/\[CQ:at,qq=(\d+)[^\]]*\]/g)) ats.push(m[1]);
    if (/\[CQ:reply/.test(text)) hasReply = true;
    if (/\[CQ:(image|record|video|file)/.test(text)) hasMedia = true;

    text = text.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    return { text, ats, hasReply, hasMedia };
  }

  return { normalizeEntry };
}
