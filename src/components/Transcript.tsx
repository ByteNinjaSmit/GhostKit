import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { GeminiLiveSpeaker } from '../../electron/ipc-types'

export interface TranscriptTurn {
  id: number
  speaker: GeminiLiveSpeaker
  text: string
  /** Whether Gemini has finished transcribing this turn (a still-growing turn shows a "…" cue). */
  finished: boolean
}

interface TranscriptProps {
  turns: TranscriptTurn[]
}

/**
 * Renders the live You/Interviewer turn list. Assembly of raw transcript
 * deltas (`GeminiLiveTranscriptEvent`) into these turns happens in the
 * caller (src/pages/Interview.tsx) -- this component only renders whatever
 * turns it's given, and auto-scrolls to the newest one.
 */
function Transcript({ turns }: TranscriptProps): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  if (turns.length === 0) {
    return <p className="text-sm text-muted-foreground">Transcript will appear here once the interview starts.</p>
  }

  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto pr-1">
      {turns.map((turn) => (
        <div key={turn.id} className="flex flex-col gap-0.5">
          <span
            className={cn(
              'text-xs font-medium uppercase tracking-wide',
              turn.speaker === 'user' ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {turn.speaker === 'user' ? 'You' : 'Interviewer'}
          </span>
          <p className="text-sm leading-snug">
            {turn.text || (!turn.finished ? '…' : '')}
            {turn.text && !turn.finished && <span className="text-muted-foreground"> …</span>}
          </p>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

export default Transcript
