import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/* ---------- 防重复：近似句判定 + 冷却期 ---------- */
const PUNC = /[\s\u3000，。、；：！？…—～·,.;:!?~"'“”‘’（）()《》<>【】\[\]]/g;
const norm = (s) => String(s || '').replace(PUNC, '').toLowerCase();
function bigrams(str) {
  const g = new Set();
  for (let i = 0; i < str.length - 1; i += 1) g.add(str.slice(i, i + 2));
  return g;
}
/** 两句是否太像：原文相同 / 开头六个字相同 / 二字组重合 70% 以上 */
export function isTooClose(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.length >= 6 && B.length >= 6) {
    let p = 0;
    const m = Math.min(A.length, B.length, 10);
    while (p < m && A[p] === B[p]) p += 1;
    if (p >= 6) return true;
  }
  const GA = bigrams(A), GB = bigrams(B);
  if (!GA.size || !GB.size) return false;
  let inter = 0;
  for (const g of GA) if (GB.has(g)) inter += 1;
  return (2 * inter) / (GA.size + GB.size) >= 0.7;
}
export function anyTooClose(text, list) {
  return (list || []).some((x) => isTooClose(text, x));
}

/* 同一句多久之后才允许再出现。默认 30 分钟。 */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const seenAt = new Map();
export function remember(text) {
  const k = String(text || '').trim();
  if (!k) return;
  seenAt.set(k, Date.now());
  if (seenAt.size > 600) {
    const now = Date.now();
    for (const [kk, t] of seenAt) if (now - t > DEFAULT_COOLDOWN_MS * 3) seenAt.delete(kk);
  }
}
export function forgetAll() { seenAt.clear(); }

/** 台词文件被外部改过（面板加台词那条路），丢掉缓存重读 */
export function reloadLines() { cache = null; }

const FILE = fileURLToPath(new URL('../data/lines.json', import.meta.url));
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(j.lines) ? j.lines.filter((l) => l && l.text) : [];
  } catch (e) {
    console.warn('[lines] 台词库读取失败：', String(e?.message || e));
    cache = [];
  }
  return cache;
}

/** 每句一个稳定 id（cat + 文本的短 hash），面板按 id 开关/删除 */
export function lineId(l) {
  return crypto.createHash('sha1').update(`${l.cat || ''}|${l.text || ''}`).digest('hex').slice(0, 10);
}

function persist(lines) {
  cache = lines;
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, note: '绫波丽的台词库：cat 决定用途，off=true 表示这句暂时不说', lines }, null, 2), 'utf8');
}

/** 面板用：全部台词（含已关掉的） */
export function allLines() {
  return load().map((l) => ({ id: lineId(l), cat: l.cat, text: l.text, off: l.off === true }));
}

/** 某一类里「还开着」的台词，招呼模板按 cat 取 */
export function linesByCat(cat) {
  return load().filter((l) => l.cat === cat && l.off !== true)
    .map((l) => ({ id: lineId(l), cat: l.cat, text: l.text }));
}

export function isLineAvailable(text) {
  const t = String(text || '').trim();
  return load().some((l) => l.text === t && l.off !== true);
}

/** 开关某一句（返回 false 表示找不到） */
export function setLineOff(id, off) {
  const lines = load().slice();
  const i = lines.findIndex((l) => lineId(l) === id);
  if (i < 0) return false;
  if (off) lines[i] = { ...lines[i], off: true };
  else { const { off: _drop, ...rest } = lines[i]; lines[i] = rest; }
  persist(lines);
  return true;
}

/** 改一句的正文：保留分类和开关状态，返回新的 id（id 是 cat+text 的 sha1） */
export function editLine(id, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const lines = load().slice();
  const i = lines.findIndex((l) => lineId(l) === id);
  if (i < 0) return null;
  if (lines.some((l, k) => k !== i && l.text === t)) return { dup: true };
  lines[i] = { ...lines[i], text: t };
  persist(lines);
  return { id: lineId(lines[i]), cat: lines[i].cat, text: t, off: !!lines[i].off };
}

/** 直接删掉某一句（写回 lines.json） */
export function deleteLine(id) {
  const lines = load().slice();
  const i = lines.findIndex((l) => lineId(l) === id);
  if (i < 0) return false;
  lines.splice(i, 1);
  persist(lines);
  return true;
}

/** 手动加一句（和面板「加台词」用同一份文件） */
export function addLine(text, cat = 'short') {
  const t = String(text || '').trim();
  if (!t) return null;
  const lines = load().slice();
  if (lines.some((l) => l.text === t)) return null;
  const item = { cat, text: t };
  lines.push(item);
  persist(lines);
  return { id: lineId(item), cat, text: t };
}

/** 台词库总条数（管理页/日志用） */
export function lineCount() {
  return load().filter((l) => l.off !== true).length;
}

/**
 * 台词分两用：
 *  - 喃喃自语（没人的时候自己念）：画室、光、东西、身体、安静、手上动作
 *  - 直播用语（必须有事件触发才说）：进人打招呼、关注、礼物、留人、收工
 * 快答属于「回复」，也只走弹幕命中。
 */
export const MURMUR_CATS = ['paper', 'light', 'things', 'self', 'quiet', 'body', 'work', 'short'];
export const LIVE_CATS = ['greet', 'hold', 'follow', 'gift', 'bye', 'quick'];

/**
 * 抽一句没在最近说过的台词。
 * @param {{recent?: string[], cat?: string, monologueChance?: number}} opt
 */
export function nextLine(opt = {}) {
  const all = load().filter((l) => l.off !== true);
  if (!all.length) return '';
  const recent = (opt.recent || []).filter(Boolean).slice(-120);
  const monologueChance = Number.isFinite(Number(opt.monologueChance)) ? Number(opt.monologueChance) : 0.08;
  const cooldown = Number.isFinite(Number(opt.cooldownMs)) ? Number(opt.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const now = Date.now();

  let pool;
  if (opt.cat) {
    pool = all.filter((l) => l.cat === opt.cat);
  } else if (Math.random() < monologueChance) {
    pool = all.filter((l) => l.cat === 'monologue');
  } else {
    /* 默认只从"喃喃自语"里挑：直播用语(打招呼/关注/礼物/留人/收工)和快答不属于自言自语 */
    pool = all.filter((l) => MURMUR_CATS.includes(l.cat));
  }
  if (!pool.length) pool = all.filter((l) => l.cat !== 'monologue');

  const strict = (l) => {
    if (recent.includes(l.text)) return false;
    if (anyTooClose(l.text, recent)) return false;
    const t = seenAt.get(l.text);
    return !(t && now - t < cooldown);
  };
  const noSame = (l) => !recent.includes(l.text) && !anyTooClose(l.text, recent);

  let list = pool.filter(strict);
  if (!list.length) list = pool.filter(noSame);                       // 冷却期到了但句子太少
  if (!list.length) list = pool.filter((l) => !recent.includes(l.text)); // 近似判定太严
  if (!list.length) list = pool.length ? pool : all;                    // 兜底

  const pick = list[Math.floor(Math.random() * list.length)];
  remember(pick.text);
  return pick.text;
}
