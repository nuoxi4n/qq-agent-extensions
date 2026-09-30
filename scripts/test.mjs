import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, listExtensions, parseOptions, selectExtensions, extensionKey, testFiles } from './extensions.mjs';

async function main() {
  const options = parseOptions(process.argv.slice(2), { allowAudit: true });
  if (options.help) {
    console.log('用法：npm test -- [ID 或 类型/ID ...] [--type skills|plugins] [--audit]');
    console.log('默认运行通用检查和所有已发现的专项测试；--audit 只运行通用检查。');
    return;
  }
  const selected = selectExtensions(await listExtensions(), options);
  if (!selected.length) throw new Error('没有匹配的扩展');
  const files = await testFiles(path.join(ROOT, 'test', 'repository'));
  if (!files.length) throw new Error('test/repository 下没有通用检查');
  if (!options.audit) {
    for (const extension of selected) {
      files.push(...await testFiles(path.join(ROOT, 'test', extension.type, extension.manifest.id)));
    }
  }
  console.log(`检查范围：${selected.map(extensionKey).join('、')}`);
  const child = spawn(process.execPath, ['--test', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, QQ_EXTENSIONS_TEST_SELECTION: JSON.stringify(selected.map(extensionKey)) }
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.exitCode = signal ? 1 : code ?? 1;
      resolve();
    });
  });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
