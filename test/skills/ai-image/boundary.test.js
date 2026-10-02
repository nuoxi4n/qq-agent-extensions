import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../../skills/ai-image/', import.meta.url));

test('生图技能的模块依赖限定在自身目录与 Node 内置模块', async () => {
  const root = await fs.realpath(source);
  async function check(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await check(file); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = await fs.readFile(file, 'utf8');
      // 当前技能仅使用静态 ESM 导入；不允许重新引入动态宿主模块桥接。
      assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/, file);
      for (const match of text.matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (specifier.startsWith('node:')) continue;
        assert.ok(specifier.startsWith('.'), `不支持的依赖：${specifier}`);
        const resolved = await fs.realpath(path.resolve(path.dirname(file), specifier));
        const relative = path.relative(root, resolved);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `依赖越过技能目录：${specifier}`);
      }
    }
  }
  await check(root);
});

test('在没有宿主 src 或配置的独立目录中，只使用公开 api/ctx 完成生图和改图', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-boundary-'));
  let skill;
  const previousDataDir = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = path.join(temporary, 'data');
  try {
    const installed = path.join(temporary, 'isolated-skill');
    await fs.cp(source, installed, { recursive: true });
    await fs.writeFile(path.join(temporary, 'package.json'), '{"type":"module"}');
    skill = await import(pathToFileURL(path.join(installed, 'index.js')).href);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');
    const registered = {};
    const calls = [];
    skill.setup({
      config: () => ({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-placeholder', dailyUserLimit: 0 }),
      registerTool: tool => { registered[tool.id] = tool; },
      fetch: async (url, options) => {
        calls.push(url);
        if (url === 'https://fixture.invalid/reference') return new Response(png);
        assert.match(url, /^https:\/\/fixture\.invalid\/v1\/images\/(generations|edits)$/);
        assert.equal(options.method, 'POST');
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      }
    });
    const images = [];
    const ctx = {
      chatKey: 'group:123', session: { status: 'running', sent: [{ type: 'text', text: '我来画～' }] },
      store: { recent: () => [{ mid: 1, media: [{ kind: 'image', url: 'https://fixture.invalid/reference' }] }] },
      sender: { sendImage: async (key, image) => {
        images.push(image);
        if (image.file) {
          const cacheRoot = path.resolve(os.tmpdir(), 'qq-agent-ai-image') + path.sep;
          assert.ok(path.resolve(image.file).startsWith(cacheRoot));
          await fs.unlink(image.file);
        }
        return { message_id: images.length };
      } }
    };
    for (const mode of ['gen', 'edit']) {
      const result = await registered[mode].execute(ctx, { prompt: '猫' });
      assert.equal(result.isError, undefined);
      assert.match(result.content, /调用 send_message/);
    }
    assert.equal(images.length, 2);
    assert.equal(calls.length, 3, '仅一次生图、一次参考图下载、一次改图，不调用聊天模型');
  } finally {
    skill?.dispose();
    if (previousDataDir === undefined) delete process.env.QQ_AGENT_DATA_DIR;
    else process.env.QQ_AGENT_DATA_DIR = previousDataDir;
    const resolved = await fs.realpath(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('ai-image-boundary-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
