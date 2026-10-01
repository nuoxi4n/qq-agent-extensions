export const MAX_AMOUNT = 1_000_000_000_000;
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function text(value, label, max = 200, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value !== value.trim()
    || value.length > max || /[\u0000-\u001f]/.test(value)) fail('INVALID_CONFIG', `${label}必须是${empty ? '不超过' : '1~'}${max}字文本，不能有首尾空白或控制字符。`);
  return value;
}
export function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_CONFIG', `${label}必须是 ${min}~${max} 的整数。`);
  return value;
}
function fields(value, allowed, label) {
  if (!isObject(value)) fail('INVALID_CONFIG', `${label}必须是对象。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('INVALID_CONFIG', `${label}.${key} 是未知字段。`);
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value)) fail('INVALID_CONFIG', `${label}须为 1~40 位字母、数字、下划线或连字符。`);
  return value;
}
export const DEFAULT_JOBS = [
  { id: 'tea', name: '奶茶店员', aliases: ['奶茶工', '调饮师'], description: '在经常接到奇怪订单的奶茶店工作，围绕调饮、顾客和店长创作。' },
  { id: 'delivery', name: '外卖骑手', aliases: ['送外卖', '骑手'], description: '在城市里配送外卖，围绕古怪地址、天气和顾客创作，注意交通安全。' },
  { id: 'developer', name: '程序员', aliases: ['写代码', '码农'], description: '在软件公司修 Bug、应对需求和上线事故，用容易理解的程序员笑话创作。' },
  { id: 'space-cleaner', name: '星际清洁工', aliases: ['太空保洁', '清洁工'], description: '清扫太空站，可能遇到失重垃圾、外星乘客和走失的小机器人，轻松科幻。' }
];
export const DEFAULTS = {
  minReward: 10, maxReward: 80, dailyLimit: 3, cooldownSeconds: 7200,
  timeZone: 'Asia/Shanghai', storyLength: 120, style: '轻松幽默，有一点意外和反转，保持机器人原有人设。',
  jobsJson: JSON.stringify(DEFAULT_JOBS, null, 2)
};

// 将整数收入区间分成低、普通、高、稀有四段；极窄区间允许相邻段重合。
export function defaultEvents(min, max) {
  const size = max - min + 1;
  const band = (a, b) => {
    const low = Math.min(max, min + Math.floor(size * a));
    return { minReward: low, maxReward: Math.max(low, Math.min(max, min + Math.floor(size * b) - 1)) };
  };
  return [
    { id: 'unlucky', name: '不顺事件', weight: 15, prompt: '工作出了小岔子，今天收入较少，但仍有工资；不扣已有余额，不造成严重伤害。', ...band(0, 0.15) },
    { id: 'normal', name: '普通事件', weight: 75, prompt: '完成日常工作，加入一个贴合职业的有趣小插曲。', ...band(0.15, 0.45) },
    { id: 'lucky', name: '好运事件', weight: 8, prompt: '意外表现出色、收获小费或获得表扬，解释这次较高的收入。', ...band(0.45, 0.8) },
    { id: 'rare', name: '稀有事件', weight: 2, prompt: '发生罕见且惊喜的转折，例如遇到神秘客户或意外救场，解释丰厚收入。', ...band(0.8, 1) }
  ];
}

export function settings(raw = {}) {
  if (!isObject(raw)) fail('INVALID_CONFIG', '插件配置必须是对象。');
  const s = { ...DEFAULTS, ...raw };
  integer(s.minReward, '默认最低收入', 1, MAX_AMOUNT);
  integer(s.maxReward, '默认最高收入', s.minReward, MAX_AMOUNT);
  integer(s.dailyLimit, '每日次数', 0, 100);
  integer(s.cooldownSeconds, '打工间隔', 0, 604800);
  integer(s.storyLength, '故事目标字数', 40, 300);
  text(s.style, '故事风格', 400, true);
  text(s.timeZone, '时区', 80);
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: s.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { fail('INVALID_CONFIG', '时区无效，例如 Asia/Shanghai。'); }
  if (typeof s.jobsJson !== 'string' || s.jobsJson.length > 100000) fail('INVALID_CONFIG', '职业配置必须是最多 100000 字的 JSON 文本。');
  let jobs;
  try { jobs = JSON.parse(s.jobsJson); } catch { fail('INVALID_CONFIG', '职业配置不是合法 JSON 数组，请检查引号和逗号。'); }
  if (!Array.isArray(jobs) || jobs.length > 30) fail('INVALID_CONFIG', '职业配置必须是数组，最多 30 个职业；[] 暂停新打工。');
  const identifiers = new Set(), names = new Set();
  jobs = jobs.map((job, index) => {
    const label = `职业[${index + 1}]`;
    fields(job, ['id', 'name', 'aliases', 'description', 'enabled', 'minReward', 'maxReward', 'events'], label);
    id(job.id, `${label}.id`);
    if (identifiers.has(job.id)) fail('INVALID_CONFIG', `${label}.id 重复。`);
    identifiers.add(job.id);
    text(job.name, `${label}.name`, 30);
    text(job.description, `${label}.description`, 400);
    const aliases = job.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 8) fail('INVALID_CONFIG', `${label}.aliases 须是最多 8 项的数组。`);
    aliases.forEach(alias => text(alias, `${label}.aliases`, 30));
    // ID、名称和别名共用一个命名空间，避免精确匹配歧义。
    for (const name of new Set([job.id, job.name, ...aliases].map(value => value.toLowerCase()))) {
      if (names.has(name)) fail('INVALID_CONFIG', `${label} 的名称、别名或 ID 与其他职业重复：${name}`);
      names.add(name);
    }
    const enabled = job.enabled ?? true;
    if (typeof enabled !== 'boolean') fail('INVALID_CONFIG', `${label}.enabled 须为布尔值。`);
    const minReward = integer(job.minReward ?? s.minReward, `${label}.minReward`, 1, MAX_AMOUNT);
    const maxReward = integer(job.maxReward ?? s.maxReward, `${label}.maxReward`, minReward, MAX_AMOUNT);
    const events = job.events ?? defaultEvents(minReward, maxReward);
    if (!Array.isArray(events) || !events.length || events.length > 30) fail('INVALID_CONFIG', `${label}.events 须有 1~30 个事件。`);
    const eventIds = new Set();
    const normalizedEvents = events.map((event, eventIndex) => {
      const at = `${label}.events[${eventIndex + 1}]`;
      fields(event, ['id', 'name', 'weight', 'minReward', 'maxReward', 'prompt'], at);
      id(event.id, `${at}.id`);
      if (eventIds.has(event.id)) fail('INVALID_CONFIG', `${at}.id 重复。`);
      eventIds.add(event.id);
      text(event.name, `${at}.name`, 30); text(event.prompt, `${at}.prompt`, 500);
      const weight = integer(event.weight, `${at}.weight`, 0, 1000000);
      const low = integer(event.minReward ?? minReward, `${at}.minReward`, minReward, maxReward);
      const high = integer(event.maxReward ?? maxReward, `${at}.maxReward`, low, maxReward);
      return { id: event.id, name: event.name, weight, minReward: low, maxReward: high, prompt: event.prompt };
    });
    if (!normalizedEvents.some(event => event.weight > 0)) fail('INVALID_CONFIG', `${label} 至少需要一个权重大于 0 的事件。`);
    return { id: job.id, name: job.name, aliases, description: job.description, enabled, minReward, maxReward, events: normalizedEvents };
  });
  const dayKey = at => {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  return { ...s, jobs, dayKey };
}
