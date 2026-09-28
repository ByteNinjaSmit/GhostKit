/**
 * turnController.ts
 *
 * The interviewer-question ENDPOINTING state machine, extracted from
 * geminiLive.ts as a pure, side-effect-free unit so it can be unit-tested with
 * fake timers (see turnController.test.ts) and reused across ASR adapters. It
 * owns exactly one decision: "the interviewer has finished asking a question."
 * It knows nothing about Gemini, history, RAG, answers, or the renderer -- the
 * caller supplies `onFinalize`, which is where recordTurn / runFastTextAnswer /
 * translation are wired in geminiLive.
 *
 * Behavior is a faithful port of the live path's proven logic
 * (docs/audio-latency-audit.md §2): a client silence timer is the PRIMARY
 * finalize trigger; a provider turn-complete and a speaker-change are backstops;
 * the provider's own per-fragment `finished` flag is deliberately IGNORED as a
 * finalize signal (it has fired early/wrong -- 7 chars into a real question).
 *
 * State: IDLE -> LISTENING -> (silence) FINALIZED -> IDLE. Finalize is
 * idempotent -- a second trigger with an already-empty buffer is a no-op, so an
 * explicit turn-complete arriving right after the silence timer cannot answer
 * the same question twice. The endpoint timer RESETS on every new fragment, so
 * a mid-question pause that resumes does not split the question.
 *
 * Clock/timer are injectable so tests run deterministically; production uses
 * Date.now + setTimeout.
 */

export type TurnState = 'IDLE' | 'LISTENING' | 'FINALIZED'

/** Opaque timer handle -- `unknown` so a fake-timer test and Node's Timeout both fit. */
export type TimerHandle = unknown

export interface FinalizeMeta {
  /** ms epoch of the first non-blank fragment of this question. */
  startedAtMs: number
  /** ms epoch the question was finalized. */
  finalizedAtMs: number
  /** finalizedAtMs - (last fragment activity): how long the silence ran before finalize fired. */
  endpointDelayMs: number
  /** What triggered finalize -- for the latency trace / tests. */
  trigger: FinalizeTrigger
}

export type FinalizeTrigger = 'silence' | 'provider_turn_complete' | 'speaker_change' | 'manual'

export interface TurnControllerOptions {
  /** Silence after the last fragment before the question is treated as over (geminiLive uses 1100). */
  silenceFlushMs: number
  /** Called once per finalized non-empty question. The ONLY output of this class. */
  onFinalize: (question: string, meta: FinalizeMeta) => void
  /** Injectable clock (default Date.now). */
  now?: () => number
  /** Injectable timer set (default setTimeout). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  /** Injectable timer clear (default clearTimeout). */
  clearTimer?: (handle: TimerHandle) => void
}

export class TurnController {
  private readonly silenceFlushMs: number
  private readonly onFinalize: (question: string, meta: FinalizeMeta) => void
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  private state: TurnState = 'IDLE'
  private buffer = ''
  private startedAtMs: number | null = null
  private lastActivityAtMs: number | null = null
  private timer: TimerHandle | null = null

  constructor(options: TurnControllerOptions) {
    this.silenceFlushMs = options.silenceFlushMs
    this.onFinalize = options.onFinalize
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  getState(): TurnState {
    return this.state
  }

  /** Current in-progress (unfinalized) question text -- for callers that show a live buffer. */
  getBuffer(): string {
    return this.buffer
  }

  /**
   * One interviewer transcript fragment (interim OR committed). Accumulates it,
   * (re)arms the silence timer, and moves to LISTENING. `providerFinal` is
   * accepted but INTENTIONALLY not used to finalize -- see class doc comment.
   */
  onInterviewerFragment(text: string, _providerFinal = false): void {
    const t = this.now()
    if (this.buffer.length === 0 && text.trim().length > 0) {
      this.startedAtMs = t
    }
    this.buffer += text
    this.lastActivityAtMs = t
    this.state = 'LISTENING'
    this.armTimer()
  }

  /** Provider signalled its own turn end -- backstop finalize (for the rare case the silence timer never fires). */
  onProviderTurnComplete(): void {
    this.finalize('provider_turn_complete')
  }

  /**
   * The active speaker changed to someone else -- finalize any buffered
   * interviewer question so it does not glue onto a later turn. No-op if nothing
   * is buffered.
   */
  onSpeakerChange(): void {
    this.finalize('speaker_change')
  }

  /** User pressed "submit now" -- finalize immediately regardless of the timer. */
  finalizeNow(): void {
    this.finalize('manual')
  }

  /** Barge-in / interruption -- drop the in-progress question without finalizing it. */
  onInterrupted(): void {
    this.clearArmedTimer()
    this.buffer = ''
    this.startedAtMs = null
    this.lastActivityAtMs = null
    this.state = 'IDLE'
  }

  /** Full reset (session start/stop). */
  reset(): void {
    this.onInterrupted()
  }

  dispose(): void {
    this.clearArmedTimer()
  }

  // --- internals -----------------------------------------------------------

  private armTimer(): void {
    this.clearArmedTimer()
    this.timer = this.setTimer(() => {
      this.timer = null
      this.finalize('silence')
    }, this.silenceFlushMs)
  }

  private clearArmedTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  /**
   * Finalizes the buffered question. Idempotent: an empty/whitespace buffer is a
   * no-op, so two triggers in a row (silence then a late turn-complete) only
   * ever fire onFinalize once.
   */
  private finalize(trigger: FinalizeTrigger): void {
    this.clearArmedTimer()
    const question = this.buffer.trim()
    const finalizedAtMs = this.now()
    const startedAtMs = this.startedAtMs ?? finalizedAtMs
    const lastActivity = this.lastActivityAtMs ?? startedAtMs

    this.buffer = ''
    this.startedAtMs = null
    this.lastActivityAtMs = null
    this.state = 'IDLE'

    if (question.length === 0) return
    this.onFinalize(question, {
      startedAtMs,
      finalizedAtMs,
      endpointDelayMs: finalizedAtMs - lastActivity,
      trigger
    })
  }
}
