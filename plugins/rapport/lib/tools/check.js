// 个人好感度查询。
import { formatPoints } from '../points.js';
export function createTool(services) {
  const {
    lifecycle, assertRunning, ensureLoaded, currentSettings, chatKeyOf, accumulate, syncOwners,
    storage, isOwner, isProtectedOwner, ownerReport, findMember, resolveRequester, fillName, pinOwner,
    applyDecay, markDirty, flush, rankOf, levelOf, titleOf, progressText, fmtDate
  } = services;
  return {
    id: 'check',
    name: '好感度查询',
    description:
      '查询某个群友对机器人的好感度分数、等级称号（疏远/初识/眼熟/熟络/亲近/知己）、累计发言数和群内排名。' +
      '当有人问「我好感度多少」「我和你多熟」「查一下 XXX 的好感度」「我们的关系怎么样了」时使用。' +
      'target 不填表示查发问者自己；填 QQ 号或群昵称表示查别人。' +
      '数据由系统自动累积，必须调用本工具。结果只返回给你，不会自动发送到 QQ；查询后必须调用 send_message 按人设回复提问者，不要只输出普通正文。',
    category: 'query',
    icon: '💗',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要查的人，可以是 QQ 号（如 10001）或群昵称（如 小明）。留空表示查发问者自己。'
        }
      }
    },
    async execute(ctx, args) {
      const epoch = lifecycle.epoch;
      try {
        assertRunning(epoch);
        ensureLoaded();
        let s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询好感度。', isError: true };

        assertRunning(epoch);
        // 查询前先补扫一次，保证分数是最新的
        await accumulate({ chatKey, store: ctx?.store, selfId: ctx?.selfId, triggerEntries: Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : ctx?.session?.triggerEntries });
        assertRunning(epoch);
        syncOwners();
        s = currentSettings();

        let chat = storage.db.chats[chatKey];
        let members = chat?.members || {};
        const selfId = String(ctx?.selfId || storage.db.meta?.selfId || '');
        const target = String(args?.target ?? '').trim();
        let userId = '';

        if (target) {
          // 主人可能从没在这个群发过言，但查 TA 必须能查到（恒为满级）
          const pure = target.replace(/[^\d]/g, '');
          if (/^[1-9]\d{4,11}$/.test(target) && isProtectedOwner(pure, s) && !members[pure]) {
            return { content: ownerReport(pure, '', s, false) };
          }
          if (!Object.keys(members).length) {
            return { content: '这个会话还没有任何好感度记录（还没人发过言，或插件刚装上）。等大家聊几句再来查就有了。' };
          }
          const hit = findMember(members, target);
          if (!hit) {
            return {
              content:
                `没有找到「${target}」的好感度记录。可能 TA 最近没在这个群发过言，` +
                '或者名字/号码写错了。可以让对方先说句话，或用 rank 工具看排行榜确认有哪些人。'
            };
          }
          if (hit.ambiguous > 1) return { content: '有多个同名成员，请提供准确 QQ 号。', isError: true };
          userId = hit.userId;
        } else {
          if (!Object.keys(members).length) {
            return { content: '这个会话还没有任何好感度记录（还没人发过言，或插件刚装上）。等大家聊几句再来查就有了。' };
          }
          const req = await resolveRequester(ctx, chatKey, selfId, s);
          if (!req.userId) {
            return {
              content: '没能确认是谁在问好感度。请让对方在提问时带上自己的 QQ 号或昵称，或者改用 rank 工具看排行榜。',
              isError: true
            };
          }
          userId = req.userId;
        }

        assertRunning(epoch);
        chat = storage.db.chats[chatKey];
        members = chat?.members || {};
        const original = members[userId];
        if (!original) return { content: '该成员记录已变更或重置，请重新查询。', isError: true };
        const named = { ...original };
        await fillName(ctx, named, userId, epoch);
        assertRunning(epoch);
        chat = storage.db.chats[chatKey];
        members = chat?.members || {};
        const rec = members[userId];
        if (!rec || rec.firstSeen !== original.firstSeen) return { content: '该成员记录已变更或重置，请重新查询。', isError: true };
        if (!rec.name && named.name) rec.name = named.name;
        s = currentSettings();
        syncOwners();
        if (isProtectedOwner(userId, s)) {
          pinOwner(rec, s);
        } else {
          applyDecay(rec, Date.now(), s);
        }
        for (const [uid, member] of Object.entries(members)) {
          if (!isProtectedOwner(uid, s)) applyDecay(member, Date.now(), s);
        }
        markDirty();
        flush();

        const rankInfo = rankOf(members, userId, s);
        const lines = [
          `对象：${rec.name || userId}（QQ ${userId}）${target ? '' : '，也就是正在提问的这个人'}`,
          isProtectedOwner(userId, s)
            ? `好感度：${formatPoints(rec.score)} 分（满级，主人固定值，不参与加分和衰减）`
            : `好感度：${formatPoints(rec.score)} 分`,
          `等级：Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」${isOwner(userId, s) ? ' · 身份：主人' : ''}`,
          `升级进度：${isProtectedOwner(userId, s) ? '已经是最高等级，无需再攒' : progressText(rec.score, s)}`,
          `累计发言：${rec.msgs} 条（当前计分方式：${s.aiMode ? 'AI' : '普通'}）`,
          `今日调分累计：+${formatPoints(rec.dayKey === services.dayString(Date.now()) ? rec.dayGain || 0 : 0)} / -${formatPoints(rec.dayKey === services.dayString(Date.now()) ? rec.dayLoss || 0 : 0)}（不含时间淡化）`,
          `首次计分记录：${fmtDate(rec.firstSeen)}，最近互动 ${fmtDate(rec.lastSeen)}（不是入群时间）`,
          `群内排名：第 ${rankInfo.rank} 名 / 共 ${rankInfo.total} 人`
        ];
        const recent = (chat.aiAudit || []).filter(item => item.userId === userId).slice(-3);
        for (const item of recent) lines.push(`AI 调分记录：${fmtDate(item.at)} ${item.delta > 0 ? '+' : ''}${formatPoints(item.delta)} 分，理由（数据）：${JSON.stringify(item.reason)}`);

        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询好感度失败：${error?.message ?? error}`, isError: true };
      }
    }
  };
}
