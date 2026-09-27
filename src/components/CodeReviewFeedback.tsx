import type { CodeReviewResult } from '../../electron/ipc-types'

interface CodeReviewFeedbackProps {
  review: CodeReviewResult | null
  error: string | null
}

/**
 * Renders the post-submission code review: time/space complexity, edge
 * cases the submitted solution likely misses, how it compares to an optimal
 * approach, and overall feedback.
 *
 * Purely presentational, same division of responsibility as
 * FeedbackCard.tsx (assembly/state happens in the page, rendering happens
 * here) -- receives an already-fetched result (or an error) and renders
 * whatever it's given.
 */
function CodeReviewFeedback({ review, error }: CodeReviewFeedbackProps): JSX.Element {
  if (error !== null) {
    return <p className="text-sm text-destructive">{error}</p>
  }

  if (review === null) {
    return <p className="text-sm text-muted-foreground">Submit your solution to get a review of its complexity, missed edge cases, and how it compares to an optimal approach.</p>
  }

  if (!review.ok) {
    return <p className="text-sm text-destructive">{review.error ?? 'Could not generate a review for this submission.'}</p>
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Time complexity</span>
          <span>{review.timeComplexity}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Space complexity</span>
          <span>{review.spaceComplexity}</span>
        </div>
      </div>

      {review.edgeCasesMissed !== undefined && review.edgeCasesMissed.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Edge cases missed</span>
          <ul className="list-disc pl-4 text-sm leading-snug">
            {review.edgeCasesMissed.map((item, index) => (
              // Index-as-key is fine -- this list is rendered once per (immutable) review result and never reordered.
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {review.comparisonToOptimal !== undefined && review.comparisonToOptimal.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Compared to an optimal approach</span>
          <p className="text-sm leading-snug">{review.comparisonToOptimal}</p>
        </div>
      )}

      {review.overallFeedback !== undefined && review.overallFeedback.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Overall feedback</span>
          <p className="text-sm leading-snug">{review.overallFeedback}</p>
        </div>
      )}
    </div>
  )
}

export default CodeReviewFeedback
