import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { beijing } from './pricing.mjs';

const DATA_DIR = path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LIFE_PATH = path.join(DATA_DIR, 'lifetime.json');
const FACES_PATH = path.join(DATA_DIR, 'faces.json');
const MAX_EVENTS = 50;
const MAX_FACES = 3000;

let state = null;
let lifetime = { tokens: 0, cost: 0, replies: 0, since: Date.now() };
// 观众脸谱：跨天保留，让她「记得这个人」
let faces = {};
let saveTimer = null;
let nextId = 1;

function freshState() {
  return {
    date: beijing().dateKey,
    startedAt: null,
    income: 0,
    spent: 0,
    tokensIn: 0,
    tokensOut: 0,
    aiCalls: 0,
    cacheHit: 0,
    cacheMiss: 0,
    replies: 0,
    entries: 0,
    follows: 0,
    likes: 0,
    gifts: {},
    giftBook: {},
    playlist: [],
    currentSong: null,
    events: [],
  };
}

export async function initStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(STATE_PATH)) {
    try {
      const raw = JSON.parse(await readFile(STATE_PATH, 'utf8'));
      state = { ...freshState(), ...raw };
      if (state.date !== beijing().dateKey) {
        // 跨天：保留图鉴、累计 token，其余清零
        const book = state.giftBook;
        state = freshState();
        state.giftBook = book;
      }
    } catch (err) {
      console.warn('[store] state.json 读取失败，重新开始：', err.message);
      state = freshState();
    }
  } else {
    state = freshState();
  }
  if (existsSync(LIFE_PATH)) {
    try {
      lifetime = { ...lifetime, ...JSON.parse(await readFile(LIFE_PATH, 'utf8')) };
    } catch {}
  }
  if (existsSync(FACES_PATH)) {
    try {
      const raw = JSON.parse(await readFile(FACES_PATH, 'utf8'));
      if (raw && typeof raw === 'object') faces = raw;
    } catch {}
  }
  return state;
}

export function getState() {
  if (!state) throw new Error('store 未初始化');
  return state;
}

export function getLifetime() {
  return lifetime;
}

export function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await flush();
  }, 1200);
}

export async function flush() {
  try {
    await writeFile(STATE_PATH, JSON.stringify(state), 'utf8');
    await writeFile(LIFE_PATH, JSON.stringify(lifetime), 'utf8');
    await writeFile(FACES_PATH, JSON.stringify(faces), 'utf8');
  } catch (err) {
    console.warn('[store] 落盘失败：', err.message);
  }
}

/**
 * 记一张脸：说过几次话、来过几次、上一句说的是什么。
 * 只留最近 MAX_FACES 个人，按 last 淘汰。
 */
export function touchFace(name, text, kind = 'chat') {
  const who = String(name || '').trim();
  if (!who || who === '神秘观众' || who === '绫波丽' || who === '系统') return null;
  const now = Date.now();
  const f = faces[who] || { chat: 0, visit: 0, first: now, last: 0, text: '', prev: '' };
  if (kind === 'chat') {
    f.chat += 1;
    const body = String(text || '').trim();
    if (body) {
      f.prev = f.text || '';
      f.text = body.slice(0, 60);
    }
  } else if (kind === 'enter') {
    f.visit += 1;
  } else if (kind === 'gift') {
    f.gift = (f.gift || 0) + 1;
  }
  f.last = now;
  faces[who] = f;
  const keys = Object.keys(faces);
  if (keys.length > MAX_FACES) {
    keys
      .sort((a, b) => (faces[a]?.last || 0) - (faces[b]?.last || 0))
      .slice(0, keys.length - MAX_FACES)
      .forEach((k) => delete faces[k]);
  }
  return f;
}

export function faceOf(name) {
  const who = String(name || '').trim();
  return who ? faces[who] || null : null;
}

export function faceCount() {
  return Object.keys(faces).length;
}

/** 统一入口：登记一条直播事件并更新统计 */
export function recordEvent(input) {
  const ev = {
    id: nextId++,
    ts: Number(input.ts) || Date.now(),
    kind: input.kind,
    username: String(input.username ?? '').slice(0, 40) || '神秘观众',
    text: String(input.text ?? '').slice(0, 300),
    gift: input.gift || null,
    source: input.source || 'unknown',
  };
  // 休息/作品讨论阶段的回复只出声、不进弹幕条
  if (input.voiceOnly) ev.voiceOnly = true;
  if (input.voice) ev.voice = String(input.voice);
  const s = getState();
  switch (ev.kind) {
    case 'chat':
      touchFace(ev.username, ev.text, 'chat');
      break;
    case 'gift':
      touchFace(ev.username, '', 'gift');
      if (ev.gift) {
        s.gifts[ev.gift.name] = (s.gifts[ev.gift.name] || 0) + (ev.gift.count || 1);
        s.giftBook[ev.gift.name] = true;
        s.income += ev.gift.price * (ev.gift.count || 1);
        s.income = Number(s.income.toFixed(2));
      }
      break;
    case 'enter':
      s.entries += 1;
      touchFace(ev.username, '', 'enter');
      break;
    case 'follow':
      s.follows += 1;
      break;
    case 'like':
      s.likes += 1;
      break;
  }
  if (!s.startedAt && ['chat', 'gift', 'enter', 'follow', 'like'].includes(ev.kind)) s.startedAt = ev.ts;
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  scheduleSave();
  return ev;
}

/** 记一条我说的话（没走 API 的兜底/点歌回复也走这里，保证刷新不丢） */
export function addAiEvent({ text, source = 'ai', ...rest }) {
  const s = getState();
  s.replies += 1;
  return recordEvent({ kind: 'ai', username: '绫波丽', text, source, ...rest });
}

export function addAiUsage({ usage, cost, replyText }) {
  const s = getState();
  const inTok = Number(usage?.prompt_tokens ?? 0);
  const outTok = Number(usage?.completion_tokens ?? 0);
  s.tokensIn += inTok;
  s.tokensOut += outTok;
  s.aiCalls = (s.aiCalls || 0) + 1;
  s.cacheHit += Number(usage?.prompt_cache_hit_tokens ?? 0);
  s.cacheMiss += Number(usage?.prompt_cache_miss_tokens ?? Math.max(0, inTok - (usage?.prompt_cache_hit_tokens ?? 0)));
  s.spent = Number((s.spent + cost).toFixed(4));
  s.replies += 1;
  lifetime.tokens += inTok + outTok;
  lifetime.cost = Number((lifetime.cost + cost).toFixed(4));
  lifetime.replies += 1;
  const ev = recordEvent({ kind: 'ai', username: '绫波丽', text: replyText, source: 'ai' });
  ev.cost = cost;
  ev.usage = {
    in: inTok,
    out: outTok,
    hit: Number(usage?.prompt_cache_hit_tokens ?? 0),
  };
  scheduleSave();
  return ev;
}

/** 只记 token 消耗，不进弹幕流（讲故事这种「我自己在讲」的调用用这个） */
export function addUsageOnly({ usage, cost }) {
  const s = getState();
  const inTok = Number(usage?.prompt_tokens ?? 0);
  const outTok = Number(usage?.completion_tokens ?? 0);
  s.tokensIn += inTok;
  s.tokensOut += outTok;
  s.cacheHit += Number(usage?.prompt_cache_hit_tokens ?? 0);
  s.cacheMiss += Number(usage?.prompt_cache_miss_tokens ?? Math.max(0, inTok - (usage?.prompt_cache_hit_tokens ?? 0)));
  s.spent = Number((s.spent + cost).toFixed(4));
  lifetime.tokens += inTok + outTok;
  lifetime.cost = Number((lifetime.cost + cost).toFixed(4));
  scheduleSave();
  return { inTok, outTok, cost };
}

export function pushPlaylist(title, by, queueMax = 3) {
  const s = getState();
  const item = { id: nextId++, title: title.slice(0, 60), by, ts: Date.now() };
  const playing = s.currentSong && s.currentSong.title === item.title;
  const queued = s.playlist.some((x) => x.title === item.title);
  if (playing || queued) return { ...item, dup: true };
  if (!s.currentSong) {
    // 第一首直接上播，不进等待队列
    s.currentSong = { title: item.title, by: item.by };
    scheduleSave();
    return { ...item, playing: true };
  }
  // 队列上限：排满了就不再收（正在播的那首不算）
  const max = Number.isFinite(Number(queueMax)) && Number(queueMax) > 0 ? Number(queueMax) : 3;
  if (s.playlist.length >= max) return { ...item, full: true, max };
  s.playlist.push(item);
  scheduleSave();
  return item;
}

export function nextSong() {
  const s = getState();
  const next = s.playlist.shift() || null;
  s.currentSong = next ? { title: next.title, by: next.by } : null;
  scheduleSave();
  return s.currentSong;
}

export function setCurrentSong(song) {
  const s = getState();
  s.currentSong = song ? { ...song } : null;
  scheduleSave();
  return s.currentSong;
}

export function patchCurrentSong(patch) {
  const s = getState();
  if (!s.currentSong) return null;
  s.currentSong = { ...s.currentSong, ...patch };
  scheduleSave();
  return s.currentSong;
}

export function addEventOnly(ev) {
  const s = getState();
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  scheduleSave();
  return ev;
}

export function resetDay() {
  const book = getState().giftBook;
  state = freshState();
  state.giftBook = book;
  scheduleSave();
  return state;
}
