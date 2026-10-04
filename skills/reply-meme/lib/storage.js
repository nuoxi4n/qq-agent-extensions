import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './image.js';

// Follow the host's public instance convention without importing its modules.
export function defaultCacheDir({ env = process.env, root = fileURLToPath(new URL('../../../', import.meta.url)), temp = os.tmpdir() } = {}) {
  const profile = String(env.QQ_AGENT_PROFILE ?? '').trim();
  const dataDir = path.resolve(env.QQ_AGENT_DATA_DIR || path.join(root, /^\d+$/.test(profile) ? `data-${profile}` : 'data'));
  const identity = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
  return path.join(temp, 'qq-agent-reply-meme', fingerprint(identity));
}
