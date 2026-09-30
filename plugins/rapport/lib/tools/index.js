// 注册入口和统一参数校验；每个工具的业务实现在独立文件中。
export function registerTools(api, services, factories) {
  const { isObject } = services;

  function registerTool(api, def) {
    const execute = def.execute;
    const isQuery = ['check', 'rank'].includes(def.id);
    const withReplyInstruction = result => {
      if (!isQuery) return result;
      return { ...result, content: `${result.content}\n\n【回复指引】以上仅是工具返回给你的数据，尚未发送到 QQ。请调用 send_message，按当前人设向提问者自然说明查询结果${result.isError ? '或无法查询的原因' : ''}；不要只把答案写在普通正文或思考中，也不要查询后直接结束。低好感不代表可以忽略明确提问；不用照抄整份报告。首次计分记录不代表入群时间，不要据此说“今天刚进群”。` };
    };
    api.registerTool({ ...def, async execute(ctx, args = {}) {
      try {
        if (!isObject(args)) throw new Error('工具参数必须是对象。');
        // 宿主内联工具解析器可能把纯数字编号解析为 number；仅无损兼容这两个标识字段。
        if (def.id === 'adjust') {
          args = { ...args };
          for (const key of ['target', 'messageId']) {
            if (typeof args[key] === 'number' && Number.isSafeInteger(args[key])) args[key] = String(args[key]);
          }
        }
        for (const key of def.parameters.required || []) {
          if (!Object.hasOwn(args, key)) throw new Error(`缺少参数 ${key}。`);
        }
        for (const [key, rule] of Object.entries(def.parameters.properties)) {
          if (!Object.hasOwn(args, key)) continue;
          const value = args[key];
          if (rule.type === 'string' && typeof value !== 'string') throw new Error(`${key} 必须是文本。`);
          if (rule.type === 'string' && value.length > 1000) throw new Error(`${key} 内容过长。`);
          if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
          if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error(`${key} 必须是 ${rule.minimum}~${rule.maximum} 的整数。`);
          if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) throw new Error(`${key} 必须是 ${rule.minimum}~${rule.maximum} 的数字。`);
          if (rule.enum && !rule.enum.includes(value)) throw new Error(`${key} 不是支持的选项。`);
        }
        return withReplyInstruction(await execute(ctx, args));
      } catch (error) { return withReplyInstruction({ content: error.message, isError: true }); }
    }});
  }

  for (const createTool of factories) registerTool(api, createTool(services));
}
