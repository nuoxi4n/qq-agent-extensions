// 主人设置管理。
export function createTool(services) {
  const {
    lifecycle, assertRunning, ensureLoaded, currentSettings, chatKeyOf, syncOwners, storage,
    trustedRequester, ownerList, TUNABLE, coerceValue, formatVal, mechanicalKeys, syncMode
  } = services;
  return {
    id: 'tune',
    name: '调整好感度设定',
    description:
      '查看或修改本插件的设定（回复风格、加分值、每日上限、衰减规则、等级门槛、主人 QQ 号等）。' +
      '仅当主人 QQ 号本人提出「看看好感度设定」「把每条加分改成 2」「关掉衰减」「等级门槛改成 …」' +
      '「把某人设成主人」这类要求时使用。非主人提出时不要调用本工具。' +
      'action=list 查看当前全部设定；action=set 配合 item 和 value 修改一项；' +
      'action=clear 清除在聊天里做过的修改、恢复成控制台的值。',
    category: 'system',
    icon: '🎛️',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set', 'clear'],
          description: 'list=列出当前设定；set=修改某一项；clear=清除聊天里做过的覆盖（不填 item 表示全部清除）'
        },
        item: {
          type: 'string',
          description: `设置项英文名。可选：${Object.keys(TUNABLE).join(' / ')}`
        },
        value: {
          type: 'string',
          description: '新值，一律用字符串传。分数可写 "0.25"，最多两位小数；风格或补充直接写文本；QQ 号多个用英文逗号分隔；等级门槛写 "5,20,50,100"'
        }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      const epoch = lifecycle.epoch;
      try {
        assertRunning(epoch);
        ensureLoaded();
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法调整设定。', isError: true };

        assertRunning(epoch);
        const owners = ownerList(s);
        if (!owners.length) {
          return {
            content: '当前没有配置主人 QQ 号，所以谁都不能在聊天里改设定。请先到控制台「插件」页 → 好感度养成 → 设置里填「主人 QQ 号」。',
            isError: true
          };
        }

        const selfId = String(ctx?.selfId || storage.db.meta?.selfId || '');
        const req = trustedRequester(ctx, selfId, { mutation: true });
        if (!req.userId) {
          return { content: '没能确认是谁在要求改设定。本轮无法唯一确认发送者，请由主人单独再发一次请求。', isError: true };
        }
        if (!owners.includes(String(req.userId))) {
          return {
            content: `权限不足：QQ ${req.userId}（${req.name || '未知昵称'}）不是主人，不能调整好感度设定。只有主人 QQ 号可以改。请礼貌拒绝，不要透露具体数值以外的内部信息。`,
            isError: true
          };
        }

        const action = String(args?.action ?? '').trim().toLowerCase();

        if (action === 'list') {
          const overrides = storage.db.meta?.overrides || {};
          const lines = [`当前好感度设定（主人：${owners.join('、')}）`];
          for (const [key, meta] of Object.entries(TUNABLE)) {
            const val = s[key];
            const src = Object.prototype.hasOwnProperty.call(overrides, key) ? '聊天改过' : '控制台/默认';
            lines.push(`${meta.label}（${key}）= ${formatVal(val)} ［${src}${s.aiMode && mechanicalKeys.includes(key) ? '；AI 模式停用、不可通过聊天修改' : ''}］`);
          }
          lines.push('', '要改哪一项，直接说「把 XX 改成 Y」就行；说「恢复默认设定」可清除所有聊天里的修改。');
          return { content: lines.join('\n') };
        }

        if (action === 'set') {
          const item = String(args?.item ?? '').trim();
          const meta = Object.hasOwn(TUNABLE, item) ? TUNABLE[item] : null;
          if (s.aiMode && mechanicalKeys.includes(item)) return { content: 'AI 模式下机械计分项不生效且不能通过聊天修改，请先关闭 AI 模式。', isError: true };
          if (!meta) {
            return {
              content: `没有叫「${item || '(空)'}」的设置项。可选项：${Object.keys(TUNABLE).join('、')}。`,
              isError: true
            };
          }
          const parsed = coerceValue(meta, args?.value);
          if (!parsed.ok) return { content: parsed.error, isError: true };

          return storage.transaction(() => {
            if (!storage.db.meta) storage.db.meta = {};
            if (!storage.db.meta.overrides || typeof storage.db.meta.overrides !== 'object') storage.db.meta.overrides = {};
            storage.db.meta.overrides[item] = parsed.value;
            syncMode();
            syncOwners();

            const extra = item === 'ownerQq' ? '（新的管理身份已生效；固定满分按主人保护设置处理）' : '';
            return { content: `已把「${meta.label}」改成 ${formatVal(parsed.value)}${extra}。此改动优先级高于控制台设置，随时可以说「恢复默认设定」撤销。` };
          });
        }

        if (action === 'clear') {
          const item = String(args?.item ?? '').trim();
          const overrides = storage.db.meta?.overrides || {};
          if (s.aiMode && mechanicalKeys.includes(item)) return { content: 'AI 模式下不能修改机械计分项，请先关闭 AI 模式。', isError: true };
          if (item) {
            if (!Object.hasOwn(TUNABLE, item)) return { content: `没有叫「${item}」的设置项。`, isError: true };
            if (!Object.prototype.hasOwnProperty.call(overrides, item)) {
              return { content: `「${TUNABLE[item].label}」本来就没在聊天里改过，不需要清除。` };
            }
            return storage.transaction(() => {
              delete overrides[item];
              syncMode();
              syncOwners();

              return { content: `已清除「${TUNABLE[item].label}」的聊天修改，恢复为控制台/默认值 ${formatVal(currentSettings()[item])}。` };
            });
          }
          const n = Object.keys(overrides).length;
          return storage.transaction(() => {
            storage.db.meta.overrides = {};
            syncMode();
            syncOwners();

            return { content: n ? `已清除全部 ${n} 项聊天修改，恢复为控制台/默认设定。` : '当前没有任何聊天里做过的修改，不用清除。' };
          });
        }

        return { content: `看不懂 action「${action}」。只能用 list / set / clear。`, isError: true };
      } catch (error) {
        return { content: `调整设定失败：${error?.message ?? error}`, isError: true };
      }
    }
  };
}
