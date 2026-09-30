// 使用 ZIP Store 格式打包独立扩展，无需安装压缩库。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listExtensions, parseOptions, selectExtensions, extensionKey, resourcePath } from './extensions.mjs';

const excluded = new Set(['.git', '.local', 'node_modules', 'data', 'dist', 'test', 'tests', 'coverage', '__pycache__']);
const developmentFiles = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'AGENTS.md', 'Thumbs.db']);
const forbidden = /\.(exe|dll|bat|cmd|ps1|vbs|sh|py)$/i;

export async function extensionFiles(extension) {
  const { directory, manifest, manifestFile, entry } = extension;
  for (const [key, value] of Object.entries(manifest.settings || {})) {
    if ((manifest.configSchema?.[key]?.secret || /(api.?key|token|password|secret)$/i.test(key)) && value != null && value !== '') {
      throw new Error(`${manifest.id} 的 ${key} 包含默认密钥，请清空后打包`);
    }
  }
  const files = [];
  let bytes = 0;
  async function visit(relative) {
    const full = resourcePath(directory, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`安装包不能包含符号链接：${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort()) {
        if (skip(name)) continue;
        await visit(`${relative}/${name}`);
      }
    } else if (stat.isFile()) {
      if (forbidden.test(relative)) throw new Error(`市场禁止的文件类型：${relative}`);
      files.push(relative);
      bytes += stat.size;
      if (files.length > 100 || bytes > 32 * 1024 * 1024) throw new Error(`${manifest.id} 超过市场文件数或解压体积限制`);
    }
  }
  function skip(name) {
    return excluded.has(name) || developmentFiles.has(name) || name.startsWith('.')
      || /\.(log|tmp|bak)$/i.test(name) || /\.(?:test|spec)\.(?:js|mjs|cjs)$/i.test(name);
  }
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!skip(name)) await visit(name);
  }
  if (!files.includes(manifestFile) || !files.includes(entry)) throw new Error(`${manifest.id} 安装包缺少清单或入口 ${entry}`);
  return files;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function buildArchive(extension) {
  const files = await extensionFiles(extension);
  const records = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const data = await fs.readFile(path.join(extension.directory, file));
    const name = Buffer.from(file);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01；可复现打包。
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralData = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...records, centralData, end]);
  if (archive.length > 8 * 1024 * 1024) throw new Error('压缩包超过市场 8MB 限制');
  return archive;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('用法：npm run pack -- [ID 或 类型/ID ...] [--type skills|plugins]');
    console.log('不指定 ID 时打包全部匹配扩展，输出到 dist/<类型>/<id>-<版本>.zip。');
    return;
  }
  const selected = selectExtensions(await listExtensions(), options);
  if (!selected.length) throw new Error('没有匹配的扩展');
  for (const extension of selected) {
    const archive = await buildArchive(extension);
    const { id, version } = extension.manifest;
    const output = path.join(ROOT, 'dist', extension.type, `${id}-${version}.zip`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, archive);
    console.log(`${extensionKey(extension)} → ${output}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
