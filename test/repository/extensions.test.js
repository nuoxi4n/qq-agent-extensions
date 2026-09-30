import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { listExtensions, selectExtensions, extensionKey, resourcePath } from '../../scripts/extensions.mjs';
import { extensionFiles, buildArchive } from '../../scripts/pack.mjs';

const all = await listExtensions();
const selectors = process.env.QQ_EXTENSIONS_TEST_SELECTION
  ? JSON.parse(process.env.QQ_EXTENSIONS_TEST_SELECTION) : [];
const selected = selectExtensions(all, { selectors });
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

for (const extension of selected) {
  const { manifest, type, directory } = extension;
  const label = extensionKey(extension);

  test(`${label}：清单、配置表单与使用说明有效`, async () => {
    assert.ok(manifest.name && manifest.description);
    assert.equal(manifest.apiVersion, 1);
    assert.ok(['model', 'message', 'knowledge', 'media', 'utility'].includes(manifest.category));
    assert.ok(isObject(manifest.settings ?? {}));
    assert.ok(isObject(manifest.configSchema ?? {}));
    for (const key of Object.keys(manifest.settings ?? {})) {
      assert.ok(manifest.configSchema?.[key], `${key} 缺少 configSchema`);
    }
    for (const [key, schema] of Object.entries(manifest.configSchema ?? {})) {
      assert.ok(schema.label || schema.type === 'internal', `${key} 缺少 label`);
      if (schema.type === 'enum') assert.ok(Array.isArray(schema.values) && schema.values.length);
      if (schema.type === 'internal') assert.ok(schema.description);
    }
    for (const section of manifest.prompt?.sections ?? []) {
      assert.ok(section.id && typeof section.content === 'string');
      if (section.priority != null) assert.ok(Number.isFinite(section.priority) && section.priority <= 99);
    }
    const readme = await fs.readFile(resourcePath(directory, 'README.md'), 'utf8');
    assert.ok(readme.trim(), '扩展应提供 README.md');
  });

  test(`${label}：入口可加载，注册内容符合 QQ Agent 契约`, async () => {
    const mod = await import(pathToFileURL(resourcePath(directory, extension.entry)).href);
    const setup = mod.setup ?? mod.register;
    const tools = [];
    const api = {
      config: () => structuredClone(manifest.settings ?? {}),
      registerTool: (tool) => { tools.push(tool); return `${manifest.id}__${tool.id}`; },
      fetch: async () => { throw new Error('通用加载检查不允许外部请求'); },
      log() {}, warn() {}, error() {}, isSkillActive: () => false,
      hasCapability: () => false, capability: () => undefined,
      utils: { sleep: async () => {}, safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } } }
    };
    try {
      if (setup) await setup(api);
      if (type === 'skills') assert.ok(tools.length, 'LLM 型技能需要注册工具');
      const ids = new Set();
      for (const tool of tools) {
        assert.match(tool.id, /^[A-Za-z0-9_-]+$/);
        const id = `${manifest.id.slice(0, 24)}__${tool.id.slice(0, 38)}`.replace(/[^A-Za-z0-9_-]/g, '_');
        assert.ok(!ids.has(id), `工具名冲突：${id}`);
        ids.add(id);
        assert.ok(tool.name && tool.description && tool.category);
        assert.equal(typeof tool.execute, 'function');
        assert.equal(tool.parameters?.type, 'object');
        if (tool.parameters.required) {
          assert.ok(Array.isArray(tool.parameters.required) && tool.parameters.required.length, '空 required 应省略');
          for (const name of tool.parameters.required) assert.ok(Object.hasOwn(tool.parameters.properties ?? {}, name));
        }
      }
      assert.deepEqual(Object.keys(mod.providers ?? {}).sort(), [...(manifest.capabilities ?? [])].sort());
      for (const provider of Object.values(mod.providers ?? {})) assert.equal(typeof provider, 'function');
      for (const hook of Object.values(mod.hooks ?? {})) assert.equal(typeof hook, 'function');
      if (mod.available) {
        const result = mod.available({});
        assert.ok(!result || typeof result.then !== 'function', 'available 必须同步');
      }
    } finally { await mod.dispose?.(); }
  });

  test(`${label}：独立安装包包含入口和说明，排除开发文件`, async () => {
    const files = await extensionFiles(extension);
    assert.ok(files.includes(extension.manifestFile));
    assert.ok(files.includes(extension.entry));
    assert.ok(files.includes('README.md'));
    assert.ok(files.every((name) => !/(^|\/)(\.git|\.local|node_modules|data|dist|test|tests|package\.json)(\/|$)/.test(name)));
    const archive = await buildArchive(extension);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.ok(archive.length <= 8 * 1024 * 1024);
  });
}
