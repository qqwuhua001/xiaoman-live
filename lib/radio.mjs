/**
 * 氛围电台：常驻播放自己的免版权曲库，按时间与“有没有人”自动换曲。
 * 与 lib/music.mjs（点歌）无关，互不影响。
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/* 一天的三个场次：白天在画室里，傍晚靠窗，夜里更空 */
const MOOD_OF_HOUR = (h) => (h >= 17 && h < 21 ? 'window' : h >= 21 || h < 5 ? 'night' : 'room');
const MOOD_LABEL = { room: '画室', window: '窗边', night: '夜里' };

export class Radio {
  constructor(getCfg, { hasAudience, log } = {}) {
    this.getCfg = getCfg;
    this.hasAudience = hasAudience || (() => false);
    this.log = log || (() => {});
    this.tracks = [];
    this.recent = [];
    this.proc = null;
    this.cur = null;
    this.played = 0;
    this.timer = null;
    this.guard = null;      // 看门狗：某首歌卡住不出声/不退出时强制切下一首
    this.paused = false;
    this.lastError = '';
    this.loaded = 0;
    this.source = '';
  }

  cfg() {
    return this.getCfg()?.radio || {};
  }

  load() {
    const dir = join(process.cwd(), this.cfg().dir || 'assets_music');
    const catPath = join(dir, 'catalog.json');
    if (!existsSync(catPath)) {
      this.lastError = '没有 assets_music/catalog.json';
      return 0;
    }
    try {
      const cat = JSON.parse(readFileSync(catPath, 'utf8'));
      this.tracks = (cat.tracks || [])
        .map((t) => ({ ...t, path: join(dir, t.file) }))
        .filter((t) => existsSync(t.path));
      this.loaded = this.tracks.length;
      this.source = String(cat.source || '');
      this.lastError = '';
    } catch (err) {
      this.lastError = String(err?.message || err);
      this.loaded = 0;
    }
    return this.loaded;
  }

  mood() {
    let m = MOOD_OF_HOUR(new Date().getHours());
    /* 没人的时候偏夜里那一档：更空、更慢 */
    if (m === 'room' && !this.hasAudience()) m = 'night';
    return m;
  }

  pick() {
    const m = this.mood();
    let pool = this.tracks.filter((t) => t.mood === m);
    if (!pool.length) pool = this.tracks;
    const fresh = pool.filter((t) => !this.recent.includes(t.file));
    const list = fresh.length ? fresh : pool;
    const t = list[Math.floor(Math.random() * list.length)];
    if (!t) return null;
    this.recent.push(t.file);
    if (this.recent.length > 8) this.recent.shift();
    return t;
  }

  start() {
    if (!this.loaded) this.load();
    if (!this.tracks.length) {
      this.log(this.lastError || '曲库是空的');
      return false;
    }
    this.paused = false;
    this.next();
    return true;
  }

  next() {
    clearTimeout(this.timer);
    this.timer = null;
    this.killProc();
    const t = this.pick();
    if (t) this.play(t);
  }

  play(t) {
    const vol = Number(this.cfg().volume ?? 0.13);
    this.cur = { ...t, startedAt: Date.now() };
    this.played += 1;
    this.log(`♪ ${MOOD_LABEL[t.mood] || t.mood} · ${t.name}（${Math.round((t.sec || 0) / 60)} 分钟）`);
    let proc;
    try {
      proc = spawn('/usr/bin/afplay', ['-v', String(vol), t.path], { stdio: 'ignore' });
    } catch (err) {
      this.lastError = String(err?.message || err);
      this.scheduleNext(8000);
      return;
    }
    this.proc = proc;
    // 正常情况 afplay 放完自己退出；卡住的话（设备被切走 / 文件读一半）靠这个兜底
    clearTimeout(this.guard);
    const sec = Number(t.sec) || 0;
    if (sec > 0) {
      this.guard = setTimeout(() => {
        if (this.proc !== proc) return;
        this.log(`♪ ${t.name} 超时没退出，强制切下一首`);
        this.proc = null;
        try { proc.kill('SIGKILL'); } catch { /* 已经没了 */ }
        if (!this.paused) this.scheduleNext(600);
      }, (sec + 10) * 1000);
    }
    proc.on('exit', () => {
      clearTimeout(this.guard);
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.paused) this.scheduleNext();
    });
    proc.on('error', (err) => {
      this.lastError = String(err?.message || err);
      if (!this.paused) this.scheduleNext(8000);
    });
  }

  scheduleNext(ms) {
    const gap = this.cfg().gapSec || [5, 9];
    const wait = ms ?? (Number(gap[0]) + Math.random() * (Number(gap[1]) - Number(gap[0]))) * 1000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.paused) this.next();
    }, wait);
  }

  killProc() {
    clearTimeout(this.guard);
    this.guard = null;
    if (!this.proc) return;
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* 已经结束了 */
    }
    this.proc = null;
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.killProc();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.next();
  }

  stop() {
    this.pause();
    this.cur = null;
  }

  status() {
    const m = this.mood();
    return {
      enabled: this.cfg().enabled !== false,
      running: !!this.proc,
      paused: this.paused,
      loaded: this.loaded,
      played: this.played,
      mood: m,
      moodLabel: MOOD_LABEL[m],
      volume: Number(this.cfg().volume ?? 0.13),
      current: this.cur
        ? {
            name: this.cur.name,
            artist: this.cur.artist,
            mood: this.cur.mood,
            sec: this.cur.sec,
            startedAt: this.cur.startedAt,
          }
        : null,
      lastError: this.lastError,
      source: this.source,
    };
  }
}
