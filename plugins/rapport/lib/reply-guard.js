// 仅保护本轮使用过 rapport 工具的回复；使用公开钩子和 session.sent，不接管发送。
import { replyTexts } from './reply-text.js';
export function createReplyGuard() {
  let sessions = new WeakSet();

  function beforeTool({ toolName, argsRaw, session } = {}) {
    if (!session || typeof session !== 'object') return;
    if (['rapport__check', 'rapport__rank', 'rapport__adjust', 'rapport__tune', 'rapport__reset'].includes(toolName)) {
      sessions.add(session);
      return;
    }
    if (toolName !== 'send_message' || !sessions.has(session) || !Array.isArray(session.sent)) return;
    let args;
    try { args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw; } catch { return; }
    const messages = replyTexts(args?.messages);
    const sent = new Set(session.sent.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text.trim()));
    if (messages.some(text => text.trim() && sent.has(text.trim()))) {
      return { block: true, reason: '这批文字包含本会话已经成功发送的相同内容，已阻止重复发送。引用回复和普通回复都算已发送；调分重试不需要重发文字。若有新内容，仅发送尚未发出的部分，否则正常结束。' };
    }
  }

  return { beforeTool, clear() { sessions = new WeakSet(); } };
}
