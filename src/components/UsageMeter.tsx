import type { UsageCategoryId, UsageSnapshot } from '../../electron/ipc-types'

const CATEGORY_LABELS: Readonly<Record<UsageCategoryId, string>> = {
  live: 'live audio',
  reviews: 'answer reviews',
  embeddings: 'resume/JD lookup',
  coding: 'coding calls'
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

interface UsageMeterProps {
  snapshot: UsageSnapshot | null
  /** Which categories make up this meter (interview vs coding). */
  categories: readonly UsageCategoryId[]
  title: string
  /** Append "(final)" when the numbers are a finished session's frozen totals. */
  finalLabel?: boolean
}

/**
 * Compact "estimated usage" block. Everything here is an ESTIMATE: tokens come
 * from the API's own usageMetadata (resume/JD lookup is estimated from text
 * length) and dollars from an approximate, dated price table (see
 * electron/services/usage.ts). Unknown models show tokens only.
 */
function UsageMeter({ snapshot, categories, title, finalLabel = false }: UsageMeterProps): JSX.Element {
  if (snapshot === null) {
    return <p className="text-xs text-muted-foreground">{title}: —</p>
  }

  let tokens = 0
  let costUsd = 0
  let unpriced = 0
  let calls = 0
  let rough = false
  let estimated = false
  for (const id of categories) {
    const b = snapshot.categories[id]
    tokens += b.totalTokens
    costUsd += b.costUsd
    unpriced += b.unpricedTokens
    calls += b.calls
    rough = rough || b.roughCost
    estimated = estimated || b.estimatedTokens
  }
  const breakdown = categories
    .filter((id) => snapshot.categories[id].calls > 0)
    .map((id) => `${CATEGORY_LABELS[id]} ${formatTokens(snapshot.categories[id].totalTokens)}`)
    .join(' · ')

  const priced = tokens - unpriced
  let costText: string
  if (tokens === 0) costText = '$0.00'
  else if (priced <= 0) costText = 'cost unavailable (no price on file for this model)'
  else costText = `≈ ${formatUsd(costUsd)}${unpriced > 0 ? ' + unpriced tokens' : ''}`

  return (
    <div
      className="flex flex-col gap-0.5 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs"
      title={`Estimate only, not a bill. Tokens are what Gemini reported (resume/JD lookup is estimated from text length). Dollar figures use an approximate price table last reviewed ${snapshot.pricesAsOf}; re-verify against Google's current pricing.`}
    >
      <span className="font-medium">
        {title}: {formatTokens(tokens)} tokens · estimated {costText}
        {finalLabel && !snapshot.sessionActive && calls > 0 ? ' (final)' : ''}
      </span>
      {breakdown.length > 0 && <span className="text-muted-foreground">{breakdown}</span>}
      {rough && <span className="text-muted-foreground">Rough estimate: audio/text token split was unavailable, so part was priced at the text rate.</span>}
      {estimated && <span className="text-muted-foreground">Includes an estimated (not reported) token count.</span>}
      <span className="text-muted-foreground">Estimate only, not a bill. Prices approximate as of {snapshot.pricesAsOf}.</span>
    </div>
  )
}

export default UsageMeter
