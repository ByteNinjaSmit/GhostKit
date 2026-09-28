/**
 * asrAdapter.ts
 *
 * Provider-agnostic contract for the SPEECH-RECOGNITION half of the interview
 * pipeline. It exists to isolate "how interviewer audio becomes transcript
 * events" behind one interface so the current Gemini native-audio Live path
 * (electron/services/geminiLive.ts) can be benchmarked against an alternate
 * ASR route -- a half-cascade Live model, or a dedicated streaming STT -- WITHOUT
 * rewriting turn control, answer generation, history, or the renderer wiring.
 * See docs/audio-latency-audit.md §5 for why the swap is the real fix for the
 * multi-turn (2nd-question) delay, and §3 for the SDK-level reason a config
 * flip on the current model cannot do it.
 *
 * SCOPE: this file is the CONTRACT ONLY. It is intentionally not yet imported
 * by geminiLive.ts -- landing it changes no runtime behavior. The migration
 * (extract the current session into GeminiNativeAudioAsrAdapter, make
 * geminiLive.ts consume an ASRAdapter, then add a second adapter to A/B) is a
 * separate, measured step gated on the latency trace confirming the ASR stall.
 *
 * DESIGN RULES (from the audit's non-negotiables):
 *  - The adapter owns ONLY audio-in -> transcript/turn events. It never
 *    generates the candidate-facing answer (that stays on the separate
 *    gemini-2.5-flash generateContentStream path) and never touches history,
 *    RAG, or usage metering.
 *  - Every emitted event carries an `origin`: `'provider'` for a signal the
 *    provider actually sent, `'inferred'` for one THIS APP synthesized locally
 *    (e.g. a client silence-timer endpoint, or a speaker-change boundary).
 *    Consumers must be able to tell a real provider turn-boundary from a
 *    locally-guessed one -- conflating them is exactly what made the current
 *    code lean on an unreliable per-fragment `finished` flag.
 *  - Endpointing (deciding a question is COMPLETE) is a TurnController concern,
 *    NOT the adapter's. The adapter reports raw speech activity + whatever
 *    boundary the provider natively gives; it does not run the silence timer.
 *  - No secrets, raw audio, or transcript text in logs (see electron/lib/redact.ts).
 */
import type { GeminiLiveSpeaker, OperationResult } from '../../ipc-types'

/**
 * Marks whether an event reflects something the provider actually reported, or
 * a boundary this app inferred locally. Keeps "the model told us the turn
 * ended" distinct from "our silence timer guessed it did" at the type level.
 */
export type ASREventOrigin = 'provider' | 'inferred'

/** Discriminated event contract an adapter emits. One event kind per `type`. */
export type ASREvent =
  | ASRSessionReadyEvent
  | ASRInterimTranscriptEvent
  | ASRFinalTranscriptEvent
  | ASRSpeechStartEvent
  | ASRSpeechEndEvent
  | ASRInterruptedEvent
  | ASRErrorEvent
  | ASRClosedEvent

/** The session is established and ready to accept audio. Emitted once per successful (re)connect. */
export interface ASRSessionReadyEvent {
  type: 'session_ready'
  origin: ASREventOrigin
  /** True when this readiness follows an automatic reconnect rather than the initial connect. */
  resumed: boolean
}

/**
 * A live, revisable transcription hypothesis for the in-progress utterance.
 * Replace-in-place in the caption UI; never appended to the finalized
 * transcript. `text` is the whole current hypothesis for the utterance (as the
 * provider streams it), not a delta.
 */
export interface ASRInterimTranscriptEvent {
  type: 'interim_transcript'
  origin: ASREventOrigin
  speaker: GeminiLiveSpeaker
  text: string
}

/**
 * A committed transcript fragment. `textDelta` is the incremental committed
 * text (the provider streams committed transcription in pieces, many of which
 * begin with a leading space -- do NOT trimStart per fragment; see
 * geminiLive.cleanCopilotText's history). `providerFinal` is the provider's own
 * per-fragment end-of-turn claim, surfaced but explicitly UNTRUSTED as a
 * completion signal -- it has fired early/wrong in this app (7 chars into a
 * real question). TurnController decides real completion.
 */
export interface ASRFinalTranscriptEvent {
  type: 'final_transcript'
  origin: ASREventOrigin
  speaker: GeminiLiveSpeaker
  textDelta: string
  providerFinal: boolean
}

/** Speech activity began (provider VAD, or inferred from first audio-bearing fragment). Marks the start the TurnController's endpoint timer resets against. */
export interface ASRSpeechStartEvent {
  type: 'speech_start'
  origin: ASREventOrigin
  speaker: GeminiLiveSpeaker
  /** Monotonic ms (process.hrtime.bigint-based) when activity was detected -- for the latency trace, never mixed with Date.now(). */
  atMono: number
}

/** Speech activity stopped (provider VAD/end-of-activity, or inferred). NOT the same as "question complete" -- that is the TurnController's call. */
export interface ASRSpeechEndEvent {
  type: 'speech_end'
  origin: ASREventOrigin
  speaker: GeminiLiveSpeaker
  atMono: number
}

/** Barge-in: new speech interrupted a model response still in flight. Consumers should drop the abandoned turn's queued output. */
export interface ASRInterruptedEvent {
  type: 'interrupted'
  origin: ASREventOrigin
}

/** A recoverable-or-terminal provider/session error. `message` is already redacted and safe to log/surface; never a raw SDK/network string. */
export interface ASRErrorEvent {
  type: 'provider_error'
  origin: ASREventOrigin
  message: string
  /** True when the adapter will attempt its own reconnect next; false when the caller must restart. */
  willRetry: boolean
}

/** The session closed. `code` is the numeric close code when known (never the server's reason text). */
export interface ASRClosedEvent {
  type: 'session_closed'
  origin: ASREventOrigin
  code: number | null
}

/** Sink the adapter pushes events into -- one callback, discriminated on `event.type`, mirroring geminiLive's existing GeminiLiveEventSink posture. */
export type ASREventSink = (event: ASREvent) => void

/**
 * What an adapter needs to open a session. Deliberately minimal and
 * provider-neutral: no history/RAG/usage handles (not the adapter's job) and no
 * app-level generation counter (the adapter has its own instance lifecycle via
 * start/stop; the consumer keeps its own staleness guard around the sink).
 */
export interface ASRSessionConfig {
  /**
   * The fully-built interviewer system instruction, when the chosen provider
   * uses one (a conversational Live model does; a pure STT service ignores it).
   * Built ONCE by the caller and passed through unchanged on reconnect -- the
   * adapter never rebuilds it.
   */
  systemInstruction?: string
  /** Input PCM sample rate in Hz (currently 16000 from pcm-worklet.js). */
  inputSampleRate: number
  /** ASR candidate languages, narrowing (not fixing) detection -- e.g. ['en-IN','en-US','hi-IN']. */
  languageCodes?: readonly string[]
}

/**
 * One ASR provider behind a uniform lifecycle. An instance owns at most one
 * live session; `start` after a successful `start` (without an intervening
 * `stop`) must fail typed, not double-dial. All methods return typed results
 * and never throw -- an unopened session, a bad key, an oversized chunk are all
 * reported as `{ ok: false, error }`, matching geminiLive's current contract so
 * main.ts's IPC handlers need no new error handling.
 */
export interface ASRAdapter {
  /** Stable id for logs/benchmarks, e.g. 'gemini-native-audio' or 'gcloud-stt-streaming'. */
  readonly id: string
  /** Opens a session and begins delivering events to `sink`. Fails typed if one is already running or credentials are missing. */
  start(config: ASRSessionConfig, sink: ASREventSink): Promise<OperationResult>
  /** Forwards one PCM16 audio chunk. `capturedAtMs` is renderer Date.now() at capture, for the latency trace only. */
  sendAudio(chunk: ArrayBuffer, capturedAtMs: number): OperationResult
  /** Closes the current session and cancels any in-flight connect/reconnect. Safe to call when nothing is running. */
  stop(): OperationResult
}

/** Factory signature -- lets the consumer pick an adapter by config/flag without importing every provider module eagerly. */
export type ASRAdapterFactory = () => ASRAdapter
