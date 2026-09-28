#!/usr/bin/env python3
"""
faster_whisper_service.py

Reference streaming ASR sidecar for GhostKit's FasterWhisperAsrAdapter. Turns
faster-whisper (a SEGMENT transcriber, not a streaming endpoint) into a rolling
partial/final caption stream.

PROTOCOL (matches electron/services/asr/fasterWhisperAdapter.ts):
  stdin  : length-prefixed PCM16 mono frames -> [uint32 LE byte length][PCM16 bytes]
  stdout : line-delimited JSON events, one per line, flushed:
             {"type":"ready"}
             {"type":"speech_start"}
             {"type":"partial","text": "...current hypothesis..."}
             {"type":"final","text":"...committed segment...","startMs":N,"endMs":N}
             {"type":"speech_end"}
             {"type":"error","message":"..."}
  stderr : human logs only. NEVER transcript text (privacy; the TS side logs stderr).

This is a REFERENCE implementation: correct in shape, conservative in tuning,
and UNVERIFIED on your GPU. Windowing, the silence threshold, and model size are
the knobs to benchmark (see scripts/asr-sidecar/README.md). It is NOT wired as
GhostKit's default ASR -- it is opt-in via the adapter factory.

Requires: faster-whisper, numpy (see requirements.txt). CUDA 12 + cuDNN 9 for GPU.
"""
import argparse
import json
import sys
import threading
import time

import numpy as np

try:
    from faster_whisper import WhisperModel
except Exception as exc:  # pragma: no cover - import-time env failure
    sys.stderr.write(f"faster-whisper import failed: {exc}\n")
    sys.stderr.flush()
    sys.exit(2)


def emit(obj):
    """Write one JSON event line to stdout and flush (the TS side parses per line)."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"[sidecar] {msg}\n")
    sys.stderr.flush()


class RollingASR:
    """
    Accumulates audio for the CURRENT utterance and transcribes the whole
    utterance buffer on each tick (partials), committing a final when energy VAD
    reports the utterance ended. Transcribing the utterance-so-far (not tiny
    windows) keeps text stable and avoids the duplicate/revised-text churn short
    overlapping windows cause.
    """

    def __init__(self, model, sample_rate, silence_ms, min_speech_ms, tick_ms):
        self.model = model
        self.sample_rate = sample_rate
        self.silence_s = silence_ms / 1000.0
        self.min_speech_s = min_speech_ms / 1000.0
        self.tick_s = tick_ms / 1000.0
        self.lock = threading.Lock()
        self.utterance = np.zeros(0, dtype=np.float32)
        self.last_voice_at = None      # monotonic time of last voiced frame
        self.speech_open = False
        self.last_partial_text = ""

    def add_frame(self, pcm16: np.ndarray):
        """pcm16: int16 samples. Appends as float32 [-1,1] and updates the voice clock via RMS energy."""
        audio = pcm16.astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        voiced = rms > 0.01  # simple energy gate; the model's own VAD refines the text
        now = time.monotonic()
        with self.lock:
            self.utterance = np.concatenate([self.utterance, audio])
            # Cap the utterance buffer so a stuck-open utterance can't grow unbounded (60s).
            max_samples = self.sample_rate * 60
            if self.utterance.size > max_samples:
                self.utterance = self.utterance[-max_samples:]
            if voiced:
                self.last_voice_at = now
                if not self.speech_open:
                    self.speech_open = True
                    emit({"type": "speech_start"})

    def _transcribe(self, audio: np.ndarray) -> str:
        # transcribe() returns a generator; iterating it runs inference.
        segments, _info = self.model.transcribe(
            audio,
            language=None,          # auto-detect; narrow with a fixed language if accent handling needs it
            vad_filter=True,        # faster-whisper's built-in Silero VAD trims non-speech
            beam_size=1,            # greedy: lowest latency; raise for accuracy if the GPU allows
            condition_on_previous_text=False,
        )
        return "".join(seg.text for seg in segments).strip()

    def tick(self):
        """Called on the worker loop: emit a partial, or commit a final on silence."""
        with self.lock:
            buf = self.utterance.copy()
            speech_open = self.speech_open
            last_voice = self.last_voice_at
        if buf.size < int(self.sample_rate * 0.2):
            return  # too little audio to bother

        now = time.monotonic()
        silent_for = (now - last_voice) if last_voice is not None else 999.0

        if speech_open and silent_for >= self.silence_s:
            # Utterance ended -> final, then reset for the next one.
            text = self._transcribe(buf)
            duration_ms = int(buf.size / self.sample_rate * 1000)
            if text:
                emit({"type": "final", "text": text, "startMs": 0, "endMs": duration_ms})
            emit({"type": "speech_end"})
            with self.lock:
                self.utterance = np.zeros(0, dtype=np.float32)
                self.speech_open = False
                self.last_partial_text = ""
            return

        if speech_open:
            text = self._transcribe(buf)
            if text and text != self.last_partial_text:
                self.last_partial_text = text
                emit({"type": "partial", "text": text})


def read_exact(stream, n):
    """Read exactly n bytes or return None on EOF."""
    chunks = []
    remaining = n
    while remaining > 0:
        b = stream.read(remaining)
        if not b:
            return None
        chunks.append(b)
        remaining -= len(b)
    return b"".join(chunks)


def stdin_reader(asr: RollingASR, stop_event: threading.Event):
    stream = sys.stdin.buffer
    while not stop_event.is_set():
        header = read_exact(stream, 4)
        if header is None:
            break
        length = int.from_bytes(header, "little")
        if length <= 0 or length > 1_000_000:
            log(f"bad frame length {length}; stopping")
            break
        payload = read_exact(stream, length)
        if payload is None:
            break
        pcm16 = np.frombuffer(payload, dtype=np.int16)
        asr.add_frame(pcm16)
    stop_event.set()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--silence-ms", type=int, default=700)
    parser.add_argument("--min-speech-ms", type=int, default=200)
    parser.add_argument("--tick-ms", type=int, default=350)
    args = parser.parse_args()

    compute_type = "float16" if args.device == "cuda" else "int8"
    log(f"loading faster-whisper model={args.model} device={args.device} compute={compute_type}")
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=compute_type)
    except Exception as exc:
        emit({"type": "error", "message": f"model load failed: {exc}"})
        sys.exit(3)

    asr = RollingASR(model, args.sample_rate, args.silence_ms, args.min_speech_ms, args.tick_ms)
    emit({"type": "ready"})
    log("ready")

    stop_event = threading.Event()
    reader = threading.Thread(target=stdin_reader, args=(asr, stop_event), daemon=True)
    reader.start()

    try:
        while not stop_event.is_set():
            try:
                asr.tick()
            except Exception as exc:
                emit({"type": "error", "message": f"transcribe error: {exc}"})
            time.sleep(asr.tick_s)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        log("stopped")


if __name__ == "__main__":
    main()
