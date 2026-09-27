import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import FeedbackCard from '@/components/FeedbackCard'
import ConfirmButton from '@/components/history/ConfirmButton'
import { ScoreBadge } from '@/components/history/SessionList'
import { formatSessionDate, historyReviewToFeedbackEvent } from '@/lib/historyMapping'
import { INTERVIEW_ROLE_LABELS } from '../../../electron/ipc-types'
import type { HistorySessionDetailResult, HistoryReview } from '../../../electron/ipc-types'

interface SessionDetailProps {
  sessionId: number
  onBack: () => void
  /** Called after this session was successfully deleted from the detail view. */
  onDeleted: () => void
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; detail: Required<Pick<HistorySessionDetailResult, 'session' | 'turns' | 'reviews' | 'turnsTruncated'>> }

/**
 * One past session: header, full transcript, and each answer's saved feedback
 * rendered under the candidate turn it belongs to (via the review's `turnId`),
 * reusing FeedbackCard through a mapper (see historyMapping.ts). Fetches on
 * mount and ignores a result that lands after unmount or after `sessionId`
 * changed.
 */
function SessionDetail({ sessionId, onBack, onDeleted }: SessionDetailProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    const request = ++requestRef.current
    setState({ kind: 'loading' })
    window.api
      .getHistorySession(sessionId)
      .then((result) => {
        if (!mountedRef.current || request !== requestRef.current) return
        if (result.ok && result.session && result.turns && result.reviews && result.turnsTruncated !== undefined) {
          setState({ kind: 'ready', detail: { session: result.session, turns: result.turns, reviews: result.reviews, turnsTruncated: result.turnsTruncated } })
        } else {
          setState({ kind: 'error', message: result.error ?? 'Could not load this session.' })
        }
      })
      .catch(() => {
        if (mountedRef.current && request === requestRef.current) setState({ kind: 'error', message: 'Could not load this session.' })
      })
    return () => {
      mountedRef.current = false
      requestRef.current++
    }
  }, [sessionId])

  const handleDelete = (): void => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(null)
    window.api
      .deleteHistorySession(sessionId)
      .then((result) => {
        if (!mountedRef.current) return
        setDeleting(false)
        if (result.ok) onDeleted()
        else setDeleteError(result.error ?? 'Could not delete that session.')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setDeleting(false)
        setDeleteError('Could not delete that session.')
      })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          ← Back to history
        </Button>
        {state.kind === 'ready' && (
          <ConfirmButton
            label="Delete this session"
            prompt="Permanently delete this session and its transcript?"
            confirmLabel="Yes, delete"
            disabled={deleting}
            onConfirm={handleDelete}
          />
        )}
      </div>

      {deleteError && (
        <div role="status" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {deleteError}
        </div>
      )}
      {state.kind === 'loading' && <p className="text-sm text-muted-foreground">Loading session…</p>}
      {state.kind === 'error' && (
        <div role="status" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </div>
      )}

      {state.kind === 'ready' && <DetailBody detail={state.detail} />}
    </div>
  )
}

function DetailBody({ detail }: { detail: Extract<LoadState, { kind: 'ready' }>['detail'] }): JSX.Element {
  const { session, turns, reviews, turnsTruncated } = detail
  const reviewByTurn = new Map<number, HistoryReview>()
  for (const review of reviews) {
    if (review.turnId !== null) reviewByTurn.set(review.turnId, review)
  }
  const turnIds = new Set(turns.map((t) => t.id))
  const unlinked = reviews.filter((r) => r.turnId === null || !turnIds.has(r.turnId))

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{formatSessionDate(session.startedAt)}</h2>
          <ScoreBadge score={session.avgScore} />
        </div>
        <p className="text-xs text-muted-foreground">
          {INTERVIEW_ROLE_LABELS[session.role]} · {session.difficulty} · {session.company.length > 0 ? session.company : 'unspecified company'} ·{' '}
          {session.durationMinutes} min planned · {session.answerCount} scored answer{session.answerCount === 1 ? '' : 's'}
          {session.focusTopics.length > 0 && <> · drill: {session.focusTopics.join(', ')}</>}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Transcript</span>
        {turns.length === 0 && <p className="text-sm text-muted-foreground">No transcript was recorded for this session.</p>}
        {turns.map((turn) => {
          const review = reviewByTurn.get(turn.id)
          return (
            <div key={turn.id} className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className={cn('text-xs font-medium uppercase tracking-wide', turn.speaker === 'user' ? 'text-primary' : 'text-muted-foreground')}>
                  {turn.speaker === 'user' ? 'You' : 'Interviewer'}
                </span>
                <p className="whitespace-pre-wrap text-sm leading-snug">{turn.text}</p>
              </div>
              {review && <FeedbackCard reviews={[historyReviewToFeedbackEvent(review)]} />}
            </div>
          )
        })}
        {turnsTruncated && <p className="text-xs text-muted-foreground">Transcript shortened: only the first turns of a very long session are shown.</p>}
      </div>

      {unlinked.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="text-sm font-medium">Other feedback</span>
          <FeedbackCard reviews={unlinked.map(historyReviewToFeedbackEvent)} />
        </div>
      )}
    </>
  )
}

export default SessionDetail
