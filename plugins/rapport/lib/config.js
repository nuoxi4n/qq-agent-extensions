// 配置默认值、校验与聊天覆盖；每次执行时读取最新设置。
export function createConfiguration(services) {
  const { clamp, parseThresholds, readConfig, readOverrides } = services;

  const DEFAULTS = {
    perMessage: 1,
    atBotBonus: 3,
    dailyCap: 20,
    decayAfterDays: 7,
    decayPerDay: 1,
    ownerQq: '',
    levelThresholds: '50,200,500,1000'
  };
  const STYLE_DEFAULTS = {
    relationshipStrength: 3,
    closeStyle: '自然亲近',
    highAffinityNote: '',
    gainCooldownSeconds: 30,
    duplicateWindowMinutes: 10
  };
  const TUNABLE = {
    perMessage: { type: 'number', min: 0, max: 20, label: '每条发言加分' },
    atBotBonus: { type: 'number', min: 0, max: 50, label: '@机器人额外加分' },
    dailyCap: { type: 'number', min: 1, max: 500, label: '每人每天加分上限' },
    decayAfterDays: { type: 'number', min: 0, max: 365, label: '多少天不发言开始衰减' },
    decayPerDay: { type: 'number', min: 0, max: 50, label: '每天衰减多少分' },
    ownerQq: { type: 'qqList', label: '主人 QQ 号' },
    levelThresholds: { type: 'thresholds', label: '等级门槛' },
    relationshipStrength: { type: 'number', min: 1, max: 3, label: '回复变化强度' },
    gainCooldownSeconds: { type: 'number', min: 0, max: 3600, label: '加分间隔秒数' },
    duplicateWindowMinutes: { type: 'number', min: 0, max: 1440, label: '重复内容去重分钟数' },
    closeStyle: { type: 'style', label: '高好感表达风格' },
    highAffinityNote: { type: 'note', label: '高好感表达补充' }
  };

  function coerceValue(meta, raw) {
    const text = String(raw ?? '').trim();
    if (!meta) return { ok: false, error: '未知设置项。' };
    if (!text && ['note','qqList'].includes(meta.type)) return { ok: true, value: '' };
    if (!text) return { ok: false, error: `「${meta.label}」需要一个新值，你没给。` };

    if (meta.type === 'note') return { ok: true, value: text.slice(0, 400) };
    if (meta.type === 'style') {
      return ['自然亲近', '温柔关心', '熟人拌嘴'].includes(text) ? { ok: true, value: text }
        : { ok: false, error: '风格请选择：自然亲近 / 温柔关心 / 熟人拌嘴。' };
    }
    if (meta.type === 'number') {
      const n = (typeof raw === 'number' || typeof raw === 'string') ? Number(text) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `「${meta.label}」要填数字，收到的是「${text}」。` };
      const v = clamp(n, meta.min, meta.max);
      const note = v !== Math.round(n) ? `（超出范围，已收敛到 ${v}）` : '';
      return { ok: true, value: v, note };
    }

    if (meta.type === 'qqList') {
      const parts = text.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (text.replace(/[,，\s]/g, '') === '') return { ok: true, value: '' }; // 允许清空
      if (!parts.length) return { ok: false, error: `「${meta.label}」要填 QQ 号（纯数字，多个用英文逗号分隔），收到的是「${text}」。` };
      for (const p of parts) {
        if (!/^[1-9]\d{4,11}$/.test(p)) return { ok: false, error: `QQ 号「${p}」长度不像正常号码（应为 5~12 位数字）。` };
      }
      return { ok: true, value: parts.join(',') };
    }

    if (meta.type === 'thresholds') {
      const parts = parseThresholds(text);
      return parts ? { ok: true, value: parts.join(',') }
        : { ok: false, error: '等级门槛须为 4 个严格递增的正整数，不能包含小数或无效项。' };
    }

    return { ok: true, value: text };
  }

  function formatVal(v) {
    if (typeof v === 'boolean') return v ? '开' : '关';
    if (v === '' || v === null || v === undefined) return '（空）';
    return String(v);
  }

  function currentSettings() {
    const out = { ...DEFAULTS, ...STYLE_DEFAULTS };
    let c = {};
    try {
      c = readConfig() || {};
    } catch {
      c = {};
    }
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined || v === null || !Object.hasOwn(out, k)) continue;
      out[k] = v;
    }
    const ov = readOverrides();
    if (ov && typeof ov === 'object') {
      for (const [k, v] of Object.entries(ov)) {
        if (v === undefined || v === null) continue;
        if (!Object.prototype.hasOwnProperty.call(out, k)) continue; // 只接受白名单里的键
        out[k] = v;
      }
    }
    for (const [key, value] of Object.entries(out)) {
      const fallback = { ...DEFAULTS, ...STYLE_DEFAULTS }[key];
      const parsed = coerceValue(TUNABLE[key], value);
      out[key] = parsed.ok ? parsed.value : fallback;
    }
    return out;
  }

  return { currentSettings, coerceValue, formatVal, TUNABLE, STYLE_DEFAULTS };
}
