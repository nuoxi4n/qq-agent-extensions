// 插件内的纯文本比较规则，与当前 QQ 发送格式对齐；不读取或导入宿主实现。
// 仅用于比较待发内容，session.sent 已是实际发送文本，不能再次转换。
export function replyTexts(input) {
  let value = input;
  if (typeof value === 'string' && /^[\[{"]/.test(value.trim())) {
    try {
      const parsed = JSON.parse(value.trim());
      if (typeof parsed === 'string' || (parsed && typeof parsed === 'object')) value = parsed;
    } catch {}
  }
  return (Array.isArray(value) ? value : [value])
    .map(item => unwrap(item)).filter(text => text !== null)
    .map(text => plainText(text)).filter(Boolean);
}

function unwrap(value, depth = 0) {
  if (depth > 16) return null;
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => unwrap(item, depth + 1)).filter(text => text !== null).join('\n');
  if (typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return value.content.filter(part => part && part.type === 'text').map(part => String(part.text ?? '')).join('\n');
    const text = value.text ?? value.content ?? value.message;
    return typeof text === 'string' ? text : null;
  }
  return String(value);
}

function plainText(text) {
  return text.trim()
    .replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''))
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => alt || url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .split('\n').filter(line => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || !line.includes('|') || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n')
    .replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
