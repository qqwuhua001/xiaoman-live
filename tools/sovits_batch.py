import os, sys, json, hashlib, time, subprocess, traceback
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOVITS = os.environ.get("GPT_SOVITS_DIR", os.path.join(ROOT, "GPT-SoVITS"))
os.chdir(SOVITS)
sys.path.insert(0, ".")
sys.path.insert(0, "GPT_SoVITS")
os.environ["PATH"] = os.path.join(ROOT, "tools") + ":" + os.environ.get("PATH", "")
os.environ["ffmpeg_path"] = os.path.join(ROOT, "tools", "ffmpeg")
sys.path.insert(0, os.path.join(ROOT, "tools"))

from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
import soundfile as sf
import numpy as np

from sovits_post import postprocess

OUT = f"{ROOT}/voice_cache"
os.makedirs(OUT, exist_ok=True)
FF = f"{ROOT}/tools/ffmpeg"
REF = f"{ROOT}/models/voice_ref/rei_ref_5s.wav"
PROMPT = "あなたは他の人がいないと自分が見えないの"

lines = json.load(open(f"{ROOT}/data/lines.json", encoding="utf-8"))["lines"]
print(f"待合成 {len(lines)} 条", flush=True)

cfg = dict(TTS_Config.default_configs["v2"])
cfg["device"] = "cpu"
cfg["is_half"] = False
tts = TTS(TTS_Config(cfg))
print("[model loaded]", flush=True)

index_path = f"{OUT}/index.json"
index = {}
if os.path.exists(index_path):
    index = json.load(open(index_path, encoding="utf-8"))

t_start = time.time()
done = skip = fail = 0
total_audio = 0.0

for i, item in enumerate(lines):
    text = item["text"].strip()
    cat = item.get("cat", "misc")
    key = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    raw = f"{OUT}/{key}_raw.wav"
    fin = f"{OUT}/{key}.wav"
    if os.path.exists(fin) and os.environ.get("SOVITS_FORCE") != "1":
        skip += 1
        continue
    t1 = time.time()
    try:
        inputs = {
            "text": text,
            "text_lang": "zh",
            "ref_audio_path": REF,
            "prompt_text": PROMPT,
            "prompt_lang": "ja",
            "top_k": 10,
            "top_p": 1.0,
            "temperature": 0.8,
            "text_split_method": "cut2",
            "batch_size": 1,
            "speed_factor": 0.84,
            "ref_free": False,
            "seed": 42,
            "parallel_infer": False,
            "repetition_penalty": 1.4,
        }
        chunks = []
        for it in tts.run(inputs):
            if isinstance(it, (tuple, list)):
                chunks.append((it[0], it[1]))
            else:
                chunks.append((it["sample_rate"], it["audio_numpy"]))
        sr = chunks[-1][0]

        # 收尾统一走 sovits_post：段间气口 + 淡化 + 句尾余音
        postprocess(chunks, sr, fin, FF)

        dur = float(sf.info(fin).duration)
        total_audio += dur
        index[key] = {"text": text, "cat": cat, "file": f"{key}.wav", "dur": round(dur, 2)}
        done += 1
        if done % 10 == 0:
            json.dump(index, open(index_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        el = time.time() - t_start
        eta = (el / (done + skip) * (len(lines) - done - skip)) if (done + skip) else 0
        print(f"[{i+1}/{len(lines)}] {dur:.2f}s {text[:14]} | 已用{el/60:.1f}min 剩~{eta/60:.1f}min", flush=True)
    except Exception as e:
        fail += 1
        print(f"[FAIL {i+1}] {text[:20]} :: {type(e).__name__} {e}", flush=True)
        if os.path.exists(raw):
            os.remove(raw)

json.dump(index, open(index_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"\n完成：新合成 {done} 跳过 {skip} 失败 {fail} | 音频总长 {total_audio:.1f}s | 总耗时 {(time.time()-t_start)/60:.1f}min", flush=True)
