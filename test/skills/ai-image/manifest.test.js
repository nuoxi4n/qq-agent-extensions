import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, available, promptSections, providers } from '../../../skills/ai-image/index.js';

const raw = await fs.readFile(new URL('../../../skills/ai-image/skill.json', import.meta.url));
const manifest = JSON.parse(raw.toString('utf8'));

test('QQ-agent 清单、配置 UI 与能力实现保持一致', () => {
  assert.notEqual(raw[0], 0xef, '清单不能带 UTF-8 BOM');
  assert.equal(manifest.id, 'ai-image');
  assert.equal(manifest.author, 'nuoxi4n');
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.category, 'media');
  assert.deepEqual(Object.keys(manifest.settings).sort(), Object.keys(manifest.configSchema).sort());
  assert.deepEqual(manifest.capabilities.sort(), Object.keys(providers).sort());
  assert.ok(manifest.permissions.includes('web_fetch'));
  assert.equal(manifest.configSchema.apiKey.secret, true);
  assert.equal(manifest.settings.apiKey, '');
  assert.equal(manifest.settings.baseUrl, '');
  for (const schema of Object.values(manifest.configSchema)) {
    assert.ok(schema.label);
    assert.ok(schema.description);
    if (schema.type === 'enum') assert.ok(schema.values.length);
  }
});

test('工具契约合法，配置缺失同步显示原因，热更新无需 setup', async () => {
  let config = { ...manifest.settings };
  const tools = [];
  setup({ config: () => config, fetch: () => { throw new Error('不应联网'); }, registerTool: (tool) => tools.push(tool) });
  assert.deepEqual(tools.map((tool) => tool.id), ['gen', 'edit']);
  for (const tool of tools) {
    assert.match(`${manifest.id}__${tool.id}`, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(tool.description.includes('当用户'));
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Object.keys(tool.parameters.properties).length <= 5);
    assert.deepEqual(tool.parameters.required, ['prompt']);
  }
  assert.equal(available().ok, false);
  assert.equal(available() instanceof Promise, false);
  assert.deepEqual(promptSections(), []);
  const failure = await tools[0].execute({ sender: { sendImage() {} } }, { prompt: '猫' });
  assert.equal(failure.isError, true);
  config = { ...config, baseUrl: 'https://example.test/v1', apiKey: 'test-placeholder' };
  assert.equal(available().ok, true);
  assert.ok(promptSections().every((section) => section.priority <= 99));
  config.extraBody = '{ invalid';
  assert.equal(available().ok, false);
});
