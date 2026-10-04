import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequest } from '../../../skills/ai-image/lib/context.js';

const context = trigger => ({ chatKey: 'group:99999', selfId: '88888', session: { trigger } });

test('单人会话共用 QQ 身份，显式请求返回准确消息边界', () => {
  const first = { id: 1, mid: -10, senderId: '12345' };
  const last = { id: 2, mid: 11, senderId: 12345 };
  const ctx = context([first, last, { id: 3, senderId: '88888', self: true }]);
  assert.equal(resolveRequest(ctx).message, last);
  for (const id of [-10, '-10', '#-10']) {
    const request = resolveRequest(ctx, id);
    assert.equal(request.userId, '12345');
    assert.equal(request.message, first);
  }
  assert.equal(resolveRequest({ ...ctx, chatKey: 'private:12345' }).userId, '12345');
  assert.throws(() => resolveRequest({ ...ctx, chatKey: 'private:67890' }), /用户/);
});

test('多人会话必须指定请求，无视 @ 标记、昵称和最新发言', () => {
  const ctx = context([
    { id: 1, mid: 10, senderId: '12345', text: '@机器人 天气怎样', atMe: true },
    { id: 2, mid: 11, senderId: '67890', text: '画一只猫' }
  ]);
  assert.throws(() => resolveRequest(ctx), /requestMessageId/);
  assert.equal(resolveRequest(ctx, 11).userId, '67890');
  ctx.session.trigger[1].atMe = true;
  assert.throws(() => resolveRequest(ctx), /requestMessageId/);
});

test('拒绝无效编号、历史、引用、撤回消息以及无效身份和边界', () => {
  const entry = { id: 5, mid: 11, senderId: '12345', reply: { mid: 100, sender: '67890' } };
  const ctx = context([entry]);
  for (const id of ['', ' ', {}, [], true, 1.1, Number.MAX_SAFE_INTEGER + 1, 'local:5', 5, 100, 999, '12345']) {
    assert.throws(() => resolveRequest(ctx, id), /requestMessageId/);
  }
  for (const changes of [{ self: true }, { recalled: true }, { isPoke: true }, { senderId: '88888' },
    { senderId: 'invalid' }, { id: 0 }, { id: undefined }, { id: '5' }]) {
    assert.throws(() => resolveRequest(context([{ ...entry, ...changes }]), 11), /消息|用户/);
  }
  assert.throws(() => resolveRequest(context([entry, { ...entry }]), 11), /requestMessageId/);
  assert.throws(() => resolveRequest({ ...ctx, session: { trigger: [entry], chatKey: 'group:12345' } }, 11), /本轮消息/);
});

test('只接受当前宿主 trigger 数组，不读取旧字段或字符串触发类型', () => {
  const entry = { id: 1, mid: 11, senderId: '12345' };
  for (const trigger of ['message', 'proactive', undefined, []]) {
    const ctx = context(trigger);
    ctx.session.triggerEntries = [entry];
    assert.throws(() => resolveRequest(ctx, 11), /消息/);
  }
  const ctx = context([entry]);
  ctx.session.triggerEntries = [{ id: 2, mid: 12, senderId: '67890' }];
  assert.equal(resolveRequest(ctx).userId, '12345');
});
