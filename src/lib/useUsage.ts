import { useEffect, useRef, useState } from 'react'
import type { UsageSnapshot } from '../../electron/ipc-types'

/**
 * Polls the main-process usage meter. `enabled` gates the interval (the
 * Interview page polls only while a session is starting/running); one fetch
 * always happens when polling starts or stops, so the FINAL total after Stop
 * is shown. `resetKey` changing (a new Start) clears the shown value at once so
 * the previous session's numbers never linger under the new session.
 * Pull-based on purpose: no push channel, no listener to leak.
 *
 * `guardInterviewSession` (the Interview page; NOT the Coding page, whose
 * bucket is not session-scoped): main's interview buckets are FROZEN, not
 * cleared, after a Stop, and `startSession` awaits the key vault before it
 * begins the new meter session -- so a poll right after Start can return the
 * PREVIOUS session's final totals. Every snapshot carries `sessionToken`; with
 * the guard on, nothing is shown after a Start until a snapshot arrives that
 * is ACTIVE (a new session's meter is running) -- that snapshot's token is then
 * the only one accepted until the next Start, so the final total after Stop
 * (same token, inactive) still shows, while an older session's frozen totals
 * (older token, inactive) never do.
 */
export function useUsage(enabled: boolean, intervalMs: number, resetKey: number, guardInterviewSession = false): UsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  /** Token of the session this Start owns; `null` until an active snapshot proves the new session's meter began. */
  const ownedTokenRef = useRef<number | null>(null)

  useEffect(() => {
    ownedTokenRef.current = null
    setSnapshot(null)
  }, [resetKey])

  useEffect(() => {
    let cancelled = false
    const accept = (next: UsageSnapshot): boolean => {
      if (!guardInterviewSession) return true
      if (ownedTokenRef.current === null) {
        if (!next.sessionActive || next.sessionToken === 0) return false
        ownedTokenRef.current = next.sessionToken
        return true
      }
      return next.sessionToken === ownedTokenRef.current
    }
    const fetchOnce = (): void => {
      void window.api
        .getUsage()
        .then((next) => {
          if (!cancelled && next.ok && accept(next)) setSnapshot(next)
        })
        .catch(() => {
          // Best-effort display only.
        })
    }
    fetchOnce()
    if (!enabled) {
      return () => {
        cancelled = true
      }
    }
    const id = window.setInterval(fetchOnce, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [enabled, intervalMs, guardInterviewSession])

  return snapshot
}
