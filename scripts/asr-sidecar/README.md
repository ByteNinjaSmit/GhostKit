# Local ASR sidecar (faster-whisper) — optional

Offline speech-to-text for GhostKit's live captions, behind the `ASRAdapter`
interface (`faster-whisper-local`). **Opt-in, not default.** Removes cloud-ASR
network latency and keeps interviewer audio on-device; the answer model stays
cloud (`gemini-2.5-flash`). It has no conversational output turn, so it cannot
show the native-audio model's next-question starvation (`docs/audio-latency-audit.md` §3).

Status: **reference implementation, unverified on your GPU.** Ship it as an
optional mode and benchmark before considering it default.

## Setup

```bash
# From the repo root. A venv is recommended.
python -m venv scripts/asr-sidecar/.venv
scripts/asr-sidecar/.venv/Scripts/activate      # Windows (PowerShell: .\.venv\Scripts\Activate.ps1)
pip install -r scripts/asr-sidecar/requirements.txt
```

GPU (RTX 3070/3080-class): install NVIDIA **CUDA 12** + **cuDNN 9** and ensure
their DLLs are on `PATH`. CPU works with no CUDA (use `--device cpu`, slower).

## Smoke-test the sidecar alone

```bash
# Feed it the same PCM fixture format the bench uses (16kHz mono s16le):
python scripts/asr-sidecar/faster_whisper_service.py --model small --device cuda < fixture.pcm.framed
```
(The Electron adapter frames each chunk as `[uint32 LE length][PCM bytes]`; for a
raw fixture, write a tiny framer or just drive it through the app.)

## Use it in the app

Point the ASR factory at it (`electron/services/asr/index.ts`,
`createASRAdapter('faster-whisper-local')`) once `geminiLive.ts` consumes an
adapter, or instantiate `FasterWhisperAsrAdapter` directly. Env overrides:

| Env | Default | Meaning |
|---|---|---|
| `GHOSTKIT_WHISPER_PYTHON` | `python` | Python executable (point at the venv) |
| `GHOSTKIT_WHISPER_MODEL` | `small` | model size: tiny/base/small/medium/large-v3 |
| `GHOSTKIT_WHISPER_DEVICE` | `cuda` | `cuda` or `cpu` |

## Benchmark before trusting it

Compare against the cloud path on the SAME multi-turn fixture (see
`docs/audio-latency-audit.md` §5): first-caption latency, speech-end→final,
real-time factor, GPU memory, and premature-split / duplicate-text rate. Tune
`--model`, `--silence-ms` (endpoint), and `--tick-ms` (partial cadence).
`small` on a 3070/3080 is the sensible starting point; measure before going larger.

## Packaging limitation

A packaged app must bundle or locate a Python runtime + this script + the model.
Not solved here — `scriptPath`/`pythonPath` are configurable on the adapter so a
packaging step can point at bundled resources. Until then this is a dev/local mode.
