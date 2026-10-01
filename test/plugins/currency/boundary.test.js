import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listExtensions } from '../../../scripts/extensions.mjs';
import { buildArchive } from '../../../scripts/pack.mjs';

const source = fileURLToPath(new URL('../../../plugins/currency/', import.meta.url));

test('货币安装包在无宿主源码和其他扩展的目录里加载并完成奖励、预扣与结算', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-package-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('currency-package-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const extension = (await listExtensions()).find(item => item.manifest.id === 'currency');
  const archive = await buildArchive(extension);
  const destination = path.join(root, 'plugins', 'currency');
  let cursor = 0;
  const packed = [];
  // 仓库使用 ZIP Store；从真实安装包提取并运行，避免仅验证源码目录。
  while (archive.readUInt32LE(cursor) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(cursor + 8), 0);
    const size = archive.readUInt32LE(cursor + 18), nameSize = archive.readUInt16LE(cursor + 26), extra = archive.readUInt16LE(cursor + 28);
    const name = archive.subarray(cursor + 30, cursor + 30 + nameSize).toString('utf8');
    const file = path.resolve(destination, name);
    assert.ok(file.startsWith(path.resolve(destination) + path.sep));
    const start = cursor + 30 + nameSize + extra;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, archive.subarray(start, start + size));
    packed.push(name); cursor = start + size;
  }
  for (const name of ['api.d.ts', 'README.md', 'API.md', 'examples/reward.js', 'examples/shop.js', 'plugin.json']) assert.ok(packed.includes(name));
  for (const name of packed.filter(name => name.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(source, name), 'utf8');
    for (const match of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('node:')) continue;
      const full = path.resolve(path.dirname(path.join(source, name)), match[1]);
      assert.ok(full.startsWith(path.resolve(source) + path.sep), `模块越界：${name} -> ${match[1]}`);
    }
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import * as plugin from './plugins/currency/index.js';
    import { grantReward } from './plugins/currency/examples/reward.js';
    import { settleOrder } from './plugins/currency/examples/shop.js';
    const settings = { integrationPermissions: JSON.stringify({
      'quest-reward': ['credit'], 'item-shop': ['reserve','capture','release','refund']
    }) };
    plugin.setup({config: () => settings, registerTool() {}});
    plugin.activate();
    try {
      const api = {capability: (name, args) => plugin.providers[name]?.(args)};
      const reward = await grantReward(api, {scope: 'group:12345', userId: '10001', amount: 100, eventId: 'first'});
      assert.equal(reward.ok, true);
      const purchase = await settleOrder(api, {grantOnce: async () => ({status:'delivered'})}, {
        id:'first-order', scope:'group:12345', userId:'10001', price:30, itemId:'cat-potion'
      });
      assert.equal(purchase.ok, true);
      const money = api.capability('currency.v1', {consumer:'reader'});
      assert.equal(money.balance({scope:'group:12345', userId:'10001'}).available,70);
      assert.equal(fs.existsSync('./data-2/currency.json'),true);
      assert.equal(fs.existsSync('./data/currency.json'),false);
    } finally { plugin.dispose(); }
    assert.equal(fs.existsSync('./data-2/currency.json.lock'),false);
  `], { cwd: root, env: { ...process.env, QQ_AGENT_DATA_DIR: '', QQ_AGENT_PROFILE: '2' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
