# 绫波丽 · 抖音虚拟主播直播间

一个跑在本机的抖音虚拟主播。她是绫波丽：蓝发、校服换成了白 T 和牛仔裤、坐在画室的高脚凳上画素描，偶尔抬头说一句。

区别于其他「套壳 AI 主播」的地方，是**她的声音不是通用 TTS**：本仓库带了她自己的音色参考（`models/voice_ref/rei_ref_5s.wav`）+ 参考文本 + 合成参数，任何人拿走这套文件，合成出来都是同一个声音。

- 直播页：`http://127.0.0.1:8787/`
- 控制台：`http://127.0.0.1:8787/control.html`
- 语音：本地 GPT-SoVITS 常驻合成器（`127.0.0.1:8790`）

![直播页](preview.png)

## 她的声音是怎么来的

零样本音色克隆，不训练、只给参考。

| 组成 | 文件 | 说明 |
|---|---|---|
| 音色参考 | `models/voice_ref/rei_ref_5s.wav` | 5 秒干声，切掉了气口和尾音，作为 timbre 锚点 |
| 长参考 | `models/voice_ref/rei_speech_full_24s.wav` | 24 秒完整语料，用于对齐语速和句尾下沉 |
| 参考文本 | `tools/sovits_worker.py` 里的 `PROMPT` | `あなたは他の人がいないと自分が見えないの` |
| 合成参数 | 同文件 | `speed_factor 0.84`、`top_k 10`、`temperature 0.8`、`repetition_penalty 1.4` |

参数偏慢、偏平，句尾下沉，不叠情绪——这是她的语感。换掉 `rei_ref_5s.wav`，声音就变成别人了。

合成链路：

```
一句话 → tools/sovits_worker.py（常驻，模型只加载一次）
        └ POST /synth {text,out}
lib/voice.mjs → 命中缓存则 0ms，否则 3~6 秒
        └ 输出 data/voice/<sha1>.wav，直播页直接播
```

`tools/sovits_gen_single.py` 是单句冷启动版（不常驻时的退路），`sovits_batch.py` 用于批量预生成。

### 自己跑起来

1. 部署 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 到 `./GPT-SoVITS`（默认路径，可用 `GPT_SOVITS_DIR` 覆盖），准备好底模。
2. 起常驻合成器：

```bash
python3 tools/sovits_worker.py          # 监听 8790
```

3. 试一句：

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"你听得见我吗。","out":"/tmp/test.wav"}' http://127.0.0.1:8790/synth
```

含拉丁字母的句子依赖 nltk 的 `averaged_perceptron_tagger_eng`，缺了会 `LookupError`：

```bash
python3 -m nltk.downloader -d ~/nltk_data averaged_perceptron_tagger_eng
```

## 直播画面

| 模块 | 说明 |
|---|---|
| 立绘 | 21 张动作帧（`public/assets/rei/`），待机呼吸，说话时切表情 |
| 速写窗 | 循环播放手绘过程（`public/assets/studio/`），角标「正在画」 |
| 背景 | `studio.jpg`，46 秒极慢推拉（`kbDrift`），不晃眼 |
| 气泡 | 打字机输出，超过 54 字截断 |
| 磁带块 | 当日 token 与花费，按北京峰谷电价计费 |

## 她怎么说话

| 层 | 文件 | 作用 |
|---|---|---|
| 人格 | `data/persona.example.md` | 绫波丽的底色：短句、不解释、不热情过头 |
| 台词库 | `data/lines.example.json` | 独处时说的话，按分类抽句，`idle.perHour` 控密度 |
| 快问快答 | `lib/quick.mjs` | 名字、在吗、画画相关的固定回应，不经过模型 |
| 模型 | `lib/persona.mjs` + `lib/ai.mjs` | 弹幕回复，先清洗再合成 |
| 长文朗读 | `server.mjs` `read/*` | 90–110 字并段、首段后台合成、预生成、念完自动收工 |

## 快速开始

```bash
git clone <this-repo> rei-live
cd rei-live
cp config.example.json config.json          # 填 DeepSeek Key、直播间 ID
mkdir -p data && cp data/persona.example.md data/persona.md
cp data/lines.example.json data/lines.json
npm install
node server.mjs                             # 8787
```

`config.json` 里 `voice.engine` 选 `sovits` 走她的声音；没有合成器就退 `edge`，音色会变成普通 TTS。

### 接弹幕

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"roomId":"<直播间数字ID>"}' http://127.0.0.1:8787/api/danmaku/connect
```

ID 从分享短链里取：`curl -sIL https://v.douyin.com/xxxx/`，看 `location:` 里的 `webcast/reflow/<roomId>`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/control/state` | 状态、统计、配置摘要 |
| POST | `/api/control/say` | 说一句 `{text}` |
| POST | `/api/control/intro` | 开场白三句 |
| GET/POST | `/api/control/lines` / `lineSet` | 台词库读取 / 开关 `{id,off}` |
| POST | `/api/control/lineSay` / `lineDel` / `lineEdit` | 立刻说 / 删 / 改句 |
| POST | `/api/control/read/start` | 长文朗读 `{text,title}` |
| POST | `/api/control/read/premake` | 预生成整篇音频 |
| GET | `/api/control/read/status` | 朗读进度 |
| POST | `/api/danmaku/connect` | 切换直播间 `{roomId}` |
| POST | `/api/event` | 注入测试事件 |

## 目录

```
server.mjs              # HTTP 服务：路由、SSE、朗读调度、进程守护
lib/voice.mjs           # 合成、缓存、同句去重
lib/persona.mjs         # 人格与回复清洗
lib/monologue.mjs       # 台词库：选句、开关、删除、改句
lib/cortico.mjs         # 抖音弹幕桥
lib/store.mjs           # 状态、事件、用量
tools/sovits_worker.py  # 常驻合成器（她的音色在这里）
models/voice_ref/       # 音色参考音频
public/                 # 直播页、控制台、立绘与速写素材
vendor/douyin-danma/    # 抖音弹幕 SDK（含 send() 容错补丁）
extension/              # 可选 Chrome 扩展：回复回写公屏
```

## 边界

- 弹幕回复 10–16 秒（合成占大头），不是即时聊天
- 朗读 23k 字约 2 小时（每段约 30 秒）
- 立绘与速写素材随仓库附带；旧的 pet 素材与音效不入库
- `config.json`、`data/`、`logs/` 不入库：里面有房间号、Cookie 和用量
- 名字：对外只叫「绫波丽」，不设外号

## 许可

新增代码 MIT（见 `LICENSE`）。原版直播间框架来自 [newbeejmc/Dsh_douyin](https://github.com/newbeejmc/Dsh_douyin)，其版权归原作者；GPT-SoVITS 版权归其作者。音色参考音频仅授权用于本项目，不要拿去商用或二次分发。
