#!/usr/bin/env python3
"""
test_gpu.py -- verifies faster-whisper can load + run on the GPU (or CPU
fallback) before wiring the sidecar into the app. Transcribes 1s of synthetic
audio; the point is that the MODEL LOADS and RUNS on the chosen device without a
CUDA/cuDNN error, not the (empty) transcript.

Usage:
  .venv/Scripts/python.exe test_gpu.py [model] [device]
    model  default 'small'   (tiny/base/small/medium/large-v3)
    device default 'cuda'    ('cuda' or 'cpu')
"""
import sys
import time

import numpy as np


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "small"
    device = sys.argv[2] if len(sys.argv) > 2 else "cuda"
    compute = "float16" if device == "cuda" else "int8"

    print(f"[test] importing faster-whisper ...")
    from faster_whisper import WhisperModel

    print(f"[test] loading model={model_name} device={device} compute={compute} ...")
    t0 = time.time()
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute)
    except Exception as exc:
        print(f"[test] FAILED to load on {device}: {exc}")
        if device == "cuda":
            print("[test] -> GPU libs missing/mismatched. Re-run with 'cpu' to confirm the model itself works,")
            print("[test]    or ensure cuDNN 9 + CUDA 12 runtime DLLs are importable (see README).")
        sys.exit(1)
    print(f"[test] model loaded in {time.time() - t0:.1f}s")

    # 1 second of quiet noise at 16kHz (float32) -- just exercises the pipeline.
    audio = (np.random.randn(16000).astype(np.float32) * 0.01)
    t1 = time.time()
    segments, info = model.transcribe(audio, language="en", vad_filter=True, beam_size=1)
    text = "".join(seg.text for seg in segments)  # forces the generator to run
    dt = time.time() - t1
    print(f"[test] transcribe ran in {dt*1000:.0f}ms on {device}; detected_lang={info.language}")
    print(f"[test] OK -- faster-whisper works on {device}. (transcript of noise: {text!r})")


if __name__ == "__main__":
    main()
