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
import glob
import json
import os
import sys
import threading
import time

import numpy as np

# Windows: the CUDA runtime libs (cublas64_12.dll, cudnn*.dll, nvrtc...) ship in
# the pip packages nvidia-cublas-cu12 / nvidia-cudnn-cu12 under
# site-packages/nvidia/<lib>/bin. When this sidecar is launched from a shell
# whose PATH happens to include a CUDA toolkit (e.g. Anaconda) it works, but
# when Electron spawns it the child inherits no such PATH and ctranslate2 fails
# at transcribe time with "Library cublas64_12.dll is not found". Add those bin
# dirs to the DLL search path explicitly, BEFORE importing faster-whisper, so
# GPU inference works regardless of how the process was launched.
if os.name == "nt":
    # Search every site-packages (venv + any base) for the nvidia pip packages'
    # bin dirs, not just sys.prefix -- covers the case where the interpreter's
    # nvidia libs live under a different site dir than expected.
    import site

    _roots = [os.path.join(sys.prefix, "Lib", "site-packages")]
    try:
        _roots += list(site.getsitepackages())
    except Exception:
        pass
    try:
        _roots.append(site.getusersitepackages())
    except Exception:
        pass
    _bins = []
    for _root in dict.fromkeys(_roots):  # de-dupe, preserve order
        _nvidia = os.path.join(_root, "nvidia")
        if os.path.isdir(_nvidia):
            _bins.extend(glob.glob(os.path.join(_nvidia, "*", "bin")))
    _bins = list(dict.fromkeys(_bins))
    for _bin in _bins:
        try:
            os.add_dll_directory(_bin)
        except OSError:
            pass
    # add_dll_directory alone does NOT reliably resolve a DLL loaded as a
    # TRANSITIVE dependency of another (cublas64_12.dll pulled in by cudnn) when
    # the process was spawned by Electron -- confirmed live 2026-09-29 (worked
    # standalone, failed spawned). Prepending the bin dirs to PATH covers the
    # legacy dependency search that transitive loads fall back to.
    if _bins:
        os.environ["PATH"] = os.pathsep.join(_bins) + os.pathsep + os.environ.get("PATH", "")
    sys.stderr.write(f"[sidecar] python={sys.executable}\n")
    sys.stderr.write(f"[sidecar] nvidia bin dirs added ({len(_bins)}): {_bins}\n")
    sys.stderr.flush()

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


# Whisper's well-known hallucinations on silence/noise -- it emits these when
# there's no real speech. Dropped so they don't create phantom transcript turns.
_HALLUCINATION_PHRASES = {
    "thank you", "thank you.", "thanks for watching", "thanks for watching.",
    "thank you for watching", "thank you for watching.", "please subscribe",
    "you", "you.", "bye", "bye.", "bye-bye", "okay", "okay.", ".", "so",
    "thanks", "thanks.", "the", "i'm not sure", "subtitles by the amara.org community",
}


def is_hallucination(text: str) -> bool:
    """True for a transcript that is almost certainly a whisper silence/noise
    artifact rather than a real utterance: a known filler phrase, or (since we
    force English) text containing non-Latin script it drifted into."""
    t = text.strip().lower()
    if t in _HALLUCINATION_PHRASES:
        return True
    # We force language=en; any CJK / Devanagari / Telugu / etc. output is a drift.
    for ch in text:
        o = ord(ch)
        if o > 0x2FF and not (0x2000 <= o <= 0x206F):  # beyond Latin+diacritics (allow general punctuation)
            return True
    return False


# Default domain bias for the decoder -- steers whisper toward interview/tech
# vocabulary so accented "vector embedding" isn't heard as "victory wedding".
DEFAULT_INITIAL_PROMPT = (
    "This is a technical software engineering job interview. Topics include algorithms, "
    "data structures, time and space complexity, SQL queries, window functions, running totals, "
    "Python, JavaScript, TypeScript, system design, APIs, databases, indexing, caching, "
    "vector embeddings, semantic search, retrieval augmented generation, tokenization, "
    "large language models, transformers, machine learning, and data pipelines."
)


class RollingASR:
    """
    Accumulates audio for the CURRENT utterance and transcribes the whole
    utterance buffer on each tick (partials), committing a final when energy VAD
    reports the utterance ended. Transcribing the utterance-so-far (not tiny
    windows) keeps text stable and avoids the duplicate/revised-text churn short
    overlapping windows cause.
    """

    def __init__(self, model, sample_rate, silence_ms, min_speech_ms, tick_ms, initial_prompt, beam_size):
        self.model = model
        self.sample_rate = sample_rate
        self.silence_s = silence_ms / 1000.0
        self.min_speech_s = min_speech_ms / 1000.0
        self.tick_s = tick_ms / 1000.0
        self.initial_prompt = initial_prompt
        self.beam_size = beam_size
        self.lock = threading.Lock()
        self.utterance = np.zeros(0, dtype=np.float32)
        self.last_voice_at = None      # monotonic time of last voiced frame
        self.speech_open = False
        self.last_partial_text = ""

    def add_frame(self, pcm16: np.ndarray):
        """pcm16: int16 samples. Appends as float32 [-1,1] and updates the voice clock via RMS energy."""
        audio = pcm16.astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        voiced = rms > 0.02  # energy gate; raised from 0.01 so faint room noise/silence
                             # doesn't open a "speech" window that whisper then hallucinates
                             # ("Thank you.", foreign script) transcripts from.
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
            language="en",              # FORCE English -- auto-detect drifted to Hindi/Telugu/etc.
                                        # on accented English and hallucinated foreign script.
            initial_prompt=self.initial_prompt,  # domain bias: corrects "victory"->"vector", etc.
            vad_filter=True,            # faster-whisper's built-in Silero VAD trims non-speech
            beam_size=self.beam_size,
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
            if text and not is_hallucination(text):
                emit({"type": "final", "text": text, "startMs": 0, "endMs": duration_ms})
            emit({"type": "speech_end"})
            with self.lock:
                self.utterance = np.zeros(0, dtype=np.float32)
                self.speech_open = False
                self.last_partial_text = ""
            return

        if speech_open:
            text = self._transcribe(buf)
            if text and text != self.last_partial_text and not is_hallucination(text):
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
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--initial-prompt", default=DEFAULT_INITIAL_PROMPT)
    args = parser.parse_args()

    compute_type = "float16" if args.device == "cuda" else "int8"
    log(f"loading faster-whisper model={args.model} device={args.device} compute={compute_type}")
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=compute_type)
    except Exception as exc:
        emit({"type": "error", "message": f"model load failed: {exc}"})
        sys.exit(3)

    asr = RollingASR(model, args.sample_rate, args.silence_ms, args.min_speech_ms, args.tick_ms, args.initial_prompt, args.beam_size)
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
