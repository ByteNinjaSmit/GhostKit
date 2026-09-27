/**
 * usage.ts
 *
 * Main-process-only accumulator behind Phase 7's usage meter: how many Gemini
 * tokens (and roughly how much money) the current interview session -- and,
 * separately, the coding round -- has used. Pure in-memory state; nothing is
 * persisted, nothing here talks to the network, and it is never imported by
 * renderer or preload code.
 *
 * SESSION BOUNDARIES (same generation-token discipline as geminiLive.ts):
 *  - `beginSession()` (called by geminiLive.startSession) zeroes the
 *    interview-scope buckets and returns a fresh, monotonically increasing
 *    token. Every interview-scope record carries the token it was issued
 *    under, captured BY VALUE when the work started (a review captures it when
 *    the answer finishes).
 *  - `endSession(token)` (Stop, or a terminal connection error) marks that
 *    session finished. Its totals are KEPT (frozen) so the UI can still show
 *    the final figure after Stop; the next `beginSession()` clears them.
 *  - A record whose token is not the CURRENT, still-ACTIVE session is
 *    DISCARDED (documented choice: "drop", not "attribute to the finished
 *    session"). So a review resolving after Stop can neither pollute the next
 *    session's meter nor mutate the frozen final total. The cost of that
 *    choice is that a late review's tokens are not shown anywhere -- the meter
 *    is a per-session estimate, not a bill.
 *  - The `coding` category is not tied to an interview session. It accumulates
 *    from app launch (or renderer reload, see `resetCoding`) and is never
 *    touched by session boundaries.
 *
 * COST HONESTY: see PRICE_TABLE below. Nothing here is a bill.
 */
import type { UsageBucket, UsageCategoryId, UsageSnapshot } from '../ipc-types'
import { USAGE_MAX_CALLS, USAGE_MAX_COST_USD, USAGE_MAX_TOKENS } from '../ipc-types'

/**
 * Per-model prices in USD per 1,000,000 tokens.
 *
 * APPROXIMATE. Taken from https://ai.google.dev/gemini-api/docs/pricing (page
 * stamped "last updated 2026-09-24", standard tier, paid; read through a
 * summarizing fetch, so transcription errors are possible). Google changes
 * prices and model lineups regularly -- RE-VERIFY THIS TABLE BEFORE TRUSTING
 * ANY DOLLAR FIGURE, and update PRICES_REVIEWED. The free tier, batch,
 * caching, long-context tiers and discounts are not modelled.
 *
 * A model id that is not a key here is "unknown": its tokens are counted and
 * shown, but NO cost is invented for them (they show up as `unpricedTokens`).
 * `audioIn`/`audioOut` are used only when the API reports a per-modality
 * breakdown; without one everything is priced at the text rate and the bucket
 * is flagged `roughCost`.
 * Thinking tokens are billed as output (`thoughtsTokenCount` is added to output).
 */
interface ModelPrice {
  textIn: number
  audioIn: number
  textOut: number
  audioOut: number
}

export const PRICES_REVIEWED = '2026-09-24'

const NATIVE_AUDIO_25: ModelPrice = { textIn: 0.5, audioIn: 3.0, textOut: 2.0, audioOut: 12.0 }

const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // Text/vision calls (review, hints, code review, screenshot). The Settings "Test key" call is NOT metered..
  'gemini-2.5-flash': { textIn: 0.3, audioIn: 1.0, textOut: 2.5, audioOut: 2.5 },
  // Live audio session models.
  'gemini-2.5-flash-native-audio-latest': NATIVE_AUDIO_25,
  'gemini-2.5-flash-native-audio-preview-12-2025': NATIVE_AUDIO_25,
  'gemini-3.8-live': { textIn: 0.75, audioIn: 3.0, textOut: 4.5, audioOut: 12.0 }
  // gemini-embedding-001 is deliberately absent: the embeddings API reports no
  // token counts (they are estimated here) and its price was not on the page.
}

/** Rough characters-per-token for ESTIMATING tokens of text the API doesn't count (embeddings). English text is ~4. */
const CHARS_PER_TOKEN_ESTIMATE = 4

export interface RawUsage {
  promptTokenCount?: number
  /** generateContent's name for output tokens. */
  candidatesTokenCount?: number
  /** Live API's name for output tokens. */
  responseTokenCount?: number
  thoughtsTokenCount?: number
  toolUsePromptTokenCount?: number
  totalTokenCount?: number
  promptTokensDetails?: ReadonlyArray<{ modality?: string; tokenCount?: number }>
  candidatesTokensDetails?: ReadonlyArray<{ modality?: string; tokenCount?: number }>
  responseTokensDetails?: ReadonlyArray<{ modality?: string; tokenCount?: number }>
}

function emptyBucket(): UsageBucket {
  return { promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, costUsd: 0, unpricedTokens: 0, roughCost: false, estimatedTokens: false }
}

let sessionToken = 0
let sessionActive = false
let interviewBuckets: Record<'live' | 'reviews' | 'embeddings', UsageBucket> = { live: emptyBucket(), reviews: emptyBucket(), embeddings: emptyBucket() }
let codingBucket: UsageBucket = emptyBucket()
/** Bumped by `resetCoding`. A coding call captures it BY VALUE before its Gemini request; a record from an older epoch (the renderer reloaded mid-call) is dropped rather than polluting the fresh total. */
let codingEpoch = 0

/** A finite, non-negative whole number, capped -- API-reported numbers are treated as untrusted input like any other. */
function tokens(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.round(value), USAGE_MAX_TOKENS)
}

/**
 * The per-modality detail arrays come from a network response: sanitize the
 * STRUCTURE too (not an array / null or non-object entries / non-numeric counts
 * must not throw -- the meter is best-effort and may never break the caller).
 */
function modalityTokens(details: unknown, wanted: 'AUDIO' | 'OTHER'): number {
  if (!Array.isArray(details)) return 0
  let sum = 0
  for (const entry of details as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as { modality?: unknown; tokenCount?: unknown }
    const isAudio = rec.modality === 'AUDIO'
    if ((wanted === 'AUDIO') === isAudio) sum += tokens(typeof rec.tokenCount === 'number' ? rec.tokenCount : undefined)
  }
  return sum
}

/** True when `details` is a non-empty array (the only shape modalityTokens can use). */
function hasDetails(details: unknown): boolean {
  return Array.isArray(details) && details.length > 0
}

/** Beginning of a new interview session: clears the interview buckets and returns the token records must carry. */
export function beginSession(): number {
  sessionToken += 1
  sessionActive = true
  interviewBuckets = { live: emptyBucket(), reviews: emptyBucket(), embeddings: emptyBucket() }
  return sessionToken
}

/** Freezes `token`'s session (keeps its totals visible, refuses further records). A stale/unknown token is ignored, so a late stop can't freeze a newer session. */
export function endSession(token: number | null): void {
  if (token !== null && token === sessionToken) sessionActive = false
}

/** Renderer reload/crash: the coding total belongs to the UI's lifetime, start it over. */
export function resetCoding(): void {
  codingEpoch += 1
  codingBucket = emptyBucket()
}

/** Epoch a coding call must capture (by value) before it starts, and pass back to `recordCoding`. */
export function currentCodingEpoch(): number {
  return codingEpoch
}

function addTo(bucket: UsageBucket, model: string, raw: RawUsage): void {
  const price = Object.prototype.hasOwnProperty.call(PRICE_TABLE, model) ? PRICE_TABLE[model] : undefined

  const promptTotal = tokens(raw.promptTokenCount) + tokens(raw.toolUsePromptTokenCount)
  const outputText = tokens(raw.candidatesTokenCount) + tokens(raw.responseTokenCount)
  const output = outputText + tokens(raw.thoughtsTokenCount)
  // Own arithmetic rather than `totalTokenCount`: the Live API's total was
  // observed to EXCLUDE thinking tokens while generateContent's includes
  // them, so the reported field is inconsistent across the two. Fall back to
  // it only if no component was reported at all.
  const parts = promptTotal + output
  const total = parts > 0 ? parts : tokens(raw.totalTokenCount)

  bucket.promptTokens = Math.min(bucket.promptTokens + promptTotal, USAGE_MAX_TOKENS)
  bucket.outputTokens = Math.min(bucket.outputTokens + output, USAGE_MAX_TOKENS)
  bucket.totalTokens = Math.min(bucket.totalTokens + total, USAGE_MAX_TOKENS)
  bucket.calls = Math.min(bucket.calls + 1, USAGE_MAX_CALLS)

  if (price === undefined) {
    bucket.unpricedTokens = Math.min(bucket.unpricedTokens + total, USAGE_MAX_TOKENS)
    return
  }

  const promptDetails = raw.promptTokensDetails
  const outDetails = raw.responseTokensDetails ?? raw.candidatesTokensDetails
  let promptAudio = 0
  let promptOther = promptTotal
  if (hasDetails(promptDetails)) {
    promptAudio = Math.min(modalityTokens(promptDetails, 'AUDIO'), promptTotal)
    promptOther = promptTotal - promptAudio
  } else if (raw.promptTokenCount !== undefined && price.audioIn !== price.textIn) {
    bucket.roughCost = true
  }
  let outAudio = 0
  if (hasDetails(outDetails)) {
    outAudio = Math.min(modalityTokens(outDetails, 'AUDIO'), outputText)
  } else if (outputText > 0 && price.audioOut !== price.textOut) {
    bucket.roughCost = true
  }
  const outText = output - outAudio // thinking tokens are text output

  const cost =
    (promptOther * price.textIn + promptAudio * price.audioIn + outText * price.textOut + outAudio * price.audioOut) / 1_000_000
  bucket.costUsd = Math.min(bucket.costUsd + cost, USAGE_MAX_COST_USD)
}

/** Records a provider-reported usage block for an interview-scope category. Dropped unless `token` is the current, active session. */
export function recordSession(token: number | null, category: 'live' | 'reviews' | 'embeddings', model: string, raw: RawUsage | undefined): void {
  try {
    if (raw === undefined || token === null || token !== sessionToken || !sessionActive) return
    addTo(interviewBuckets[category], model, raw)
  } catch (err) {
    warnBestEffort(err)
  }
}

/** Embeddings report no token counts: estimate from the text sent (input only). Same session rules as `recordSession`. */
export function recordEmbeddingEstimate(token: number | null, model: string, texts: readonly string[]): void {
  try {
    if (token === null || token !== sessionToken || !sessionActive) return
    let chars = 0
    for (const text of texts) chars += text.length
    const estimated = Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
    addTo(interviewBuckets.embeddings, model, { promptTokenCount: estimated })
    interviewBuckets.embeddings.estimatedTokens = true
  } catch (err) {
    warnBestEffort(err)
  }
}

/** Records a coding-round call (hints / code review / screenshot extraction). Not session-scoped. */
export function recordCoding(epoch: number, model: string, raw: RawUsage | undefined): void {
  try {
    if (raw === undefined || epoch !== codingEpoch) return
    addTo(codingBucket, model, raw)
  } catch (err) {
    warnBestEffort(err)
  }
}

/** The meter is best-effort: a malformed usage block is logged (message only, never the payload) and skipped. */
function warnBestEffort(err: unknown): void {
  console.warn('[usage] ignored a malformed usage block:', err instanceof Error ? err.name : 'unknown error')
}

/** Token of the current session while it is active, else `null` -- what work that starts now should carry. */
export function currentActiveToken(): number | null {
  return sessionActive ? sessionToken : null
}

/** All-zero buckets, for a refused (untrusted-sender) reply. */
export function emptyCategories(): Record<UsageCategoryId, UsageBucket> {
  return { live: emptyBucket(), reviews: emptyBucket(), embeddings: emptyBucket(), coding: emptyBucket() }
}

export function getSnapshot(): UsageSnapshot {
  const copy = (b: UsageBucket): UsageBucket => ({ ...b })
  const categories: Record<UsageCategoryId, UsageBucket> = {
    live: copy(interviewBuckets.live),
    reviews: copy(interviewBuckets.reviews),
    embeddings: copy(interviewBuckets.embeddings),
    coding: copy(codingBucket)
  }
  return { ok: true, sessionActive, sessionToken, categories, pricesAsOf: PRICES_REVIEWED }
}
