// 分数以百分之一分的整数参与运算，避免 0.1 + 0.2 的浮点尾差。
export const SCORE_MAX = 100;
export const SCORE_MIN = -100;
export function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('分数必须是有限数字。');
  const scaled = Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(scaled)) throw new Error('分数超出安全范围。');
  return scaled || 0;
}
export const points = value => value / 100;
export const roundPoints = value => points(cents(value));
export const formatPoints = value => roundPoints(value).toFixed(2);
export const boundedScore = value => roundPoints(Math.max(SCORE_MIN, Math.min(SCORE_MAX, Number(value))));
export function validPoints(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100))
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}
