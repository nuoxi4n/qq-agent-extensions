export const MAX_AMOUNT = 1_000_000_000_000;
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value !== value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail('INVALID_ARGUMENT', `${label}须为${empty ? '0' : '1'}~${max}字文本。`);
  return value;
}
export function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${label}须为 ${min}~${max} 的整数。`);
  return value;
}
export function gain(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 10 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) fail('INVALID_CONFIG', '好感度奖励须为 0.01~10，最多两位小数。');
  return value;
}
export const DEFAULT_FOODS = [
  { id: 'cookie', name: '小饼干', aliases: ['饼干'], price: 20, fixedGain: 0.1, description: '酥脆的小饼干，有淡淡的黄油香。' },
  { id: 'tea', name: '奶茶', aliases: ['一杯奶茶'], price: 35, fixedGain: 0.15, description: '一杯香甜奶茶，带着茶香。' },
  { id: 'cake', name: '小蛋糕', aliases: ['蛋糕'], price: 60, fixedGain: 0.2, description: '一块松软的奶油蛋糕。' },
  { id: 'meal', name: '爱心便当', aliases: ['便当'], price: 100, fixedGain: 0.3, description: '荤素搭配、摆放整齐的热乎便当。' }
];
export function settings(raw = {}) {
  if (!isObject(raw)) fail('INVALID_CONFIG', '投喂设置须为对象。');
  let foods;
  try { foods = raw.foodsJson === undefined ? DEFAULT_FOODS : JSON.parse(raw.foodsJson); }
  catch { fail('INVALID_CONFIG', '食物配置不是有效 JSON。'); }
  if (!Array.isArray(foods) || foods.length > 50) fail('INVALID_CONFIG', '食物配置须为最多 50 项的数组；[] 暂停新投喂。');
  const names = new Set();
  foods = foods.map(food => {
    if (!isObject(food) || !/^[a-z][a-z0-9-]{0,39}$/.test(food.id)) fail('INVALID_CONFIG', '食物 ID 须为小写字母、数字和连字符。');
    const name = text(food.name, '食物名称', 30);
    const aliases = food.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 10) fail('INVALID_CONFIG', '每种食物最多 10 个别名。');
    const own = new Set([food.id, name, ...aliases.map(v => text(v, '别名', 40))].map(v => v.toLowerCase()));
    for (const label of own) { if (names.has(label)) fail('INVALID_CONFIG', `食物名称或别名重复：${label}`); names.add(label); }
    if (food.enabled !== undefined && typeof food.enabled !== 'boolean') fail('INVALID_CONFIG', 'enabled 须为布尔值。');
    return { id: food.id, name, aliases, price: integer(food.price, '价格', 1, MAX_AMOUNT), fixedGain: gain(food.fixedGain),
      description: text(food.description ?? '', '食物描述', 250, true), reactionHint: text(food.reactionHint ?? '', '反应素材', 200, true),
      enabled: food.enabled !== false };
  });
  const timeZone = text(raw.timeZone ?? 'Asia/Shanghai', '时区', 80);
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { fail('INVALID_CONFIG', '时区无效。'); }
  return { foods, timeZone, dailyLimit: integer(raw.dailyLimit ?? 3, '每日次数', 0, 100),
    cooldownSeconds: integer(raw.cooldownSeconds ?? 1800, '投喂间隔', 0, 604800),
    reactionLength: integer(raw.reactionLength ?? 60, '目标字数', 20, 200),
    dayKey: at => formatter.format(at) };
}
