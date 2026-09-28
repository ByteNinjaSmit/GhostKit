# GhostKit audio + multi-turn latency audit

_Last updated: 2026-09-28._

Scope: the reported **4–8 s delay recognizing the second-and-later interviewer
question**. First question feels fast; later ones lag. This document maps the
real runtime path, names every async boundary/timer/queue that can add delay,
states the root-cause hypothesis, and explains how to prove it with the
trace instrumentation added on 2026-09-28.

---

## 1. Runtime data flow (actual, from code)

```
System-audio loopback (interviewer voice)
  src/audio/capture.ts        acquire tracks (system + mic)
  src/audio/pcm-worklet.js    fixed 100 ms PCM16 @ 16 kHz mono chunks
  src/audio/pipeline.ts       onSystemChunk(chunk, capturedAtMs)
        │  Interview.tsx onSystemChunk -> window.api.streamMicChunk  (only while liveOpenRef.current === true)
        ▼  IPC  gemini-live:send-audio
  electron/main.ts            IPC handler -> geminiLive.sendAudioChunk
  electron/services/geminiLive.ts
        session.sendRealtimeInput({ audio })   -> Gemini Live websocket
        │
        ▼  onmessage (LiveServerMessage)
     handleServerMessage
        ├─ interimInputTranscription  -> onInterimTranscript (live caption)
        ├─ inputTranscription         -> emitTranscript('interviewer')  + arm silence timer
        ├─ interrupted (barge-in)     -> drop partial, onInterrupted
        ├─ turnComplete               -> flushInterviewerTurn (backstop only)
        └─ data (model AUDIO out)     -> DISCARDED (never played)
        │
   silence timer (INTERVIEWER_SILENCE_FLUSH_MS = 1100 ms) fires
        ▼
     flushInterviewerTurn  -> lastInterviewerQuestion, recordTurn, translation,
        ▼                      runFastTextAnswer(question)
     runFastTextAnswerNow   answerQueue (serialized) -> rag cache check ->
        ▼                    gemini-2.5-flash generateContentStream
     emitTranscript('assistant') deltas -> IPC -> Interview.tsx / GhostOverlay
```

Two Gemini calls, deliberately separate:

| Path | Model | Purpose |
|---|---|---|
| ASR / captions | `gemini-2.5-flash-native-audio-latest` (Live, bidi) | transcribe interviewer audio |
| Visible answer | `gemini-2.5-flash` (`generateContentStream`) | the answer shown on screen |

The Live model is a **conversational native-audio model**. It **cannot** run
text-only (`Modality.TEXT` → socket 1007 before setupComplete; verified in code
comments). So every interviewer turn it **also generates a full spoken AUDIO
response** — which GhostKit throws away (`message.data` discarded).

---

## 2. Async boundaries, queues, timers

| Mechanism | File / symbol | Latency role |
|---|---|---|
| Worklet chunking | pcm-worklet.js | fixed 100 ms; steady baseline |
| Renderer→main IPC | Interview.tsx `streamMicChunk` | sub-ms normally; only sends while `liveOpenRef` true |
| Silence endpoint timer | geminiLive `INTERVIEWER_SILENCE_FLUSH_MS = 1100` | adds ≤1.1 s after last fragment before a question is finalized |
| turnComplete backstop | geminiLive `handleServerMessage` | fires only when the model's hidden AUDIO turn ends — measured **20.8 s** for a 7-char question |
| Answer serialization | geminiLive `answerQueue` | one answer streams at a time |
| Stale-answer cancel | geminiLive `activeAnswerId` | new question bumps id; queued/in-flight stale answers early-return |
| Reconnect | geminiLive `handleClose` / `RECONNECT_DELAY_MS = 1000` | 1 s + re-handshake on a socket drop |
| Learned-answer cache | rag.findLearnedAnswer | tens of ms on hit; skips the model call |

`answerQueue` is **not** the multi-turn culprit: `activeAnswerId` already makes a
superseded answer bail, so a new question does not wait out a previous stream's
tokens for its own transcription.

---

## 3. Root-cause hypothesis

**ASR starvation by the Live model's hidden output turn.**

1. Q1 ends → model idle → transcribes + finalizes fast. Feels good.
2. Model then enters its **own output turn**, synthesizing ~30 s of (discarded)
   audio. Evidence: `turnComplete` for a 7-char question took **20.8 s** (code
   comment, 2026-09-27).
3. Q2 audio arrives **while the model is mid-output-turn**. Interim
   `inputTranscription` for Q2 does not flow promptly — it waits on VAD/barge-in
   to interrupt the output turn — producing the observed 4–8 s gap.

Every existing workaround (client silence timer replacing `turnComplete`,
barge-in handler, discarding model audio, splitting the answer onto a separate
non-Live model) is scar tissue around this one mismatch: **a conversational
model is being used as a transcriber.**

Not React rendering. Not the answer queue.

### SDK reality (checked against `@google/genai` 2.24.0 types)
`RealtimeInputConfig` exposes `automaticActivityDetection`, `activityHandling`
(`START_OF_ACTIVITY_INTERRUPTS` default / `NO_INTERRUPTION`), and `turnCoverage`.
**There is no "transcription-only / do-not-respond" flag** for a native-audio
model. So the cheap fix (suppress the output turn on the current model) does not
exist cleanly — the real fix is an ASR-path swap behind an adapter (see §5).

---

## 4. How to PROVE it — the multi-turn trace (added 2026-09-28)

Instrumentation in `geminiLive.ts`, monotonic clock (`process.hrtime.bigint()`),
not `Date.now()` (which can step). Reproduce **one slow transition** (ask Q1,
let the answer finish, ask Q2) and read three lines from the console/`dev-live.log`:

```
[gemini-live][trace] t_audio: first audio chunk <A>ms after previous answer completed (audio pipeline is alive)
[gemini-live][trace] [GAP] prev-answer-done -> next-question first caption: <G>ms (t_audio->caption <C>ms = ASR/turn-boundary delay ...)
```

Interpretation:

| Observation | Conclusion | Fix path |
|---|---|---|
| `t_audio` early (small A), `[GAP]` large, `t_audio->caption` large | **ASR / turn-boundary stall** (hypothesis confirmed) — audio flows, model won't transcribe Q2 | §5 — swap ASR path |
| `t_audio` **null / very late** ("NO audio chunk arrived...") | audio pipeline stalled (capture/worklet/IPC) after the answer | fix renderer audio lifecycle |
| `[GAP]` small (<1.5 s) | no real multi-turn defect on this run; the interviewer was simply silent | re-check reproduction |

The prior `[T1] ... 0ms` log was set at first-interim **receipt**, so it never
measured real speech-start latency — do not use it for this. The new `[GAP]`
line is the money metric.

---

## 5. Fix options (ranked) — behind an `ASRAdapter`

Only act after the trace confirms the ASR-stall row above. ASR is now wrapped
behind `ASRAdapter` (`electron/services/asr/`), so routes are swappable +
benchmarkable without touching Turn/Answer logic. Keep the answer on
`gemini-2.5-flash`.

**Scaffolded (2026-09-28, additive — the live path in `geminiLive.ts` is NOT yet
rewired, so app behavior is unchanged):**
- `asr/asrAdapter.ts` — the event contract (`session_ready | interim_transcript |
  final_transcript | speech_start | speech_end | interrupted | provider_error |
  session_closed`), each event tagged `origin: 'provider' | 'inferred'`.
- `asr/liveConnect.ts` — the proven handshake (timeout race, early-close) shared
  by all Live adapters.
- `asr/liveAdapterBase.ts` — session/reconnect/message→event mapping; concrete
  adapters differ ONLY by model id + modality.
- `asr/geminiNativeAudioAdapter.ts` — the baseline (today's route).
- `asr/geminiHalfCascadeAdapter.ts` — the candidate (`gemini-3.1-flash-live-preview`,
  TEXT modality — no synthesized-audio output turn).
- `asr/index.ts` — `createASRAdapter(id)` factory + `DEFAULT_ASR_ADAPTER_ID`.

**Bench the A/B (`scripts/asr-bench.mjs`, plain Node, no build step):**
```
ffmpeg -i clip.wav -f s16le -acodec pcm_s16le -ac 1 -ar 16000 fixture.pcm
GEMINI_API_KEY=xxx node scripts/asr-bench.mjs fixture.pcm gemini-2.5-flash-native-audio-latest
GEMINI_API_KEY=xxx node scripts/asr-bench.mjs fixture.pcm gemini-3.1-flash-live-preview
```
Record a real multi-turn clip (Q1, ~3–5 s pause, Q2, pause, Q3). It prints the
**next-utterance first-caption gap** p50/p95 per model. The candidate wins if its
utterance-#2+ gap is materially below native-audio's (the reported 4–8 s).

1. **Half-cascade Live model** from `ai.models.list()` (`gemini-3.1-flash-live-preview`,
   `gemini-3.8-live`, …) that streams audio-in + interim/final transcripts
   without a mandatory heavy audio-out turn. Benchmark 10 back-to-back turns.
2. **Manual activity signaling** on the current model:
   `automaticActivityDetection: { disabled: true }` + client-sent `ActivityStart`/
   `ActivityEnd` from our own VAD — gives precise control of turn boundaries
   (does not remove the output turn, but may cut the starvation window).
3. **Dedicated streaming STT** — cloud (Google Cloud STT streaming, Speechmatics)
   OR **local faster-whisper** (`faster-whisper-local` adapter, built:
   `asr/fasterWhisperAdapter.ts` + `scripts/asr-sidecar/`). Local removes
   cloud-ASR network latency and keeps audio on-device, and has no conversational
   output turn (so it cannot starve the next question). Costs: model load, GPU
   contention, Python packaging. **Opt-in, unverified on the target GPU** — bench
   before default (README in the sidecar dir).

Keep whichever is **measured** fastest **and** reliable across repeated turns —
not the one that wins a single shot. Only after the output-turn blocker is gone
should `INTERVIEWER_SILENCE_FLUSH_MS` be lowered (toward 700–900 ms), tuned on
recordings with natural pauses — never blindly (900 ms already split a real
question in testing).

---

## 5b. Rust evaluation (verdict: no Rust — evidence-based)

The Rust brief mandates profiling first and adding Rust ONLY at a local
CPU-bound hot path. Findings from the code:

| Rust candidate | Finding | Verdict |
|---|---|---|
| A — resampling / PCM conversion | `pcm-worklet.js` already produces 16 kHz mono PCM16 100 ms chunks on the **audio thread** — the exact format ASR wants. No second resample exists to remove. | **No** |
| B — ring buffer / backpressure | `pipeline.ts` **recycles the chunk ArrayBuffer back to the worklet** (zero-alloc), and chunks are forwarded per-100ms with no main-thread queue accumulating. `getSystemAudioHealth().maxGapMs` is the gate: steady ~100 ms ⇒ no backpressure hot path. | **No** (re-check with the health metric) |
| C — local VAD | Could add an independent speech-stop signal to feed `TurnController`, but the bottleneck is cloud turn-boundary, not endpoint compute. Only worth it if the trace shows endpointing (not ASR) is the delay. | **Deferred, gated** |
| D — transcript processing | `cleanCopilotText` etc. are trivial regex on short strings; FFI overhead would exceed the work. | **No** |

The 4–8 s delay is **cloud ASR turn-boundary**, which the brief itself says Rust
must not target. Only main-thread per-chunk cost is a base64 encode of 3200
bytes every 100 ms (`geminiLive.sendAudioChunk`) — negligible. **No Rust added;
no `napi-rs` addon, no packaging/build risk introduced.** If the health metric
later shows a real local frame-gap hot path, Candidate B/C revisits, measured.

## 5c. Status — built, verified without live audio

| Item | State |
|---|---|
| Multi-turn trace (`t_audio`, `[GAP]`) | **done**, monotonic |
| `ASRAdapter` contract + 3 adapters (native-audio, half-cascade, faster-whisper-local) + `liveConnect` + factory | **done**, typecheck |
| faster-whisper local sidecar (`scripts/asr-sidecar/`) | **done** (reference, unverified on GPU) |
| `TurnController` (endpointing state machine) | **done** + **9 unit tests** |
| `AnswerOrchestrator` (questionId-scoped, cancellation) | **done** + **8 unit tests** |
| Bench harness `scripts/asr-bench.mjs` | **done** (you run it) |
| Local audio-health metric + "Audio unavailable" UX | **done** |
| Rust | **evaluated, none added** (evidence above) |
| `geminiLive.ts` consuming the new modules | **NOT wired** — deferred; live path unchanged, so no unverified regression (see below) |

Verification run: `npm run typecheck` ✓ · `npm test` → **17 passed** ✓ ·
`npm run build` ✓ (55 s). Not run (needs your machine + key + audio): the live
interview, the trace capture, the ASR bench.

**Why `geminiLive.ts` is not rewired:** its current inline logic ALREADY has the
Section-4 properties (cancellation via `activeAnswerId`, non-blocking
supersession, idempotent flush, endpoint-timer reset). Swapping in
`TurnController`/`AnswerOrchestrator` is a code-quality refactor, not a
functional fix — and it touches the most timing-sensitive file, unverifiable
without a live run. The functional fix for the 4–8 s is the **ASR adapter swap**,
gated on the bench. The tested modules are ready for the wire-in on request.

## 6. What is already correct (don't regress)

- Audio ingestion is independent of answer generation (renderer forwards
  continuously while `liveOpenRef` is true).
- Stale answers are cancelled by `activeAnswerId`; the shared `userTurnBuffer`
  is protected by `answerQueue` serialization.
- Errors/audio/transcripts are redacted out of logs (`redact`).
- Concurrent capture + Live-session startup on Start.
