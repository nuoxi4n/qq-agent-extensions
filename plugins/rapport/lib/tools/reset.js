// 主人重置记录。
export function createTool(services) {
  const {
    lifecycle, assertRunning, ensureLoaded, currentSettings, chatKeyOf, syncOwners, storage,
    findMember, trustedRequester, ownerList
  } = services;
  return {
    id: 'reset',
    name: '重置好感度',
    description:
      '把某个群友（或整个会话）的好感度清零重来。这是不可撤销的操作，' +
      '仅当已配置的主人明确要求「清空/重置好感度」时才用。普通群友不能执行重置。',
    category: 'system',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要重置的人，QQ 号或群昵称。留空表示重置整个会话（所有人）。'
        },
        confirm: {
          type: 'boolean',
          description: '必须为 true 才执行。用于防止误清空整个会话。'
        }
      },
      required: ['confirm']
    },
    async execute(ctx, args) {
      const epoch = lifecycle.epoch;
      try {
        assertRunning(epoch);
        ensureLoaded();
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法重置。', isError: true };

        assertRunning(epoch);

        if (args?.confirm !== true) {
          return { content: '重置不可撤销。请先向用户确认，再带 confirm=true 调用一次。', isError: true };
        }

        // 重置只允许已配置的主人执行
        const selfId = String(ctx?.selfId || storage.db.meta?.selfId || '');
        const req = trustedRequester(ctx, selfId, { mutation: true });
        const byOwner = Boolean(req.userId) && ownerList(s).includes(String(req.userId));
        if (!req.userId) return { content: '本轮无法唯一确认发送者，请单独再发一次请求。', isError: true };
        if (!byOwner) {
          return {
            content: '只有已配置的主人能重置好感度。请礼貌说明权限不足。',
            isError: true
          };
        }

        const chat = storage.db.chats[chatKey];
        if (!chat) return { content: '这个会话还没有好感度数据，不需要重置。' };

        const target = String(args?.target ?? '').trim();
        if (!target) {
          const n = Object.keys(chat.members || {}).length;
          return storage.transaction(() => {
            chat.members = {};
            chat.aiEligible = [];
            chat.aiAudit = [];
            chat.resetAt = Date.now(); // 保留去重记录，防止清空后补扫把旧分加回来
            syncOwners();

            return { content: `已清空本会话全部好感度记录（共 ${n} 人）。此操作不可撤销。新记录按当前计分模式和主人保护设置建立。` };
          });
        }

        const hit = findMember(chat.members || {}, target);
        if (!hit) return { content: `没有找到「${target}」的好感度记录，无需重置。` };
        if (hit.ambiguous > 1) return { content: '同名成员不唯一，请用准确 QQ 号重置。', isError: true };
        const name = hit.rec.name || hit.userId;
        return storage.transaction(() => {
          chat.resetUsers ||= {};
          chat.resetUsers[hit.userId] = Date.now();
          delete chat.members[hit.userId];
          chat.aiEligible = (chat.aiEligible || []).filter(item => !item.key.startsWith(`${hit.userId}:`));
          chat.aiAudit = (chat.aiAudit || []).filter(item => item.userId !== hit.userId);

          return { content: `已清空 ${name}（QQ ${hit.userId}）的好感度记录。此操作不可撤销。` };
        });
      } catch (error) {
        return { content: `重置好感度失败：${error?.message ?? error}`, isError: true };
      }
    }
  };
}
