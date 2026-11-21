/* 绫波丽直播间前端（竖屏版）：SSE 收弹幕/礼物/回话，只做展示，不回写抖音 */
(() => {
  const SERVER = location.origin;
  const say = document.getElementById('say');
  const voiceEl = document.getElementById('voice');
  const READ = { on: false };   /* 长文朗读：一句放完自动领下一句 */
  const toast = document.getElementById('toast');
  const soundhint = document.getElementById('soundhint');
  const dmlist = document.getElementById('dmlist');
  const DM_MAX = 2;
  const dmItems = [];
  let dmCount = 0;
  const STATIC = new URLSearchParams(location.search).has('static');
  if (STATIC) document.body.classList.add('static');

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function clock() {
    const el = document.getElementById('clock');
    if (!el) return; // 新版版面不再显示时钟，元素可能不存在
    const d = new Date();
    el.textContent =
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  setInterval(clock, 20000); clock();

  function toastMsg(text) {
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = text;
    toast.appendChild(t);
    setTimeout(() => t.remove(), 4200);
    while (toast.children.length > 3) toast.firstChild.remove();
  }

  /* ---------- 弹幕条 ---------- */
  function pushDanmaku(ev) {
    if (!ev || ev.kind !== 'chat' || !ev.text) return;
    dmItems.unshift(ev);
    if (dmItems.length > DM_MAX) dmItems.pop();
    dmCount += 1;
    const c = document.getElementById('dmCount');
    if (c) c.textContent = dmCount;
    renderDmlist();
  }

  function renderDmlist() {
    const last = document.getElementById('dmLast');
    const num = document.getElementById('dmNum');
    if (num) num.textContent = dmCount + '条';
    if (last) {
      if (!dmItems.length) {
        last.textContent = '等观众说话';
      } else {
        const ev = dmItems[0];
        last.innerHTML = '<b>' + esc(ev.username || '观众') + '</b>：' + esc(ev.text);
      }
    }
    if (dmlist) {
      dmlist.innerHTML = dmItems.length
        ? dmItems.map((ev) => '<li><b>' + esc(ev.username || '观众') + '</b>' + esc(ev.text) + '</li>').join('')
        : '<li class="empty">等观众说话</li>';
    }
  }

  /* ---------- 消息 ---------- */
  let lastEventTs = Date.now();
  function addEvent(ev, silent, replay) {
    if (!ev || !ev.kind) return;
    lastEventTs = Date.now();
    if (!silent) pushDanmaku(ev);

    if ((ev.kind === 'chat' || ev.kind === 'danmaku') && !STATIC) beginThink();
    if (ev.kind === 'ai') {
      if (ev.source === 'read') READ.on = true;
      if (ev.text) setCaption(ev.text);
      if (!replay && ev.voice && ev.voiceOnly !== false) playVoice(ev.voice, ev.source !== 'idle');
      const mood = document.getElementById('moodTag');
      if (mood) mood.textContent = ev.source === 'idle' ? '自己待着' : '在这儿';
      if (ev.source === 'enter' && !STATIC) showFrame('wave', 2800);
      if (currentPose === 'think') { endThink(); showFrame('base', 0); }
      if (ev.source === 'idle' && !STATIC) {
        const pose = poseForText(ev.text || '');
        if (pose) showFrame(pose, pose === 'blink' ? 500 : 3200);
      }
    } else if (ev.kind === 'gift') {
      if (replay) return;
      const g = ev.gift || {};
      const name = g.name || '礼物';
      const n = g.count || 1;
      toastMsg((ev.username || '有人') + ' 送出 ' + name + ' ×' + n);
    }
  }

  /* 安静了一阵子：让她自己轻轻晃一晃，别像张挂画 */
  const girlEl = document.getElementById('girl');

  /* ---------- 待机小动作：眨眼、撩刘海、喝水、伸懒腰、看手机、画画 ---------- */
  const FRAME = {
    base: 'assets/rei/v2_base.png',
    blink: 'assets/rei/v2_blink.png',
    hair: 'assets/rei/v2_hair.png',
    drink: 'assets/rei/v2_drink.png',
    stretch: 'assets/rei/v3_stretch.png',
    phone: 'assets/rei/v2_phone.png',
    draw: 'assets/rei/v2_base.png',
    wave: 'assets/rei/v2_wave.png',
    think: 'assets/rei/v2_think.png',
    lookout: 'assets/rei/v3_lookout.png',
    lean: 'assets/rei/v3_lean.png',
    holdup: 'assets/rei/v3_holdup.png',
    blow: 'assets/rei/v3_blow.png',
    wipe: 'assets/rei/v3_wipe.png',
    point: 'assets/rei/v3_point.png',
    stand: 'assets/rei/v3_stand.png',
    walk: 'assets/rei/v3_walk.png',
    window: 'assets/rei/v3_window.png',
    crouch: 'assets/rei/v4_crouch.png',
  };
  /* ---------- 拟音：换个动作配一声，音量压得很低，说话时让路 ---------- */
  const SFX = {
    hair: 'sfx/cloth.wav',
    drink: 'sfx/sip.wav',
    stretch: 'sfx/cloth.wav',
    holdup: 'sfx/paper.wav',
    blow: 'sfx/blow.wav',
    wipe: 'sfx/cloth.wav',
    lean: 'sfx/cloth.wav',
    stand: 'sfx/stool.wav',
    walk: 'sfx/steps.wav',
    crouch: 'sfx/cloth.wav',
    draw: 'sfx/pencil_paper.wav',
  };
  function voiceBusy() {
    return !!voiceEl && !voiceEl.paused && !voiceEl.ended && voiceEl.currentTime > 0;
  }
  /* 语音排队：一直接一句会听到「半句被掐断」，排着播就行。
     正式回复（弹幕/进房/命令）优先：正在自语就打断它，别让观众等；
     自语之间则老实排队，最多排 3 句，多了丢掉。 */
  let vQueue = [];
  let vCur = '';
  function startVoice(url) {
    vCur = url;
    voiceEl.src = url;
    voiceEl.volume = VOL.voice;
    voiceEl.play().catch(() => {});
  }
  function voiceNext() {
    vCur = '';
    const n = vQueue.shift();
    if (n) { startVoice(n); syncVoiceIdle(); return; }
    syncVoiceIdle();
    if (READ.on) askNextRead();     /* 朗读模式：这句放完就去服务端领下一句 */
  }

  /* 长文朗读是「页面驱动」的：服务端合成一句、广播一句，这里放完再要下一句，
     这样第一句 3 秒就能出声，不用等整篇合成完。 */
  function askNextRead() {
    fetch(SERVER + '/api/control/read/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((d) => {
        if (!d) { READ.on = false; return; }
        if (d.busy) { setTimeout(askNextRead, 1200); return; }   /* 服务端正在合成下一句，稍后再要 */
        if (d.done || d.stopped || d.running === false) READ.on = false;
      })
      .catch(() => { READ.on = false; });
  }
  function syncVoiceIdle() {
    /* 说话中给聊天区一个提示位，别处不用 */
    document.body.classList.toggle('speaking', voiceBusy());
  }
  const sfxPool = [];
  const VOL = { voice: 0.9, sfx: 0.5, amb: 0.22 };   // 控制板可调，服务端存 config
  let actSfx = null;        // 当前动作音，独占：新动作上来先把旧的掐掉，绝不叠成一堆
  let lastSfxAt = 0;
  let lastSfxName = '';
  function playSfx(name, vol) {
    if (STATIC || !SFX[name]) return;
    const now = Date.now();
    // 连点不同动作时容易几声糊在一起：600ms 内只留第一声，同一段音效 1.2 秒内不重播
    if (now - lastSfxAt < 600) return;
    if (name === lastSfxName && now - lastSfxAt < 1200) return;
    lastSfxAt = now;
    lastSfxName = name;
    try {
      if (actSfx) {
        try { actSfx.pause(); actSfx.currentTime = 0; } catch { /* 已经播完了 */ }
        actSfx = null;
      }
      const a = new Audio(SFX[name]);
      // 她在说话时也照常出声（现实中喝水就是边喝边说），只把音量让一点，不整个掐掉
      const base = (vol == null) ? VOL.sfx : vol;
      a.volume = voiceBusy() ? base * 0.7 : base;
      const log = (ok, err) => {
        try {
          console.warn('[sfx]', ok ? '响了' : '没播出来', SFX[name], err || '');
          fetch('/api/sfxlog', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, file: SFX[name], ok, err: err || '' }),
          }).catch(() => {});
        } catch { /* 忽略 */ }
      };
      a.play().then(() => log(true, '')).catch((e) => log(false, (e && e.name) || 'unknown'));
      actSfx = a;
      sfxPool.push(a);
      while (sfxPool.length > 4) sfxPool.shift();   // 留住引用，别被回收掉
    } catch {
      /* 播不出来就算了，不能影响画面 */
    }
  }
  let frameTimer = 0;
  let currentPose = 'base';
  let thinkTimer = 0;
  let thinking = false;
  function beginThink() {
    if (STATIC) return;
    thinking = true;
    showFrame('think', 0);
    clearTimeout(thinkTimer);
    thinkTimer = setTimeout(() => { thinking = false; if (currentPose === 'think') showFrame('base', 0); }, 12000);
  }
  function endThink() {
    thinking = false;
    clearTimeout(thinkTimer);
  }
  const forcedFrame = new URLSearchParams(location.search).get('frame');
  const sketchVid = document.getElementById('sketchVid');
  // 四个机位轮着放，别让观众一直看同一帧（同一段实拍切出来的不同构图/段落）
  /* 速写窗：两块 video 叠化。换镜点卡在一段的循环收尾（笔刚好回到起笔位置），
     看起来就是"这张画完、换下一张"，不是原地闪一下。 */
  const SKETCH_CLIPS = [
    'assets/studio/sketch.mp4',
    'assets/studio/sketch_e.mp4',
    'assets/studio/sketch_b.mp4',
    'assets/studio/sketch_f.mp4',
    'assets/studio/sketch_c.mp4',
    'assets/studio/sketch_d.mp4',
  ];
  const SKETCH_MIN_PLAY = 24;              // 一段至少播 24 秒；15 秒的短片段会播两遍
  const sketchA = document.getElementById('sketchVid');
  const sketchB = document.getElementById('sketchVidB');
  let sketchIdx = 1;   /* 从新加的 A 段起播，之后按列表顺序轮 */
  let sketchFront = sketchA;
  let sketchBack = sketchB;

  function sketchLoad(el, src) {
    el.loop = false;                 // 不用 loop：loop 回到 0 秒那一帧会被浏览器吞掉，判断不到
    el.muted = true;
    el.src = src;
    el.currentTime = 0;
    el.play().catch(() => {});
  }

  function sketchNext() {
    const next = (sketchIdx + 1) % SKETCH_CLIPS.length;
    const back = sketchBack;
    const old = sketchFront;
    back.classList.remove('on');
    sketchLoad(back, SKETCH_CLIPS[next]);
    /* 新的一段先跑起来再叠上来，65ms 让浏览器先渲染第一帧，避免叠化时看到空窗 */
    setTimeout(() => {
      back.classList.add('on');
      old.classList.remove('on');
    }, 65);
    sketchFront = back;
    sketchBack = old;
    sketchIdx = next;
    sketchRound = 0;
    setTimeout(() => { old.pause(); }, 1000);   // 淡完再停旧的，别中途掐断画面
  }

  let sketchRound = 0;               // 当前这段已经放了几遍

  /* 一段放到结尾再决定：不够 24 秒就原地重播一遍（不切、不闪），够了就叠化换下一段。
     结尾那一刻笔正好停在纸上，从这里换镜最干净。 */
  function onSketchEnded(el) {
    if (el !== sketchFront) return;
    const dur = el.duration || 0;
    sketchRound += 1;
    if (sketchRound * dur < SKETCH_MIN_PLAY) {
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    sketchRound = 0;
    sketchNext();
  }

  if (sketchA) {
    sketchLoad(sketchA, SKETCH_CLIPS[sketchIdx]);
    sketchA.classList.add('on');
    sketchA.addEventListener('ended', () => onSketchEnded(sketchA));
    sketchB.addEventListener('ended', () => onSketchEnded(sketchB));
  }

  function syncSketch(pose) {
    if (!sketchA) return;
    if (pose === 'base') { sketchFront.play().catch(() => {}); }
    else { sketchA.pause(); sketchB.pause(); }
  }
  function showFrame(name, ms, opts) {
    if (!girlEl || STATIC || !FRAME[name]) return;
    if (currentPose === name) return;
    currentPose = name;
    girlEl.src = FRAME[name];
    if (!(opts && opts.silent)) playSfx(name === 'walk' ? 'walk' : name);
    syncSketch(name);
    clearTimeout(frameTimer);
    if (ms <= 0) return;
    frameTimer = setTimeout(() => {
      currentPose = 'base';
      girlEl.src = FRAME.base;
      syncSketch('base');
    }, ms);
  }

  if (sketchA) {
    const tryPlay = () => { sketchFront.play().catch(() => {}); };
    tryPlay();
    document.addEventListener('pointerdown', tryPlay, { once: true });
  }
  if (forcedFrame && FRAME[forcedFrame] && girlEl) {
    girlEl.src = FRAME[forcedFrame];
  } else if (!STATIC) {
    let awayNow = false;
    Object.keys(FRAME).forEach((k) => { const im = new Image(); im.src = FRAME[k]; });

    // 眨眼：固定的小频率，说话时停
    (function blinkLoop() {
      setTimeout(() => {
        // 眨眼是无声的自然动作，不该每十几秒来一声布料
        if (!thinking && !awayNow && Date.now() - lastEventTs > 5000) showFrame('blink', 170, { silent: true });
        blinkLoop();
      }, 3000 + Math.random() * 4000);
    })();

    // 其它小动作：闲下来才做，每次随机挑一件，45~95 秒一次
    const ACTIONS = [
      { name: 'hair', ms: 2400 },
      { name: 'drink', ms: 3400 },
      { name: 'stretch', ms: 4200 },
      { name: 'phone', ms: 4200 },
      { name: 'lookout', ms: 5200 },
      { name: 'lean', ms: 4200 },
      { name: 'holdup', ms: 4200 },
      { name: 'blow', ms: 3200 },
      { name: 'wipe', ms: 3000 },
      { name: 'point', ms: 4000 },
      { name: 'crouch', ms: 3600 },
    ];
    (function actionLoop() {
      setTimeout(() => {
        if (!thinking && !awayNow && Date.now() - lastEventTs > 12000) {
          const a = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
          showFrame(a.name, a.ms);
        }
        actionLoop();
      }, 22000 + Math.random() * 26000);
    })();

    /* 画画的声音：坐着画的时候，隔一阵子来一段铅笔摩擦纸的沙沙声 */
    (function drawLoop() {
      setTimeout(() => {
        if (!thinking && !awayNow && currentPose === 'base' && Date.now() - lastEventTs > 6000) {
          playSfx('draw', VOL.sfx * 0.6);
        }
        drawLoop();
      }, 15000 + Math.random() * 17000);
    })();

    // 起身走动：每 7~13 分钟一次，站起来走两步、去窗边看一会儿、再回来坐下
    const walkSeq = [
      ['stand', 2000], ['walk', 1500], ['walk', 1500], ['window', 9000],
      ['walk', 1600], ['walk', 1600], ['stand', 1600], ['base', 0],
    ];
    (async function walkLoop() {
      const wait = 420000 + Math.random() * 360000;   // 7~13 分钟一次
      setTimeout(async () => {
        if (!thinking && Date.now() - lastEventTs > 12000) {
          awayNow = true;
          for (const [name, ms] of walkSeq) {
            if (thinking) break;                 // 有人说话就先回去回答
            showFrame(name, 0);                  // 长驻，靠 sleep 控制每步时长
            await new Promise((r) => setTimeout(r, ms || 600));
          }
          showFrame('base', 0);
          awayNow = false;
        }
        walkLoop();
      }, wait);
    })().catch(() => {});
  }

  /* 自言自语说什么，就顺手配个动作，别嘴上说画画、手里端着杯子 */
  function poseForText(t) {
    if (/窗外|外面|窗边|天气|下雨|月亮|天空/.test(t)) return 'lookout';
    if (/蹲|掉了|捡|地上/.test(t)) return 'crouch';
    if (/站起来|起身|走|走到|过去/.test(t)) return 'walk';
    if (/懒腰|伸|动一动|舒展/.test(t)) return 'stretch';
    if (/看|凑近|低/.test(t)) return 'lean';
    if (/纸|素描纸|晾|一页/.test(t)) return 'holdup';
    if (/茶|杯|水|喝|咖啡/.test(t)) return 'drink';
    if (/手机|屏幕|消息|评论|留言/.test(t)) return 'phone';
    if (/画|速写|写|本子|笔|涂/.test(t)) return 'draw';
    if (/头发|刘海|发丝|发梢|挠/.test(t)) return 'hair';
    if (/眼睛|揉|困|眨/.test(t)) return 'blink';
    return '';
  }

  let idleNow = false;
  setInterval(() => {
    const quiet = Date.now() - lastEventTs > 45_000;
    if (!girlEl || quiet === idleNow) return;
    idleNow = quiet;
    girlEl.classList.toggle('restless', quiet);
  }, 6000);

  /* ---------- 字幕打字机 ---------- */
  let typing = 0;
  function setCaption(text) {
    /* 朗读时一段 90~110 字，小卡片塞不下，只看开头会被截得没头没尾：
       超过 54 字就显示前 54 字 + 省略号，正文仍然完整念。 */
    if (text && text.length > 54) text = text.slice(0, 54).replace(/[，、]$/, '') + '…';
    if (STATIC) { say.textContent = text; return; }
    const run = ++typing;
    say.innerHTML = '';
    let i = 0;
    const step = Math.max(1, Math.round(text.length / 38));
    const timer = setInterval(() => {
      if (run !== typing) { clearInterval(timer); return; }
      i += step;
      say.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(timer);
        say.innerHTML = esc(text) + '<span class="cursor"></span>';
      }
    }, 45);
  }

  /* ---------- 声音 ---------- */
  soundhint.addEventListener('click', () => { soundhint.classList.add('hide'); voiceEl.play().catch(() => {}); });
  document.addEventListener('click', () => soundhint.classList.add('hide'), { once: true });
  /* 直播窗口里没人点它，几秒后自动收起，免得出现在画面里 */
  setTimeout(() => soundhint.classList.add('hide'), 4000);

  function playVoice(url, urgent) {
    if (!url) return;
    const busy = voiceBusy();
    if (busy && urgent) {
      // 有人说话：把自语排队的清掉，正在播的自语直接掐断
      vQueue = [];
      try { voiceEl.pause(); } catch { /* 忽略 */ }
      startVoice(url);
      return;
    }
    if (busy) {
      if (vCur !== url && vQueue.length < 3) vQueue.push(url);
      return;
    }
    startVoice(url);
  }
  voiceEl.addEventListener('ended', voiceNext);
  voiceEl.addEventListener('error', voiceNext);

  /* ---------- 背景音乐已全部移除（2026-11-12），网页与系统层都不再出声 ---------- */
  function bgmDuck() {}

  /* ---------- 统计：隐藏位 + 画面上的用量小挂件 ---------- */
  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000000) return (v / 1000000000).toFixed(1) + 'B';
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    return String(Math.round(v));
  }
  function fmtCost(n) {
    const v = Number(n) || 0;
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(3);
    return v.toFixed(4);
  }
  function renderStats(st) {
    if (!st) return;
    const gifts = st.gifts || {};
    let n = 0;
    for (const k in gifts) n += gifts[k] || 0;
    const map = {
      statReply: st.replies || 0,
      statGift: n,
      statIncome: Number(st.income || 0).toFixed(2),
      gcount: n,
    };
    for (const id in map) { const el = document.getElementById(id); if (el) el.textContent = map[id]; }
    const gl = document.getElementById('glist');
    if (gl) gl.textContent = Object.keys(gifts).filter((k) => gifts[k]).map((k) => k + ' ×' + gifts[k]).join(' · ');

    // 直播画面挂件按 100 倍显示（观众看的展示数值）；控制台的用量永远是真实值
    const HUD_SCALE = 10000;
    const num = document.getElementById('tkNum');
    if (num) num.textContent = fmtTok(st.tokensToday * HUD_SCALE);
    const cost = document.getElementById('tkCost');
    if (cost) cost.textContent = '¥' + fmtCost(st.spent * HUD_SCALE);
  }

  function setHud(show) {
    const chip = document.getElementById('deckHud');
    if (chip) chip.classList.toggle('hide', !show);
  }

  /* ---------- 弹幕连接状态 ---------- */
  function renderDanmaku(d) {
    if (!d) return;
    const state = d.state || d.status || '';
    const rid = d.roomId || d.savedRoomId || '';
    let line = rid ? '尾号 ' + String(rid).slice(-5) : '还没连直播间';
    if (state === 'live') line = '正在收';
    else if (state === 'waiting') line = '等开播';
    else if (state === 'connecting') line = '连接中';
    else if (state === 'error' || state === 'closed') line = '断开了';
    const el = document.getElementById('dmLine');
    if (el) el.textContent = line;
    const st = document.getElementById('dmState');
    if (st) st.textContent = state === 'live' ? '弹幕已连' : (state === 'waiting' ? '等她开播' : '弹幕未连');
  }

  /* ---------- SSE ---------- */
  function boot(state) {
    dmItems.length = 0; dmCount = 0;
    (state.events || []).forEach((ev) => addEvent(ev, true, true));
    const chats = (state.events || []).filter((e) => e.kind === 'chat' && e.text).slice(-DM_MAX).reverse();
    chats.forEach((ev) => { dmItems.push(ev); dmCount += 1; });
    const c = document.getElementById('dmCount');
    if (c) c.textContent = dmCount;
    renderDmlist();
    const lastAi = (state.events || []).filter((e) => e.kind === 'ai').pop();
    if (lastAi && lastAi.text) setCaption(lastAi.text);
    renderStats(state.stats);
    renderDanmaku(state.danmaku);
    const ui = (state.config && state.config.ui) || {};
    setHud(ui.showTokens !== false);
    applyLayout(ui.layout || null);
    setLayEdit(ui.layoutEdit === true);
  }

  fetch(SERVER + '/api/state').then((r) => r.json()).then(boot).catch(() => {});

  /* ---------- 控制板指令：动作 / 说话 / 停 / 环境音 ---------- */
  const AMBIENCE = {};
  function setAmbience(name, on) {
    if (on) {
      if (!AMBIENCE[name]) {
        const a = new Audio(`ambience/${name}.wav`);
        a.loop = true;
        a.preload = 'auto';
        a.volume = VOL.amb;
        AMBIENCE[name] = a;
      }
      AMBIENCE[name].currentTime = 0;
      AMBIENCE[name].play().catch(() => {});
    } else if (AMBIENCE[name]) {
      AMBIENCE[name].pause();
      AMBIENCE[name].currentTime = 0;
    }
  }
  function handleControl(p) {
    if (p.action === 'pose') {
      showFrame(p.name, Number(p.ms) || 0);
    } else if (p.action === 'say') {
      playVoice(p.url, true);
    } else if (p.action === 'stop') {
      vQueue = [];
      vCur = '';
      try {
        voiceEl.pause();
        voiceEl.currentTime = 0;
      } catch {
        /* 停不下来也无所谓 */
      }
    } else if (p.action === 'ambience') {
      setAmbience(p.name, !!p.on);
    } else if (p.action === 'layout') {
      applyLayout({ [p.name]: { x: p.x, y: p.y } });
    } else if (p.action === 'layoutEdit') {
      setLayEdit(p.on);
    } else if (p.action === 'layoutReset') {
      resetLayout();
    } else if (p.action === 'layoutClear') {
      if (LAYOUT_DEFAULT[p.name]) {
        layPos[p.name] = { ...LAYOUT_DEFAULT[p.name] };
        placeEl(p.name);
      }
    } else if (p.action === 'volume') {
      if (p.kind === 'voice') {
        VOL.voice = p.value;
        if (voiceEl) voiceEl.volume = p.value;
      } else if (p.kind === 'sfx') {
        VOL.sfx = p.value;
      } else if (p.kind === 'amb') {
        VOL.amb = p.value;
        Object.values(AMBIENCE).forEach((a) => { a.volume = p.value; });
      }
    }
  }

  /* ---------- 画面元素位置：弹幕 / 说句 / 速写窗 / 直播标识，面板开拖动模式后可自由摆 ---------- */
  const LAYOUT_ELS = {
    say: document.getElementById('sayCard'),
    sketch: document.getElementById('sketchwin'),
    deck: document.getElementById('deckCard'),
  };
  const LAYOUT_DEFAULT = {
    say: { x: 5, y: 43.6 },
    sketch: { x: 6.4, y: 26.2 },
    deck: { x: 5, y: 57.2 },
  };
  let layPos = JSON.parse(JSON.stringify(LAYOUT_DEFAULT));
  let layEdit = false;

  function placeEl(key) {
    const el = LAYOUT_ELS[key];
    if (!el) return;
    const p = layPos[key];
    if (!p) return;
    el.style.left = p.x + '%';
    el.style.top = p.y + '%';
  }
  function applyLayout(lay) {
    if (lay) {
      Object.keys(LAYOUT_ELS).forEach((k) => {
        const v = lay[k];
        if (v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) {
          layPos[k] = { x: Number(v.x), y: Number(v.y) };
        }
      });
    }
    Object.keys(LAYOUT_ELS).forEach(placeEl);
  }
  function resetLayout() {
    layPos = JSON.parse(JSON.stringify(LAYOUT_DEFAULT));
    Object.keys(LAYOUT_ELS).forEach((k) => {
      const el = LAYOUT_ELS[k];
      if (el) { el.style.left = ''; el.style.top = ''; }
    });
    Object.keys(LAYOUT_ELS).forEach(placeEl);
  }
  function setLayEdit(on) {
    layEdit = !!on;
    document.body.classList.toggle('layout-edit', layEdit);
    Object.values(LAYOUT_ELS).forEach((el) => { if (el) el.classList.toggle('draggable', layEdit); });
  }
  function bindDrags() {
    Object.entries(LAYOUT_ELS).forEach(([key, el]) => {
      if (!el || el.dataset.dragBound) return;
      el.dataset.dragBound = '1';
      el.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;     // 不用先开编辑模式，直接拖就行
        ev.preventDefault();
        ev.stopPropagation();
        const r = el.getBoundingClientRect();
        const offX = ev.clientX - r.left;
        const offY = ev.clientY - r.top;
        try { el.setPointerCapture(ev.pointerId); } catch { /* 不支持就算了 */ }
        el.classList.add('dragging');
        const move = (e) => {
          const w = window.innerWidth || 1;
          const h = window.innerHeight || 1;
          let x = ((e.clientX - offX) / w) * 100;
          let y = ((e.clientY - offY) / h) * 100;
          x = Math.max(0, Math.min(100 - (r.width / w) * 100, x));
          y = Math.max(0, Math.min(100 - (r.height / h) * 100, y));
          el.style.left = x.toFixed(2) + '%';
          el.style.top = y.toFixed(2) + '%';
        };
        const up = () => {
          el.classList.remove('dragging');
          el.removeEventListener('pointermove', move);
          const x = parseFloat(el.style.left);
          const y = parseFloat(el.style.top);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            layPos[key] = { x, y };
            fetch(SERVER + '/api/control/layout', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: key, x, y }),
            }).catch(() => {});
          }
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up, { once: true });
      }, { capture: true });
    });
  }
  applyLayout(null);
  bindDrags();

  // 探针：页面真的加载并执行到这里了
  fetch('/api/sfxlog', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'page-boot', ok: true, err: 'loaded-v85' }) }).catch(() => {});

  fetch('/api/control/state').then((r) => r.json()).then((st) => {
    if (!st || !st.volumes) return;
    VOL.voice = Number(st.volumes.voice != null ? st.volumes.voice : 0.9);
    VOL.sfx = Number(st.volumes.sfx != null ? st.volumes.sfx : 0.5);
    VOL.amb = Number(st.volumes.amb != null ? st.volumes.amb : 0.22);
    if (voiceEl) voiceEl.volume = VOL.voice;
  }).catch(() => {});

  const es = new EventSource(SERVER + '/api/events');
  es.onmessage = (e) => {
    let p; try { p = JSON.parse(e.data); } catch { return; }
    switch (p.type) {
      case 'init': boot(p); break;
      case 'event': addEvent(p.item, false); break;
      case 'stats': renderStats(p.stats); break;
      case 'danmaku': renderDanmaku(p.danmaku); break;
      case 'hud': setHud(p.showTokens !== false); break;
      case 'control': handleControl(p); break;
      case 'read':
        if (p.read && p.read.stopped) {
          READ.on = false;
          vQueue = [];
          try { voiceEl.pause(); voiceEl.currentTime = 0; } catch { /* 忽略 */ }
          syncVoiceIdle();
        } else if (p.read && p.read.running === false) {
          READ.on = false;
        }
        break;
      case 'boot':
        dmItems.length = 0; dmCount = 0;
        renderDmlist();
        renderStats(p.stats);
        break;
      default: break;
    }
  };
})();
