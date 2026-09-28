/**
 * answerOrchestrator.ts
 *
 * Owns per-question answer lifecycle, extracted from geminiLive.ts's
 * `activeAnswerId` + `answerQueue` logic as a pure, testable unit. Each
 * finalized question gets a unique monotonically increasing `questionId`;
 * submitting a new question SUPERSEDES all older ones. A run receives an
 * `isCurrent()` predicate and must check it before emitting any delta -- so a
 * stale stream (a slower earlier answer, or one the user interrupted) emits
 * nothing once a newer question has arrived, and late deltas from an older
 * questionId are dropped by the runner itself.
 *
 * Serialization vs blocking: like the live path, runs are chained so only one
 * writes the shared assistant transcript buffer at a time -- but because a new
 * `submit` immediately bumps the current id, a queued older run early-returns
 * the instant it reaches the front, so a NEW question is never held waiting for
 * an OLD answer's full token stream. (This is the Section-4 "do not serialize
 * all answers behind a single promise chain if that delays a new question"
 * requirement: the chain exists only to protect the buffer, and supersession
 * makes it non-blocking for the latest question.)
 *
 * Pure of Gemini/history/usage: the caller supplies `runAnswer`, which does the
 * actual model streaming and checks `isCurrent()` around every emit.
 */

export interface AnswerRunContext {
  /** Unique id for this question -- stamp every emitted delta with it so the UI can drop superseded ones. */
  readonly questionId: number
  /** The finalized question text. */
  readonly question: string
  /** True only while THIS question is the latest submitted one AND the orchestrator has not been reset. Check before every emit. */
  isCurrent(): boolean
}

export interface AnswerOrchestratorOptions {
  /** Runs one answer. Must not throw (errors are swallowed to protect the chain); must consult ctx.isCurrent() before emitting. */
  runAnswer: (ctx: AnswerRunContext) => Promise<void>
}

export class AnswerOrchestrator {
  private readonly runAnswer: (ctx: AnswerRunContext) => Promise<void>
  private nextQuestionId = 1
  private currentQuestionId = 0
  /** Bumped on reset so in-flight runs from a previous session are superseded even if a same-valued id were reused. */
  private epoch = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(options: AnswerOrchestratorOptions) {
    this.runAnswer = options.runAnswer
  }

  /**
   * Submit a finalized question. Returns its `questionId`. Immediately supersedes
   * every earlier question, then queues the run behind any currently-writing run
   * (which will early-return on its own next isCurrent() check).
   */
  submit(question: string): number {
    const questionId = this.nextQuestionId++
    this.currentQuestionId = questionId
    const epochAtSubmit = this.epoch
    const ctx: AnswerRunContext = {
      questionId,
      question,
      isCurrent: () => this.epoch === epochAtSubmit && this.currentQuestionId === questionId
    }
    this.chain = this.chain
      .then(() => {
        if (!ctx.isCurrent()) return // superseded while queued -- never even start
        return this.runAnswer(ctx)
      })
      .catch(() => {
        // A failed run must not poison the chain for what's queued behind it.
      })
    return questionId
  }

  /** The id of the latest submitted question (0 before any submit). */
  getCurrentQuestionId(): number {
    return this.currentQuestionId
  }

  /** True if `questionId` is still the latest -- the UI uses this to ignore late deltas from older ids. */
  isCurrent(questionId: number): boolean {
    return questionId === this.currentQuestionId
  }

  /** Supersede everything in flight (barge-in, or user interrupt) without starting a new question. */
  cancelAll(): void {
    this.currentQuestionId = this.nextQuestionId++ // a value no in-flight run holds -> all stale
  }

  /** Session reset: supersede all runs across the epoch boundary and clear ids. */
  reset(): void {
    this.epoch++
    this.currentQuestionId = 0
    this.chain = Promise.resolve()
  }
}
