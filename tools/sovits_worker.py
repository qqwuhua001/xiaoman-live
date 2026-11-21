"""
GPT-SoVITS 常驻合成器。

2026-11-13 新增。原来每一句话都要 spawn 一个 python 进程，光加载
Text2Semantic / VITS / BERT / CNHuBERT 就要 10 秒以上，观众听到的是
「问完等 15~20 秒才开口」。模型常驻以后，单句只要推理时间（约 3~6 秒）。

接口（只在本机 127.0.0.1 监听）：
  GET  /health           -> {"ok":true,"loaded":true}
  POST /synth {"text","out"} -> {"ok":true,"ms":1234}
"""

import json
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOVITS = os.environ.get("GPT_SOVITS_DIR", os.path.join(ROOT, "GPT-SoVITS"))
os.chdir(SOVITS)
sys.path.insert(0, ".")
sys.path.insert(0, "GPT_SoVITS")
os.environ["PATH"] = os.path.join(ROOT, "tools") + ":" + os.environ.get("PATH", "")
os.environ["ffmpeg_path"] = os.path.join(ROOT, "tools", "ffmpeg")
sys.path.insert(0, os.path.join(ROOT, "tools"))

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

FF = f"{ROOT}/tools/ffmpeg"
REF = f"{ROOT}/models/voice_ref/rei_ref_5s.wav"
PROMPT = "あなたは他の人がいないと自分が見えないの"
PORT = int(os.environ.get("SOVITS_PORT", "8790"))

sys.path.insert(0, f"{ROOT}/tools")
from sovits_post import postprocess  # noqa: E402

cfg = dict(TTS_Config.default_configs["v2"])
cfg["device"] = "cpu"
cfg["is_half"] = False
tts = TTS(TTS_Config(cfg))
print("[worker] 模型已加载", flush=True)

lock = threading.Lock()


def synth(text: str, out: str) -> float:
    inputs = {
        "text": text,
        "text_lang": "zh",
        "ref_audio_path": REF,
        "prompt_text": PROMPT,
        "prompt_lang": "ja",
        "top_k": 10,
        "top_p": 1.0,
        "temperature": 0.8,
        "text_split_method": "cut2",   # ≤50 字不拆，整句一口气合成
        "batch_size": 1,
        "speed_factor": 0.84,
        "ref_free": False,
        "seed": 42,
        "parallel_infer": False,
        "repetition_penalty": 1.4,
    }
    t0 = time.time()
    chunks = []
    for it in tts.run(inputs):
        if isinstance(it, (tuple, list)):
            chunks.append((it[0], it[1]))
        else:
            chunks.append((it["sample_rate"], it["audio_numpy"]))
    sr = chunks[-1][0]
    postprocess(chunks, sr, out, FF)
    return (time.time() - t0) * 1000


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send({"ok": True, "loaded": True})
        self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/synth":
            return self._send({"ok": False, "error": "not found"}, 404)
        try:
            n = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            text = str(payload.get("text") or "").strip()
            out = str(payload.get("out") or "").strip()
            if not text or not out:
                return self._send({"ok": False, "error": "text/out 必填"}, 400)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with lock:                       # 单卡单进程，串行推理
                started = time.time()
                synth(text, out)
            return self._send({"ok": True, "ms": int((time.time() - started) * 1000)})
        except Exception as e:               # 出错也要把原因带回去，方便排查
            import traceback
            traceback.print_exc()
            return self._send({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"[worker] 预热…", flush=True)
    with lock:
        try:
            synth("嗯。在。", f"{ROOT}/data/voice/_warmup.wav")
        except Exception as e:
            print(f"[worker] 预热失败：{e}", flush=True)
    print(f"[worker] 监听 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
