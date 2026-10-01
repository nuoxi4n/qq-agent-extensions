import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRapportPlugin } from '../../../plugins/rapport/index.js';
import { eventKey } from '../../../plugins/rapport/lib/events.js';
import { recordQuestEvent, rateQuestEvent } from '../../../plugins/rapport/examples/quest.js';

const actor = { scope: 'group:12345', userId: '10001' };
const grants = ['recordEvent', 'rateEvent', 'bindMessage'];
function fixture(t, settings = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rapport-events-'));
  const previous = process.env.QQ_AGENT_DATA_DIR, realNow = Date.now;
  process.env.QQ_AGENT_DATA_DIR = directory;
  let now = new Date().setHours(12, 0, 0, 0), plugin;
  Date.now = () => now;
  const file = path.join(directory, 'rapport.json');
  const config = { perMessage: 0, atBotBonus: 0, decayEnabled: false, aiCooldownSeconds: 0,
    integrationPermissions: JSON.stringify({ quest: grants, gardening: grants }), ...settings };
  const tools = {};
  const boot = () => { plugin = createRapportPlugin(); plugin.setup({ config: () => config, registerTool: tool => { tools[tool.id] = tool; } }); plugin.activate(); };
  t.after(() => {
    try { plugin?.dispose(); } finally {
      Date.now = realNow;
      if (previous === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = previous;
      const absolute = fs.realpathSync(directory);
      assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(absolute).startsWith('rapport-events-'));
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  });
  boot();
  return { config, tools, file, get plugin() { return plugin; },
    client: (consumer = 'quest') => plugin.providers['rapport.v1']({ consumer }),
    input: (eventId = 'quest:42', extra = {}) => ({ ...actor, eventId, at: now, mode: config.aiMode ? 'ai' : 'normal', fixedDelta: 0.1, reason: '完成任务', ...extra }),
    advance: ms => { now += ms; },
    restart: () => { plugin.dispose(); boot(); },
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    rewrite: change => { plugin.deactivate(); const db = JSON.parse(fs.readFileSync(file, 'utf8')); change(db); fs.writeFileSync(file, JSON.stringify(db)); },
    ctx: (userId = '99999') => ({ chatKey: actor.scope, kind: 'group', chatId: '12345', selfId: '88888',
      session: { status: 'running', triggerEntries: [{ senderId: userId, mid: '999', ts: now, text: '重置好感度' }], sent: [] }, store: { recent: () => [] } })
  };
}
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };

test('通用 v1：任意扩展按来源与会话隔离事件，返回快照且不暴露旧方法', t => {
  const f = fixture(t), quest = f.client(), garden = f.client('gardening');
  assert.deepEqual(Object.keys(f.plugin.providers), ['rapport.v1']);
  assert.equal(quest.apiVersion, 1); assert.equal(quest.consumer, 'quest');
  for (const method of ['deliver', 'receipt', 'info', 'bind', 'rate']) assert.equal(quest[method], undefined);
  const input = f.input('same-id'), original = ok(quest.recordEvent(input));
  assert.equal(original.event.applied, 0.1);
  const key = { ...actor, eventId: input.eventId };
  assert.equal(garden.getEvent(key).code, 'NOT_FOUND');
  assert.equal(garden.bindMessage({ ...key, messageId: '5' }).code, 'NOT_FOUND');
  assert.equal(garden.rateEvent({ ...key, delta: 0, reason: '保持' }).code, 'NOT_FOUND');
  assert.notEqual(ok(garden.recordEvent(input)).event.id, original.event.id);
  assert.equal(ok(quest.getState(actor)).score, 0.2);
  assert.equal(ok(quest.recordEvent({ ...input, scope: 'group:12346' })).event.applied, 0.1);
  assert.equal(quest.recordEvent({ ...input, userId: '10002' }).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(quest.getEvent({ ...key, userId: '10002' }).code, 'NOT_FOUND');
  original.event.input.reason = '篡改返回值';
  assert.equal(ok(quest.getEvent(key)).event.input.reason, '完成任务');
});

test('默认禁止写入，权限动态授予和撤回，原型属性不被当成授权', t => {
  const f = fixture(t, { integrationPermissions: '{}' }), api = f.client();
  assert.deepEqual(ok(api.getState(actor)).permissions, []);
  assert.equal(api.recordEvent(f.input()).code, 'FORBIDDEN');
  assert.equal(f.client('constructor').recordEvent(f.input()).code, 'FORBIDDEN');
  f.config.integrationPermissions = JSON.stringify({ quest: grants });
  ok(api.recordEvent(f.input()));
  f.config.integrationPermissions = '{}';
  assert.equal(api.bindMessage({ ...actor, eventId: 'quest:42', messageId: '3' }).code, 'FORBIDDEN');
  assert.equal(api.recordEvent(f.input()).code, 'FORBIDDEN');
  ok(api.getEvent({ ...actor, eventId: 'quest:42' }));
});

test('错误权限配置可修复；旧 v1 对象在停用和重启后失效', t => {
  const f = fixture(t), api = f.client();
  for (const raw of ['broken', '[]', '{"quest":["anything"]}', '{"bad/id":[]}']) {
    f.config.integrationPermissions = raw;
    assert.equal(f.plugin.available().ok, false);
    assert.equal(api.getState(actor).code, 'INVALID_CONFIG');
    assert.equal(api.recordEvent(f.input()).code, 'INVALID_CONFIG');
  }
  f.config.integrationPermissions = JSON.stringify({ quest: grants });
  assert.equal(f.plugin.available(), true);
  ok(api.recordEvent(f.input()));
  f.restart();
  assert.equal(api.getState(actor).ok, false);
  ok(f.client().getState(actor));
});

test('固定加减精确应用，共享每日额度；扣分需要额外授权且不返还加分额度', t => {
  const f = fixture(t, { dailyCap: 0.2, aiDailyLossCap: 0.1 }), api = f.client();
  const negative = f.input('penalty', { fixedDelta: -0.1 });
  assert.equal(api.recordEvent(negative).code, 'FORBIDDEN');
  f.config.integrationPermissions = JSON.stringify({ quest: [...grants, 'decrease'] });
  assert.equal(ok(api.recordEvent(negative)).event.applied, -0.1);
  assert.equal(ok(api.recordEvent(f.input('reward', { fixedDelta: 0.2 }))).event.score, 0.1);
  assert.equal(ok(api.recordEvent(f.input('extra'))).event.status, 'rejected');
  assert.equal(ok(api.recordEvent(f.input('extra-loss', { fixedDelta: -0.01 }))).event.status, 'rejected');
  assert.equal(ok(api.getState(actor)).remainingGain, 0);
  assert.equal(ok(api.getState(actor)).remainingLoss, 0);
});

test('AI 正负评分裁剪事件与当前上限，扣分下限和每日额度均生效', t => {
  const f = fixture(t, { aiMode: true, aiMinScore: -0.1, aiDailyLossCap: 0.2,
    integrationPermissions: JSON.stringify({ quest: [...grants, 'decrease'] }) }), api = f.client();
  const apply = (id, delta, extra) => {
    ok(api.recordEvent(f.input(id, extra)));
    return ok(api.rateEvent({ ...actor, eventId: id, delta, reason: '事件结果' })).event;
  };
  assert.equal(apply('gain', 9, { maxGain: 0.07 }).applied, 0.07);
  assert.equal(apply('loss', -9, { maxGain: 0, maxLoss: 0.5 }).applied, -0.17);
  assert.equal(ok(api.getState(actor)).remainingLoss, 0);
  f.config.aiMinScore = -100; f.config.aiMaxLoss = 0.01;
  assert.equal(apply('loss-current-limit', -2, { maxLoss: 1 }).applied, -0.01);
  f.config.aiMaxLoss = 0.3;
  assert.equal(apply('loss-daily-cap', -2, { maxLoss: 1 }).applied, -0.02);
});

test('AI 方向限制和 0 分闭单；已评分的参数不能重写', t => {
  const f = fixture(t, { aiMode: true }), api = f.client(), input = f.input();
  ok(api.recordEvent(input));
  const args = { ...actor, eventId: input.eventId, delta: 0, reason: '无变化' };
  assert.equal(api.rateEvent({ ...args, delta: -0.1 }).code, 'INVALID_ARGUMENT');
  assert.equal(ok(api.rateEvent(args)).event.status, 'rated');
  f.restart();
  assert.equal(ok(f.client().rateEvent(args)).event.applied, 0);
  assert.equal(f.client().rateEvent({ ...args, delta: 0.01 }).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.client().rateEvent({ ...args, reason: '另一个理由' }).code, 'IDEMPOTENCY_CONFLICT');
  ok(f.client().recordEvent(f.input('neutral', { maxGain: 0 })));
  assert.equal(f.client().rateEvent({ ...args, eventId: 'neutral', delta: 0.01 }).code, 'INVALID_ARGUMENT');
});

test('AI 扣分授权在登记和评分时均检查，撤权后可用 0 结束待评事件', t => {
  const f = fixture(t, { aiMode: true }), api = f.client(), input = f.input('loss', { maxLoss: 1 });
  assert.equal(api.recordEvent(input).code, 'FORBIDDEN');
  f.config.integrationPermissions = JSON.stringify({ quest: [...grants, 'decrease'] });
  ok(api.recordEvent(input));
  f.config.integrationPermissions = JSON.stringify({ quest: grants });
  assert.equal(api.rateEvent({ ...actor, eventId: 'loss', delta: -0.1, reason: '扣分' }).code, 'FORBIDDEN');
  assert.equal(ok(api.rateEvent({ ...actor, eventId: 'loss', delta: 0, reason: '保持' })).event.applied, 0);
});

test('业务 ID 不依赖消息，参数顺序无关；参数改动和未知字段被拒绝', t => {
  const f = fixture(t), api = f.client(), input = f.input('每日任务/2026-10-02');
  const result = ok(api.recordEvent(input));
  assert.deepEqual(result.event.messages, []);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(ok(api.recordEvent(reordered)).event, result.event);
  assert.equal(api.recordEvent({ ...input, fixedDelta: 0.2 }).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(api.recordEvent({ ...input, food: '蛋糕' }).code, 'INVALID_ARGUMENT');
  assert.equal(api.getState({ ...actor, eventId: input.eventId }).code, 'INVALID_ARGUMENT');
  for (const extra of [{ at: input.at + 60001 }, { fixedDelta: 0.001 }, { scope: 'private:10002' }, { messageId: 'fake' }]) {
    assert.equal(api.recordEvent({ ...input, ...extra }).code, 'INVALID_ARGUMENT');
  }
  f.restart();
  assert.deepEqual(ok(f.client().recordEvent(reordered)).event, result.event);
  assert.equal(ok(f.client().getState(actor)).score, 0.1);
});

test('关联消息跨来源互斥，恢复绑定与普通 AI 评分互斥', async t => {
  const f = fixture(t, { aiMode: true }), api = f.client();
  ok(api.recordEvent(f.input('one', { messageId: '11' })));
  assert.equal(ok(f.client('gardening').recordEvent(f.input('two', { messageId: '11' }))).event.status, 'rejected');
  ok(f.client('gardening').recordEvent(f.input('three')));
  assert.equal(f.client('gardening').bindMessage({ ...actor, eventId: 'three', messageId: '11' }).code, 'ALREADY_RATED');
  ok(api.bindMessage({ ...actor, eventId: 'one', messageId: '12' }));
  assert.deepEqual(ok(api.getEvent({ ...actor, eventId: 'one' })).event.messages, ['11', '12']);
  const ctx = f.ctx('10001'); ctx.session.triggerEntries[0].mid = '12'; ctx.session.triggerEntries[0].text = '感谢帮助，聊得很开心';
  await f.plugin.hooks['before-context']({ ...ctx, triggerEntries: ctx.session.triggerEntries });
  assert.equal((await f.tools.adjust.execute(ctx, { target: '10001', messageId: '12', delta: 0.1, reason: '互动' })).isError, true);
  ctx.session.triggerEntries[0].mid = '13';
  await f.plugin.hooks['before-context']({ ...ctx, triggerEntries: ctx.session.triggerEntries });
  assert.equal((await f.tools.adjust.execute(ctx, { target: '10001', messageId: '13', delta: 0.1, reason: '互动' })).isError, undefined);
  assert.equal(api.bindMessage({ ...actor, eventId: 'one', messageId: '13' }).code, 'ALREADY_RATED');
});

test('跨日待评事件遵守原模式，重置保留回执且旧事件只闭单不恢复分数', async t => {
  const f = fixture(t, { ownerQq: '99999' }), api = f.client(), fixed = f.input('fixed');
  ok(api.recordEvent(fixed));
  f.config.aiMode = true;
  ok(api.recordEvent(f.input('pending')));
  f.advance(86400000);
  f.config.aiMode = false;
  const reset = await f.tools.reset.execute(f.ctx(), { target: '10001', confirm: true });
  assert.equal(reset.isError, undefined, reset.content);
  assert.equal(ok(api.recordEvent(fixed)).event.applied, 0.1);
  assert.equal(ok(api.getState(actor)).score, 0);
  const rated = ok(api.rateEvent({ ...actor, eventId: 'pending', delta: 0.2, reason: '完成旧事件' })).event;
  assert.equal(rated.applied, 0); assert.match(rated.note, /重置/);
  assert.equal(ok(api.recordEvent(f.input('wrong-mode', { mode: 'ai' }))).event.status, 'rejected');
});

test('固定事件不足额度整单拒绝；主人保护、满分与查询衰减仍有效', t => {
  const f = fixture(t, { dailyCap: 0.05 }), api = f.client();
  assert.equal(ok(api.recordEvent(f.input())).event.status, 'rejected');
  f.config.dailyCap = 100;
  f.config.ownerQq = '10001';
  assert.equal(ok(api.getState(actor)).score, 100);
  assert.equal(ok(api.recordEvent(f.input('owner'))).event.status, 'rejected');
  f.config.ownerQq = '';
  assert.equal(ok(api.recordEvent(f.input('full'))).event.status, 'rejected');
  f.config.decayEnabled = true; f.config.decayAfterDays = 0; f.config.decayPerDay = 0.1;
  ok(api.getState(actor)); f.advance(86400000);
  assert.equal(ok(api.getState(actor)).score, 99.9);
  assert.equal(ok(api.getState(actor)).score, 99.9);
  assert.equal(f.read().chats[actor.scope].members[actor.userId].score, 99.9);
});

function legacyEvent(f, messageId, mode, status) {
  const id = createHash('sha256').update(JSON.stringify([actor.scope, actor.userId, messageId])).digest('hex');
  const now = f.input().at;
  return { input: { ...actor, eventId: id, at: now, messageAt: now, messageId, mode, fixedGain: 0.1, aiMaxGain: 0.3 },
    messages: [messageId, `local:${messageId}`], status,
    ...(status === 'rated' ? { requested: mode === 'normal' ? 0.1 : 0, applied: mode === 'normal' ? 0.1 : 0,
      score: 0.1, level: 1, ratedAt: now, reason: '旧评分' } : {}) };
}

test('迁移本地旧投喂回执保留固定、待评与 0 分结果，不重新计分', t => {
  const f = fixture(t, { integrationPermissions: JSON.stringify({ feeding: grants, quest: grants }) });
  ok(f.client().recordEvent(f.input()));
  const list = [legacyEvent(f, '21', 'normal', 'rated'), legacyEvent(f, '22', 'ai', 'pending'), legacyEvent(f, '23', 'ai', 'rated')];
  f.rewrite(db => {
    db.feedingEvents = Object.fromEntries(list.map(e => [e.input.eventId, e]));
    delete db.chats[actor.scope].members[actor.userId].aiRated;
  });
  f.restart();
  assert.equal(f.read().feedingEvents, undefined);
  const api = f.client('feeding');
  assert.equal(ok(api.getState(actor)).score, 0.1);
  for (const old of list) {
    const result = ok(api.getEvent({ ...actor, eventId: old.input.eventId })).event;
    assert.equal(result.status, old.status); assert.deepEqual(result.messages, old.messages);
    const { consumer, ...args } = result.input;
    assert.deepEqual(ok(api.recordEvent(args)).event, result);
  }
  assert.equal(ok(api.rateEvent({ ...actor, eventId: list[1].input.eventId, delta: 0.07, reason: '补完原评分' })).event.applied, 0.07);
  assert.equal(api.rateEvent({ ...actor, eventId: list[2].input.eventId, delta: 0.1, reason: '重评' }).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(ok(f.client().recordEvent(f.input('new-after-migration', { messageId: '99' }))).event.applied, 0.1);
});

test('损坏或冲突的旧回执停止迁移且不覆盖原文件', t => {
  const f = fixture(t), legacy = legacyEvent(f, '31', 'normal', 'rated');
  f.rewrite(db => { db.feedingEvents = { [legacy.input.eventId]: { ...legacy, applied: 999 } }; });
  let original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.restart(), /回执损坏/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const db = JSON.parse(original);
  db.feedingEvents[legacy.input.eventId] = legacy;
  const { fixedGain, aiMaxGain, messageAt, ...rest } = legacy.input;
  const input = { consumer: 'feeding', ...rest, occurredAt: messageAt, fixedDelta: fixedGain, maxGain: aiMaxGain, maxLoss: 0, reason: '投喂互动' };
  const id = eventKey('feeding', actor.scope, input.eventId);
  db.integrationEvents = { [id]: { ...legacy, input, id, reason: '冲突的旧结果' } };
  fs.writeFileSync(f.file, JSON.stringify(db)); original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.restart(), /冲突/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('重复发送防护按授权扩展匹配，不写死具体玩法或拦截无关工具', t => {
  const f = fixture(t), hook = f.plugin.hooks['before-tool'];
  const session = { sent: [{ type: 'text', text: '已完成' }] };
  const send = () => hook({ toolName: 'send_message', argsRaw: { messages: ['已完成'] }, session });
  hook({ toolName: 'unknown__do', session }); assert.equal(send(), undefined);
  hook({ toolName: 'quest__complete', session }); assert.equal(send().block, true);
  const other = { sent: [{ type: 'text', text: '已完成' }] };
  f.config.integrationPermissions = '{}';
  hook({ toolName: 'quest__complete', session: other });
  assert.equal(hook({ toolName: 'send_message', argsRaw: { messages: ['已完成'] }, session: other }), undefined);
});

test('通用任务接入示例核验完成状态、复用业务输入且不重复计分', t => {
  const f = fixture(t, { aiMode: true });
  const host = { capability: (name, args) => f.plugin.providers[name](args) };
  const quest = { completed: true, rapportInput: f.input('quest-example') };
  assert.throws(() => recordQuestEvent(host, { ...quest, completed: false }), /未完成/);
  assert.equal(ok(recordQuestEvent(host, quest)).event.status, 'pending');
  assert.equal(ok(rateQuestEvent(host, quest, { delta: 0.07, reason: '完成任务' })).event.applied, 0.07);
  f.restart();
  assert.equal(ok(recordQuestEvent(host, quest)).event.status, 'rated');
  assert.equal(ok(f.client().getState(actor)).score, 0.07);
});
