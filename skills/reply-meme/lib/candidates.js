import { fingerprint } from './image.js';

// Diversify the shelf, never classify the conversation or decide whether to send.
const SHELVES = [
  /生气|气鼓鼓|愤怒|哼|你才|反击/, /哈哈|大笑|笑死|乐/, /疑惑|问号|震惊/,
  /委屈|哭|难过|可怜/, /抱抱|安慰|摸摸/, /喜欢|爱你|比心|贴贴/,
  /躺平|摆烂|摸鱼|装死/, /谢谢|感谢|不客气/, /晚安|早安|你好|Ciallo/i,
  /加油|厉害|真棒/, /开心|好耶|高兴|得意/, /钱|续费|收费|余额|赞助/,
  /无语|嫌弃|吐槽/, /害羞|尴尬|捂脸/, /道歉|对不起|认错/, /收到|好的|同意/
];
const STOP = new Set(['我们', '你们', '这个', '那个', '就是', '一个', '什么', '怎么', '可以', '现在', '然后', '一下', '还是', '不是', '因为', '所以', '用户', '机器人', '模型']);
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const norm = value => String(value || '').normalize('NFKC').toLowerCase();
export const candidateId = item => fingerprint(item.original).slice(0, 16);

export function buildCandidates(items, text = '', { seen = () => false, limit = 28, seed = '' } = {}) {
  const words = [...new Set([...segmenter.segment(norm(text).slice(-6000))]
    .filter(x => x.isWordLike && x.segment.length >= 2 && !STOP.has(x.segment)).map(x => x.segment))].slice(-96);
  const pool = items.filter(item => !/壁纸|人物介绍|角色设定|立绘/.test(item.title)).map(item => {
    const title = norm(item.title), story = norm(item.story);
    return { ...item, recent: seen(item), fit: words.reduce((n, w) => n + (title.includes(w) ? 4 : story.includes(w) ? 1 : 0), 0),
      tie: fingerprint(seed + item.original).slice(0, 8) };
  });
  const novelty = (a, b) => Number(a.recent) - Number(b.recent) || a.tie.localeCompare(b.tie);
  const selected = [], taken = new Set();
  const add = item => { if (item && !taken.has(item.original) && selected.length < limit) { taken.add(item.original); selected.push(item); } };
  pool.filter(x => x.fit > 0).sort((a, b) => b.fit - a.fit || novelty(a, b)).slice(0, Math.floor(limit / 3)).forEach(add);
  for (const shelf of SHELVES) add(pool.filter(x => shelf.test(x.title) && !taken.has(x.original)).sort(novelty)[0]);
  pool.sort(novelty).forEach(add);
  return selected;
}

export function describe(item, recent = false) {
  return { id: candidateId(item), title: item.title.slice(0, 110), description: item.story.slice(0, 100), character: item.category, recentlySent: recent };
}
