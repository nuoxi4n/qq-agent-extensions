// 真实进程生命周期夹具：故意不调用 deactivate/dispose，模拟宿主直接退出。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCurrencyPlugin } from '../../plugins/currency/index.js';
import { createRapportPlugin } from '../../plugins/rapport/index.js';
import { createWorkPlugin } from '../../skills/work/index.js';
import { createFeedingSkill } from '../../skills/feeding/index.js';

const [mode, directory, modulePath] = process.argv.slice(2);
const send = data => process.send(data);
const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const parse = result => good(JSON.parse(result.content.split('\n')[0]));
process.on('message', message => { if (message === 'exit') process.exit(0); });

if (mode === 'lock') {
  const { createFileLock } = await import(new URL(`../../${modulePath}/lib/file-lock.js`, import.meta.url));
  const lock = createFileLock();
  process.on('message', message => {
    if (message !== 'acquire') return;
    try { lock.acquire(`${directory}/race.json.lock`); send({ ok: true }); }
    catch (error) { send({ ok: false, code: error.code, message: error.message, stack: error.stack }); }
  });
  send({ ready: true });
} else {
  const at = Date.parse('2026-10-02T04:00:00Z');
  Date.now = () => at;
  const currency = createCurrencyPlugin({ directory });
  const rapport = createRapportPlugin();
  const work = createWorkPlugin({ directory, draw: () => 0 });
  const feeding = createFeedingSkill({ directory });
  const workTools = {}, feedingTools = {};
  const base = { isSkillActive: () => true, registerTool() {}, fetch() { assert.fail('不应调用模型'); } };
  const capability = (name, args) => (name === 'currency.v1' ? currency : rapport).providers[name](args);
  currency.setup({ ...base, config: () => ({ integrationPermissions: JSON.stringify({ seed: ['credit'], work: ['credit'], feeding: ['reserve', 'capture', 'release'] }) }) });
  rapport.setup({ ...base, config: () => ({ perMessage: 0, atBotBonus: 0, decayEnabled: false,
    integrationPermissions: JSON.stringify({ feeding: ['recordEvent', 'rateEvent', 'bindMessage'] }) }) });
  work.setup({ ...base, capability, config: () => ({}), registerTool: tool => { workTools[tool.id] = tool; } });
  feeding.setup({ ...base, capability, config: () => ({}), registerTool: tool => { feedingTools[tool.id] = tool; } });
  const extensions = { currency, rapport, work, feeding };
  if (mode === 'probe') {
    const errors = {};
    for (const [name, extension] of Object.entries(extensions)) {
      try { extension.activate(); errors[name] = null; }
      catch (error) { errors[name] = error.code ?? error.message; }
    }
    send({ errors });
  } else {
    for (const extension of Object.values(extensions)) extension.activate();
    const wallet = currency.providers['currency.v1']({ consumer: 'seed' });
    good(wallet.credit({ scope: 'group:12345', userId: '10001', amount: 1000, requestId: 'seed', reason: '测试资金' }));
    const context = (mid, text) => ({ chatKey: 'group:12345', kind: 'group', chatId: '12345', selfId: '88888',
      session: { status: 'running', triggerEntries: [{ mid, text, ts: at, senderId: '10001' }], sent: [] } });
    const workResult = parse(workTools.play.execute(context('100', '我要打工'), { messageId: '100' }));
    const feedingResult = parse(feedingTools.feed.execute(context('200', '买饼干投喂你'), { messageId: '200', food: '饼干' }));
    if (mode === 'exit-cleanup-retry') {
      // 隔离子进程内模拟退出时每个锁文件第一次删除失败。
      const unlink = fs.unlinkSync, failed = new Set();
      fs.unlinkSync = file => {
        if (String(file).includes('.lock') && !failed.has(file)) {
          failed.add(file);
          throw Object.assign(new Error('temporary sharing violation'), { code: 'EPERM' });
        }
        return unlink(file);
      };
    }
    send({ work: workResult, feeding: feedingResult, balance: good(wallet.balance({ scope: 'group:12345', userId: '10001' })).balance,
      available: Object.fromEntries(Object.entries(extensions).map(([name, extension]) => [name, extension.available()])) });
  }
}
