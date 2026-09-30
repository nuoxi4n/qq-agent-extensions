import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, listExtensions, selectExtensions, parseOptions, extensionKey, testFiles } from '../../scripts/extensions.mjs';
import { extensionFiles, buildArchive } from '../../scripts/pack.mjs';

async function fixture(t) {
  const parent = path.join(ROOT, 'work');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'repository-test-'));
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const realDirectory = await fs.realpath(directory);
    assert.equal(path.dirname(realDirectory), realParent);
    assert.ok(path.basename(realDirectory).startsWith('repository-test-'));
    await fs.rm(realDirectory, { recursive: true });
  });
  return directory;
}

async function write(root, name, value) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function addExtension(root, type, id, extra = {}) {
  const directory = path.join(root, type, id);
  await write(directory, type === 'skills' ? 'skill.json' : 'plugin.json', {
    id, name: id, version: '1.0.0', apiVersion: 1, category: 'utility',
    description: 'fixture', settings: {}, configSchema: {}, ...extra
  });
  await write(directory, extra.entry || 'index.js', 'export function setup(api) {}\n');
  await write(directory, 'README.md', '# Fixture\n');
  return directory;
}

test('无需扩展名单即可发现新目录，并按类型或明确 ID 选择', async (t) => {
  const root = await fixture(t);
  await addExtension(root, 'skills', 'sample');
  await addExtension(root, 'plugins', 'sample');
  const items = await listExtensions(root);
  assert.equal(items.length, 2);
  assert.throws(() => selectExtensions(items, { selectors: ['sample'] }), /唯一扩展/);
  assert.deepEqual(selectExtensions(items, { selectors: ['skills/sample'] }).map(extensionKey), ['skills/sample']);
  assert.deepEqual(selectExtensions(items, { type: 'plugins' }).map(extensionKey), ['plugins/sample']);
  assert.throws(() => selectExtensions(items, { selectors: ['missing'] }), /唯一扩展/);
});

test('支持自定义入口、根目录模块和新资源目录，不包含缓存与 npm 元数据', async (t) => {
  const root = await fixture(t);
  const directory = await addExtension(root, 'skills', 'custom', { entry: 'runtime/main.mjs' });
  await write(directory, 'helper.js', 'export const value = 1;\n');
  await write(directory, 'templates/prompt.txt', 'fixture prompt');
  await write(directory, '.env', 'API_KEY=fixture');
  await write(directory, 'data/private.json', {});
  await write(directory, 'package.json', { private: true });
  await write(directory, 'lib/sample.test.js', 'throw new Error("not runtime");');
  const [extension] = await listExtensions(root);
  const files = await extensionFiles(extension);
  assert.ok(files.includes('runtime/main.mjs') && files.includes('helper.js') && files.includes('templates/prompt.txt'));
  assert.ok(!files.includes('.env') && !files.includes('data/private.json') && !files.includes('package.json') && !files.includes('lib/sample.test.js'));
  const archive = await buildArchive(extension);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
});

test('拒绝缺失入口、越界入口、默认密钥及市场禁止文件', async (t) => {
  const root = await fixture(t);
  const directory = await addExtension(root, 'plugins', 'sample');
  const [extension] = await listExtensions(root);
  await assert.rejects(buildArchive({ ...extension, entry: 'missing.js' }), /缺少清单或入口/);
  await assert.rejects(buildArchive({ ...extension, manifest: { ...extension.manifest, settings: { apiKey: 'fixture' } } }), /包含默认密钥/);
  await write(directory, 'helper.ps1', '# fixture');
  await assert.rejects(buildArchive(extension), /禁止的文件类型/);
  await write(directory, 'plugin.json', { ...extension.manifest, entry: '../outside.js' });
  await assert.rejects(listExtensions(root), /越界/);
});

test('测试文件发现支持嵌套目录，不依赖专项测试名称', async (t) => {
  const root = await fixture(t);
  await write(root, 'nested/feature.test.mjs', '');
  await write(root, 'feature.test.js', '');
  await write(root, 'helper.js', '');
  await write(root, 'node_modules/ignored.test.js', '');
  assert.deepEqual((await testFiles(root)).map((file) => path.relative(root, file).replaceAll('\\', '/')), [
    'feature.test.js', 'nested/feature.test.mjs'
  ]);
});

test('测试与打包共享参数规则，错误选择不会静默运行全部扩展', () => {
  assert.deepEqual(parseOptions(['--type', 'plugins', 'sample']).selectors, ['sample']);
  assert.equal(parseOptions(['--audit'], { allowAudit: true }).audit, true);
  assert.throws(() => parseOptions(['--type', 'unknown']), /--type/);
  assert.throws(() => parseOptions(['--audit']), /未知参数/);
  assert.throws(() => parseOptions(['--all', 'sample']), /不能/);
});
