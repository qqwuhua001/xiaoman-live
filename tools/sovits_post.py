"""
GPT-SoVITS 合成后的统一收尾：拼接、气口、淡入淡出、EQ。

2026-11-13 新增。原来单条和批量脚本各写一份 `np.concatenate` + silenceremove，
两个问题：
  1) cut5 按每个标点切，一句 20 字会被切成 5 段，段与段之间直接硬拼；
  2) silenceremove 把所有停顿统一压成 0.36 秒，听起来一顿一顿的，
     句尾又没有淡出，像录音被掐断。
现在：段间留 180ms 自然气口 + 12ms 交叉淡化，句尾留 400ms 余音，
只修剪首尾的空白，不碰句子内部的停顿。
"""

import os
import subprocess

import numpy as np
import soundfile as sf

GAP_MS = 180
TAIL_MS = 420
FADE_MS = 12
LEAD_TRIM_S = 0.05
TAIL_TRIM_S = 0.10


def trim_edges(a, sr, lead=LEAD_TRIM_S, tail=TAIL_TRIM_S):
    """只去掉首尾多余空白，不碰内部停顿。阈值跟着整体 RMS 走，避免把轻声吃掉。"""
    if a is None or a.size == 0:
        return np.zeros(0, dtype=np.float32)
    rms = float(np.sqrt(np.mean(np.square(a)))) or 1e-6
    th = max(1e-4, rms * 0.03)
    idx = np.where(np.abs(a) > th)[0]
    if idx.size == 0:
        return np.zeros(0, dtype=np.float32)
    start = max(0, int(idx[0] - lead * sr))
    end = min(a.size, int(idx[-1] + tail * sr))
    return a[start:end]


def fade_edges(a, sr, ms=FADE_MS):
    n = int(ms / 1000 * sr)
    if n <= 0 or a.size <= n * 2:
        return a
    a[:n] *= np.linspace(0.0, 1.0, n, dtype=np.float32)
    a[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)
    return a


def postprocess(chunks, sr, out, ffmpeg, gap_ms=GAP_MS, tail_ms=TAIL_MS):
    """chunks 是 [(sr, np.float32 audio), ...]；写成 out（32000Hz 单声道 wav）。"""
    segs = []
    for item in chunks:
        audio = item[1] if isinstance(item, (tuple, list)) else item["audio_numpy"]
        a = np.asarray(audio, dtype=np.float32)
        a = fade_edges(trim_edges(a, sr), sr)
        if a.size:
            segs.append(a)
    if not segs:
        raise RuntimeError("GPT-SoVITS 没有产出可用音频")

    gap = np.zeros(int(gap_ms / 1000 * sr), dtype=np.float32) if len(segs) > 1 else None
    audio = segs[0]
    for s in segs[1:]:
        audio = np.concatenate([audio, gap, s])
    if tail_ms > 0:
        audio = np.concatenate([audio, np.zeros(int(tail_ms / 1000 * sr), dtype=np.float32)])

    peak = float(np.abs(audio).max()) or 1e-6
    audio = audio * (0.9 / peak)

    raw = out + ".raw.wav"
    tmp = out + ".tmp.wav"
    sf.write(raw, audio, sr)
    try:
        subprocess.run(
            [
                ffmpeg, "-y", "-i", raw, "-af",
                "highpass=f=85,"
                "equalizer=f=250:width_type=q:w=1:g=-1.5,"
                "treble=g=3:f=2200,"
                "lowpass=f=14000",
                "-ar", "32000", "-ac", "1", tmp,
            ],
            check=True,
            capture_output=True,
        )
        os.replace(tmp, out)     # 原子替换：直播中重建缓存也不会读到半截文件
    finally:
        for f in (raw, tmp):
            try:
                os.remove(f)
            except OSError:
                pass
    return out
