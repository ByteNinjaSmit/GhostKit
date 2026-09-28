import { describe, it, expect, vi } from 'vitest'
import { TurnController, type FinalizeMeta } from './turnController'

/** Deterministic clock + timer harness -- the whole reason TurnController takes injectable now/setTimer/clearTimer. */
function makeClock() {
  let now = 0
  let id = 1
  const timers = new Map<number, { fireAt: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const h = id++
      timers.set(h, { fireAt: now + ms, fn })
      return h
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number)
    },
    /** Advance time, firing any timers whose deadline is reached (in deadline order). */
    advance: (ms: number) => {
      now += ms
      for (;;) {
        let next: [number, { fireAt: number; fn: () => void }] | null = null
        for (const entry of timers) {
          if (entry[1].fireAt <= now && (next === null || entry[1].fireAt < next[1].fireAt)) next = entry
        }
        if (next === null) break
        timers.delete(next[0])
        next[1].fn()
      }
    }
  }
}

function make(onFinalize: (q: string, m: FinalizeMeta) => void, silenceFlushMs = 1100) {
  const clock = makeClock()
  const tc = new TurnController({ silenceFlushMs, onFinalize, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  return { tc, clock }
}

describe('TurnController', () => {
  it('finalizes on silence after the flush window', () => {
    const onFinalize = vi.fn()
    const { tc, clock } = make(onFinalize)
    tc.onInterviewerFragment('What is your greatest strength?')
    expect(tc.getState()).toBe('LISTENING')
    clock.advance(1099)
    expect(onFinalize).not.toHaveBeenCalled()
    clock.advance(1)
    expect(onFinalize).toHaveBeenCalledTimes(1)
    expect(onFinalize.mock.calls[0][0]).toBe('What is your greatest strength?')
    expect((onFinalize.mock.calls[0][1] as FinalizeMeta).trigger).toBe('silence')
    expect(tc.getState()).toBe('IDLE')
  })

  it('resets the endpoint timer on resumed speech (does not split a paused question)', () => {
    const onFinalize = vi.fn()
    const { tc, clock } = make(onFinalize)
    tc.onInterviewerFragment('Show me the SQL query that fetches the data from')
    clock.advance(600) // mid-sentence pause, under the 1100 window
    tc.onInterviewerFragment(' all rows.')
    clock.advance(600) // 1200ms since first fragment, but only 600ms since the second
    expect(onFinalize).not.toHaveBeenCalled()
    clock.advance(500) // now 1100ms since the second fragment
    expect(onFinalize).toHaveBeenCalledTimes(1)
    expect(onFinalize.mock.calls[0][0]).toBe('Show me the SQL query that fetches the data from all rows.')
  })

  it('does NOT finalize on the provider per-fragment finished flag alone', () => {
    const onFinalize = vi.fn()
    const { tc } = make(onFinalize)
    tc.onInterviewerFragment('What is', true) // providerFinal=true, but only a partial question
    expect(onFinalize).not.toHaveBeenCalled()
    expect(tc.getState()).toBe('LISTENING')
  })

  it('is idempotent: silence then a late provider turn-complete answers once', () => {
    const onFinalize = vi.fn()
    const { tc, clock } = make(onFinalize)
    tc.onInterviewerFragment('Explain closures.')
    clock.advance(1100) // silence fires
    tc.onProviderTurnComplete() // late backstop for the same question
    expect(onFinalize).toHaveBeenCalledTimes(1)
  })

  it('finalizes on a speaker change', () => {
    const onFinalize = vi.fn()
    const { tc } = make(onFinalize)
    tc.onInterviewerFragment('Tell me about yourself.')
    tc.onSpeakerChange()
    expect(onFinalize).toHaveBeenCalledTimes(1)
    expect((onFinalize.mock.calls[0][1] as FinalizeMeta).trigger).toBe('speaker_change')
  })

  it('drops the in-progress question on interruption (barge-in)', () => {
    const onFinalize = vi.fn()
    const { tc, clock } = make(onFinalize)
    tc.onInterviewerFragment('Half a question')
    tc.onInterrupted()
    expect(tc.getState()).toBe('IDLE')
    clock.advance(2000)
    expect(onFinalize).not.toHaveBeenCalled()
  })

  it('never finalizes an empty/whitespace buffer', () => {
    const onFinalize = vi.fn()
    const { tc, clock } = make(onFinalize)
    tc.onProviderTurnComplete() // nothing buffered
    tc.onInterviewerFragment('   ')
    clock.advance(1100)
    tc.finalizeNow()
    expect(onFinalize).not.toHaveBeenCalled()
  })

  it('reports endpoint delay measured from the last activity', () => {
    const onFinalize = vi.fn()
    const { tc, clock } = make(onFinalize)
    tc.onInterviewerFragment('Question.') // at now=0
    clock.advance(1100)
    const meta = onFinalize.mock.calls[0][1] as FinalizeMeta
    expect(meta.endpointDelayMs).toBe(1100)
    expect(meta.startedAtMs).toBe(0)
    expect(meta.finalizedAtMs).toBe(1100)
  })

  it('manual submit finalizes immediately with the manual trigger', () => {
    const onFinalize = vi.fn()
    const { tc } = make(onFinalize)
    tc.onInterviewerFragment('Ready?')
    tc.finalizeNow()
    expect(onFinalize).toHaveBeenCalledTimes(1)
    expect((onFinalize.mock.calls[0][1] as FinalizeMeta).trigger).toBe('manual')
  })
})
