// 当前会话排行榜。
export function createTool(services) {
  const {
    lifecycle, assertRunning, ensureLoaded, currentSettings, chatKeyOf, accumulate, syncOwners,
    storage, isOwner, resolveRequester, applyDecay, markDirty, flush, rankOf, levelOf, titleOf,
    sortedMembers, clamp
  } = services;
  return {
    id: 'rank',
    name: '好感度排行榜',
    description:
      '列出当前会话里好感度最高的若干人，含分数和等级称号。' +
      '当有人说「好感度排行」「排行榜」「谁跟机器人最熟」「群里谁好感度最高」时使用。' +
      'topN 不填默认列出前 10 名。',
    category: 'query',
    icon: '🏆',
    parameters: {
      type: 'object',
      properties: {
        topN: {
          type: 'integer', minimum: 1, maximum: 50,
          description: '列出前几名，1~50。不填默认 10。'
        }
      }
    },
    async execute(ctx, args) {
      const epoch = lifecycle.epoch;
      try {
        assertRunning(epoch);
        ensureLoaded();
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询排行榜。', isError: true };

        assertRunning(epoch);
        await accumulate({ chatKey, store: ctx?.store, selfId: ctx?.selfId, triggerEntries: Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : ctx?.session?.triggerEntries });
        assertRunning(epoch);
        syncOwners();

        const members = storage.db.chats[chatKey]?.members || {};
        const now = Date.now();
        for (const [uid, rec] of Object.entries(members)) {
          if (!isOwner(uid, s)) applyDecay(rec, now, s);
        }
        const list = sortedMembers(members);
        if (!list.length) return { content: '这个会话还没有好感度记录，等大家聊几句再来查排行榜。' };

        const n = clamp(Number(args?.topN) || 10, 1, 50);
        const shown = Math.min(n, list.length);
        const lines = [`好感度排行榜（前 ${shown} 名 / 共 ${list.length} 人）`];
        list.slice(0, n).forEach(([userId, rec], i) => {
          if (!isOwner(userId, s)) applyDecay(rec, now, s);
          const tag = isOwner(userId, s) ? ' · 主人' : '';
          lines.push(`${i + 1}. ${rec.name || userId} — ${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」${tag}`);
        });

        // 如果发问者自己没进榜，补一行告诉 TA 自己的位置
        const selfId = String(ctx?.selfId || storage.db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        if (req.userId && members[req.userId]) {
          const info = rankOf(members, req.userId, s);
          if (info.rank > shown) {
            const rec = members[req.userId];
            lines.push(`（提问的 ${rec.name || req.userId} 排在第 ${info.rank} 名，${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」）`);
          }
        }
        markDirty();
        flush();
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询排行榜失败：${error?.message ?? error}`, isError: true };
      }
    }
  };
}
