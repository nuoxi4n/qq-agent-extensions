import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../../skills/ai-image/', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=', 'base64');

for (const [limit, message] of [['dailyUserLimit', /个人每日/], ['dailyTotalLimit', /全局每日/], ['totalLimit', /累计/]]) {
  test(`覆盖安装后仅重载入口，${limit} 仍扣额并在重载后保留`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-upgrade-'));
    const installed = path.join(root, 'skills', 'ai-image');
    const previous = process.env.QQ_AGENT_DATA_DIR;
    process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
    const usagePath = path.join(process.env.QQ_AGENT_DATA_DIR, 'ai-image-usage.json');
    const cache = new Set();
    let skill;
    t.after(async () => {
      skill?.dispose();
      if (previous === undefined) delete process.env.QQ_AGENT_DATA_DIR;
      else process.env.QQ_AGENT_DATA_DIR = previous;
      for (const file of cache) {
        assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir(), 'qq-agent-ai-image') + path.sep));
        await fs.unlink(file).catch(() => {});
      }
      const resolved = await fs.realpath(root);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('ai-image-upgrade-'));
      await fs.rm(resolved, { recursive: true, force: true });
    });
    await fs.cp(source, installed, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    // 重现 1.0.1 的关键行为：无版本的静态依赖、图片客户端不调用扣额钩子。
    for (const file of ['index.js', 'lib/config.js', 'lib/images.js', 'lib/reference.js', 'lib/usage.js', 'lib/context.js']) {
      const target = path.join(installed, file);
      const text = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, text.replace(/\?v=[\d.]+/g, '').replace('operation?.beforeSubmit?.();', ''));
    }
    const config = {
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-placeholder',
      dailyUserLimit: 0, dailyTotalLimit: 0, totalLimit: 0, [limit]: 1
    };
    let posts = 0;
    const tools = {};
    const api = {
      config: () => config,
      registerTool: tool => { tools[tool.id] = tool; },
      fetch: async (url, options) => {
        if (options.method === 'POST') {
          posts++;
          return Response.json({ data: [{ b64_json: png.toString('base64') }] });
        }
        return new Response(png);
      }
    };
    const ctx = {
      chatKey: 'group:12345',
      session: { status: 'running', trigger: [{ id: 2, mid: 2, senderId: '12345' }], sent: [{ type: 'text', text: '我来画' }] },
      store: { recent: () => [{ id: 1, mid: 1, media: [{ kind: 'image', url: 'https://fixture.invalid/ref' }] }] },
      sender: { sendImage: async (key, image) => { if (image.file) cache.add(image.file); return { message_id: 1 }; } }
    };
    const entry = pathToFileURL(path.join(installed, 'index.js')).href;
    skill = await import(`${entry}?t=old`);
    skill.setup(api);
    assert.equal((await tools.gen.execute(ctx, { prompt: '猫' })).isError, undefined);
    await assert.rejects(fs.stat(usagePath), { code: 'ENOENT' });
    skill.dispose();

    await fs.cp(source, installed, { recursive: true });
    skill = await import(`${entry}?t=upgrade`);
    skill.setup(api);
    assert.equal((await tools.gen.execute(ctx, { prompt: '猫' })).isError, undefined);
    assert.equal(JSON.parse(await fs.readFile(usagePath, 'utf8')).total, 1);
    assert.match((await tools.edit.execute(ctx, { prompt: '水彩猫' })).content, message);
    assert.equal(posts, 2, '升级后达到上限不能再次提交接口');

    skill.dispose();
    skill = await import(`${entry}?t=reload`);
    skill.setup(api);
    assert.match((await tools.gen.execute(ctx, { prompt: '猫' })).content, message);
    config[limit] = 2;
    assert.equal((await tools.edit.execute(ctx, { prompt: '水彩猫' })).isError, undefined);
    assert.equal(JSON.parse(await fs.readFile(usagePath, 'utf8')).total, 2);
    assert.equal(posts, 3);
  });
}
