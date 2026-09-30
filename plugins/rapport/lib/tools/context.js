// 工具共享的调用者校验、成员查找和昵称补全。
export function createToolContext(services) {
  const { normalizeEntry, unwrapList, getRun, firstVal, markDirty, assertRunning, warn } = services;

  async function resolveRequester(ctx, chatKey, selfId, s) {
    return trustedRequester(ctx, selfId);
  }

  function trustedRequester(ctx, selfId, { mutation = false } = {}) {
    if (ctx?.kind === 'private' && /^[1-9]\d{4,11}$/.test(String(ctx.chatId))) {
      return { userId: String(ctx.chatId), name: '' };
    }
    const raw = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : ctx?.session?.triggerEntries;
    const entries = unwrapList(raw).map((e) => normalizeEntry(e, selfId))
      .filter((e) => e && !e.isSelf && /^[1-9]\d{4,11}$/.test(e.userId));
    const cached = getRun(ctx);
    const source = entries.length ? entries : cached ? cached.entries : [];
    // 修改操作不从混合发言批推测授权，更不信文字里的“我是主人”。
    if (!source.length || (mutation && new Set(source.map((e) => e.userId)).size !== 1)) return { userId: '', name: '' };
    return source[source.length - 1];
  }

  function findMember(members, target) {
    const q = String(target ?? '').trim();
    if (!q) return null;
    const pure = /^[1-9]\d{4,11}$/.test(q) ? q : '';
    if (pure && members[pure]) return { userId: pure, rec: members[pure] };

    const list = Object.entries(members || {});
    const norm = (x) => String(x || '').trim().toLowerCase();
    const key = norm(q);

    const exact = list.filter(([, r]) => norm(r.name) === key);
    if (exact.length) return { userId: exact[0][0], rec: exact[0][1], ambiguous: exact.length };

    const fuzzy = list.filter(([, r]) => norm(r.name) && (norm(r.name).includes(key) || key.includes(norm(r.name))));
    if (fuzzy.length === 1) return { userId: fuzzy[0][0], rec: fuzzy[0][1] };
    if (fuzzy.length > 1) {
      // 多个同名时取分数最高的那个，并在结果里说明有歧义
      fuzzy.sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
      return { userId: fuzzy[0][0], rec: fuzzy[0][1], ambiguous: fuzzy.length };
    }
    return null;
  }

  function sortedMembers(members) {
    return Object.entries(members || {}).sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
  }

  function rankOf(members, userId, s) {
    const list = sortedMembers(members);
    const idx = list.findIndex(([id]) => id === String(userId));
    return { rank: idx >= 0 ? idx + 1 : 0, total: list.length };
  }

  async function fillName(ctx, rec, userId, epoch) {
    if (!rec || rec.name || ctx?.kind !== 'group' || !ctx?.onebot) return;
    if (typeof ctx.onebot.call !== 'function') return;
    const gid = Number(ctx.chatId);
    const uid = Number(userId);
    if (!Number.isInteger(gid) || gid <= 0 || !Number.isInteger(uid) || uid <= 0) return;
    try {
      const info = await ctx.onebot.call('get_group_member_info', { group_id: gid, user_id: uid });
      assertRunning(epoch);
      const nm = String(firstVal([info?.card, info?.nickname, info?.name]) ?? '').trim();
      if (nm) {
        rec.name = nm;
        markDirty();
      }
    } catch (error) {
      warn(`补全群昵称失败（QQ ${userId}）：${error?.message ?? error}`);
    }
  }

  return { resolveRequester, trustedRequester, findMember, sortedMembers, rankOf, fillName };
}
