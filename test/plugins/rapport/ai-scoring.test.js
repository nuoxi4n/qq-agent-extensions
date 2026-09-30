import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRapportPlugin } from '../../../plugins/rapport/index.js';
import { createLevels } from '../../../plugins/rapport/lib/levels.js';
import { cents, formatPoints } from '../../../plugins/rapport/lib/points.js';

const DAY = 86400000;
async function fixture(t, settings = {}, seed) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rapport-ai-test-'));
  const previous = process.env.QQ_AGENT_DATA_DIR, realNow = Date.now;
  let now = new Date().setHours(12, 0, 0, 0), sequence = 0;
  Date.now = () => now;
  process.env.QQ_AGENT_DATA_DIR = directory;
  const config = { aiMode: true, aiCooldownSeconds: 0, perMessage: 1, atBotBonus: 3, dailyCap: 20, aiMaxGain: 3, aiMaxLoss: 3, aiDailyLossCap: 10, decayPerDay: 1, ...settings };
  const tools = {}, entries = [];
  const file = path.join(directory, 'rapport.json');
  if (seed) await fs.writeFile(file, JSON.stringify(seed(now)));
  let plugin;
  const boot = async () => {
    plugin = createRapportPlugin();
    plugin.setup({ config: () => config, registerTool: tool => { tools[tool.id] = tool; },
      fetch() { assert.fail('不允许额外模型请求'); } });
    await plugin.activate();
  };
  await boot();
  t.after(async () => {
    try { plugin.dispose(); } finally {
      Date.now = realNow;
      if (previous === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = previous;
      const resolved = await fs.realpath(directory);
      assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('rapport-ai-test-'));
      await fs.rm(resolved, { recursive: true, force: true });
    }
  });
  const message = async (text = '跟你聊天很开心', userId = '10001', options = {}) => {
    const entry = { senderId: userId, senderName: userId, ts: now, mid: String(++sequence), text, ...options };
    entries.push(entry);
    const ctx = { chatKey: 'group:12345', kind: 'group', chatId: '12345', selfId: '88888',
      session: { id: `session-${sequence}`, status: 'running', trigger: [entry], sent: [] }, store: { recent: () => entries },
      sender: { sendTextBatch() { assert.fail('不能播报调分'); }, sendImage() { assert.fail('不能发图'); } } };
    await plugin.hooks['before-context']({ ...ctx, triggerEntries: [entry] });
    return ctx;
  };
  return { config, tools, message, entries, directory, advance: ms => { now += ms; }, read: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    restart: async () => { plugin.dispose(); await boot(); }, get plugin() { return plugin; },
    adjust: (ctx, delta, target = ctx.session.trigger[0].senderId, messageId = ctx.session.trigger[0].mid) =>
      tools.adjust.execute(ctx, { target, messageId, delta, reason: delta > 0 ? '交流友善且尊重彼此' : '本次互动包含明确冒犯' }) };
}
const member = data => data.chats['group:12345'].members['10001'];

test('普通模式保留机械奖励，AI 模式记录消息但不自动奖励', async t => {
  const f = await fixture(t, { aiMode: false, gainCooldownSeconds: 0 });
  const first = await f.message('你好', '10001', { atMe: true });
  assert.equal(member(await f.read()).score, 4);
  assert.equal((await f.adjust(first, 3)).isError, true);
  f.config.aiMode = true; f.advance(1000);
  const next = await f.message('你很有意思', '10001', { atMe: true });
  assert.equal(member(await f.read()).score, 4);
  assert.equal(JSON.parse((await f.adjust(next, 50)).content).applied, 3);
  assert.equal(member(await f.read()).msgs, 2);
});

test('每日加减额度分别累计，扣分不返还加分额度', async t => {
  const f = await fixture(t, { dailyCap: 5, aiMaxGain: 4, aiMaxLoss: 2, aiDailyLossCap: 3 });
  for (const [wanted, applied] of [[4, 4], [-2, -2], [4, 1], [-2, -1]]) {
    const ctx = await f.message('这条互动不同' + wanted + Math.random());
    assert.equal(JSON.parse((await f.adjust(ctx, wanted)).content).applied, applied);
  }
  for (const delta of [3, -3]) assert.match((await f.adjust(await f.message(), delta)).content, /变化 0/);
  const record = member(await f.read());
  assert.equal(record.score, 2); assert.equal(record.dayGain, 5); assert.equal(record.dayLoss, 3);
});

test('允许负分、遵守下限，重启后可查询负分和调分记录', async t => {
  const f = await fixture(t, { aiMinScore: -2 });
  const ctx = await f.message('这次交流存在冒犯');
  assert.equal(JSON.parse((await f.adjust(ctx, -3)).content).applied, -2);
  await f.restart();
  const result = await f.tools.check.execute(ctx, {});
  assert.match(result.content, /好感度：-2\.00 分/);
  assert.match(result.content, /Lv\.0「疏远」/);
  assert.match(result.content, /再攒 2\.00 分回到/);
  assert.match(result.content, /AI 调分记录/);
  assert.equal(member(await f.read()).score, -2);
});

test('同条互动并发、重试和重启都只计分一次', async t => {
  const f = await fixture(t);
  const ctx = await f.message();
  const results = await Promise.all([f.adjust(ctx, 2), f.adjust(ctx, 2)]);
  assert.equal(results.filter(result => !result.isError).length, 1);
  assert.equal(member(await f.read()).score, 2);
  await f.restart();
  assert.match((await f.adjust(ctx, 2)).content, /已经评过分/);
  assert.equal(member(await f.read()).score, 2);
});

test('拒绝错配作者、伪造消息、纯查询和结束会话', async t => {
  const f = await fixture(t);
  const ctx = await f.message();
  assert.equal((await f.adjust(ctx, 1, '20002')).isError, true);
  assert.equal((await f.adjust(ctx, 1, '10001', '10099')).isError, true);
  const query = await f.message('我的好感度是多少？');
  assert.match((await f.adjust(query, 1)).content, /仅查询/);
  ctx.session.status = 'done';
  assert.equal((await f.adjust(ctx, 1)).isError, true);
  assert.equal(member(await f.read()).score, 0);
});

test('AI 间隔限制生效，普通模式再切回不清空当天额度或重复计分', async t => {
  const f = await fixture(t, { aiCooldownSeconds: 30, dailyCap: 4, gainCooldownSeconds: 0 });
  const first = await f.message();
  await f.adjust(first, 3);
  assert.match((await f.adjust(await f.message(), 1)).content, /间隔内/);
  f.config.aiMode = false; f.advance(31000);
  const ordinary = await f.message('普通模式的一条消息');
  assert.equal(member(await f.read()).dayGain, 4);
  f.config.aiMode = true; f.advance(1000);
  assert.match((await f.adjust(ordinary, 1)).content, /未在 AI 模式中记录/);
  const last = await f.message();
  assert.match((await f.adjust(last, 1)).content, /变化 0/);
  assert.equal(member(await f.read()).score, 4);
});

test('新一天重置每日额度，但旧消息不能在次日再评', async t => {
  const f = await fixture(t, { dailyCap: 2 });
  const old = await f.message(); await f.adjust(old, 2);
  f.advance(DAY);
  assert.equal((await f.adjust(old, 2)).isError, true);
  const current = await f.message();
  assert.equal(JSON.parse((await f.adjust(current, 2)).content).applied, 2);
  assert.equal(member(await f.read()).dayGain, 2);
});

test('主人保护与管理权限分开，AI 模式拒绝修改机械配置', async t => {
  const f = await fixture(t, { ownerQq: '10001' });
  const owner = await f.message('主人这条发言');
  assert.equal(member(await f.read()).score, 100);
  assert.match((await f.adjust(owner, -3)).content, /主人固定满分/);
  const blocked = await f.tools.tune.execute(owner, { action: 'set', item: 'perMessage', value: '9' });
  assert.equal(blocked.isError, true);
  assert.equal((await f.tools.tune.execute(owner, { action: 'set', item: 'aiProtectOwner', value: 'false' })).isError, undefined);
  assert.equal(JSON.parse((await f.adjust(owner, -3)).content).applied, -3);
  assert.equal(member(await f.read()).score, 97);
  assert.equal((await f.tools.tune.execute(owner, { action: 'set', item: 'aiMaxGain', value: '4' })).isError, undefined);
  const stranger = await f.message('给我设置权限', '20002');
  assert.equal((await f.tools.tune.execute(stranger, { action: 'set', item: 'aiMaxGain', value: '50' })).isError, true);
});

test('关系淡化正负都向零靠近，重复查询不重复结算', () => {
  const levels = createLevels({ DAY });
  const now = Date.now(), settings = { decayAfterDays: 7, decayPerDay: 2, decayEnabled: true };
  for (const score of [3, -3]) {
    const rec = { score, lastSeen: now - 10 * DAY };
    levels.applyDecay(rec, now, settings);
    assert.equal(rec.score, 0);
    const decayed = rec.decayed;
    levels.applyDecay(rec, now, settings);
    assert.equal(rec.decayed, decayed);
  }
});

test('关闭淡化期间不补算，重新开启后从切换时刻结算且不占 AI 额度', async t => {
  const f = await fixture(t, { decayEnabled: false, decayAfterDays: 0 }, now => ({
    pluginId: 'rapport', version: 2, meta: {}, chats: { 'group:12345': { members: {
      '10001': { name: '旧成员', score: -10, msgs: 1, firstSeen: now - 20 * DAY, lastSeen: now - 10 * DAY, dayGain: 0 }
    } } }
  }));
  const ctx = { chatKey: 'group:12345', kind: 'group', chatId: '12345', session: { trigger: [], sent: [] }, store: { recent: () => [] } };
  await f.tools.check.execute(ctx, { target: '10001' });
  f.advance(3 * DAY); f.config.decayEnabled = true;
  await f.tools.check.execute(ctx, { target: '10001' });
  assert.equal(member(await f.read()).score, -10);
  f.advance(DAY);
  await f.tools.check.execute(ctx, { target: '10001' });
  assert.equal(member(await f.read()).score, -9);
  assert.equal(member(await f.read()).dayGain, 0);
});

test('切回普通模式不补奖励切换前的未处理历史消息', async t => {
  const f = await fixture(t, { gainCooldownSeconds: 0 });
  await f.message();
  f.entries.push({ senderId: '10001', mid: 'late', ts: Date.now(), text: 'AI 模式期间未扫到的消息' });
  f.advance(1000); f.config.aiMode = false;
  await f.message('切换后新消息');
  assert.equal(member(await f.read()).score, 1);
});

test('AI 规则仅使用当前触发批，负分有独立语气且没有额外消息', async t => {
  const f = await fixture(t);
  const ctx = await f.message('一次不愉快的互动'); await f.adjust(ctx, -1);
  const sections = f.plugin.promptSections(ctx);
  assert.ok(sections.every(section => section.priority <= 99));
  assert.match(sections.map(s => s.content).join('\n'), /Lv\.0「疏远」/);
  assert.match(sections.map(s => s.content).join('\n'), /rapport__adjust/);
  assert.match(sections.map(s => s.content).join('\n'), /合理批评、纠错/);
  assert.deepEqual(ctx.session.sent, []);
});

test('支持真实本地消息编号，撤回消息和空触发批不能回退到旧证据', async t => {
  const f = await fixture(t);
  const ctx = await f.message('有趣的一次讨论', '10001', { mid: undefined, id: '42' });
  assert.equal(JSON.parse((await f.adjust(ctx, 1, '10001', 'local:42')).content).applied, 1);
  const recalled = await f.message('撤回前的消息');
  recalled.session.trigger[0].recalled = true;
  assert.equal((await f.adjust(recalled, 1)).isError, true);
  const empty = { ...ctx, session: { ...ctx.session, trigger: [] } };
  assert.equal((await f.adjust(empty, 1, '10001', 'local:42')).isError, true);
  assert.equal(member(await f.read()).score, 1);
});

test('读取记录期间停用插件不会写入 AI 调分', async t => {
  const f = await fixture(t);
  const ctx = await f.message();
  let release;
  ctx.store = { recent: () => new Promise(resolve => { release = resolve; }) };
  const pending = f.adjust(ctx, 2);
  f.plugin.deactivate();
  release([]);
  assert.equal((await pending).isError, true);
  assert.equal(member(await f.read()).score, 0);
});

test('重置清除对应调分记录且旧消息不能恢复分数', async t => {
  const f = await fixture(t, { ownerQq: '10001', aiProtectOwner: false });
  const ctx = await f.message('一次正常互动');
  await f.adjust(ctx, 2);
  f.advance(1);
  assert.equal((await f.tools.reset.execute(ctx, { target: '10001', confirm: true })).isError, undefined);
  const data = await f.read();
  assert.equal(data.chats['group:12345'].members['10001'], undefined);
  assert.deepEqual(data.chats['group:12345'].aiAudit, []);
  assert.equal((await f.adjust(ctx, 2)).isError, true);
});

test('小数 AI 加减、每日额度和重启后的分数没有浮点尾差', async t => {
  const f = await fixture(t, { aiMaxGain: 0.3, aiMaxLoss: 0.3, dailyCap: 0.35, aiDailyLossCap: 0.2 });
  for (const [delta, expected] of [[0.1, 0.1], [0.2, 0.2], [0.1, 0.05], [-0.15, -0.15], [-0.1, -0.05]]) {
    const result = JSON.parse((await f.adjust(await f.message(), delta)).content);
    assert.equal(result.applied, expected);
  }
  const rec = member(await f.read());
  assert.equal(rec.score, 0.15); assert.equal(rec.dayGain, 0.35); assert.equal(rec.dayLoss, 0.2);
  await f.restart();
  const ctx = await f.message('查询小数展示');
  assert.match((await f.tools.check.execute(ctx, {})).content, /好感度：0\.15 分/);
  assert.match((await f.tools.rank.execute(ctx, {})).content, /0\.15 分/);
  for (const delta of [0.001, -0.001, 1.234, NaN, Infinity, '0.1']) {
    assert.equal((await f.adjust(await f.message(), delta)).isError, true);
  }
  assert.equal(member(await f.read()).score, 0.15);
});

test('普通计分和 AI 调分均不能越过 ±100，封顶只消耗实际额度', async t => {
  const f = await fixture(t, { aiMaxGain: 0.3, aiMaxLoss: 0.3 }, now => ({
    pluginId: 'rapport', version: 2, meta: {}, chats: { 'group:12345': { members: {
      '10001': { name: '边界成员', score: 99.95, msgs: 1, firstSeen: now, lastSeen: now, dayGain: 0 },
      '20002': { name: '负边界成员', score: -99.95, msgs: 1, firstSeen: now, lastSeen: now, dayGain: 0 }
    } } }
  }));
  assert.equal(JSON.parse((await f.adjust(await f.message(), 0.3)).content).applied, 0.05);
  const negative = await f.message('负分边界测试', '20002');
  assert.equal(JSON.parse((await f.adjust(negative, -0.3)).content).applied, -0.05);
  f.config.aiMode = false; f.advance(1000);
  await f.message('普通计分也不能超出上限');
  assert.equal(member(await f.read()).score, 100);
  assert.equal(member(await f.read()).dayGain, 0.05);
  assert.equal((await f.read()).chats['group:12345'].members['20002'].score, -100);
});

test('小数衰减、门槛和默认新称呼正确，不把小数取整后判断等级', () => {
  const levels = createLevels({ DAY });
  assert.equal(levels.levelOf(4.99, {}).title, '初识');
  assert.equal(levels.levelOf(5, {}).title, '眼熟');
  assert.equal(levels.levelOf(20, {}).title, '熟络');
  assert.equal(levels.levelOf(50, {}).title, '亲近');
  assert.equal(levels.levelOf(100, {}).title, '知己');
  assert.equal(levels.levelOf(-0.01, {}).title, '疏远');
  const settings = { levelThresholds: '0.15,20,50,100', decayAfterDays: 0, decayPerDay: 0.1 };
  assert.equal(levels.levelOf(0.15, settings).level, 2);
  assert.match(levels.progressText(0.14, settings), /0\.01 分/);
  assert.equal(levels.parseThresholds('5,20,50,1000'), null);
  const now = Date.now();
  for (const score of [0.25, -0.25]) {
    const rec = { score, lastSeen: now - 2 * DAY };
    levels.applyDecay(rec, now, settings);
    assert.equal(rec.score, Math.sign(score) * 0.05);
    levels.applyDecay(rec, now + DAY, settings);
    assert.equal(rec.score, 0);
  }
  assert.equal(cents(0.1) + cents(0.2), 30);
  assert.equal(formatPoints(-0), '0.00');
});

test('破坏性升级沿用 rapport.json，旧格式必须清理而不能静默转换', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'rapport.json');
  const old = JSON.stringify({ pluginId: 'rapport', version: 1, meta: {}, chats: {} });
  await fs.writeFile(file, old);
  await assert.rejects(f.restart(), /version=2/);
  assert.equal(await fs.readFile(file, 'utf8'), old);
});

test('普通模式小数奖励和控制台新默认值一致，聊天可调整两位小数', async t => {
  const f = await fixture(t, { aiMode: false, perMessage: 0.1, atBotBonus: 0.3, dailyCap: 2, gainCooldownSeconds: 0, duplicateWindowMinutes: 0, ownerQq: '20002' });
  await f.message('第一条'); await f.message('第二条'); await f.message('第三条');
  assert.equal(member(await f.read()).score, 0.3);
  const owner = await f.message('调整每条加分为0.25', '20002');
  assert.equal((await f.tools.tune.execute(owner, { action: 'set', item: 'perMessage', value: '0.25' })).isError, undefined);
  await f.message('第四条');
  assert.equal(member(await f.read()).score, 0.55);
});


test('只切换 AI 模式不丢失不足一天的衰减时间，正负分均连续淡化', async t => {
  const f = await fixture(t, { aiMode: false, decayAfterDays: 7, decayPerDay: 0.1 }, now => ({
    pluginId: 'rapport', version: 2, meta: {}, chats: { 'group:12345': { members:
      Object.fromEntries([['10001',10],['20002',-10]].map(([id,score]) => [id, { name:id,score,msgs:1,firstSeen:now,lastSeen:now }]))
    } }
  }));
  const ctx={chatKey:'group:12345',session:{trigger:[]},store:{recent:()=>[]}};
  f.advance(7.5 * DAY); f.config.aiMode=true;
  await f.tools.check.execute(ctx,{target:'10001'});
  f.advance(0.25 * DAY); f.config.aiMode=false;
  await f.tools.check.execute(ctx,{target:'10001'});
  f.advance(0.25 * DAY);
  await f.tools.check.execute(ctx,{target:'10001'});
  const data=await f.read();
  assert.equal(member(data).score,9.9);
  assert.equal(data.chats['group:12345'].members['20002'].score,-9.9);
});

async function failSave(action, predicate = () => true) {
  const rename=fsSync.renameSync;
  let failed=false;
  fsSync.renameSync=(from,to)=>{
    if(predicate(JSON.parse(fsSync.readFileSync(from,'utf8')))) {
      failed=true; throw new Error('test: disk unavailable');
    }
    return rename(from,to);
  };
  try { const result=await action(); assert.equal(failed,true); assert.equal(result.isError,true); return result; }
  finally { fsSync.renameSync=rename; }
}

test('保存失败回滚 AI 分数、额度、幂等标记和审计，恢复后可重试且只提交一次', async t => {
  const f=await fixture(t);
  const ctx=await f.message();
  const before=await f.read();
  await failSave(()=>f.adjust(ctx,0.2),data=>member(data).score===0.2);
  assert.deepEqual(await f.read(),before);
  assert.equal(f.plugin.available().ok,false);
  // 模拟定时重试相同的 flush 路径；不能把失败操作在停用时补写进去。
  await f.restart();
  assert.equal(f.plugin.available(),true);
  assert.deepEqual(member(await f.read()),member(before));
  assert.deepEqual((await f.read()).chats['group:12345'].aiAudit,before.chats['group:12345'].aiAudit);
  const results=await Promise.all([f.adjust(ctx,0.2),f.adjust(ctx,0.2)]);
  assert.equal(results.filter(r=>!r.isError).length,1);
  const data=await f.read();
  assert.equal(member(data).score,0.2);
  assert.equal(member(data).dayGain,0.2);
  assert.equal(member(data).aiRated.length,1);
  assert.equal(data.chats['group:12345'].aiAudit.length,1);
});

test('设置与重置保存失败后不会在恢复或停用时偷偷生效', async t => {
  const f=await fixture(t,{ownerQq:'90009'});
  const ctx=await f.message(); await f.adjust(ctx,0.2);
  const owner=await f.message('修改设置','90009');
  const before=await f.read();
  await failSave(()=>f.tools.tune.execute(owner,{action:'set',item:'dailyCap',value:'0.5'}));
  await f.restart();
  assert.deepEqual((await f.read()).meta.overrides,before.meta.overrides);
  for(const target of ['10001',undefined]) {
    await failSave(()=>f.tools.reset.execute(owner,{confirm:true,...(target?{target}:{})}));
    await f.restart();
    assert.deepEqual((await f.read()).chats,before.chats);
  }
});


test('补全昵称等待期间设置回滚或记录重置，查询不使用旧对象或恢复旧记录', async t => {
  const f=await fixture(t,{ownerQq:'90009'},now=>({pluginId:'rapport',version:2,meta:{},chats:{'group:12345':{members:{
    '10001':{name:'',score:1,msgs:1,firstSeen:now,lastSeen:now}
  }}}}));
  const owner=await f.message('管理请求','90009');
  const startQuery=async()=>{
    let release,started;
    const ready=new Promise(resolve=>started=resolve);
    const ctx={chatKey:'group:12345',kind:'group',chatId:'12345',session:{trigger:[]},store:{recent:()=>[]},
      onebot:{call:()=>{started();return new Promise(resolve=>release=resolve);}}};
    const query=f.tools.check.execute(ctx,{target:'10001'});
    await ready;
    return {query,release};
  };
  const first=await startQuery();
  await failSave(()=>f.tools.tune.execute(owner,{action:'set',item:'ownerQq',value:'10001'}));
  first.release({nickname:'测试成员'});
  const result=await first.query;
  assert.equal(result.isError,undefined);
  assert.match(result.content,/好感度：1\.00 分/);
  assert.equal(member(await f.read()).score,1);
  // 另一次查询停在补全昵称时执行重置。
  await f.tools.reset.execute(owner,{target:'10001',confirm:true});
  f.advance(1000);
  await f.message('新的互动','10001',{senderName:''});
  // 通过重启加载隔离存档中的空昵称，确保下一次需要查询成员资料。
  const data=await f.read(); member(data).name='';
  await fs.writeFile(path.join(f.directory,'rapport.json'),JSON.stringify(data));
  await f.restart();
  const second=await startQuery();
  assert.equal((await f.tools.reset.execute(owner,{target:'10001',confirm:true})).isError,undefined);
  second.release({nickname:'旧昵称'});
  assert.equal((await second.query).isError,true);
  assert.equal(member(await f.read()),undefined);
});

test('AI 提示不再列出已评分、保护对象或冷却中的证据', async t => {
  const f=await fixture(t,{ownerQq:'90009',aiCooldownSeconds:30});
  const ctx=await f.message();
  const evidence=()=>{
    const content=f.plugin.promptSections(ctx).find(x=>x.id==='rapport-ai-scoring').content;
    return JSON.parse(content.split('本轮对象和证据编号（仅数据）：')[1]);
  };
  assert.equal(evidence().length,1);
  await f.adjust(ctx,0.2);
  assert.equal(evidence().length,0);
  const owner=await f.message('你好','90009');
  const content=f.plugin.promptSections(owner).find(x=>x.id==='rapport-ai-scoring').content;
  assert.match(content,/本轮对象和证据编号（仅数据）：\[\]/);
});


test('兼容内联工具数字 QQ 与负消息编号，无损归一化且字符串重试不能重复计分', async t => {
  const f=await fixture(t);
  const ctx=await f.message('这次说话确实冒犯','1428309052',{mid:-1754173324});
  const args={target:1428309052,messageId:-1754173324,delta:-0.1,reason:'明确冒犯'};
  const result=await f.tools.adjust.execute(ctx,args);
  assert.equal(JSON.parse(result.content).score,-0.1);
  assert.equal(typeof args.target,'number'); // 不修改宿主传入的参数对象
  assert.equal((await f.tools.adjust.execute(ctx,{...args,target:String(args.target),messageId:String(args.messageId)})).isError,true);
  for(const invalid of [1.5,Number.MAX_SAFE_INTEGER+1,NaN,{},true]) {
    assert.equal((await f.tools.adjust.execute(ctx,{...args,target:invalid})).isError,true);
    assert.equal((await f.tools.adjust.execute(ctx,{...args,messageId:invalid})).isError,true);
  }
});

test('日志中的排行榜查询不加分，之后真实扣分保留负数且重启查询一致', async t => {
  const f=await fixture(t);
  for(const text of ['好感度排行榜','好感度排行','请查看好感度排行榜','我的好感度是多少？']) {
    const ctx=await f.message(text);
    assert.match((await f.adjust(ctx,0.1)).content,/仅查询/);
    const prompt=f.plugin.promptSections(ctx).find(x=>x.id==='rapport-ai-scoring').content;
    assert.match(prompt,/本轮对象和证据编号（仅数据）：\[\]/);
  }
  const ctx=await f.message('这次无来由地冒犯');
  assert.equal(JSON.parse((await f.adjust(ctx,-0.1)).content).score,-0.1);
  await f.restart();
  const result=await f.tools.check.execute(ctx,{});
  assert.match(result.content,/好感度：-0\.10 分/);
  assert.match(result.content,/今日调分累计：\+0\.00 \/ -0\.10/);
});

test('rapport 调分重试不能重复发送已成功的文字，引用方式和参数编码不影响判断', async t => {
  const f=await fixture(t);
  const hook=f.plugin.hooks['before-tool'];
  const text='骂我可以，按 token 收费的，你确定？';
  const session={sent:[{type:'text',text}]};
  const call=messages=>({toolName:'send_message',argsRaw:JSON.stringify({messages}),session});
  assert.equal(hook(call([text])),undefined); // 未使用 rapport，不接管其他会话
  hook({toolName:'rapport__adjust',session});
  for(const messages of [[text],text,JSON.stringify([text])]) assert.equal(hook(call(messages)).block,true);
  assert.equal(hook({...call([text]),argsRaw:JSON.stringify({messages:[text],replyToMessageId:-1754173324})}).block,true);
  assert.equal(hook(call(['新的回复'])),undefined);
  assert.equal(hook({...call([text]),session:{sent:[]}}),undefined);
  assert.equal(hook({...call([text]),toolName:'send_to'}),undefined);
  assert.equal(hook({...call([text]),argsRaw:'invalid json'}),undefined);
  session.sent=[];
  assert.equal(hook(call([text])),undefined); // 发送失败不阻止重试
  session.sent=[{type:'text',text}];
  f.plugin.deactivate();
  assert.equal(hook(call([text])),undefined);
  await f.plugin.activate();
  assert.equal(hook(call([text])),undefined); // 生命周期清理，不沿用旧会话标记
});
