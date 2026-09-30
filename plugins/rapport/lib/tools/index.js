// 注册入口和统一参数校验；每个工具的业务实现在独立文件中。
export function registerTools(api, services, factories) {
  const { isObject } = services;

  function registerTool(api, def) {
    const execute = def.execute;
    api.registerTool({ ...def, async execute(ctx, args = {}) {
      try {
        if (!isObject(args)) throw new Error('工具参数必须是对象。');
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
          if (rule.enum && !rule.enum.includes(value)) throw new Error(`${key} 不是支持的选项。`);
        }
        return await execute(ctx, args);
      } catch (error) { return { content: error.message, isError: true }; }
    }});
  }

  for (const createTool of factories) registerTool(api, createTool(services));
}
