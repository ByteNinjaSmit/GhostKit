import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { GeminiLiveSpeaker } from '../../electron/ipc-types'

export interface TranscriptTurn {
  id: number
  speaker: GeminiLiveSpeaker
  text: string
  /** Whether Gemini has finished transcribing this turn (a still-growing turn shows a "…" cue). */
  finished: boolean
  /** Set once an 'interviewer' turn's history row exists (see onLiveInterviewerTurn) -- lets a later onLiveTranslation event find and replace this turn's text. */
  turnId?: number
}

export interface ProvisionalCaption {
  speaker: GeminiLiveSpeaker
  text: string
}

interface TranscriptProps {
  turns: TranscriptTurn[]
  provisionalCaption?: ProvisionalCaption | null
}

/**
 * Renders the live You/Interviewer turn list. Assembly of raw transcript
 * deltas (`GeminiLiveTranscriptEvent`) into these turns happens in the
 * caller (src/pages/Interview.tsx) -- this component only renders whatever
 * turns it's given, plus any active real-time provisional caption, and auto-scrolls to the newest one.
 */
function Transcript({ turns, provisionalCaption }: TranscriptProps): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, provisionalCaption])

  const hasProvisional = Boolean(provisionalCaption && provisionalCaption.text.trim().length > 0)

  if (turns.length === 0 && !hasProvisional) {
    return <p className="text-sm text-muted-foreground">Transcript will appear here once the interview starts.</p>
  }

  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto pr-1">
      {turns.map((turn) => (
        <div key={turn.id} className="flex flex-col gap-0.5">
          <span
            className={cn(
              'text-xs font-medium uppercase tracking-wide',
              turn.speaker === 'assistant'
                ? 'text-purple-400 font-semibold'
                : turn.speaker === 'interviewer'
                ? 'text-cyan-400 font-semibold'
                : 'text-primary'
            )}
          >
            {turn.speaker === 'assistant'
              ? '⚡ GhostKit AI (Response)'
              : turn.speaker === 'interviewer'
              ? '🎧 Interviewer (System Audio)'
              : 'You'}
          </span>
          <p className="text-sm leading-snug">
            {turn.text || (!turn.finished ? '…' : '')}
            {turn.text && !turn.finished && <span className="text-muted-foreground"> …</span>}
          </p>
        </div>
      ))}

      {hasProvisional && provisionalCaption && (
        <div className="flex flex-col gap-1 rounded-lg border border-cyan-500/40 bg-cyan-950/20 p-2.5 shadow-sm transition-all duration-150">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-500"></span>
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
              {provisionalCaption.speaker === 'assistant'
                ? '⚡ GhostKit AI (Generating…)'
                : provisionalCaption.speaker === 'interviewer'
                ? '🎧 Interviewer (Speaking live…)'
                : 'You (Speaking live…)'}
            </span>
          </div>
          <p className="text-sm italic leading-snug text-foreground/90">
            {provisionalCaption.text}
          </p>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

export default Transcript
