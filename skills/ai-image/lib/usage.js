import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function usageFile() {
  const profile = (process.env.QQ_AGENT_PROFILE || '').trim();
  const directory = process.env.QQ_AGENT_DATA_DIR || fileURLToPath(new URL(`../../../data${/^\d+$/.test(profile) ? `-${profile}` : ''}/`, import.meta.url));
  return path.resolve(directory, 'ai-image-usage.json');
}

const integer = value => Number.isSafeInteger(value) && value >= 0;
function restore(data) {
  if (!data || data.version !== 1 || !integer(data.total) || !integer(data.totalImages)
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.day) || !integer(data.dailyTotal)
    || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)
    || Object.entries(data.users).some(([key, n]) => !/^(provider|unknown|[1-9]\d{4,11})$/.test(key) || !integer(n))
    || Object.values(data.users).reduce((a, b) => a + b, 0) !== data.dailyTotal
    || data.dailyTotal > data.total || data.totalImages < data.total) throw new Error('生图用量记录损坏，已停止请求，请管理员检查数据文件');
  return data;
}

// 每次提交前同步锁定、重读并原子保存；并发调用和其他进程不能使用同一个剩余额度。
export function consumeUsage(settings, user, count, { file = usageFile(), now = new Date() } = {}) {
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch { throw new Error('生图用量记录正在使用或遗留锁未清理，请稍后重试或联系管理员'); }
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    let data;
    try { data = restore(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取生图用量记录，已停止请求，请管理员检查数据文件');
      data = { version: 1, total: 0, totalImages: 0, day, dailyTotal: 0, users: {} };
    }
    if (day < data.day) throw new Error('系统日期早于生图用量记录，已停止请求');
    if (day > data.day) Object.assign(data, { day, dailyTotal: 0, users: {} });
    if (settings.dailyUserLimit && (data.users[user] || 0) >= settings.dailyUserLimit) throw new Error(`已达到${user === 'provider' ? '扩展能力共享' : '个人'}每日生图上限（${settings.dailyUserLimit} 次），北京时间次日重置`);
    if (settings.dailyTotalLimit && data.dailyTotal >= settings.dailyTotalLimit) throw new Error(`已达到全局每日生图上限（${settings.dailyTotalLimit} 次）`);
    if (settings.totalLimit && data.total >= settings.totalLimit) throw new Error(`已达到累计生图上限（${settings.totalLimit} 次），请联系管理员`);
    data.total++;
    data.totalImages += count;
    data.dailyTotal++;
    data.users[user] = (data.users[user] || 0) + 1;
    if (!integer(data.total) || !integer(data.totalImages)) throw new Error('生图用量超出可记录范围');
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    return data;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* 没有临时文件 */ }
    fs.rmdirSync(lock);
  }
}
