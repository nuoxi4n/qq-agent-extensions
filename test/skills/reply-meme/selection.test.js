import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseIndex, rankCandidates } from '../../../skills/reply-meme/lib/source.js';
import { buildCandidates, describe, candidateId } from '../../../skills/reply-meme/lib/candidates.js';
import { selectionInfo } from '../../../skills/reply-meme/lib/metadata.js';
import { setup, activate, dispose, hooks, promptSections } from '../../../skills/reply-meme/index.js';

const row = (id, name, story, category = 'DeepSeek娘') => ({ original: `https://img.aigengtu.com/meme/${id}.webp`, name, story, category });
const raw = (...rows) => ({ gallery: Object.fromEntries([...new Set(rows.map(x => x.category))].map(category => [category, { images: rows.filter(x => x.category === category) }])) });
const items = (...rows) => parseIndex(raw(...rows));
const ids = rows => rows.map(x => /\/(\d+)\./.exec(x.original)[1]);

test('无描述但标题明确的表情可检索、进入候选且不会伪造说明', () => {
  const [hug, cheer] = items(row(1, 'DeepSeek鲸娘『抱抱』表情包'), row(2, 'DeepSeek娘『好耶』表情包'));
  assert.deepEqual(ids(rankCandidates([hug, cheer], { keyword: '抱抱' })), ['1']);
  assert.equal(buildCandidates([hug, cheer], '抱抱我')[0].original, hug.original);
  const shown = describe(hug);
  assert.equal(shown.evidence, 'title');
  assert.equal(shown.requestOnly, undefined);
  assert.equal(Object.hasOwn(shown, 'description'), false);
});

test('纯编号和角色泛称不进入主动候选，有可用说明或 alt 时保留', () => {
  const data = items(row(1, 'DeepSeek鲸娘『1000382886』表情包'), row(2, 'DeepSeek娘表情包'),
    row(3, 'DeepSeek娘表情包', { zh: '张开双臂，给你一个抱抱。' }),
    { ...row(4, 'DeepSeek娘表情包'), alt: 'DeepSeek娘『好耶』表情包' });
  assert.equal(selectionInfo(data[0]).evidence, 'unknown');
  assert.equal(selectionInfo(data[1]).requestOnly, true);
  assert.equal(selectionInfo(data[2]).evidence, 'description');
  assert.equal(selectionInfo(data[3]).evidence, 'title');
  assert.deepEqual(ids(rankCandidates(data, { keyword: '抱抱' })), ['3']);
  assert.deepEqual(new Set(ids(buildCandidates(data))), new Set(['3', '4']));
});

test('描述中出现某词不能压过有明确相反含义的标题', () => {
  const data = items(row(1, 'DeepSeek娘『这用户发的啥啊』疑惑表情包', { zh: '收到用户消息时的困惑。' }),
    row(2, 'DeepSeek娘『收到』表情包'), row(3, 'DeepSeek娘『不开心』表情包'), row(4, 'DeepSeek娘『开心』表情包'));
  assert.deepEqual(ids(rankCandidates(data, { keyword: '收到' })), ['2']);
  assert.deepEqual(ids(rankCandidates(data, { keyword: '开心' })), ['4']);
});

test('贴贴的备选应是亲近动作，不把喜欢偷懒当作贴贴', () => {
  const data = items(row(1, 'DeepSeek娘『我喜欢偷懒』表情包'), row(2, 'DeepSeek娘『抱抱你吧』表情包'));
  assert.deepEqual(ids(rankCandidates(data, { keyword: '贴贴' })), ['2']);
});

test('文件名和哈希不能作为可判断的标题', () => {
  for (const name of ['1000382886.jpg', 'IMG_1000382886.png', 'd7da296f2cf7dee3be58605e4c0c8bdf.webp']) {
    const [item] = items(row(1, `DeepSeek鲸娘『${name}』表情包`));
    assert.equal(selectionInfo(item).evidence, 'unknown');
  }
});

test('最近话题权重更高，普通词不会把安全帽和AGI图片算成相关素材', () => {
  const data = items(row(1, 'DeepSeek娘『下班摸鱼』表情包'), row(2, 'DeepSeek娘『可爱的小肥鱼』表情包'),
    row(3, 'DeepSeek娘『不要提前摘掉安全帽』表情包'), row(4, 'DeepSeek娘『不要耽误AGI训练』表情包'));
  const selected = buildCandidates(data, '下班摸鱼\n不要老是只用同一个颜文字啦\n你不是还有很多吗\n不够可爱呢', { limit: 4 });
  assert.equal(ids(selected)[0], '2');
  assert.ok(!ids(selected).includes('3'));
  assert.ok(!ids(selected).includes('4'));
});

test('无关且没有表达信息的图片不用于补满话题候选', () => {
  const data = items(row(1, 'DeepSeek娘『抱抱』表情包'), row(2, 'DeepSeek娘『建筑材料编号』表情包'), row(3, 'DeepSeek娘表情包'));
  assert.deepEqual(ids(buildCandidates(data, '今天想要抱抱', { limit: 12 })), ['1']);
});

test('默认候选上限12；同样相关优先未发素材，再考虑缓存', () => {
  const data = items(...Array.from({ length: 30 }, (_, i) => row(i + 1, `DeepSeek娘『好耶 ${i}』表情包`)));
  const selected = buildCandidates(data, '好耶', { seen: x => x === data[0], cached: x => x === data[0] });
  assert.equal(selected.length, 12);
  assert.notEqual(selected[0].original, data[0].original);
});

test('保留不同态度备选，不固定先展示生气；seed固定时结果稳定', () => {
  const data = items(row(1, 'DeepSeek娘『开心』表情包'), row(2, 'DeepSeek娘『生气』表情包'),
    row(3, 'DeepSeek娘『抱抱』表情包'), row(4, 'DeepSeek娘『谢谢』表情包'), row(5, 'DeepSeek娘『加油』表情包'));
  const variants = new Set();
  for (let i = 0; i < 12; i++) {
    const options = { limit: 2, seed: String(i) };
    const selected = buildCandidates(data, '今天开心', options);
    assert.equal(ids(selected)[0], '1');
    assert.deepEqual(ids(selected), ids(buildCandidates(data, '今天开心', options)));
    variants.add(ids(selected)[1]);
  }
  assert.ok(variants.size > 1);
});

test('图源纠错在入口生效：原截图不再以“加载可爱中”检索或主动展示', () => {
  const data = items(row(1532, 'DeepSeek鲸娘『加载可爱中』表情包'), row(1531, 'DeepSeek鲸娘『可爱即正义』表情包'),
    row(1610, 'DeepSeek鲸娘『贴贴』表情包'), row(1, 'DeepSeek娘『可爱的小肥鱼』表情包'));
  assert.deepEqual(ids(rankCandidates(data, { keyword: '可爱' })), ['1']);
  assert.deepEqual(ids(buildCandidates(data, '可爱 贴贴')), ['1']);
  assert.equal(describe(data[0]).requestOnly, true);
  assert.match(data[0].title, /截图/);
  assert.deepEqual(ids(rankCandidates(data, { keyword: '截图' })), ['1532'], '用户仍可明确检索展示图片');
  const [fixed] = items(row(1532, 'DeepSeek鲸娘『抱抱』表情包'));
  assert.equal(selectionInfo(fixed).requestOnly, false, '上游改正标题后不继续套用旧纠错');
});

test('角色显式指定和auto覆盖配置，词语筛选不会退回随机', () => {
  const data = items(row(1, 'DeepSeek娘『抱抱』表情包'), row(2, 'Claude娘『抱抱』表情包', undefined, 'Claude娘'));
  assert.deepEqual(ids(rankCandidates(data, { keyword: '抱抱', defaultCharacter: 'DeepSeek', character: 'Claude' })), ['2']);
  assert.equal(rankCandidates(data, { keyword: '抱抱', defaultCharacter: 'DeepSeek', character: 'auto' }).length, 2);
  assert.deepEqual(rankCandidates(data, { keyword: '宇宙飞船', random: true }), []);
});

async function host(t, rows, settings = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-meme-selection-'));
  t.after(async () => {
    dispose();
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('reply-meme-selection-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, 'gallery-cache.json'), JSON.stringify({ at: Date.now(), raw: raw(...rows) }));
  const tools = {}, calls = [], sent = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
  await setup({ config: () => ({ cooldownSeconds: 0, ...settings }), registerTool: tool => { tools[tool.id] = tool; }, fetch: async url => {
    calls.push(url); return new Response(png);
  } }, { cacheDir: directory });
  activate();
  const ctx = { chatKey: 'group:selection', session: { id: 'selection', status: 'running', sent: [{ type: 'text', text: '给你抱抱' }] },
    sender: { sendImage: async (...args) => { sent.push(args); return true; } } };
  return { ctx, tools, calls, sent };
}
const execute = async (tool, ctx, args) => JSON.parse((await tool.execute(ctx, args)).content);

test('纯文本宿主：无描述图片可完整主动发送，hook不联网且只下载所选图', async t => {
  const { ctx, tools, calls, sent } = await host(t, [row(1, 'DeepSeek娘『抱抱』表情包')]);
  const messages = [{ role: 'user', content: '抱抱我' }];
  hooks['before-llm-messages']({ ...ctx, messages });
  assert.equal(calls.length, 0);
  const candidates = JSON.parse(messages.at(-1).content.split('\n').at(-1));
  const prepared = await execute(tools.find_meme, ctx, { ids: [candidates[0].id] });
  assert.equal(prepared.prepared[0].evidence, 'title');
  assert.equal(Object.hasOwn(prepared.prepared[0], 'description'), false);
  hooks['after-response'](ctx);
  const result = await execute(tools.send_meme, ctx, { tickets: [prepared.prepared[0].ticket], mode: 'reply' });
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls.every(url => url === 'https://img.aigengtu.com/meme/1.webp'));
});

test('未知图片只在明确随机检索中出现，准备后仍拒绝reply，允许request', async t => {
  const { ctx, tools, sent } = await host(t, [row(1, 'DeepSeek娘『1000382886』表情包')]);
  const messages = [{ role: 'user', content: '可爱一点' }];
  hooks['before-llm-messages']({ ...ctx, messages });
  assert.equal(messages.length, 1);
  assert.deepEqual((await execute(tools.find_meme, ctx, {})).candidates, []);
  const random = await execute(tools.find_meme, ctx, { random: true });
  assert.equal(random.candidates[0].evidence, 'unknown');
  const prepared = await execute(tools.find_meme, ctx, { ids: [random.candidates[0].id] });
  const repeated = await execute(tools.find_meme, ctx, { ids: [random.candidates[0].id] });
  assert.equal(repeated.prepared[0].requestOnly, true);
  hooks['after-response'](ctx);
  const tickets = [prepared.prepared[0].ticket];
  assert.equal((await execute(tools.send_meme, ctx, { tickets, mode: 'reply' })).sent, 0);
  assert.equal(sent.length, 0);
  assert.equal((await execute(tools.send_meme, ctx, { tickets, mode: 'request' })).sent, 1);
});

test('未知图片不能通过带语义关键词的随机请求凑数；未提供id也不能准备', async t => {
  const data = [row(1, 'DeepSeek娘『1000382886』表情包')];
  const { ctx, tools } = await host(t, data);
  const found = await execute(tools.find_meme, ctx, { keyword: '开心', random: true });
  assert.deepEqual(found.candidates, []);
  const result = await execute(tools.find_meme, ctx, { ids: [candidateId(items(...data)[0])] });
  assert.match(result.reason, /不在本次会话/);
});

test('系统提示在发送前、冷却中、跨会话及冷却结束后保持逐字相同', async t => {
  const { ctx, tools, calls } = await host(t, [row(1, 'DeepSeek娘『抱抱』表情包')], { cooldownSeconds: 60 });
  const system = JSON.stringify(promptSections(ctx));
  const messages = [{ role: 'system', content: '宿主稳定前缀' }, { role: 'user', content: '抱抱我' }];
  hooks['before-llm-messages']({ ...ctx, messages });
  const offered = JSON.parse(messages.at(-1).content.split('\n').at(-1));
  const prepared = await execute(tools.find_meme, ctx, { ids: [offered[0].id] });
  hooks['after-response'](ctx);
  assert.equal((await execute(tools.send_meme, ctx, { tickets: [prepared.prepared[0].ticket], mode: 'reply' })).sent, 1);
  assert.equal(JSON.stringify(promptSections(ctx)), system);
  assert.equal(JSON.stringify(promptSections({ chatKey: 'group:other' })), system);
  assert.equal(JSON.stringify(promptSections()), system, '预览和实际会话使用相同系统段落');
  const next = { ...ctx, session: { id: 'next', status: 'running', sent: [] } };
  const original = [{ role: 'system', content: '宿主稳定前缀' }, { role: 'user', content: '继续抱抱' }];
  const during = structuredClone(original);
  const requests = calls.length;
  hooks['before-llm-messages']({ ...next, messages: during });
  assert.deepEqual(during.slice(0, 2), original);
  assert.match(during.at(-1).content, /冷却中/);
  assert.equal(calls.length, requests);
  const later = Date.now() + 61000;
  t.mock.method(Date, 'now', () => later);
  const after = structuredClone(original);
  hooks['before-llm-messages']({ ...next, sessionId: 'later', messages: after });
  assert.match(after.at(-1).content, /候选数据/);
  assert.equal(JSON.stringify(promptSections(ctx)), system);
  assert.deepEqual(after.slice(0, 2), original);
});

test('默认预置4张精简候选，检索默认6张，仍保留按描述选择的必要信息', async t => {
  const data = Array.from({ length: 8 }, (_, i) => row(i + 1, `DeepSeek娘『抱抱 ${i}』表情包`, { zh: '拥抱安慰的图片说明。'.repeat(10) }));
  const { ctx, tools } = await host(t, data);
  const messages = [{ role: 'user', content: '抱抱' }];
  hooks['before-llm-messages']({ ...ctx, messages });
  const candidates = JSON.parse(messages.at(-1).content.split('\n').at(-1));
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every(x => Object.keys(x).sort().join(',') === 'id,title'));
  assert.equal((await execute(tools.find_meme, ctx, { keyword: '抱抱' })).candidates.length, 6);
  const [descriptionOnly] = items(row(20, 'DeepSeek娘表情包', { zh: '张开双臂给你抱抱。' }));
  assert.equal(describe(descriptionOnly, false, { compact: true }).description, '张开双臂给你抱抱。');
});

test('预置候选设为0不注入图库，按需检索和纯文本主动发送仍可用', async t => {
  const { ctx, tools, calls } = await host(t, [row(1, 'DeepSeek娘『抱抱』表情包')], { promptCandidates: 0 });
  const original = [{ role: 'user', content: '抱抱' }];
  const messages = structuredClone(original);
  hooks['before-llm-messages']({ ...ctx, messages });
  assert.deepEqual(messages, original);
  assert.equal(calls.length, 0);
  const result = await execute(tools.find_meme, ctx, { keyword: '抱抱' });
  const prepared = await execute(tools.find_meme, ctx, { ids: [result.candidates[0].id] });
  hooks['after-response'](ctx);
  assert.equal((await execute(tools.send_meme, ctx, { tickets: [prepared.prepared[0].ticket], mode: 'reply' })).sent, 1);
});
