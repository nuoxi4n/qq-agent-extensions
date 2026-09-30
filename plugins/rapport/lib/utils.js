// 通用纯函数：不持有插件状态。
export const DAY = 86400000;
export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function dayString(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(ts) {
  if (!ts) return '未知';
  return dayString(ts);
}

export function chatKeyOf(ctx) {
  if (!ctx) return '';
  const key = String(ctx.chatKey || (ctx.kind && ctx.chatId ? `${ctx.kind}:${ctx.chatId}` : ''));
  return /^(group|private):[1-9]\d{4,11}$/.test(key) ? key : '';
}

export function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function unwrapList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flat(1).filter(Boolean);
  if (typeof x === 'object') {
    for (const k of ['messages', 'entries', 'items', 'list', 'data', 'records']) {
      if (Array.isArray(x[k])) return x[k].filter(Boolean);
    }
  }
  return [];
}

export function firstVal(list) {
  for (const v of list) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    return v;
  }
  return undefined;
}

export function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}
