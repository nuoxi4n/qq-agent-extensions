import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyGuard } from '../../../plugins/rapport/lib/reply-guard.js';

function fixture(text) {
  const guard = createReplyGuard();
  const session = { sent: [{ type: 'text', text }] };
  guard.beforeTool({ toolName: 'rapport__adjust', session });
  return messages => guard.beforeTool({ toolName: 'send_message', argsRaw: JSON.stringify({ messages }), session });
}

test('格式转换后与已发文字相同的 Markdown 和编码消息会被拦截', () => {
  const check = fixture('你好');
  for (const value of [
    '**你好**', '*你好*', '***你好***', '__你好__', '~~你好~~', '`你好`',
    '```text\n你好\n```', '# 你好', '> 你好',
    JSON.stringify('你好'), JSON.stringify(['**你好**']),
    { text: '你好' }, JSON.stringify({ content: '你好' }),
    [{ type: 'text', text: '**你好**' }],
    { content: [{ type: 'text', text: '你好' }] }
  ]) assert.equal(check(value)?.block, true, JSON.stringify(value));
  assert.equal(check(['**你好**', '新内容'])?.block, true);
});

test('链接地址、列表与换行保留区别，不把不同内容误判为重复', () => {
  const check = fixture('你好');
  for (const value of ['你好呀', '[你好](https://example.com)', '- 你好', '你\n好', '"未闭合', { other: '你好' }]) {
    assert.equal(check(value), undefined, JSON.stringify(value));
  }
  assert.equal(fixture('你好 (https://example.com)')('[你好](https://example.com)')?.block, true);
  assert.equal(fixture('• 你好')('- 你好')?.block, true);
  assert.equal(fixture('你好\n世界')([['你好', '世界']])?.block, true);
});

test('已发送文本不重复解析 Markdown 或 JSON，避免误拦截新的内容', () => {
  assert.equal(fixture('**你好**')('你好'), undefined);
  assert.equal(fixture('"你好"')('你好'), undefined);
  assert.equal(fixture('[你好](https://example.com)')('你好 (https://example.com)'), undefined);
});
