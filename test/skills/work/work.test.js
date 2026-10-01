import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkPlugin } from '../../../skills/work/index.js';
import { createCurrencyPlugin } from '../../../plugins/currency/index.js';
import { DEFAULTS, DEFAULT_JOBS, settings, defaultEvents, MAX_AMOUNT } from '../../../skills/work/lib/config.js';
import { defaultDataDirectory } from '../../../skills/work/lib/storage.js';

const USER = '10001', SCOPE = 'group:12345';
const START = Date.parse('2026-10-02T02:00:00Z');
const unpack = result => JSON.parse(result.content.split('\n')[0]);
const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const bad = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code, JSON.stringify(result)); return result; };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-'));
  let at = options.at ?? START, failWorkSave = 0, failCurrency = false, afterCreditThrows = false, draws = 0, active = true;
  const config = { ...DEFAULTS, ...options.config };
  const moneyConfig = { currencyName: '星屑', integrationPermissions: '{"work":["credit"]}' };
  const moneyPlugin = createCurrencyPlugin({ directory, now: () => at });
  moneyPlugin.setup({ config: () => moneyConfig, registerTool() {} }); moneyPlugin.activate();
  const client = () => moneyPlugin.providers['currency.v1']({ consumer: 'work' });
  const io = Object.create(fs);
  io.renameSync = (from, to) => {
    if (path.basename(to) === 'work.json' && failWorkSave && --failWorkSave === 0) throw new Error('injected rename failure');
    return fs.renameSync(from, to);
  };
  const tools = {};
  const plugin = createWorkPlugin({ directory, io, now: () => at, draw(max) { draws++; return options.draw ? options.draw(max) : 0; } });
  plugin.setup({ config: () => config, registerTool(tool) { tools[tool.id] = tool; }, isSkillActive: () => active,
    capability(name, args) {
      assert.equal(name, 'currency.v1'); assert.equal(args.consumer, 'work');
      const money = client();
      if (!money) return undefined;
      return { ...money, credit(input) {
        if (failCurrency) return { ok: false, code: 'STORAGE_ERROR', message: 'currency injected failure' };
        const result = money.credit(input);
        if (afterCreditThrows) throw new Error('response lost after credit');
        return result;
      } };
    }
  });
  plugin.activate();
  t.after(() => {
    plugin.dispose(); moneyPlugin.dispose();
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('work-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const context = (mid = '1', userId = USER, scope = SCOPE) => {
    const [kind, chatId] = scope.split(':');
    return { chatKey: scope, kind, chatId, selfId: '88888', session: { chatKey: scope, status: 'running',
      triggerEntries: [{ senderId: userId, mid, ts: at, text: '我要打工' }] },
      sender: { sendTextBatch() { assert.fail('打工工具不直接发送消息'); } } };
  };
  const call = (id, args = {}, ctx = context(args.messageId)) => unpack(tools[id].execute(ctx, args));
  return { directory, plugin, tools, config, moneyConfig, moneyPlugin, client, context, call,
    play: (mid = '1', job = 'tea', ctx) => call('play', { messageId: mid, ...(job === undefined ? {} : { job }) }, ctx),
    balance: (userId = USER, scope = SCOPE) => good(client().balance({ userId, scope })).balance,
    records: () => JSON.parse(fs.readFileSync(path.join(directory, 'work.json'), 'utf8')).records,
    setTime: value => { at = value; }, setFailSave: value => { failWorkSave = value; },
    setFailCurrency: value => { failCurrency = value; }, setLostResponse: value => { afterCreditThrows = value; },
    setActive: value => { active = value; }, get draws() { return draws; }
  };
}

test('清单与运行默认值一致，四职业和自定义模板可用', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../../skills/work/skill.json', import.meta.url), 'utf8'));
  assert.deepEqual({ ...manifest.settings, jobsJson: JSON.parse(manifest.settings.jobsJson) }, { ...DEFAULTS, jobsJson: DEFAULT_JOBS });
  assert.equal(settings().jobs.length, 4);
  const readme = fs.readFileSync(new URL('../../../skills/work/README.md', import.meta.url), 'utf8');
  const snippets = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(settings({ jobsJson: snippets[1][1] }).jobs[0].events.length, 4);
});

test('默认事件区间符合示例，狭窄和最大金额区间仍不越界', () => {
  assert.deepEqual(defaultEvents(10, 80).map(event => [event.weight, event.minReward, event.maxReward]), [[15, 10, 19], [75, 20, 40], [8, 41, 65], [2, 66, 80]]);
  for (const [min, max] of [[1, 1], [2, 3], [1, 5], [20, 100], [1, MAX_AMOUNT], [MAX_AMOUNT, MAX_AMOUNT]]) {
    for (const event of defaultEvents(min, max)) assert.ok(event.minReward >= min && event.maxReward <= max && event.maxReward >= event.minReward);
  }
});

test('只读工具不创建打工文件，不暴露整个职业描述与事件库', t => {
  const f = fixture(t);
  const jobs = good(f.call('jobs'));
  assert.equal(jobs.jobs.length, 4); assert.equal(jobs.currencyName, '星屑');
  assert.equal(jobs.jobs[0].events, undefined); assert.equal(jobs.jobs[0].description, undefined);
  assert.deepEqual(good(f.call('status')).recent, []);
  assert.equal(fs.existsSync(path.join(f.directory, 'work.json')), false);
});

test('一次打工用真实货币入账，包含素材和配额；修改结果不能改存档', t => {
  const f = fixture(t);
  const result = good(f.play());
  assert.equal(result.amount, 10); assert.equal(result.currencyName, '星屑'); assert.equal(result.paid, true);
  assert.equal(result.job, '奶茶店员'); assert.equal(result.event, '不顺事件'); assert.equal(result.remaining, 2);
  assert.equal(result.cooldownRemainingSeconds, 7200); assert.equal(f.balance(), 10);
  assert.equal(result.narrative.targetCharacters, 120); assert.ok(result.narrative.background.includes('奶茶'));
  result.narrative.background = 'changed';
  assert.ok(f.records()[0].job.description.includes('奶茶'));
  const history = good(f.client().history({ scope: SCOPE, userId: USER }));
  assert.equal(history.receipts[0].input.consumer, 'work');
  assert.match(history.receipts[0].input.reason, /趣味打工/);
});

test('随机职业、别名、未知或停用职业不被擅自替换', t => {
  const f = fixture(t, { config: { cooldownSeconds: 0 } });
  const random = good(f.call('play', { messageId: '1' }));
  assert.equal(random.job, '奶茶店员'); assert.equal(f.draws, 3);
  assert.equal(good(f.play('2', '调饮师')).job, '奶茶店员');
  bad(f.play('3', '总统'), 'UNKNOWN_JOB');
  const jobs = structuredClone(DEFAULT_JOBS); jobs[0].enabled = false; f.config.jobsJson = JSON.stringify(jobs);
  bad(f.play('4', 'tea'), 'UNKNOWN_JOB'); assert.equal(f.records().length, 2);
});

test('权重由程序选择，零权重事件不会出现，区间端点可抽中', t => {
  const jobs = [{ ...DEFAULT_JOBS[0], minReward: 1, maxReward: 100, events: [
    { id: 'disabled', name: '停用', weight: 0, minReward: 1, maxReward: 1, prompt: '不会抽中' },
    { id: 'common', name: '普通', weight: 99, minReward: 2, maxReward: 5, prompt: '普通剧情' },
    { id: 'rare', name: '特别大奖', weight: 1, minReward: 90, maxReward: 100, prompt: '神秘老板' }
  ] }];
  const f = fixture(t, { config: { jobsJson: JSON.stringify(jobs) }, draw: max => max - 1 });
  const result = good(f.play()); assert.equal(result.event, '特别大奖'); assert.equal(result.amount, 100);
  assert.equal(result.narrative.eventHint, '神秘老板');
  assert.ok(!JSON.stringify(result).includes('普通剧情'));
});

test('参数不允许模型传入金额、对象或事件，来源必须真实且唯一', t => {
  const f = fixture(t);
  for (const extra of [{ amount: 99999 }, { userId: '10002' }, { event: 'rare' }]) bad(f.call('play', { messageId: '1', ...extra }), 'INVALID_ARGUMENT');
  for (const job of ['', ' tea', 5, 'x\n']) bad(f.call('play', { messageId: '1', job }), 'INVALID_ARGUMENT');
  bad(f.call('play', {}), 'INVALID_ARGUMENT');
  bad(f.call('play', { messageId: '999' }, f.context()), 'INVALID_CONTEXT');
  const other = f.context(); other.session.triggerEntries.push({ senderId: '10002', mid: '2', ts: START });
  bad(f.play('1', 'tea', other), 'AMBIGUOUS_REQUESTER');
  for (const change of [ctx => { ctx.proactive = true; }, ctx => { ctx.session.status = 'done'; }, ctx => { ctx.chatKey = 'group:99999'; }, ctx => { ctx.session.triggerEntries[0].recalled = true; }, ctx => { ctx.session.triggerEntries[0].ts -= 86400001; }]) {
    const ctx = f.context(); change(ctx);
    const result = f.play('1', 'tea', ctx); assert.equal(result.ok, false);
  }
  assert.equal(f.balance(), 0); assert.equal(fs.existsSync(path.join(f.directory, 'work.json')), false);
});

test('数字 QQ/消息编号与 local 编号兼容，私聊不得冒用他人', t => {
  const f = fixture(t, { config: { cooldownSeconds: 0 } });
  good(f.play(123, 'tea', f.context(123, 10001)));
  const ctx = f.context(); delete ctx.session.triggerEntries[0].mid; ctx.session.triggerEntries[0].id = 42;
  good(f.play('local:42', 'tea', ctx));
  bad(f.play('3', 'tea', f.context('3', USER, 'private:10002')), 'INVALID_CONTEXT');
  good(f.play('3', 'tea', f.context('3', USER, 'private:10001')));
});

test('权限或依赖不足不消耗次数；配置修复和开关即时生效', t => {
  const f = fixture(t);
  f.moneyConfig.integrationPermissions = '{}'; bad(f.play(), 'FORBIDDEN'); assert.equal(f.draws, 0);
  f.moneyConfig.integrationPermissions = '{"work":["credit"]}';
  f.moneyPlugin.deactivate(); bad(f.play(), 'UNAVAILABLE'); f.moneyPlugin.activate();
  f.config.jobsJson = '{'; assert.equal(f.plugin.available().ok, false); bad(f.play(), 'INVALID_CONFIG');
  f.config.jobsJson = DEFAULTS.jobsJson; assert.equal(f.plugin.available(), true);
  f.setActive(false); bad(f.play(), 'UNAVAILABLE'); f.setActive(true);
  good(f.play());
  f.plugin.deactivate(); bad(f.play('2'), 'UNAVAILABLE');
});

test('同条消息永久去重，变更参数冲突，重启后不重抽不再发奖', t => {
  const f = fixture(t);
  const first = good(f.play());
  const again = good(f.play()); assert.equal(again.id, first.id); assert.equal(again.replayed, true); assert.equal(f.draws, 2);
  bad(f.play('1', 'developer'), 'IDEMPOTENCY_CONFLICT');
  f.config.minReward = 500; f.config.maxReward = 600; f.config.jobsJson = '[]';
  f.moneyConfig.currencyName = '月亮'; f.plugin.deactivate(); f.plugin.activate();
  const restored = good(f.play()); assert.equal(restored.amount, 10); assert.equal(restored.currencyName, '月亮');
  assert.equal(f.balance(), 10); assert.equal(f.records().length, 1);
});

test('并发同消息只生成一单；不同消息共享每日次数与职业冷却', async t => {
  const f = fixture(t, { config: { cooldownSeconds: 0 } });
  const repeated = await Promise.all(Array.from({ length: 20 }, async () => f.play()));
  assert.equal(repeated.filter(result => result.ok && !result.replayed).length, 1); assert.equal(f.balance(), 10);
  const more = await Promise.all(Array.from({ length: 20 }, async (_, index) => f.play(String(index + 2), 'developer')));
  assert.equal(more.filter(result => result.ok).length, 2); assert.equal(f.balance(), 30);
  bad(f.play('40'), 'DAILY_LIMIT');
});

test('跨日重置次数但保留冷却，群和成员独立', t => {
  const at = Date.parse('2026-10-02T15:30:00Z');
  const f = fixture(t, { at }); good(f.play());
  bad(f.play('2', 'developer'), 'COOLDOWN');
  good(f.play('2', 'developer', f.context('2', '10002')));
  good(f.play('2', 'developer', f.context('2', USER, 'group:23456')));
  f.setTime(at + 3600000);
  const status = good(f.call('status')); assert.equal(status.day, '2026-10-03'); assert.equal(status.remaining, 3); assert.equal(status.cooldownRemainingSeconds, 3600);
  bad(f.play('3'), 'COOLDOWN'); f.setTime(at + 7200000); assert.equal(good(f.play('4')).remaining, 2);
});

test('修改时区由时间戳重算次数，系统时间倒退暂停新单', t => {
  const at = Date.parse('2026-10-02T16:30:00Z');
  const f = fixture(t, { at, config: { cooldownSeconds: 0 } }); good(f.play());
  assert.equal(good(f.call('status')).day, '2026-10-03');
  f.config.timeZone = 'UTC'; assert.equal(good(f.call('status')).used, 1); assert.equal(good(f.call('status')).day, '2026-10-02');
  f.setTime(at - 1); bad(f.play('2'), 'CLOCK_ROLLBACK');
});

test('首次事件保存失败不发钱、不占次数，恢复后可重新开始', t => {
  const f = fixture(t); f.setFailSave(1);
  bad(f.play(), 'STORAGE_ERROR'); assert.equal(f.balance(), 0); assert.equal(good(f.call('status')).used, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'work.json')), false);
  good(f.play()); assert.equal(f.balance(), 10);
});

test('货币写入失败保留抽取结果；跨日和改配置后新请求只恢复原单', t => {
  const f = fixture(t); f.setFailCurrency(true);
  const failed = bad(f.play(), 'STORAGE_ERROR'); assert.equal(failed.record.amount, 10); assert.equal(failed.remaining, 2);
  assert.equal(f.records()[0].status, 'pending'); assert.equal(f.balance(), 0);
  const status = good(f.call('status')); assert.equal(status.recent[0].paid, false); assert.equal(status.recent[0].paymentUnconfirmed, false);
  f.config.dailyLimit = 0; f.config.jobsJson = '[]'; f.config.minReward = 100; f.config.maxReward = 100;
  f.setTime(START + 86400000); f.setFailCurrency(false);
  const recovered = good(f.play('2', 'developer')); assert.equal(recovered.recovered, true); assert.equal(recovered.amount, 10);
  assert.equal(recovered.job, '奶茶店员'); assert.equal(f.balance(), 10); assert.equal(f.records().length, 1); assert.equal(f.draws, 2);
  bad(f.play('3'), 'DAILY_LIMIT');
});

test('入账后响应丢失：只读查询确认已到账，重启通过回执恢复且不再 credit', t => {
  const f = fixture(t); f.setLostResponse(true);
  const failed = bad(f.play(), 'CURRENCY_ERROR'); assert.equal(failed.paymentUnconfirmed, true); assert.equal(f.balance(), 10);
  assert.equal(f.records()[0].status, 'pending');
  const status = good(f.call('status')); assert.equal(status.recent[0].paid, true); assert.equal(status.pending, true);
  assert.equal(f.records()[0].status, 'pending'); // 查询不写入。
  f.plugin.deactivate(); f.plugin.activate();
  f.moneyConfig.integrationPermissions = '{}'; // 已成功交易即使权限收回，也能核对并补记。
  const recovered = good(f.play('2')); assert.equal(recovered.recovered, true); assert.equal(f.balance(), 10);
  assert.equal(f.records()[0].status, 'paid'); assert.equal(good(f.call('status')).pending, false);
});

test('钱已到账但完成标记保存失败，明确返回 paid 并阻止下一次抽取', t => {
  const f = fixture(t); f.setFailSave(2);
  const result = good(f.play()); assert.equal(result.paid, true); assert.equal(result.recoveryRequired, true); assert.match(result.warning, /已到账/);
  assert.equal(f.records()[0].status, 'pending'); assert.equal(f.balance(), 10);
  f.setFailSave(2); // 第一笔保存新恢复消息，第二笔保存完成标记。
  const retry = good(f.play('2', 'developer')); assert.equal(retry.recovered, true); assert.equal(retry.recoveryRequired, true);
  assert.equal(f.draws, 2); assert.equal(f.balance(), 10);
  good(f.play('3')); assert.equal(f.records()[0].status, 'paid'); assert.equal(f.balance(), 10);
});

test('恢复消息完成后重放仍对应原单，跨重启也不会当作新打工', t => {
  const f = fixture(t, { config: { cooldownSeconds: 0 } }); f.setFailCurrency(true);
  bad(f.play(), 'STORAGE_ERROR'); f.setFailCurrency(false);
  const restored = good(f.play('2', 'developer')); assert.equal(restored.recovered, true);
  const replay = good(f.play('2', 'developer')); assert.equal(replay.id, restored.id); assert.equal(replay.replayed, true);
  assert.equal(f.records().length, 1); assert.equal(f.draws, 2); assert.equal(f.balance(), 10);
  bad(f.play('2', 'tea'), 'IDEMPOTENCY_CONFLICT');
  f.plugin.deactivate(); f.plugin.activate(); good(f.play('2', 'developer')); assert.equal(f.balance(), 10);
  good(f.play('3', 'developer')); assert.equal(f.balance(), 20);
});

test('恢复请求关联保存失败时不继续发奖，原待结算记录保持不变', t => {
  const f = fixture(t); f.setFailCurrency(true); bad(f.play(), 'STORAGE_ERROR');
  f.setFailCurrency(false); f.setFailSave(1); bad(f.play('2'), 'STORAGE_ERROR');
  assert.equal(f.balance(), 0); assert.deepEqual(f.records()[0].recoveries, []);
  good(f.play('2')); assert.equal(f.balance(), 10); assert.equal(f.records()[0].recoveries.length, 1);
});

test('货币余额上限失败保留原单，不截断金额或刷取新事件', t => {
  const f = fixture(t);
  good(f.client().credit({ scope: SCOPE, userId: USER, amount: MAX_AMOUNT, requestId: 'seed', reason: '测试' }));
  bad(f.play(), 'BALANCE_LIMIT'); bad(f.play('2', 'developer'), 'BALANCE_LIMIT');
  assert.equal(f.records().length, 1); assert.equal(f.draws, 2); assert.equal(f.balance(), MAX_AMOUNT);
});

test('配置严格校验边界、名称碰撞、事件范围和权重', () => {
  for (const raw of [{ minReward: 0 }, { minReward: 1.5 }, { maxReward: '80' }, { maxReward: 5 }, { minReward: null },
    { dailyLimit: -1 }, { cooldownSeconds: Infinity }, { storyLength: 1000 }, { timeZone: 'somewhere' }, { jobsJson: '{}' }, { jobsJson: '{' }]) {
    assert.throws(() => settings(raw), /./, JSON.stringify(raw));
  }
  const base = DEFAULT_JOBS[0];
  const event = { id: 'test', name: '测试', weight: 1, minReward: 10, maxReward: 80, prompt: '事件' };
  const invalidJobs = [
    [{ ...base, surprise: true }], [{ ...base, enabled: 'true' }], [{ ...base, aliases: [1] }],
    [base, { ...DEFAULT_JOBS[1], aliases: ['TEA'] }], [base, { ...base, name: '重复' }],
    [{ ...base, events: [] }], [{ ...base, events: [{ ...event, minReward: 9 }] }],
    [{ ...base, events: [{ ...event, maxReward: 81 }] }], [{ ...base, events: [{ ...event, weight: 0 }] }],
    [{ ...base, events: [{ ...event, weight: 0.5 }] }], [{ ...base, events: [event, event] }],
    [{ ...base, events: [{ ...event, probability: 20 }] }]
  ];
  for (const jobs of invalidJobs) assert.throws(() => settings({ jobsJson: JSON.stringify(jobs) }), /职业/);
});

test('存档损坏停止写入保留原文件，不把读错数据当新用户', t => {
  const f = fixture(t); good(f.play()); f.plugin.deactivate();
  const file = path.join(f.directory, 'work.json'), original = fs.readFileSync(file, 'utf8');
  const broken = JSON.parse(original); broken.records[0].amount = 999;
  const text = JSON.stringify(broken); fs.writeFileSync(file, text);
  assert.throws(() => f.plugin.activate(), /数据校验失败/); assert.equal(f.plugin.available().ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), text); bad(f.play('2'), 'UNAVAILABLE');
  fs.writeFileSync(file, original); f.plugin.activate(); good(f.play()); assert.equal(f.balance(), 10);
});

test('独占锁阻止多实例写入；锁更换后不删除他人的锁', t => {
  const f = fixture(t);
  const second = createWorkPlugin({ directory: f.directory }); second.setup({ config: () => DEFAULTS, registerTool() {} });
  assert.throws(() => second.activate(), /遗留 work.json.lock/); second.dispose();
  assert.equal(fs.existsSync(path.join(f.directory, 'work.json.lock')), true);
  const lock = path.join(f.directory, 'work.json.lock'); fs.writeFileSync(lock, 'another-instance');
  bad(f.play(), 'STORAGE_LOCKED'); assert.equal(f.balance(), 0);
  f.plugin.deactivate(); assert.equal(fs.readFileSync(lock, 'utf8'), 'another-instance');
});

test('待结算期间丢失写锁，原消息重试也不能继续发奖', t => {
  const f = fixture(t); f.setFailCurrency(true); bad(f.play(), 'STORAGE_ERROR'); f.setFailCurrency(false);
  fs.unlinkSync(path.join(f.directory, 'work.json.lock'));
  bad(f.play(), 'STORAGE_LOCKED'); assert.equal(f.balance(), 0); assert.equal(f.records()[0].status, 'pending');
});

test('同业务编号的货币回执内容不符时停止恢复，不接受他人的金额', t => {
  const f = fixture(t); f.setFailCurrency(true); bad(f.play(), 'STORAGE_ERROR');
  const saved = f.records()[0];
  good(f.client().credit({ scope: saved.scope, userId: saved.userId, amount: saved.amount + 1, requestId: `work:${saved.id}`, reason: saved.reason }));
  f.setFailCurrency(false); bad(f.play(), 'RECEIPT_MISMATCH'); assert.equal(f.records()[0].status, 'pending');
  bad(f.call('status'), 'RECEIPT_MISMATCH'); assert.equal(f.balance(), 11);
});

test('初始错误配置不阻止存储初始化，修正后无需重启即可使用', t => {
  const f = fixture(t, { config: { jobsJson: '{' } });
  assert.equal(f.plugin.available().ok, false); bad(f.play(), 'INVALID_CONFIG');
  f.config.jobsJson = DEFAULTS.jobsJson; assert.equal(f.plugin.available(), true); good(f.play());
});

test('默认数据目录遵循独立实例规则', () => {
  const url = pathToFileURL(path.join(os.tmpdir(), 'host', 'skills', 'work', 'index.js')).href;
  const legacyUrl = pathToFileURL(path.join(os.tmpdir(), 'host', 'plugins', 'work', 'index.js')).href;
  for (const env of [{}, { QQ_AGENT_PROFILE: '2' }, { QQ_AGENT_DATA_DIR: os.tmpdir() }]) {
    assert.equal(defaultDataDirectory(url, env), defaultDataDirectory(legacyUrl, env), '迁移目录不得改变数据位置');
  }
  assert.equal(defaultDataDirectory(url, {}), path.join(os.tmpdir(), 'host', 'data') + path.sep);
  assert.equal(defaultDataDirectory(url, { QQ_AGENT_PROFILE: '2' }), path.join(os.tmpdir(), 'host', 'data-2') + path.sep);
  assert.equal(defaultDataDirectory(url, { QQ_AGENT_PROFILE: '../escape' }), path.join(os.tmpdir(), 'host', 'data') + path.sep);
  assert.equal(defaultDataDirectory(url, { QQ_AGENT_DATA_DIR: os.tmpdir() }), path.resolve(os.tmpdir()));
});

test('复制到无宿主源码的独立目录后可注册并完成奖励', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-package-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('work-package-test-')); fs.rmSync(resolved, { recursive: true, force: true });
  });
  const destination = path.join(root, 'skills', 'work');
  fs.cpSync(fileURLToPath(new URL('../../../skills/work/', import.meta.url)), destination, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const mod = await import(pathToFileURL(path.join(destination, 'index.js')).href);
  const f = fixture(t); const tools = {};
  const plugin = mod.createWorkPlugin({ directory: path.join(root, 'data'), now: () => START, draw: () => 0 });
  plugin.setup({ config: () => DEFAULTS, registerTool: tool => { tools[tool.id] = tool; }, capability: () => f.client() });
  plugin.activate();
  try { good(unpack(tools.play.execute(f.context(), { messageId: '1', job: 'tea' }))); assert.equal(f.balance(), 10); }
  finally { plugin.dispose(); }
});
