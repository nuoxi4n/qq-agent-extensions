import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRapportPlugin } from '../../../plugins/rapport/index.js';
import { registerTools } from '../../../plugins/rapport/lib/tools/index.js';

test('查询各返回分支和参数错误都有发送指引，不自动发送或影响管理工具', async () => {
  const tools = {};
  const factory = (id, result) => () => ({ id, parameters: { properties: { target: { type: 'string' } } }, execute: async () => result });
  registerTools({ registerTool: tool => { tools[tool.id] = tool; } }, { isObject: value => value && typeof value === 'object' && !Array.isArray(value) }, [
    factory('check', { content: '没有找到记录。' }), factory('rank', { content: '这个会话还没有记录。' }),
    factory('tune', { content: '参数已设置。' })
  ]);
  for (const id of ['check', 'rank']) {
    const result = await tools[id].execute({}, {});
    assert.match(result.content, /尚未发送到 QQ.*调用 send_message/s);
    assert.equal(result.isError, undefined);
    const error = await tools[id].execute({}, { target: 1 });
    assert.equal(error.isError, true);
    assert.match(error.content, /target 必须是文本/);
    assert.match(error.content, /调用 send_message/);
  }
  assert.deepEqual(await tools.tune.execute({}, {}), { content: '参数已设置。' });
});

test('真实查询流程返回当前提问者分数和发送指引，不发送消息、不误称入群时间', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rapport-query-test-'));
  const previous = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = dir;
  const plugin = createRapportPlugin();
  try {
    const tools = {};
    plugin.setup({ config: () => ({ ownerQq: '99999' }), registerTool: tool => { tools[tool.id] = tool; } });
    await plugin.activate();
    const entry = { senderId: '10001', senderName: '查询者', mid: '1', ts: Date.now(), text: '我的好感度是多少？' };
    const ctx = { chatKey: 'group:12345', kind: 'group', chatId: '12345', selfId: '88888', session: { trigger: [entry], sent: [] },
      store: { recent: () => [entry] }, sender: { sendTextBatch() { assert.fail('查询工具不得自行发送文字'); } } };
    const result = await tools.check.execute(ctx, {});
    assert.equal(result.isError, undefined);
    assert.match(result.content, /对象：查询者（QQ 10001），也就是正在提问的这个人/);
    assert.match(result.content, /好感度：0\.10 分/);
    assert.match(result.content, /等级：Lv\.1「初识」/);
    assert.match(result.content, /首次计分记录：.*不是入群时间/);
    assert.match(result.content, /尚未发送到 QQ.*请调用 send_message/s);
    assert.doesNotMatch(result.content, /认识时间：/);
    assert.deepEqual(ctx.session.sent, []);
    const again = await tools.check.execute(ctx, {});
    assert.match(again.content, /好感度：0\.10 分/, '重复查询不重复计分');
    for (const args of [{ target: '99999' }, { target: '无记录成员' }]) {
      assert.match((await tools.check.execute(ctx, args)).content, /请调用 send_message/);
    }
    assert.match((await tools.rank.execute(ctx, {})).content, /好感度排行榜.*请调用 send_message/s);
    const before = JSON.parse(await fs.readFile(path.join(dir, 'rapport.json'), 'utf8'));
    assert.equal(before.chats['group:12345'].members['10001'].score, 0.1);
  } finally {
    plugin.dispose();
    if (previous === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = previous;
    const resolved = await fs.realpath(dir);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('rapport-query-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
