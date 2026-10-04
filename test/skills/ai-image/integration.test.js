import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { setup, providers } from '../../../skills/ai-image/index.js';
import * as skill from '../../../skills/ai-image/index.js';
import { readSettings } from '../../../skills/ai-image/lib/config.js';
import { createImageClient, decodeBase64, checkImage, readLimited } from '../../../skills/ai-image/lib/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
const png2 = Buffer.concat([png, Buffer.from('second')]);
const fixtureKey = 'fixture-only-not-a-real-api-key';
const cacheFiles = new Set();
let server, baseUrl, calls, handler, usageDirectory;
const previousDataDir = process.env.QQ_AGENT_DATA_DIR;
const jsonImage = (res, images = [png]) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: images.map((image) => ({ b64_json: image.toString('base64') })) }));
};

before(async () => {
  usageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-usage-test-'));
  process.env.QQ_AGENT_DATA_DIR = usageDirectory;
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    try { await handler(call, res); } catch (error) { res.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.QQ_AGENT_DATA_DIR;
  else process.env.QQ_AGENT_DATA_DIR = previousDataDir;
  await fs.rm(usageDirectory, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const expected = path.join(os.tmpdir(), 'qq-agent-ai-image') + path.sep;
  for (const file of cacheFiles) {
    assert.ok(path.resolve(file).startsWith(expected));
    await fs.unlink(file).catch(() => {});
  }
});

function fixture(overrides = {}, entries = []) {
  entries = entries.map((entry, index) => ({ id: index + 1, ...entry }));
  calls = [];
  handler = (call, res) => {
    if (call.method === 'POST') jsonImage(res);
    else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(call.url.endsWith('second') ? png2 : png); }
  };
  const config = { baseUrl, apiKey: fixtureKey, maxImagesPerRequest: 4, dailyUserLimit: 0, dailyTotalLimit: 0, totalLimit: 0, ...overrides };
  const tools = {};
  const warnings = [];
  const sent = [];
  setup({ config: () => config, fetch, registerTool: (tool) => { tools[tool.id] = tool; }, warn: (text) => warnings.push(text) });
  const ctx = {
    // 模拟主会话已成功执行 send_message；技能本身不得代替主模型发文字。
    chatKey: 'group:123', session: { id: 'test-session', trigger: [{ id: 100, mid: 100, senderId: '12345', media: [] }], sent: [{ type: 'text', text: '我来试试，稍等～' }] },
    store: {
      findByMid(key, mid) { assert.equal(key, 'group:123'); return entries.find((entry) => String(entry.mid) === String(mid)); },
      recent(key) { assert.equal(key, 'group:123'); return entries; }
    },
    sender: { async sendImage(key, image) {
      assert.equal(key, 'group:123');
      if (image.file) cacheFiles.add(image.file);
      sent.push(image);
      return { message_id: sent.length };
    } }
  };
  return { tools, config, ctx, sent, warnings };
}

function remember(result) {
  for (const image of result.images || []) if (image.filePath) cacheFiles.add(image.filePath);
  return result;
}

test('文生图发送 JSON、Bearer 认证和 OneBot base64，缓存文件与结果一致', async () => {
  const f = fixture();
  const result = await f.tools.gen.execute(f.ctx, { prompt: '水彩猫', size: '1024x1024' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/images/generations');
  assert.equal(calls[0].headers.authorization, `Bearer ${fixtureKey}`);
  assert.deepEqual(JSON.parse(calls[0].body), { model: 'gpt-image-1', prompt: '水彩猫', n: 1, size: '1024x1024' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].dataUrl, `base64://${png.toString('base64')}`);
  assert.deepEqual(await fs.readFile(f.sent[0].file), png);
  assert.equal(f.ctx.session.sent.length, 2);
  assert.ok(!result.content.includes(png.toString('base64')));
});

test('文生图和图生图在同一 skill 中共享实时配置', async () => {
  const f = fixture();
  f.config.model = 'changed-model';
  f.config.editModel = 'edit-model';
  let result = remember(await providers['image.generate']({ prompt: '猫' }));
  assert.equal(result.ok, true);
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(JSON.parse(calls[0].body).model, 'changed-model');
  result = remember(await providers['image.edit']({ prompt: '换背景', image: { buffer: png } }));
  assert.equal(result.ok, true);
  assert.equal(calls[1].url, '/v1/images/edits');
  const form = await new Response(calls[1].body, { headers: { 'Content-Type': calls[1].headers['content-type'] } }).formData();
  assert.equal(form.get('model'), 'edit-model');
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), png);
  assert.equal(f.sent.length, 0, '能力调用不自动发送');
});

test('图生图选择指定消息的第二张，发送真实 multipart 文件', async () => {
  const f = fixture({}, [{ mid: 456, media: [
    { kind: 'image', url: baseUrl + '/first' }, { kind: 'image', url: baseUrl + '/second' }
  ] }]);
  const result = await f.tools.edit.execute(f.ctx, { prompt: '变成水彩', messageId: '#456', imageIndex: 2 });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, '/v1/second');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[1].url, '/v1/images/edits');
  assert.match(calls[1].headers['content-type'], /^multipart\/form-data; boundary=/);
  const form = await new Response(calls[1].body, { headers: { 'Content-Type': calls[1].headers['content-type'] } }).formData();
  assert.equal(form.get('prompt'), '变成水彩');
  assert.equal(form.get('n'), '1');
  assert.equal(form.getAll('image').length, 1);
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), png2);
});

test('优先使用请求附图，没有附图时使用边界内唯一历史图片', async () => {
  const entries = [{ mid: 3, media: [{ kind: 'image', url: baseUrl + '/second' }] }];
  const f = fixture({}, entries);
  f.ctx.session.trigger = [{ id: 2, mid: 2, senderId: '12345', media: [{ kind: 'image', url: baseUrl + '/first' }] }];
  assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '改图' })).isError, undefined);
  assert.equal(calls[0].url, '/v1/first');
  calls = [];
  f.ctx.session.trigger = [{ id: 4, mid: 4, senderId: '12345', media: [] }];
  assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '改图' })).isError, undefined);
  assert.equal(calls[0].url, '/v1/second');
});

test('未知消息、无图、越界或小数序号在生成前失败，不静默换图', async () => {
  const f = fixture({}, [{ mid: 1, media: [{ kind: 'image', url: baseUrl + '/first' }] }, { mid: 2, media: [] }]);
  for (const args of [{ messageId: 99 }, { messageId: 2 }, { imageIndex: 2 }, { imageIndex: 1.5 }, { imageIndex: 0 }]) {
    assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '改图', ...args })).isError, true);
  }
  assert.equal(calls.length, 0);
});

test('get_image 同时返回过期 URL 和有效文件时仍能读取本地参考图', async () => {
  const file = path.join(os.tmpdir(), 'qq-agent-ai-image-reference-test-' + process.pid + '.png');
  await fs.writeFile(file, png);
  try {
    const f = fixture({}, [{ mid: 1, media: [{ kind: 'image', url: baseUrl + '/expired', file: 'qq-image-id' }] }]);
    handler = (call, res) => { if (call.method === 'POST') jsonImage(res); else { res.writeHead(404); res.end(); } };
    f.ctx.onebot = { async call(action, args) {
      assert.equal(action, 'get_image');
      assert.deepEqual(args, { file: 'qq-image-id' });
      return { url: baseUrl + '/expired', file: pathToFileURL(file).href };
    } };
    assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '改图' })).isError, undefined);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  } finally { await fs.unlink(file); }
});

test('自动选图不使用本轮触发批之后的新消息，等待期开始时间不截断触发批', async () => {
  const f = fixture({}, [
    { id: 10, mid: 100, ts: 1000, media: [{ kind: 'image', url: baseUrl + '/first' }] },
    { id: 12, mid: 102, ts: 1200, media: [{ kind: 'image', url: baseUrl + '/second' }] }
  ]);
  f.ctx.session.startedAt = 500;
  f.ctx.session.trigger = [{ id: 11, mid: 101, senderId: '12345', ts: 1200, text: '修改上面的图片', media: [] }];
  assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '水彩风格' })).isError, undefined);
  assert.equal(calls[0].url, '/v1/first');
});

test('技能停用会中断在途生成，即使立即重新启用也不会补发旧图片', async () => {
  const f = fixture();
  handler = (call, res) => {
    skill.deactivate?.();
    skill.activate?.();
    jsonImage(res);
  };
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫' });
  assert.equal(result.isError, true);
  assert.equal(f.sent.length, 0);
  assert.equal(calls.length, 1);
});

test('已结束的会话不再生成，执行中可见的中止状态阻止后续发送', async () => {
  const f = fixture();
  f.ctx.session.status = 'aborted';
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
  assert.equal(calls.length, 0);
  f.ctx.session.status = 'running';
  handler = (call, res) => { f.ctx.session.status = 'aborted'; jsonImage(res); };
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
  assert.equal(f.sent.length, 0);
});

test('参考图下载期间停用后，不回退协议端或提交生成请求', async () => {
  const f = fixture({}, [{ mid: 1, media: [{ kind: 'image', url: baseUrl + '/reference', file: 'file-id' }] }]);
  let lookups = 0;
  f.ctx.onebot = { call() { lookups++; throw new Error('不应查询'); } };
  handler = (call, res) => { skill.deactivate(); res.end(png); };
  const result = await f.tools.edit.execute(f.ctx, { prompt: '修改背景' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(lookups, 0);
  assert.equal(f.sent.length, 0);
});

test('结果图下载期间停用后，不重试下载或发送', async () => {
  const f = fixture();
  handler = (call, res) => {
    if (call.method === 'POST') res.end(JSON.stringify({ data: [{ url: baseUrl + '/result' }] }));
    else { skill.deactivate(); res.end(png); }
  };
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
  assert.equal(calls.length, 2);
  assert.equal(f.sent.length, 0);
});

test('停用取消 429 退避等待，能力调用也不能继续生成', { timeout: 2000 }, async () => {
  fixture({ maxRetries: 1 });
  handler = (call, res) => {
    res.writeHead(429);
    res.end('{}');
    setTimeout(() => skill.deactivate(), 20);
  };
  const result = await providers['image.generate']({ prompt: '猫' });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal((await providers['image.generate']({ prompt: '另一只猫' })).ok, false);
  assert.equal(calls.length, 1);
});

test('多图发送中观察到会话结束时保留已发结果并停止后续发送', async () => {
  const f = fixture();
  handler = (call, res) => jsonImage(res, [png, png2]);
  const send = f.ctx.sender.sendImage;
  f.ctx.sender.sendImage = async (...args) => {
    const result = await send(...args);
    f.ctx.session.status = 'aborted';
    return result;
  };
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫', count: 2 });
  for (const match of result.content.matchAll(/（本地缓存：([^）]+)）/g)) cacheFiles.add(match[1]);
  assert.equal(f.sent.length, 1);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /生成并发送 1 张/);
  assert.match(result.content, /部分结果未完成/);
});

test('参考图不同入口均限制体积，拒绝 GIF 和伪造图片', async () => {
  const f = fixture({ maxRefMB: 1 });
  const large = Buffer.concat([png, Buffer.alloc(1048576)]);
  for (const image of [{ buffer: large }, { dataUrl: large.toString('base64') }, { buffer: Buffer.from('GIF89a1234567890') }, { buffer: Buffer.from('not a picture at all') }]) {
    assert.equal((await providers['image.edit']({ prompt: '修改', image })).ok, false);
  }
  assert.equal(calls.length, 0);
  const result = remember(await providers['image.edit']({ prompt: '修改', image: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } }));
  assert.equal(result.ok, true);
  assert.equal(f.sent.length, 0);
});

test('结果 URL 下载不携带 API Key', async () => {
  const f = fixture();
  handler = (call, res) => {
    if (call.method === 'POST') res.end(JSON.stringify({ data: [{ url: baseUrl + '/image' }] }));
    else { assert.equal(call.headers.authorization, undefined); res.end(png); }
  };
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, undefined);
  assert.equal(calls.length, 2);
});

test('默认不重试 429、5xx 和 408，网络断开不重试 POST', async () => {
  for (const status of [429, 500, 502, 408]) {
    const f = fixture({ maxRetries: status === 429 ? 0 : 3 });
    handler = (call, res) => { res.writeHead(status); res.end(JSON.stringify({ error: { message: 'upstream timeout' } })); };
    assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
    assert.equal(calls.length, 1);
  }
  const f = fixture({ maxRetries: 3 });
  handler = (call, res) => res.destroy();
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
  assert.equal(calls.length, 1);
});

test('管理员开启后仅对 HTTP 429 做有限重试', async () => {
  const f = fixture({ maxRetries: 1 });
  handler = (call, res) => {
    if (calls.length === 1) { res.writeHead(429, { 'Retry-After': '0.001' }); res.end('{}'); }
    else jsonImage(res);
  };
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, undefined);
  assert.equal(calls.length, 2);
});

test('响应头先到、body 卡住也会超时，计时器释放且不重试生成', async () => {
  fixture();
  handler = (call, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); res.write('{'); };
  const client = createImageClient(fetch);
  const settings = { ...readSettings({ baseUrl, apiKey: fixtureKey, maxRetries: 3 }), timeoutMs: 40 };
  await assert.rejects(client.request(settings, { prompt: '猫', count: 1, size: '' }), /超时.*不自动重新生成/);
  assert.equal(calls.length, 1);
});

test('下载暂时中断只重试 GET，不再次生成', async () => {
  const f = fixture();
  let downloads = 0;
  handler = (call, res) => {
    if (call.method === 'POST') res.end(JSON.stringify({ data: [{ url: baseUrl + '/image' }] }));
    else if (downloads++ === 0) { res.writeHead(200, { 'Content-Length': '1000' }); res.write('part'); setTimeout(() => res.destroy(), 5); }
    else res.end(png);
  };
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, undefined);
  assert.equal(downloads, 2);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('无 Content-Length 的大响应在读取中截断', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(50)); controller.enqueue(Buffer.alloc(50)); controller.close(); } }));
  await assert.rejects(readLimited(response, 60), /体积上限/);
  assert.throws(() => decodeBase64(png.toString('base64'), 8), /体积上限/);
  assert.throws(() => checkImage(Buffer.from('<html>error page</html>'), 100), /不是支持的图片/);
});

test('结果部分无效时仍发送有效图，并报告部分失败', async () => {
  const f = fixture();
  handler = (call, res) => jsonImage(res, [png, Buffer.from('<html>error page</html>')]);
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫', count: 2 });
  assert.equal(result.isError, undefined);
  assert.equal(f.sent.length, 1);
  assert.match(result.content, /部分结果未完成/);
  assert.equal(calls.length, 1);
});

test('服务端多返回图片时仅交付请求数量', async () => {
  const f = fixture();
  handler = (call, res) => jsonImage(res, [png, png]);
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫', count: 1 })).isError, undefined);
  assert.equal(f.sent.length, 1);
});

test('发送失败保留本地缓存，既不重复生成也不返回图片 base64', async () => {
  const f = fixture();
  let file;
  f.ctx.sender.sendImage = async (key, image) => { file = image.file; cacheFiles.add(file); throw new Error('QQ unavailable'); };
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫' });
  assert.equal(result.isError, true);
  assert.match(result.content, /本地缓存/);
  assert.match(result.content, /不要重新生成/);
  assert.deepEqual(await fs.readFile(file), png);
  assert.equal(calls.length, 1);
  assert.ok(!result.content.includes(png.toString('base64')));
});

test('sender 已更新 session 时不添加重复展示记录', async () => {
  const f = fixture();
  const send = f.ctx.sender.sendImage;
  f.ctx.sender.sendImage = async (...args) => { const receipt = await send(...args); f.ctx.session.sent.push({ type: 'image' }); return receipt; };
  await f.tools.gen.execute(f.ctx, { prompt: '猫' });
  assert.equal(f.ctx.session.sent.length, 2);
});

test('上游回显密钥和图片时，工具与日志脱敏', async () => {
  const f = fixture();
  handler = (call, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ error: { message: `Bearer ${fixtureKey} data:image/png;base64,${png.toString('base64')}` } }));
  };
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫' });
  assert.equal(result.isError, true);
  for (const text of [result.content, ...f.warnings]) {
    assert.ok(!text.includes(fixtureKey));
    assert.ok(!text.includes(png.toString('base64')));
  }
});

test('缺少发送器、无效参数、空结果或非 JSON 均返回可读错误', async () => {
  const f = fixture();
  assert.equal((await f.tools.gen.execute({}, { prompt: '猫' })).isError, true);
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫', count: 0 })).isError, true);
  assert.equal(calls.length, 0);
  for (const body of ['not json', '{"data":[]}']) {
    handler = (call, res) => res.end(body);
    assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
  }
});

for (const mode of ['gen', 'edit']) {
  test(`${mode} 未发送开始文字时不请求接口，主模型发送后才等待处理并返回回复指引`, { timeout: 3000 }, async () => {
    const f = fixture({}, [{ mid: 1, media: [{ kind: 'image', url: baseUrl + '/ref' }] }]);
    for (const sent of [[], [{ type: 'image' }], [{ type: 'text', text: ' ' }]]) {
      f.ctx.session.sent = sent;
      const result = await f.tools[mode].execute(f.ctx, { prompt: '猫' });
      assert.equal(result.isError, true);
      assert.match(result.content, /先调用 send_message/);
    }
    assert.equal(calls.length, 0);
    f.ctx.session.sent = [{ type: 'text', text: '好，我来画～' }];
    f.ctx.sender.sendTextBatch = () => { throw new Error('技能不得自行调用聊天发送器'); };
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const requestStarted = new Promise(resolve => { started = resolve; });
    handler = async (call, res) => {
      if (call.method === 'POST') { started(); await gate; jsonImage(res); }
      else res.end(png);
    };
    let returned = false;
    const pending = f.tools[mode].execute(f.ctx, { prompt: '猫' }).then(result => { returned = true; return result; });
    try {
      await requestStarted;
      assert.equal(returned, false);
      assert.equal(f.sent.length, 0);
      release();
      const result = await pending;
      assert.equal(result.isError, undefined);
      assert.equal(f.sent.length, 1);
      assert.match(result.content, /完成文字尚未由本工具发送.*调用 send_message/);
      assert.match(result.content, /不要因已发图就选择不发送/);
      assert.equal(f.ctx.session.sent.filter(entry => entry.type === 'text').length, 1);
    } finally { release(); await pending; }
  });
}

test('平台未确认图片发送时不声称成功，并交给主会话模型说明失败', async () => {
  const f = fixture();
  f.ctx.sender.sendImage = async (key, image) => { cacheFiles.add(image.file); return { ok: false }; };
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫' });
  assert.equal(result.isError, true);
  assert.match(result.content, /平台未确认发送/);
  assert.match(result.content, /请通过 send_message 如实说明/);
  assert.equal(f.ctx.session.sent.length, 1);
  assert.equal(calls.length, 1);
});

async function quotaFixture(t, overrides = {}, entries = []) {
  const directory = await fs.mkdtemp(path.join(usageDirectory, 'case-'));
  const previous = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = directory;
  t.after(() => { process.env.QQ_AGENT_DATA_DIR = previous; });
  const f = fixture(overrides, entries);
  return { ...f, usagePath: path.join(directory, 'ai-image-usage.json') };
}

test('单次张数与黑名单在文生图、图生图、扩展能力入口统一拦截且不扣次数', async t => {
  const f = await quotaFixture(t, { maxImagesPerRequest: 1, blockedTerms: '禁词' });
  for (const tool of Object.values(f.tools)) {
    assert.match((await tool.execute(f.ctx, { prompt: '猫', count: 2 })).content, /count/);
    assert.match((await tool.execute(f.ctx, { prompt: '禁\u200b 词' })).content, /黑名单/);
  }
  for (const provider of Object.values(providers)) {
    assert.match((await provider({ prompt: '猫', count: 2 })).error, /count/);
    assert.match((await provider({ prompt: '禁词' })).error, /黑名单/);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(f.usagePath), { code: 'ENOENT' });
  f.config.blockedTerms = '新禁词';
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '新禁词' })).content, /黑名单/);
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '禁词' })).isError, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.usagePath, 'utf8')).total, 1);
});

test('文生图与图生图共用个人额度，并发只能提交一次且重载不重置', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 1 }, [{ mid: 1, media: [{ kind: 'image', url: baseUrl + '/ref' }] }]);
  const results = await Promise.all([
    f.tools.gen.execute(f.ctx, { prompt: '猫' }),
    f.tools.edit.execute(f.ctx, { prompt: '水彩猫' })
  ]);
  assert.equal(results.filter(result => !result.isError).length, 1);
  assert.match(results.find(result => result.isError).content, /个人每日/);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  const reloaded = await import(pathToFileURL(path.resolve('skills/ai-image/index.js')).href + '?quota-reload');
  const tools = {};
  reloaded.setup({ config: () => f.config, fetch, registerTool: tool => { tools[tool.id] = tool; } });
  try {
    assert.match((await tools.gen.execute(f.ctx, { prompt: '猫' })).content, /个人每日/);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  } finally { reloaded.dispose(); }
});

test('生成失败仍扣次数，HTTP 429 重试也受剩余额度约束', async t => {
  const f = await quotaFixture(t, { maxRetries: 3, totalLimit: 1 });
  handler = (call, res) => { res.writeHead(429, { 'Retry-After': '0.001' }); res.end('{}'); };
  const result = await f.tools.gen.execute(f.ctx, { prompt: '猫' });
  assert.match(result.content, /累计/);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.usagePath, 'utf8')).total, 1);
  f.config.totalLimit = 2;
  handler = (call, res) => { res.writeHead(500); res.end('{}'); };
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, true);
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).content, /累计/);
  assert.equal(calls.length, 2);
});

test('能力调用共用日额度并计入全局累计，传入伪造用户参数无效', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 1, totalLimit: 2 });
  assert.equal(remember(await providers['image.generate']({ prompt: '猫', userId: '12345' })).ok, true);
  const denied = await providers['image.edit']({ prompt: '猫', userId: '67890', image: { buffer: png } });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /扩展能力共享/);
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, undefined);
  f.ctx.session.trigger = [{ id: 101, mid: 101, senderId: '67890' }];
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).content, /累计/);
  assert.equal(calls.length, 2);
});

test('身份不明、无效参考图和存储损坏时不会提交生成请求', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 1 });
  f.ctx.session.trigger.push({ senderId: '67890' });
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫', userId: '12345' })).content, /无法唯一确定/);
  f.ctx.session.trigger.pop();
  assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '猫' })).isError, true);
  await assert.rejects(fs.stat(f.usagePath), { code: 'ENOENT' });
  await fs.writeFile(f.usagePath, '{broken');
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).content, /用量记录/);
  assert.equal(await fs.readFile(f.usagePath, 'utf8'), '{broken');
  assert.equal(calls.length, 0);
});

test('多人触发按请求消息扣个人额度，改图的参考图发送者不影响归属', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 2 }, [
    { mid: 10, senderId: '67890', media: [{ kind: 'image', url: baseUrl + '/ref' }] }
  ]);
  f.ctx.session.trigger = [
    { id: 11, mid: 11, senderId: '12345', text: '把 #10 改成水彩风' },
    { id: 12, mid: 12, senderId: '67890', text: '我也喜欢猫' }
  ];
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫', requestMessageId: 11 })).isError, undefined);
  assert.equal((await f.tools.edit.execute(f.ctx, { prompt: '水彩猫', requestMessageId: '#11', messageId: 10 })).isError, undefined);
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫', requestMessageId: 11, userId: '67890' })).content, /个人每日/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.usagePath, 'utf8')).users, { '12345': 2 });
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].body).requestMessageId, undefined);
  assert.ok(!posts[1].body.toString().includes('name="requestMessageId"'));
  assert.equal(f.sent.length, 2);
});

test('混合群聊不能借唯一 @ 旁人的额度生成，关闭个人限额也必须指定请求', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 1 });
  f.ctx.session.trigger = [{ id: 10, mid: 10, senderId: '67890', text: '画猫' }];
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).isError, undefined);
  f.ctx.session.trigger = [
    { id: 11, mid: 11, senderId: '12345', text: '@机器人 天气怎样', atMe: true },
    { id: 12, mid: 12, senderId: '67890', text: '再画一只猫' }
  ];
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).content, /requestMessageId/);
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫', requestMessageId: 12 })).content, /个人每日/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.usagePath, 'utf8')).users, { '67890': 1 });
  assert.equal(calls.length, 1);
  f.config.dailyUserLimit = 0;
  assert.match((await f.tools.gen.execute(f.ctx, { prompt: '猫' })).content, /requestMessageId/);
  assert.equal((await f.tools.gen.execute(f.ctx, { prompt: '猫', requestMessageId: 12 })).isError, undefined);
  assert.equal(calls.length, 2);
});

test('改图以已选请求为边界，不读取同批后来发出的旁人图片或本人的下一张图', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 2 });
  const cat = { id: 10, mid: 10, senderId: '12345', media: [{ kind: 'image', url: baseUrl + '/first' }] };
  const request = { id: 11, mid: 11, senderId: '12345', text: '把这只猫改成水彩风' };
  const later = { id: 12, mid: 12, senderId: '67890', media: [{ kind: 'image', url: baseUrl + '/second' }] };
  f.ctx.session.trigger = [cat, request, later];
  f.ctx.store.recent = () => { throw new Error('本轮已找到参考图，不应读取历史'); };
  for (const senderId of ['67890', '12345']) {
    later.senderId = senderId;
    const result = await f.tools.edit.execute(f.ctx, { prompt: '水彩猫', requestMessageId: 11 });
    assert.equal(result.isError, undefined);
    assert.match(result.content, /消息 #10/);
  }
  assert.deepEqual(calls.filter(call => call.method === 'GET').map(call => call.url), ['/v1/first', '/v1/first']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.usagePath, 'utf8')).users, { '12345': 2 });
});

test('自动选图有歧义时不下载或扣额，明确参考图后才执行', async t => {
  const images = [
    { id: 8, mid: 80, senderId: '12345', media: [{ kind: 'image', url: baseUrl + '/first' }] },
    { id: 9, mid: 90, senderId: '67890', media: [{ kind: 'image', url: baseUrl + '/second' }] }
  ];
  const f = await quotaFixture(t, { dailyUserLimit: 1 }, images);
  const request = { id: 10, mid: 100, senderId: '12345', text: '改成水彩风' };
  for (const trigger of [[...images, request], [request]]) {
    f.ctx.session.trigger = trigger;
    assert.match((await f.tools.edit.execute(f.ctx, { prompt: '水彩风', requestMessageId: 100 })).content, /参考图不唯一/);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(f.usagePath), { code: 'ENOENT' });
  const result = await f.tools.edit.execute(f.ctx, { prompt: '水彩风', requestMessageId: 100, messageId: 90 });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, '/v1/second');
  assert.deepEqual(JSON.parse(await fs.readFile(f.usagePath, 'utf8')).users, { '12345': 1 });
});

test('请求之前没有图片时不选后来的图，也不以时间戳兼容缺少序号的记录', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 1 }, [
    { id: undefined, mid: 1, ts: 1, media: [{ kind: 'image', url: baseUrl + '/first' }] },
    { id: 12, mid: 12, media: [{ kind: 'image', url: baseUrl + '/second' }] }
  ]);
  f.ctx.session.trigger = [{ id: 11, mid: 11, senderId: '12345', ts: Date.now(), media: [] }];
  assert.match((await f.tools.edit.execute(f.ctx, { prompt: '水彩猫' })).content, /没有可用图片/);
  assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(f.usagePath), { code: 'ENOENT' });
});

test('无效请求消息在下载参考图和扣额前拒绝，不使用参考图或 userId 推断身份', async t => {
  const f = await quotaFixture(t, { dailyUserLimit: 1 }, [
    { mid: 10, senderId: '12345', media: [{ kind: 'image', url: baseUrl + '/ref' }] }
  ]);
  f.ctx.session.trigger = [{ id: 11, mid: 11, senderId: '12345' }, { id: 12, mid: 12, senderId: '67890' }];
  for (const tool of Object.values(f.tools)) {
    for (const requestMessageId of [10, 999, '12345']) {
      const result = await tool.execute(f.ctx, { prompt: '猫', requestMessageId, messageId: 10, userId: '12345' });
      assert.equal(result.isError, true);
      assert.match(result.content, /requestMessageId/);
    }
    assert.match((await tool.execute(f.ctx, { prompt: '猫', messageId: 10 })).content, /无法唯一确定/);
  }
  assert.equal(calls.length, 0);
  assert.equal(f.sent.length, 0);
  await assert.rejects(fs.stat(f.usagePath), { code: 'ENOENT' });
});
