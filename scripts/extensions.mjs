import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TYPES = { skills: 'skill.json', plugins: 'plugin.json' };
export const extensionKey = ({ type, manifest }) => `${type}/${manifest.id}`;

export function resourcePath(directory, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)) {
    throw new Error('扩展资源必须使用目录内的相对路径和 / 分隔符');
  }
  const full = path.resolve(directory, relative);
  const resolved = path.relative(directory, full);
  if (!resolved || resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
    throw new Error(`扩展资源路径越界：${relative}`);
  }
  return full;
}

export async function listExtensions(rootDir = ROOT) {
  const extensions = [];
  for (const [type, manifestFile] of Object.entries(TYPES)) {
    const parent = path.join(rootDir, type);
    let children;
    try { children = await fs.readdir(parent, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name.startsWith('.')) continue;
      if (child.isSymbolicLink()) throw new Error(`扩展目录不能是符号链接：${type}/${child.name}`);
      if (!child.isDirectory()) continue;
      const directory = path.join(parent, child.name);
      const manifestPath = path.join(directory, manifestFile);
      const stat = await fs.lstat(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${manifestFile} 必须是普通文件`);
      const text = await fs.readFile(manifestPath, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) throw new Error(`${child.name} 清单含 UTF-8 BOM`);
      const manifest = JSON.parse(text);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${child.name} 清单必须是对象`);
      if (manifest.id !== child.name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id)) {
        throw new Error(`${type}/${child.name} 的 id 必须合法且与目录名一致`);
      }
      if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)) throw new Error(`${manifest.id} 版本号无效`);
      const rawEntry = manifest.entry ?? 'index.js';
      resourcePath(directory, rawEntry);
      const entry = path.posix.normalize(rawEntry);
      extensions.push({ type, directory, manifestFile, manifest, entry });
    }
  }
  return extensions;
}

export function parseOptions(args, { allowAudit = false } = {}) {
  const options = { selectors: [], type: null, help: false, audit: false };
  let all = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--all') all = true;
    else if (arg === '--audit' && allowAudit) options.audit = true;
    else if (arg === '--type') {
      const value = args[++index];
      if (!Object.hasOwn(TYPES, value)) throw new Error('--type 必须是 skills 或 plugins');
      if (options.type && options.type !== value) throw new Error('一次只能指定一种 --type');
      options.type = value;
    } else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else options.selectors.push(arg);
  }
  if (all && options.selectors.length) throw new Error('--all 不能与指定 ID 同时使用');
  return options;
}

export function selectExtensions(extensions, { selectors = [], type = null } = {}) {
  const candidates = extensions.filter((item) => !type || item.type === type);
  if (!selectors.length) return candidates;
  const selected = selectors.map((id) => {
    const matches = candidates.filter((item) => item.manifest.id === id || extensionKey(item) === id);
    if (matches.length !== 1) {
      throw new Error(`找不到唯一扩展 ${id}，请使用明确的 ID 或 类型/ID。可选：${candidates.map(extensionKey).join('、') || '无'}`);
    }
    return matches[0];
  });
  return [...new Set(selected)];
}

export async function testFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(full));
    else if (entry.isFile() && /\.test\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}
