import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndpoint, readSettings, validateArgs, buildBody } from '../../../skills/ai-image/lib/config.js';

const raw = { baseUrl: 'https://example.test/v1', apiKey: 'test-placeholder' };

test('域名、前缀和任一完整端点均能按模式解析', () => {
  for (const base of ['https://example.test', 'https://example.test/v1/', 'https://example.test/v1/images/generations', 'https://example.test/v1/images/edits/']) {
    assert.equal(resolveEndpoint(base, 'generate'), 'https://example.test/v1/images/generations');
    assert.equal(resolveEndpoint(base, 'edit'), 'https://example.test/v1/images/edits');
  }
  assert.equal(resolveEndpoint('https://example.test/proxy/v2', 'edit'), 'https://example.test/proxy/v2/images/edits');
  assert.throws(() => resolveEndpoint('file:///tmp', 'edit'));
  assert.throws(() => resolveEndpoint('https://user:password@example.test/v1', 'edit'));
  assert.throws(() => resolveEndpoint('https://example.test/v1?api_key=secret', 'edit'));
});

test('两种模式共用模型，也能配置单独的编辑模型', () => {
  assert.equal(readSettings(raw, 'edit').model, 'gpt-image-1');
  assert.equal(readSettings({ ...raw, model: 'gen-model', editModel: 'edit-model' }, 'edit').model, 'edit-model');
  assert.equal(readSettings({ ...raw, model: 'gen-model', editModel: 'edit-model' }).model, 'gen-model');
  assert.equal(readSettings(raw).maxRetries, 0);
});

test('extraBody 合法且不能注入或重复核心字段', () => {
  for (const extraBody of ['[]', 'null', '1', '{broken']) assert.throws(() => readSettings({ ...raw, extraBody }));
  const settings = readSettings({ ...raw, extraBody: JSON.stringify({ model: 'wrong', image: 'bad', 'image[]': 'bad', prompt: 'bad', n: 9, size: 'bad', response_format: 'url', stream: true, quality: 'high' }) });
  const args = validateArgs({ prompt: '一只猫' }, settings);
  const body = JSON.parse(buildBody(settings, args));
  assert.deepEqual(body, { model: 'gpt-image-1', prompt: '一只猫', n: 1, quality: 'high' });
  const form = buildBody(settings, args, { buffer: Buffer.from('fixture'), mime: 'image/png' });
  assert.equal(form.getAll('image').length, 1);
  assert.equal(form.getAll('model').length, 1);
  assert.equal(form.has('size'), false);
  assert.equal(form.has('response_format'), false);
});

test('付费操作之前拒绝不合法的参数', () => {
  const settings = readSettings(raw);
  for (const count of [0, -1, 1.5, 5, 'NaN']) assert.throws(() => validateArgs({ prompt: '猫', count }, settings));
  for (const prompt of ['', '  ', 1, 'a'.repeat(2001)]) assert.throws(() => validateArgs({ prompt }, settings));
  assert.throws(() => validateArgs({ prompt: '猫', size: 'wrong' }, settings));
});
