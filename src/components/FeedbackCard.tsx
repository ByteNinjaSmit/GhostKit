import { cn } from '@/lib/utils'
import type { AnswerReviewStar, AnswerSpeechMetrics, GeminiLiveAnswerReviewEvent } from '../../electron/ipc-types'

interface FeedbackCardProps {
  /**
   * One review result per completed candidate answer, in `answerIndex`
   * order (see Interview.tsx's `handleAnswerReview` -- results can *arrive*
   * out of order since each review call runs independently, but are sorted
   * back into answer order before reaching this component).
   */
  reviews: GeminiLiveAnswerReviewEvent[]
}

const STAR_LABELS: Readonly<Record<keyof AnswerReviewStar, string>> = {
  situation: 'Situation',
  task: 'Task',
  action: 'Action',
  result: 'Result'
}

/**
 * Renders the per-answer feedback list: score, STAR checklist, missing
 * points, technical errors, the improved-answer rewrite, the suggested
 * follow-up question, and the local speech metrics (WPM/filler count/
 * longest pause). Sits below the transcript as a sibling section, matching
 * this app's existing single-column layout (see Interview.tsx) rather than
 * introducing a new page-level layout.
 *
 * Purely presentational -- receives already-assembled review events and
 * renders whatever it's given, same division of responsibility as
 * Transcript.tsx (assembly happens in the page, rendering happens here).
 */
function FeedbackCard({ reviews }: FeedbackCardProps): JSX.Element {
  if (reviews.length === 0) {
    return <p className="text-sm text-muted-foreground">Feedback on each answer will appear here once you finish speaking.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {reviews.map((review) => (
        <div key={review.answerIndex} className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Answer {review.answerIndex + 1}
            </span>
            <div className="flex items-center gap-2">
              {review.topic !== undefined && (
                <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-xs text-muted-foreground">{review.topic}</span>
              )}
              {review.ok && review.score !== undefined && <ScoreBadge score={review.score} />}
            </div>
          </div>

          {!review.ok && (
            <p className="text-sm text-destructive">{review.error ?? 'Could not generate feedback for this answer.'}</p>
          )}

          {review.ok && review.star !== undefined && <StarChecklist star={review.star} />}

          {review.ok && review.missingPoints !== undefined && review.missingPoints.length > 0 && (
            <FeedbackList title="Missing points" items={review.missingPoints} />
          )}

          {review.ok && review.technicalErrors !== undefined && review.technicalErrors.length > 0 && (
            <FeedbackList title="Technical errors" items={review.technicalErrors} />
          )}

          {review.ok && review.improvedAnswer !== undefined && review.improvedAnswer.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Improved answer</span>
              <p className="text-sm leading-snug">{review.improvedAnswer}</p>
            </div>
          )}

          {review.ok && review.followUpQuestion !== undefined && review.followUpQuestion.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Likely follow-up</span>
              <p className="text-sm leading-snug">{review.followUpQuestion}</p>
            </div>
          )}

          <MetricsRow metrics={review.metrics} />
        </div>
      ))}
    </div>
  )
}

function ScoreBadge({ score }: { score: number }): JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-medium',
        score >= 7 && 'bg-success/10 text-success',
        score >= 4 && score < 7 && 'bg-secondary text-secondary-foreground',
        score < 4 && 'bg-destructive/10 text-destructive'
      )}
    >
      {score}/10
    </span>
  )
}

function StarChecklist({ star }: { star: AnswerReviewStar }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {(Object.keys(STAR_LABELS) as Array<keyof typeof STAR_LABELS>).map((key) => (
        <span key={key} className={cn('flex items-center gap-1', star[key] ? 'text-success' : 'text-muted-foreground')}>
          <span aria-hidden="true">{star[key] ? '✓' : '✗'}</span>
          {STAR_LABELS[key]}
        </span>
      ))}
    </div>
  )
}

function FeedbackList({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <ul className="list-disc pl-4 text-sm leading-snug">
        {items.map((item, index) => (
          // Index-as-key is fine here -- this list is rendered once per (immutable) review event and never reordered.
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function MetricsRow({ metrics }: { metrics: AnswerSpeechMetrics }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-4 border-t border-border pt-2 text-xs text-muted-foreground">
      <span>{metrics.wpm !== null ? `${metrics.wpm} wpm` : '— wpm'}</span>
      <span>
        {metrics.fillerWordCount} filler word{metrics.fillerWordCount === 1 ? '' : 's'}
      </span>
      <span>longest pause ~{Math.round(metrics.longestPauseMs / 1000)}s</span>
    </div>
  )
}

export default FeedbackCard
