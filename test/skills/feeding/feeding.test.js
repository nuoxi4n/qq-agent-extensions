import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeedingSkill } from '../../../skills/feeding/index.js';
import { createCurrencyPlugin } from '../../../plugins/currency/index.js';
import { createRapportPlugin } from '../../../plugins/rapport/index.js';
import { settings, DEFAULT_FOODS } from '../../../skills/feeding/lib/config.js';
import { defaultDataDirectory } from '../../../skills/feeding/lib/storage.js';

const parse = result => JSON.parse(result.content.split('\n')[0]);
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feeding-test-'));
  const oldDir = process.env.QQ_AGENT_DATA_DIR, realNow = Date.now;
  process.env.QQ_AGENT_DATA_DIR = directory;
  let at = new Date().setHours(12, 0, 0, 0), seq = 0, skill, rapport, currency;
  Date.now = () => at;
  const config = { dailyLimit: 3, cooldownSeconds: 0, ...options.feeding };
  const rapportConfig = { integrationPermissions: JSON.stringify({ feeding: ["recordEvent", "rateEvent", "bindMessage"] }), perMessage: 0, atBotBonus: 0, dailyCap: 2, decayEnabled: false, aiCooldownSeconds: 0, ...options.rapport };
  const currencyConfig = { integrationPermissions: JSON.stringify({ funding: ['credit'], feeding: ['reserve', 'capture', 'release'] }) };
  const tools = {}, rapportTools = {}, faults = {}, enabled = { feeding: true, rapport: true, currency: true };
  let failSave = 0, saveCount = 0;
  const io = { ...fs, renameSync(from, to) { if (String(to).endsWith('feeding.json') && ++saveCount === failSave) throw new Error('模拟订单落盘失败'); fs.renameSync(from, to); } };
  const bridge = (object, prefix) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key,
    typeof value !== 'function' ? value : args => faults[`${prefix}.${key}`] ? faults[`${prefix}.${key}`](args, value) : value(args)]));
  const boot = async () => {
    currency = createCurrencyPlugin({ directory, now: () => at });
    currency.setup({ config: () => currencyConfig, registerTool() {}, isSkillActive: id => enabled[id] }); currency.activate();
    rapport = createRapportPlugin();
    rapport.setup({ config: () => rapportConfig, registerTool: tool => { rapportTools[tool.id] = tool; }, isSkillActive: id => enabled[id] });
    await rapport.activate();
    skill = createFeedingSkill({ directory, io, now: () => at });
    skill.setup({ config: () => config, registerTool: tool => { tools[tool.id] = tool; }, isSkillActive: id => enabled[id],
      capability: (name, args) => {
        if (name === 'currency.v1') return enabled.currency ? bridge(currency.providers[name](args), 'money') : undefined;
        return enabled.rapport ? bridge(rapport.providers[name](args), 'rapport') : undefined;
      }, fetch() { assert.fail('不能请求额外模型'); } });
    skill.activate();
  };
  await boot();
  const funding = () => currency.providers['currency.v1']({ consumer: 'funding' });
  const credit = (amount = 1000, scope = 'group:12345', userId = '10001') => assert.equal(funding().credit({ scope, userId, amount, requestId: `seed-${++seq}`, reason: '测试资金' }).ok, true);
  credit(options.balance ?? 1000);
  t.after(() => {
    try { skill.dispose(); rapport.dispose(); currency.dispose(); }
    finally {
      Date.now = realNow;
      if (oldDir === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = oldDir;
      const absolute = fs.realpathSync(directory);
      assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(absolute).startsWith('feeding-test-'));
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  });
  async function message(text = '买个饼干投喂你', userId = '10001', scope = 'group:12345') {
    const [kind, chatId] = scope.split(':');
    const entry = { senderId: userId, senderName: userId, mid: String(++seq), ts: at, text };
    const ctx = { chatKey: scope, kind, chatId, selfId: '88888', store: { recent: () => [] },
      session: { id: `session-${seq}`, status: 'running', triggerEntries: [entry], sent: [] },
      sender: { sendTextBatch() { assert.fail('技能不能替 AI 发言'); } } };
    await rapport.hooks['before-context']({ ...ctx, triggerEntries: [entry] });
    return ctx;
  }
  return { directory, config, rapportConfig, currencyConfig, tools, rapportTools, faults, enabled, message, credit,
    advance: ms => { at += ms; }, failNextSave: (offset = 1) => { failSave = saveCount + offset; },
    read: file => JSON.parse(fs.readFileSync(path.join(directory, `${file}.json`), 'utf8')),
    balance: (scope = 'group:12345', userId = '10001') => funding().balance({ scope, userId }),
    feed: (ctx, food = '饼干') => parse(tools.feed.execute(ctx, { messageId: ctx.session.triggerEntries[0].mid, ...(food === null ? {} : { food }) })),
    rate: (ctx, eventId, delta, reason = '本次投喂友善，符合当下互动') => parse(tools.rate.execute(ctx, { messageId: ctx.session.triggerEntries[0].mid, eventId, delta, reason })),
    restart: async () => { skill.dispose(); rapport.dispose(); currency.dispose(); await boot(); },
    get rapport() { return rapport; }, get skill() { return skill; },
    wallet: () => currency.providers['currency.v1']({ consumer: 'feeding' })
  };
}
const member = f => f.read('rapport').chats['group:12345'].members['10001'];

test('通用接口：好感度提示不硬编码任何投喂工具', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  const prompt = () => f.rapport.promptSections(ctx).map(x => x.content).join('\n');
  assert.doesNotMatch(prompt(), /feeding__/);
  f.enabled.feeding = false;
  assert.doesNotMatch(prompt(), /feeding__/);
  delete f.enabled.feeding;
  assert.doesNotMatch(prompt(), /feeding__/);
});

test('审查：结算写入返回 NOT_FOUND 不能标记支付成功或放行评分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  f.faults['money.capture'] = () => ({ ok: false, code: 'NOT_FOUND', message: '预扣记录不可用' });
  const result = f.feed(ctx);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(f.read('feeding').records[0].status, 'pending');
  assert.equal(f.balance().balance, 1000); assert.equal(f.balance().held, 20);
  assert.equal(f.rate(ctx, f.read('feeding').records[0].id, 0.1).code, 'INVALID_EVENT');
  delete f.faults['money.capture'];
  const retry = await f.message('恢复投喂');
  assert.equal(f.feed(retry, null).paid, true); assert.equal(f.balance().balance, 980);
});

test('审查：取消写入返回 NOT_FOUND 仍保留待恢复单和预扣', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.faults['rapport.recordEvent'] = (args, next) => { f.rapportConfig.dailyCap = 0; return next(args); };
  f.faults['money.release'] = () => ({ ok: false, code: 'NOT_FOUND', message: '预扣记录不可用' });
  assert.equal(f.feed(ctx).ok, false);
  assert.equal(f.read('feeding').records[0].status, 'pending');
  assert.equal(f.balance().held, 20);
  delete f.faults['money.release'];
  assert.equal(f.feed(await f.message('恢复投喂'), null).code, 'ORDER_CANCELLED');
  assert.equal(f.balance().held, 0); assert.equal(f.balance().balance, 1000);
});

test('审查：已付款订单缺少两方回执时停止恢复，不能重新预扣', async t => {
  const f = await fixture(t), ctx = await f.message();
  assert.equal(f.feed(ctx).paid, true);
  const absent = () => ({ ok: false, code: 'NOT_FOUND', message: '回执缺失' });
  f.faults['money.receipt'] = absent; f.faults['rapport.getEvent'] = absent;
  let writes = 0;
  f.faults['money.reserve'] = (args, next) => { writes++; return next(args); };
  assert.equal(f.feed(ctx).code, 'RECEIPT_MISMATCH');
  assert.equal(writes, 0);
});

test('默认菜单、真实扣款、固定奖励和原有发送方式', async t => {
  const f = await fixture(t), ctx = await f.message();
  const menu = parse(f.tools.menu.execute(ctx, {}));
  assert.equal(menu.ok, true, JSON.stringify(menu));
  assert.equal(menu.foods.length, 4); assert.equal(menu.currencyName, '金币');
  const result = f.feed(ctx);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.paid, true);
  assert.equal(result.applied, 0.1); assert.equal(result.ratingPending, false);
  assert.equal(f.balance().balance, 980); assert.equal(f.balance().held, 0);
  assert.equal(member(f).score, 0.1); assert.deepEqual(ctx.session.sent, []);
});

test('重复、并发和重启后重放同一订单不重复扣款加分', async t => {
  const f = await fixture(t), ctx = await f.message();
  const results = await Promise.all([f.feed(ctx), f.feed(ctx)]);
  assert.equal(results[0].eventId, results[1].eventId);
  await f.restart();
  assert.equal(f.feed(ctx).replayed, true);
  assert.equal(f.balance().balance, 980); assert.equal(member(f).score, 0.1);
  assert.equal(f.feed(ctx, '奶茶').code, 'IDEMPOTENCY_CONFLICT');
});

test('AI 模式待评、非固定评分、裁剪上限并防止再次评分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  const result = f.feed(ctx);
  assert.equal(result.ratingPending, true); assert.equal(member(f).score, 0);
  assert.equal(f.rate(ctx, result.eventId, 0.07).applied, 0.07);
  assert.equal(f.rate(ctx, result.eventId, 0.07).applied, 0.07);
  assert.equal(f.rate(ctx, result.eventId, 0.2).code, 'IDEMPOTENCY_CONFLICT');
  const next = await f.message();
  assert.equal(f.rate(next, f.feed(next).eventId, 9).applied, 0.3);
  assert.equal(member(f).score, 0.37);
});

test('AI 的 0 分是已完成结果，重启后不能改成加分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  const { eventId } = f.feed(ctx);
  assert.equal(f.rate(ctx, eventId, 0).applied, 0);
  await f.restart();
  assert.equal(f.feed(ctx).ratingPending, false);
  assert.equal(f.rate(ctx, eventId, 0.1).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.balance().balance, 980); assert.equal(member(f).score, 0);
});

test('普通模式拒绝 AI 评分，AI 模式拒绝负分和过多小数', async t => {
  const f = await fixture(t), ctx = await f.message();
  assert.equal(f.rate(ctx, f.feed(ctx).eventId, 0.1).code, 'INVALID_EVENT');
  f.rapportConfig.aiMode = true; f.advance(1000);
  const next = await f.message(), { eventId } = f.feed(next);
  assert.equal(f.rate(next, eventId, -0.1).code, 'INVALID_ARGUMENT');
  assert.equal(f.rate(next, eventId, 0.001).code, 'INVALID_ARGUMENT');
  assert.equal(member(f).score, 0.1);
});

test('共享每日额度，普通模式额度不够不截断奖励也不扣款', async t => {
  const f = await fixture(t, { rapport: { dailyCap: 0.15 } });
  assert.equal(f.feed(await f.message()).ok, true);
  assert.equal(f.feed(await f.message()).code, 'AFFINITY_LIMIT');
  assert.equal(f.balance().balance, 980); assert.equal(member(f).score, 0.1);
});

test('聊天冷却不吞掉固定奖励，返回加分后的真实关系等级', async t => {
  const f = await fixture(t, { rapport: { perMessage: 0.1, gainCooldownSeconds: 3600, levelThresholds: '0.2,20,50,100' } });
  const result = f.feed(await f.message());
  assert.equal(result.applied, 0.1); assert.equal(result.relationship.score, 0.2);
  assert.equal(result.relationship.level, 2);
});

test('主人固定满分保护时不购买，缺插件或货币权限时不扣款', async t => {
  const f = await fixture(t, { rapport: { ownerQq: '10001' } }), ctx = await f.message();
  assert.equal(f.feed(ctx).code, 'AFFINITY_LIMIT');
  f.enabled.rapport = false; assert.equal(f.feed(ctx).code, 'MISSING_DEPENDENCY');
  f.enabled.rapport = true; f.enabled.currency = false; assert.equal(f.feed(ctx).code, 'MISSING_DEPENDENCY');
  f.enabled.currency = true; f.currencyConfig.integrationPermissions = '{"funding":["credit"]}';
  assert.equal(f.feed(ctx).code, 'FORBIDDEN'); assert.equal(f.balance().balance, 1000);
});

test('余额不足取消订单，不占用次数，同消息不会后来偷偷消费', async t => {
  const f = await fixture(t, { balance: 10 }), ctx = await f.message();
  assert.equal(f.feed(ctx).code, 'INSUFFICIENT_FUNDS');
  assert.equal(parse(f.tools.status.execute(ctx, {})).remaining, 3);
  f.credit(100);
  assert.equal(f.feed(ctx).code, 'ORDER_CANCELLED'); assert.equal(f.balance().balance, 110);
  assert.equal(f.feed(await f.message()).ok, true);
});

test('好感度写权限缺失在预扣前拒绝，权限补齐后可使用原请求', async t => {
  const f = await fixture(t, { rapport: { integrationPermissions: '{}' } }), ctx = await f.message();
  const rejected = f.feed(ctx);
  assert.equal(rejected.code, 'FORBIDDEN'); assert.match(rejected.message, /好感度养成/);
  assert.equal(f.balance().balance, 1000); assert.equal(f.balance().held, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'feeding.json')), false);
  f.rapportConfig.integrationPermissions = JSON.stringify({ feeding: ['recordEvent', 'rateEvent', 'bindMessage'] });
  assert.equal(f.feed(ctx).paid, true); assert.equal(f.balance().balance, 980);
});

test('本地旧投喂账本迁移后固定单和待评单仍能恢复，不双扣或重奖', async t => {
  const f = await fixture(t), fixed = await f.message();
  f.feed(fixed); f.rapportConfig.aiMode = true;
  const pending = await f.message(), result = f.feed(pending);
  f.rapport.deactivate();
  const db = f.read('rapport');
  db.feedingEvents = Object.fromEntries(Object.values(db.integrationEvents).map(event => {
    const { id, input, ...rest } = event;
    const { consumer, fixedDelta, maxGain, maxLoss, reason, occurredAt, ...original } = input;
    return [input.eventId, { ...rest, input: { ...original, fixedGain: fixedDelta, aiMaxGain: maxGain, messageAt: occurredAt } }];
  }));
  delete db.integrationEvents;
  fs.writeFileSync(path.join(f.directory, 'rapport.json'), JSON.stringify(db));
  await f.restart();
  assert.equal(f.feed(fixed).replayed, true);
  const retry = await f.message('恢复投喂');
  assert.equal(f.feed(retry, null).eventId, result.eventId);
  assert.equal(f.rate(retry, result.eventId, 0.07).applied, 0.07);
  assert.equal(f.balance().balance, 960); assert.equal(member(f).score, 0.17);
  assert.equal(f.read('rapport').feedingEvents, undefined);
});

test('次数、冷却、停用菜单均限制新订单，跨日仍保持冷却', async t => {
  const f = await fixture(t, { feeding: { dailyLimit: 1, cooldownSeconds: 172800 } });
  assert.equal(f.feed(await f.message()).ok, true);
  assert.equal(f.feed(await f.message()).code, 'DAILY_LIMIT');
  f.advance(86400000);
  assert.equal(f.feed(await f.message()).code, 'COOLDOWN');
  f.config.cooldownSeconds = 0; f.config.foodsJson = '[]';
  assert.equal(f.feed(await f.message()).code, 'UNKNOWN_FOOD');
});

test('拒绝伪造消息、多人请求、会话错配、结束会话及跨用户评分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  assert.equal(parse(f.tools.feed.execute(ctx, { messageId: '99999', food: '饼干' })).code, 'INVALID_CONTEXT');
  assert.equal(f.feed({ ...ctx, chatId: '99999' }).code, 'INVALID_CONTEXT');
  assert.equal(f.feed({ ...ctx, session: { ...ctx.session, status: 'done' } }).code, 'INVALID_CONTEXT');
  const multi = structuredClone({ ...ctx.session, triggerEntries: [...ctx.session.triggerEntries, { senderId: '10002' }] });
  assert.equal(f.feed({ ...ctx, session: multi }).code, 'AMBIGUOUS_REQUESTER');
  const result = f.feed(ctx), other = await f.message('评分', '10002');
  assert.equal(f.rate(other, result.eventId, 0.3).code, 'INVALID_EVENT');
});

test('交付后回执丢失保留预扣，恢复原单且绑定恢复消息', async t => {
  const f = await fixture(t);
  f.faults['rapport.recordEvent'] = (args, next) => { next(args); throw new Error('回执丢失'); };
  const ctx = await f.message();
  assert.equal(f.feed(ctx).ok, false); assert.equal(f.balance().held, 20); assert.equal(member(f).score, 0.1);
  delete f.faults['rapport.recordEvent']; await f.restart();
  const retry = await f.message('恢复投喂'), result = f.feed(retry, null);
  assert.equal(result.ok, true); assert.equal(result.recovered, true);
  assert.equal(f.feed(retry, null).replayed, true);
  assert.equal(f.balance().balance, 980); assert.equal(f.balance().held, 0); assert.equal(member(f).score, 0.1);
});

test('扣款失败恢复不重复发奖励；配置价格改变仍按原订单结算', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.faults['money.capture'] = () => ({ ok: false, code: 'STORAGE_ERROR', message: '模拟钱包保存失败' });
  assert.equal(f.feed(ctx).ok, false); assert.equal(member(f).score, 0.1);
  f.config.foodsJson = JSON.stringify(DEFAULT_FOODS.map(x => ({ ...x, price: 999 })));
  delete f.faults['money.capture'];
  const result = f.feed(await f.message('恢复投喂'), null);
  assert.equal(result.price, 20); assert.equal(f.balance().balance, 980); assert.equal(member(f).score, 0.1);
});

test('扣款成功但订单标记保存失败，重启后恢复且不双扣', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.failNextSave(2);
  assert.equal(f.feed(ctx).code, 'STORAGE_ERROR'); assert.equal(f.balance().balance, 980);
  await f.restart();
  assert.equal(f.feed(await f.message('恢复投喂'), null).ok, true);
  assert.equal(f.balance().balance, 980); assert.equal(member(f).score, 0.1);
});

for (const aiMode of [false, true]) {
  for (const failure of ['失败回执', '异常抛出']) {
    test(`${aiMode ? 'AI' : '普通'}投喂已付款后关系查询${failure}，仍返回成功且不重复消费`, async t => {
      const f = await fixture(t, { rapport: { aiMode } }), ctx = await f.message();
      let reads = 0;
      f.faults['rapport.getState'] = (args, next) => {
        if (++reads === 1) return next(args); // 购买前检查正常，付款后的附加查询失败。
        if (failure === '异常抛出') throw new Error('模拟关系查询抛错');
        return { ok: false, code: 'STORAGE_ERROR', message: '模拟关系查询保存失败' };
      };
      const raw = f.tools.feed.execute(ctx, { messageId: ctx.session.triggerEntries[0].mid, food: '饼干' });
      const result = parse(raw);
      assert.equal(raw.isError, undefined, raw.content);
      assert.equal(result.ok, true); assert.equal(result.paid, true);
      assert.equal(result.ratingPending, aiMode); assert.equal(result.relationship, null);
      assert.match(result.notice, /已完成/); assert.match(result.notice, /不要重新购买/);
      assert.equal(result.recovery, undefined);
      assert.equal(f.balance().balance, 980); assert.equal(f.balance().held, 0);
      assert.equal(member(f).score, aiMode ? 0 : 0.1);
      assert.equal(f.read('feeding').records[0].status, 'paid');
      if (aiMode) assert.equal(result.aiMaxGain, 0.3);
      else assert.equal(result.applied, 0.1);
      const replay = f.feed(ctx);
      assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
      assert.equal(replay.eventId, result.eventId); assert.equal(f.balance().balance, 980);
      delete f.faults['rapport.getState'];
      await f.restart();
      if (aiMode) {
        const retry = await f.message('恢复投喂'), recovered = f.feed(retry, null);
        assert.equal(recovered.eventId, result.eventId); assert.equal(recovered.ratingPending, true);
        assert.equal(f.rate(retry, result.eventId, 0.07).applied, 0.07);
      } else {
        const recovered = f.feed(ctx);
        assert.equal(recovered.replayed, true); assert.equal(recovered.ratingPending, false);
        assert.equal(recovered.relationship.score, 0.1); assert.equal(recovered.notice, undefined);
      }
      assert.equal(f.balance().balance, 980); assert.equal(f.read('feeding').records.length, 1);
      assert.equal(member(f).score, aiMode ? 0.07 : 0.1);
    });
  }
}

test('购买前关系查询失败仍拒绝交易，不返回已付款或创建订单', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.faults['rapport.getState'] = () => ({ ok: false, code: 'STORAGE_ERROR', message: '购买前查询失败' });
  const result = f.feed(ctx);
  assert.equal(result.ok, false); assert.equal(result.code, 'STORAGE_ERROR');
  assert.equal(result.paid, undefined); assert.equal(f.balance().balance, 1000); assert.equal(f.balance().held, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'feeding.json')), false);
});

test('AI 评分成功但本地标记失败，只同步旧结果不重复加分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  const result = f.feed(ctx); f.failNextSave();
  assert.equal(f.rate(ctx, result.eventId, 0.1).code, 'STORAGE_ERROR');
  const recovered = f.feed(await f.message('恢复投喂'), null);
  assert.equal(recovered.ratingPending, false); assert.equal(member(f).score, 0.1);
});

test('AI 已登记投喂阻止日常重复评分；日常先评分则退回预扣', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  f.feed(ctx);
  const adjust = c => f.rapportTools.adjust.execute(c, { target: '10001', messageId: c.session.triggerEntries[0].mid, delta: 0.1, reason: '友善交流' });
  assert.equal((await adjust(ctx)).isError, true);
  f.rate(ctx, f.read('feeding').records[0].id, 0);
  const next = await f.message();
  assert.equal((await adjust(next)).isError, undefined);
  assert.equal(f.feed(next).code, 'ORDER_CANCELLED');
  assert.equal(f.balance().balance, 980); assert.equal(f.balance().held, 0);
});

test('跨日恢复 AI 待评单，切换模式不兑换成固定奖励', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } });
  const original = f.feed(await f.message());
  f.advance(86400000); f.rapportConfig.aiMode = false; f.config.dailyLimit = 0;
  const retry = await f.message('恢复投喂'), result = f.feed(retry, null);
  assert.equal(result.eventId, original.eventId); assert.equal(result.mode, 'ai');
  assert.equal(result.ratingPending, true); assert.equal(f.rate(retry, result.eventId, 0.08).applied, 0.08);
  assert.equal(f.balance().balance, 980);
});

test('重置后旧 AI 事件关闭为 0，固定事件重放不恢复旧分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true, ownerQq: '99999' } });
  const result = f.feed(await f.message()); f.advance(1000);
  const owner = await f.message('重置 10001 好感度', '99999');
  assert.equal((await f.rapportTools.reset.execute(owner, { target: '10001', confirm: true })).isError, undefined);
  const retry = await f.message('恢复投喂'); f.feed(retry, null);
  assert.equal(f.rate(retry, result.eventId, 0.2).applied, 0);
  f.rapportConfig.aiMode = false; f.advance(1000);
  const fixed = await f.message(); f.feed(fixed); f.advance(1000);
  await f.rapportTools.reset.execute(await f.message('重置', '99999'), { target: '10001', confirm: true });
  assert.equal(f.feed(fixed).replayed, true); assert.equal(member(f).score, 0);
});

test('私聊和群聊账户独立；原技能停用和旧能力对象失效', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.feed(ctx); f.credit(100, 'private:10001');
  assert.equal(f.feed(await f.message('投喂', '10001', 'private:10001')).ok, true);
  assert.equal(f.balance('private:10001').balance, 80); assert.equal(f.balance().balance, 980);
  const old = f.rapport.providers['rapport.v1']({ consumer: 'feeding' });
  f.enabled.rapport = false;
  assert.equal(old.getState({ scope: 'group:12345', userId: '10001' }).ok, false);
  f.enabled.rapport = true; await f.restart();
  assert.equal(old.getState({ scope: 'group:12345', userId: '10001' }).ok, false);
});

test('配置校验、数据目录隔离和重复实例写锁', async t => {
  assert.throws(() => settings({ foodsJson: JSON.stringify([...DEFAULT_FOODS, DEFAULT_FOODS[0]]) }));
  assert.throws(() => settings({ foodsJson: JSON.stringify([{ ...DEFAULT_FOODS[0], price: 1.5 }]) }));
  assert.throws(() => settings({ foodsJson: 'oops' })); assert.throws(() => settings({ timeZone: 'bad-zone' }));
  assert.match(defaultDataDirectory(import.meta.url, { QQ_AGENT_PROFILE: '3' }), /data-3/);
  const f = await fixture(t);
  const duplicate = createFeedingSkill({ directory: f.directory });
  assert.throws(() => duplicate.activate(), /占用/); duplicate.dispose();
  const otherRapport = createRapportPlugin(); otherRapport.setup({ config: () => ({}), registerTool() {} });
  assert.throws(() => otherRapport.activate(), /占用/); otherRapport.dispose();
  assert.equal(f.feed(await f.message()).ok, true);
});

test('投喂评分保存失败回滚分数，预扣保留并可恢复', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.faults['rapport.recordEvent'] = (args, next) => {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(to).endsWith('rapport.json')) throw new Error('模拟好感度落盘失败'); return rename(from, to); };
    try { return next(args); } finally { fs.renameSync = rename; }
  };
  assert.equal(f.feed(ctx).code, 'STORAGE_ERROR');
  assert.equal(member(f).score, 0); assert.equal(f.balance().held, 20);
  delete f.faults['rapport.recordEvent'];
  assert.equal(f.feed(await f.message('恢复投喂'), null).applied, 0.1);
  assert.equal(member(f).score, 0.1); assert.equal(f.balance().balance, 980);
});

test('已取消的预扣不会继续交付；未知交付不会自动退款', async t => {
  const f = await fixture(t), ctx = await f.message();
  f.faults['rapport.recordEvent'] = () => ({ ok: false, code: 'UNAVAILABLE', message: '暂不可用' });
  assert.equal(f.feed(ctx).ok, false); assert.equal(f.balance().held, 20);
  const wallet = f.wallet(), scope = ctx.chatKey;
  const hold = wallet.reservations({ scope }).reservations[0];
  assert.equal(wallet.release({ scope, reservationId: hold.id, requestId: 'cancel-test', reason: '确认未交付' }).ok, true);
  delete f.faults['rapport.recordEvent'];
  assert.equal(f.feed(await f.message('恢复投喂'), null).code, 'ORDER_CANCELLED');
  assert.equal(f.balance().balance, 1000); assert.equal(member(f).score, 0);
});

test('恢复消息已按日常评分时，不允许绕过绑定再给原投喂加分', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } });
  const original = f.feed(await f.message());
  const retry = await f.message('恢复投喂');
  await f.rapportTools.adjust.execute(retry, { target: '10001', messageId: retry.session.triggerEntries[0].mid, delta: 0.1, reason: '普通互动' });
  assert.equal(f.feed(retry, null).code, 'ALREADY_RATED');
  assert.equal(f.rate(retry, original.eventId, 0.3).code, 'INVALID_EVENT');
  const clean = await f.message('恢复投喂');
  assert.equal(f.feed(clean, null).eventId, original.eventId);
  assert.equal(f.rate(clean, original.eventId, 0.07).applied, 0.07);
  assert.equal(f.balance().balance, 980);
});

test('评分前额度被用完，0 分回执仍永久结束事件', async t => {
  const f = await fixture(t, { rapport: { aiMode: true } }), ctx = await f.message();
  const { eventId } = f.feed(ctx);
  f.rapportConfig.dailyCap = 0;
  assert.equal(f.rate(ctx, eventId, 0.1).applied, 0);
  f.rapportConfig.dailyCap = 2;
  assert.equal(f.feed(ctx).ratingPending, false);
  assert.equal(f.rate(ctx, eventId, 0.1).applied, 0);
  assert.equal(member(f).score, 0);
});

test('损坏的订单和评分回执不清空、不覆盖原文件', async t => {
  const f = await fixture(t);
  f.feed(await f.message()); f.skill.dispose();
  const orders = path.join(f.directory, 'feeding.json'); fs.writeFileSync(orders, '{bad');
  assert.throws(() => f.skill.activate(), /读取投喂数据/);
  assert.equal(fs.readFileSync(orders, 'utf8'), '{bad');
  f.rapport.deactivate();
  const scores = path.join(f.directory, 'rapport.json'), data = f.read('rapport');
  Object.values(data.integrationEvents)[0].applied = 999;
  const broken = JSON.stringify(data); fs.writeFileSync(scores, broken);
  assert.throws(() => f.rapport.activate(), /回执损坏/);
  assert.equal(fs.readFileSync(scores, 'utf8'), broken);
});
