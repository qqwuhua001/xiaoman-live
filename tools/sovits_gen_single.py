import os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOVITS = os.environ.get("GPT_SOVITS_DIR", os.path.join(ROOT, "GPT-SoVITS"))
os.chdir(SOVITS)
sys.path.insert(0, ".")
sys.path.insert(0, "GPT_SoVITS")
os.environ["PATH"] = os.path.join(ROOT, "tools") + ":" + os.environ.get("PATH", "")
os.environ["ffmpeg_path"] = os.path.join(ROOT, "tools", "ffmpeg")
sys.path.insert(0, ".")
sys.path.insert(0, "GPT_SoVITS")

from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
import soundfile as sf
import numpy as np

REF = f"{ROOT}/models/voice_ref/rei_ref_5s.wav"
PROMPT = "あなたは他の人がいないと自分が見えないの"

txt_file = sys.argv[1]
out = sys.argv[2]
text = open(txt_file, encoding="utf-8").read().strip()
if not text:
    print("empty text", file=sys.stderr)
    sys.exit(1)

cfg = dict(TTS_Config.default_configs["v2"])
cfg["device"] = "cpu"
cfg["is_half"] = False
tts = TTS(TTS_Config(cfg))

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

sys.path.insert(0, f"{ROOT}/tools")
from sovits_post import postprocess

sr = chunks[-1][0]
postprocess(chunks, sr, out, f"{ROOT}/tools/ffmpeg")
print(f"ok {out}")
