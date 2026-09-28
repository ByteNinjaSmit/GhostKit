import { describe, it, expect, vi } from 'vitest'
import { AnswerOrchestrator, type AnswerRunContext } from './answerOrchestrator'

/** A controllable run: resolves when `release()` is called, records isCurrent at that moment. */
function deferredRun() {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const seen: { questionId: number; currentAtEnd?: boolean } = { questionId: -1 }
  const run = async (ctx: AnswerRunContext) => {
    seen.questionId = ctx.questionId
    await gate
    seen.currentAtEnd = ctx.isCurrent()
  }
  return { run, release, seen }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('AnswerOrchestrator', () => {
  it('runs a submitted question', async () => {
    const runAnswer = vi.fn(async (ctx: AnswerRunContext) => {
      expect(ctx.isCurrent()).toBe(true)
    })
    const orch = new AnswerOrchestrator({ runAnswer })
    const id = orch.submit('Q1')
    expect(id).toBe(1)
    await tick()
    expect(runAnswer).toHaveBeenCalledTimes(1)
  })

  it('supersedes an older question: the older run sees isCurrent()===false', async () => {
    const first = deferredRun()
    let secondRan = false
    const orch = new AnswerOrchestrator({
      runAnswer: async (ctx) => {
        if (ctx.questionId === 1) return first.run(ctx)
        secondRan = true
      }
    })
    orch.submit('Q1')
    await tick() // Q1 run has started, awaiting its gate
    orch.submit('Q2') // supersedes Q1
    first.release() // Q1 finishes now
    await tick()
    await tick()
    expect(first.seen.currentAtEnd).toBe(false) // Q1 was no longer current when it ended
    expect(secondRan).toBe(true) // Q2 ran after Q1 yielded (chain not blocked)
    expect(orch.getCurrentQuestionId()).toBe(2)
  })

  it('a queued run superseded before it starts never calls runAnswer', async () => {
    const first = deferredRun()
    const runAnswer = vi.fn(async (ctx: AnswerRunContext) => {
      if (ctx.questionId === 1) return first.run(ctx)
    })
    const orch = new AnswerOrchestrator({ runAnswer })
    orch.submit('Q1')
    await tick()
    orch.submit('Q2')
    orch.submit('Q3') // Q2 superseded by Q3 while still queued behind Q1
    first.release()
    await tick()
    await tick()
    const ran = runAnswer.mock.calls.map((c) => c[0].questionId)
    expect(ran).toContain(1)
    expect(ran).toContain(3)
    expect(ran).not.toContain(2) // Q2 was superseded before it ever started
  })

  it('isCurrent(id) tracks only the latest submitted question', () => {
    const orch = new AnswerOrchestrator({ runAnswer: async () => {} })
    const q1 = orch.submit('Q1')
    const q2 = orch.submit('Q2')
    expect(orch.isCurrent(q1)).toBe(false)
    expect(orch.isCurrent(q2)).toBe(true)
  })

  it('cancelAll before the run starts supersedes it so runAnswer never fires', async () => {
    const runAnswer = vi.fn(async () => {})
    const orch = new AnswerOrchestrator({ runAnswer })
    const id = orch.submit('Q1')
    orch.cancelAll() // lands synchronously, before the queued run reaches the front
    expect(orch.isCurrent(id)).toBe(false)
    await tick()
    // The queued Q1 run checks isCurrent() at the front of the chain, sees false, and returns without running.
    expect(runAnswer).not.toHaveBeenCalled()
  })

  it('cancelAll makes an already-started run see isCurrent()===false', async () => {
    const first = deferredRun()
    const orch = new AnswerOrchestrator({ runAnswer: (ctx) => first.run(ctx) })
    orch.submit('Q1')
    await tick() // Q1 run has started, awaiting its gate
    orch.cancelAll()
    first.release()
    await tick()
    expect(first.seen.currentAtEnd).toBe(false)
  })

  it('reset supersedes in-flight runs across the epoch boundary', async () => {
    const first = deferredRun()
    const orch = new AnswerOrchestrator({ runAnswer: (ctx) => first.run(ctx) })
    orch.submit('Q1')
    await tick()
    orch.reset()
    first.release()
    await tick()
    expect(first.seen.currentAtEnd).toBe(false)
    expect(orch.getCurrentQuestionId()).toBe(0)
  })

  it('a failed run does not poison the chain', async () => {
    let secondRan = false
    const orch = new AnswerOrchestrator({
      runAnswer: async (ctx) => {
        if (ctx.questionId === 1) throw new Error('boom')
        secondRan = true
      }
    })
    orch.submit('Q1')
    await tick()
    orch.submit('Q2')
    await tick()
    await tick()
    expect(secondRan).toBe(true)
  })
})
