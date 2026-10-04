import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkImage, decodeBase64 } from './images.js?v=1.0.5';
import { positiveInteger } from './config.js?v=1.0.5';
import { messageId } from './context.js?v=1.0.5';

function imageMedias(entry) {
  if (entry?.recalled || !Array.isArray(entry?.media)) return [];
  return entry.media.filter((media) => media?.kind === 'image' && (media.url || media.file));
}

async function automaticReference(ctx, request) {
  if (imageMedias(request.message).length) return request.message;
  const beforeRequest = entry => Number.isSafeInteger(entry?.id) && entry.id > 0
    && entry.id <= request.message.id && imageMedias(entry).length;
  let candidates = request.trigger.filter(beforeRequest);
  if (!candidates.length) {
    candidates = (await ctx.store.recent(ctx.chatKey, { limit: 30 })).filter(beforeRequest);
  }
  if (candidates.length > 1) throw new Error('参考图不唯一，请用 messageId 指定要修改的带图消息');
  if (!candidates.length) throw new Error('请求消息及其之前的最近记录里没有可用图片，请先发送参考图或指定 messageId');
  return candidates[0];
}

async function readLocalReference(source, settings, operation) {
  const localPath = /^file:/i.test(source) ? fileURLToPath(source) : source;
  operation?.check();
  const handle = await fs.open(localPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > settings.maxRefBytes) throw new Error('参考图不是普通文件或超过体积上限');
    // 读取 stat 时的长度，避免文件增长导致无界分配。
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      operation?.check();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    operation?.check();
    return checkImage(buffer.subarray(0, offset), settings.maxRefBytes, true).buffer;
  } finally { await handle.close(); }
}

export async function loadReference(ctx, args, request, settings, client, operation) {
  operation?.check();
  const imageIndex = positiveInteger(args.imageIndex, 1, 'imageIndex', 100);
  let entry;
  if (args.messageId != null) {
    const mid = messageId(args.messageId, 'messageId');
    entry = await ctx.store.findByMid(ctx.chatKey, mid);
    if (!entry) throw new Error(`当前会话找不到消息 #${mid}，请使用真实的带图消息 id`);
  } else {
    entry = await automaticReference(ctx, request);
  }
  operation?.check();
  const images = imageMedias(entry);
  if (!images.length) throw new Error('指定消息里没有可用图片，请确认消息 id');
  if (imageIndex > images.length) throw new Error(`这条消息只有 ${images.length} 张图片，不能选择第 ${imageIndex} 张`);
  const media = images[imageIndex - 1];
  let buffer;
  let lastError;
  const triedUrls = new Set();
  async function fromUrl(value) {
    const url = String(value || '').trim();
    if (!url || triedUrls.has(url)) return null;
    triedUrls.add(url);
    try {
      const downloaded = await client.download(url, settings.refDownloadTimeoutMs, settings.maxRefBytes, operation);
      return checkImage(downloaded, settings.maxRefBytes, true).buffer;
    } catch (error) { operation?.check(); lastError = error; return null; }
  }
  if (media.url) buffer = await fromUrl(media.url);
  // 仅从当前会话的媒体 file id 向协议端查询路径，不接收模型提供的任意本地路径。
  if (!buffer && media.file && typeof ctx.onebot?.call === 'function') {
    try {
      operation?.check();
      const info = await ctx.onebot.call('get_image', { file: String(media.file) });
      operation?.check();
      const result = info?.data || info;
      if (result?.url) buffer = await fromUrl(result.url);
      if (!buffer) {
        const source = String(result?.file || result?.path || '');
        if (/^https?:\/\//i.test(source)) buffer = await fromUrl(source);
        else if (source) buffer = await readLocalReference(source, settings, operation);
      }
    } catch (error) { operation?.check(); lastError = error; }
  }
  operation?.check();
  if (!buffer) throw new Error(`参考图读取失败：${lastError?.message || '链接不可用且协议端没有提供文件'}。请重新发送参考图`);
  return {
    ...checkImage(buffer, settings.maxRefBytes, true),
    origin: `消息 #${entry.mid ?? '未知'} 的第 ${imageIndex} 张图`
  };
}

export async function providerReference(image, settings, client, operation) {
  operation?.check();
  let buffer;
  if (Buffer.isBuffer(image?.buffer)) buffer = image.buffer;
  else if (typeof image === 'string' || image?.dataUrl) {
    buffer = decodeBase64(typeof image === 'string' ? image : image.dataUrl, settings.maxRefBytes);
  } else if (image?.url) buffer = await client.download(image.url, settings.refDownloadTimeoutMs, settings.maxRefBytes, operation);
  else throw new Error('请提供参考图 image：{ buffer }、{ dataUrl } 或 { url }');
  operation?.check();
  return checkImage(buffer, settings.maxRefBytes, true);
}
