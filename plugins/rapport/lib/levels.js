// 等级、衰减和主人固定满级规则；不读取文件。
import { cents, points, formatPoints, boundedScore, SCORE_MAX, validPoints } from './points.js';
export function createLevels(services) {
  const { DAY } = services;

  const LEVEL_TITLES = ['初识', '眼熟', '熟络', '亲近', '知己'];
  const DEFAULT_THRESHOLDS = [5, 20, 50, 100];

  function parseThresholds(text) {
    const parts = String(text).trim().split(/[,，\s]+/).map(Number);
    return parts.length === 4 && parts[3] === SCORE_MAX && parts.every((n, i) => validPoints(n) && n > 0 && (i === 0 || n > parts[i-1])) ? parts : null;
  }

  function levelTable(s) {
    const th = parseThresholds(String(s?.levelThresholds ?? '')) || DEFAULT_THRESHOLDS;
    return [
      { min: th[3], level: 5, title: LEVEL_TITLES[4] },
      { min: th[2], level: 4, title: LEVEL_TITLES[3] },
      { min: th[1], level: 3, title: LEVEL_TITLES[2] },
      { min: th[0], level: 2, title: LEVEL_TITLES[1] },
      { min: 0, level: 1, title: LEVEL_TITLES[0] }
    ];
  }

  function levelOf(score, s) {
    if (Number(score) < 0) return { min: Number(s?.aiMinScore ?? -100), level: 0, title: '疏远' };
    const v = boundedScore(Number(score) || 0);
    const table = levelTable(s);
    for (const L of table) if (v >= L.min) return L;
    return table[table.length - 1];
  }

  function titleOf(score, s) {
    return levelOf(score, s).title;
  }

  function progressText(score, s) {
    const v = boundedScore(Number(score) || 0);
    if (v < 0) return `再攒 ${formatPoints(-v)} 分回到 Lv.1「初识」`;
    const next = levelTable(s).filter((L) => L.min > v).sort((a, b) => a.min - b.min)[0];
    if (!next) return '已经是最高等级「知己」了';
    return `再攒 ${formatPoints(points(cents(next.min) - cents(v)))} 分升到 Lv.${next.level}「${next.title}」`;
  }

  function applyDecay(rec, now, s) {
    if (!rec || typeof rec !== 'object') return 0;
    if (rec.pinned === true) return 0; // 主人恒定满级

    let loss = 0;
    const perDay = s?.decayEnabled === false ? 0 : Math.max(0, Number(s?.decayPerDay) || 0);
    const lastSeen = Number(rec.lastSeen) || 0;
    const graceEnd = lastSeen + Math.max(0, Number(s?.decayAfterDays) || 0) * DAY;
    // 查询不会刷新宽限期；每次只结算尚未结算的完整一天。
    const anchor = Math.max(graceEnd, Number(rec.decayAnchor) || 0);
    if (lastSeen && now > anchor) {
      const days = Math.floor((now - anchor) / DAY);
      if (days > 0) {
        const score = cents(boundedScore(Number(rec.score) || 0));
        const movement = Math.min(Math.abs(score), days * cents(perDay));
        loss = points(movement);
        rec.score = points(score - Math.sign(score) * movement);
        rec.decayed = points(cents(Number(rec.decayed) || 0) + movement);
        rec.decayAnchor = anchor + days * DAY;
      }
    }

    // 无论有没有扣分，都把 level 校正到"当前分数 + 当前门槛"
    // （门槛可能被主人在聊天里改过，存的旧 level 会失效）
    rec.level = levelOf(rec.score, s).level;
    return loss;
  }

  function ownerList(s) {
    const raw = String(s?.ownerQq ?? '');
    return raw
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter((x) => /^[1-9]\d{4,11}$/.test(x));
  }

  function isOwner(userId, s) {
    const uid = String(userId ?? '').trim();
    if (!uid) return false;
    return ownerList(s).includes(uid);
  }

  function ownerPoints(s) {
    return SCORE_MAX;
  }

  function isProtectedOwner(userId, s) { return isOwner(userId, s) && (!s.aiMode || s.aiProtectOwner !== false); }

  function pinOwner(rec, s) {
    const max = ownerPoints(s);
    rec.pinned = true;
    rec.score = max;
    rec.level = levelOf(max, s).level;

  }

  function ownerReport(userId, name, s, isSelfQuery) {
    const max = ownerPoints(s);
    const lv = levelOf(max, s);
    return [
      `对象：${name || userId}（QQ ${userId}）${isSelfQuery ? '，也就是正在提问的这个人' : ''}`,
      `好感度：${formatPoints(max)} 分（满级，主人固定值，不参与加分和衰减）`,
      `等级：Lv.${lv.level}「${lv.title}」 · 身份：主人`,
      '升级进度：已经是最高等级，无需再攒',
      '备注：TA 在这个会话里还没有发言记录，所以没有发言数和首次计分时间可显示。'
    ].join('\n');
  }

  return { parseThresholds, levelTable, levelOf, titleOf, progressText, applyDecay, ownerList, isOwner, isProtectedOwner, ownerPoints, pinOwner, ownerReport, LEVEL_TITLES };
}
