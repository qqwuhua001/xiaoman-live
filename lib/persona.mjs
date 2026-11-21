import { readFileSync } from 'node:fs';
import { beijing } from './pricing.mjs';

/**
 * 绫波丽的人格层。
 *
 * 2026-11-13：正文从代码里抽出来，放到 data/persona.md。
 * 改人设不用碰代码，编辑那个文件 → 控制面板点「重载人设」（或 curl 一下）就生效。
 * 文件被删/写坏时用下面这段兜底，保证服务不会因为人设丢了而不说话。
 */
const PERSONA_FILE = new URL('../data/persona.md', import.meta.url);
const FALLBACK_PERSONA =
  '你是「绫波丽」，坐在画室的高脚凳上画素描，镜头对着你，直播间的人说话你接。' +
  '安静、话少、有主见。先反应再回答，一般 1~2 句 15~40 字，不要客服腔，不复述问题。';

function loadPersona() {
  try {
    const t = readFileSync(PERSONA_FILE, 'utf8').trim();
    if (t.length > 200) return t;
    console.warn('[persona] data/persona.md 内容太短，先用内置兜底');
  } catch {
    console.warn('[persona] 没读到 data/persona.md，先用内置兜底');
  }
  return FALLBACK_PERSONA;
}

let BASE_PERSONA = loadPersona();

/** 改完 data/persona.md 调一下，不用重启服务。返回生效字数。 */
export function reloadPersona() {
  BASE_PERSONA = loadPersona();
  return BASE_PERSONA.length;
}


/** 给「这个人」的一句话画像：熟人/生人决定语气松紧 */
function describeFace(face, speaker) {
  const chat = Number(face?.chat || 0);
  const visit = Number(face?.visit || 0);
  const bits = [];
  if (chat <= 1) {
    bits.push('这个人第一次开口。客气一点，可以对他好奇一点。');
  } else if (chat <= 3) {
    bits.push(`这个人说过 ${chat} 次话，算认识了。语气可以自然点。`);
  } else {
    bits.push(`这个人说过 ${chat} 次话，是熟客。可以放松、可以开一句轻的玩笑。`);
  }
  if (visit >= 5) bits.push(`他来过 ${visit} 次。`);
  const prev = String(face?.prev || '').trim();
  if (prev) {
    bits.push(`他上次说的是「${prev.slice(0, 30)}」，接得上就顺口提一句；接不上就别硬提。`);
  }
  return bits.join('');
}

function timeOfDay(hhmm) {
  const h = Number(String(hhmm || '').slice(0, 2));
  if (!Number.isFinite(h)) return '现在';
  if (h < 5) return '凌晨';
  if (h < 9) return '清早';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

export function buildSystemPrompt(cfg, state, opts = {}) {
  const b = beijing();
  const giftCount = Object.values(state.gifts || {}).reduce((a, c) => a + c, 0);
  const lines = [
    BASE_PERSONA,
    '',
    '【此刻】',
    `- 现在 ${b.dateKey} ${b.hhmm}，${timeOfDay(b.hhmm)}。说话带一点这个时间的感觉：深夜可以问人怎么还不睡，清早可以问吃过没有。`,
    `- 今天进房 ${Number(state.entries || 0)} 人，收到礼物 ${giftCount} 个。这些数字你自己知道就行，不要说出口。`,
  ];
  if (opts.speaker) {
    lines.push(`- 正在跟你说话的人：${opts.speaker}。${describeFace(opts.face, opts.speaker)}`);
  }
  const lastLines = (opts.lastLines || []).filter(Boolean).slice(-8);
  if (lastLines.length) {
    lines.push(
      `- 你最近说过：${lastLines.map((t) => `「${String(t).slice(0, 24)}」`).join('、')}。不要重复这些话，也别用一样的开头。`,
    );
  }
  if (cfg.ai?.systemPrompt) lines.push('', '【主播本人的追加要求，优先遵守】', cfg.ai.systemPrompt);
  return lines.join('\n');
}

export function buildMessages(cfg, state, { username, text, recent = [], face = null }) {
  const lastLines = (state.events || [])
    .filter((e) => e.kind === 'ai' && e.text)
    .map((e) => e.text);
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg, state, { speaker: username, face, lastLines }) },
  ];
  for (const r of recent.slice(-6)) {
    const body = String(r.text || '');
    messages.push({
      role: r.kind === 'ai' ? 'assistant' : 'user',
      content: r.kind === 'ai' ? body : `[${r.username}] ${body}`,
    });
  }
  messages.push({ role: 'user', content: `[${username}] ${text}` });
  return messages;
}

/** 点歌 / 切歌 这类指令：不花 token，直接给固定语气 */
export function commandReply(kind) {
  if (kind === 'song') return '不唱。今天只说话。';
  if (kind === 'next') return '不唱。今天只说话。';
  return '';
}

/* ---------------- 清洗：把「机器味」从输出里剪掉 ---------------- */

const ROBOTIC = [
  /作为(一个|一名)?\s*(AI|人工智能|语言模型|助手|虚拟主播|主播)[，,：:]?/giu,
  /(很高兴|开心)(能)?(为|和|跟)你(交流|聊天|说话)[。！!]?/gu,
  /希望(能)?(对|帮到)你(有)?(所)?(帮助|帮)[。！!]?/gu,
  /(如果|若)(你)?(还)?有(其他|别的)?(问题|需要)[，,]?(随时|可以)?(问|找)我[。！!]?/gu,
  /(还有|其他)什么(可以|能)帮(到)?你/gu,
  /首先[，,]?|其次[，,]?|总的来说[，,]?|总而言之[，,]?|值得一提的是[，,]?/gu,
  /^\s*(绫波丽|助手|AI)\s*[：:]\s*/u,
];

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * 回复落库/进语音前统一过一遍：
 * 去掉客服腔、身份自述、颜文字、重复的省略号，控一下长度。
 */
export function normalizeReply(raw, { maxChars = 70 } = {}) {
  let t = String(raw || '')
    .replace(/\r/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^["“「『]|["”」』]$/g, '')
    .trim();
  for (const re of ROBOTIC) t = t.replace(re, '');
  t = t.replace(EMOJI, '');
  t = t.replace(/[~～]+/g, '');
  t = t.replace(/[!！]{2,}/g, '！');
  t = t.replace(/(…{3,}|\.{3,})/g, '……');
  t = t.replace(/(……)(?=.*……)/su, '，');
  t = t.replace(/^[，,、。\s]+/, '').replace(/\s+/g, ' ').trim();
  // 中文句子之间不该有空格（模型有时会在标点后带一个空格，念出来像卡了一下）
  t = t.replace(/(?<=[\u4e00-\u9fff，。？！、…])\s+(?=[\u4e00-\u9fff，。？！、…])/gu, '');
  // 开头的括号动作（会被念出来）
  t = t.replace(/^[（(][^）)]{0,12}[）)]\s*/, '');
  if (t.length > maxChars) {
    // 按句号/问号/感叹号截，尽量不切在句子中间
    const cut = t.slice(0, maxChars);
    const m = cut.match(/^[\s\S]*[。？！!?]/u);
    t = (m ? m[0] : cut).trim();
  }
  return t;
}
