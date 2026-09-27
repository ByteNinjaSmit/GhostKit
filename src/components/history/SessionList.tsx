import { cn } from '@/lib/utils'
import { formatSessionDate } from '@/lib/historyMapping'
import ConfirmButton from '@/components/history/ConfirmButton'
import { INTERVIEW_ROLE_LABELS } from '../../../electron/ipc-types'
import type { HistorySessionSummary } from '../../../electron/ipc-types'

interface SessionListProps {
  sessions: HistorySessionSummary[]
  onOpen: (sessionId: number) => void
  onDelete: (sessionId: number) => void
  /** Disables Delete buttons while a delete/clear is in flight. */
  busy: boolean
}

export function ScoreBadge({ score }: { score: number | null }): JSX.Element {
  if (score === null) {
    return <span className="rounded-full bg-secondary/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">no score</span>
  }
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-medium',
        score >= 7 && 'bg-success/10 text-success',
        score >= 4 && score < 7 && 'bg-secondary text-secondary-foreground',
        score < 4 && 'bg-destructive/10 text-destructive'
      )}
    >
      avg {score}/10
    </span>
  )
}

/** Past sessions, newest first. Row click opens the detail view; each row has its own confirm-gated Delete. */
function SessionList({ sessions, onOpen, onDelete, busy }: SessionListProps): JSX.Element {
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No past interviews yet. Sessions you complete on the Interview page are saved here.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {sessions.map((session) => (
        <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
          <button
            type="button"
            onClick={() => onOpen(session.id)}
            className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-sm font-medium">{formatSessionDate(session.startedAt)}</span>
            <span className="text-xs text-muted-foreground">
              {INTERVIEW_ROLE_LABELS[session.role]} · {session.difficulty} · {session.company.length > 0 ? session.company : 'unspecified company'} ·{' '}
              {session.answerCount} answer{session.answerCount === 1 ? '' : 's'}
              {session.focusTopics.length > 0 && <> · drill: {session.focusTopics.join(', ')}</>}
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <ScoreBadge score={session.avgScore} />
            <ConfirmButton
              label="Delete"
              prompt="Delete this session and its transcript?"
              confirmLabel="Yes, delete"
              disabled={busy}
              onConfirm={() => onDelete(session.id)}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default SessionList
