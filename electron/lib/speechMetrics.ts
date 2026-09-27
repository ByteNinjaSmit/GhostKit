/**
 * speechMetrics.ts
 *
 * Pure functions computing local (non-Gemini) speech metrics from a
 * completed answer turn's raw transcript fragments: words-per-minute,
 * filler-word count, and an approximate "longest pause". No Gemini call, no
 * I/O, no module state -- kept pure and side-effect free specifically so
 * it's trivially unit-testable in isolation from geminiLive.ts's session
 * state, even though no test file exists yet (see Phase 4's task notes).
 *
 * Callers (electron/services/geminiLive.ts) accumulate `SpeechFragment[]`
 * for the in-progress candidate turn as `inputTranscription` messages arrive
 * from the Gemini Live server, tagged with the wall-clock time each fragment
 * was *received* in the main process -- not a real speech timestamp, see
 * `computeSpeechMetrics`'s doc comment on `longestPauseMs`.
 */

export interface SpeechFragment {
  /** This fragment's transcript text delta (may be empty for a fragment that only signals turn completion). */
  text: string
  /** `Date.now()` when this fragment was received from the Gemini Live server -- reflects transcription/delivery timing, not necessarily the instant the words were spoken. */
  timestampMs: number
}

export interface SpeechMetrics {
  /**
   * Words per minute across the turn, or `null` when there isn't enough
   * signal to make the number meaningful (fewer than 2 non-empty fragments,
   * or the measured duration is under `MIN_DURATION_FOR_WPM_MS`). Gemini
   * Live's input transcription arrives in bursts -- a short answer whose
   * fragments happen to land a few milliseconds apart would otherwise
   * produce a nonsensical rate (tens of thousands of "words per minute")
   * rather than a real measurement; `null` is more honest than a wrong
   * number, and the UI should render it as "—", not "0 wpm" or a huge one.
   */
  wpm: number | null
  /** Case-insensitive, word-boundary count of filler words: "um", "uh", "like", "basically", "actually". */
  fillerWordCount: number
  /** Approximate longest gap between consecutive fragment arrivals, in ms. See doc comment below -- this is a jitter-influenced proxy for a real pause, not a precise silence measurement. */
  longestPauseMs: number
}

/** Below this measured duration, a WPM figure is more timing-artifact than measurement -- see `SpeechMetrics.wpm`'s doc comment. */
const MIN_DURATION_FOR_WPM_MS = 2000
/** Upper bound on a reported WPM figure -- roughly the fastest sustained real human speech; anything above this is a timing artifact (burst-arrived fragments), not an actual rate, and is reported as this cap rather than an implausible number. */
const MAX_PLAUSIBLE_WPM = 400

const FILLER_WORDS = ['um', 'uh', 'like', 'basically', 'actually']
/** Word-boundary matched so "actually" doesn't match inside a longer word, and "like" only matches the standalone word -- not a substring match. */
const FILLER_WORD_RE = new RegExp(`\\b(?:${FILLER_WORDS.join('|')})\\b`, 'gi')

function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

/**
 * Computes WPM/filler-count/longest-pause from one answer turn's fragments,
 * in the order they arrived. Never throws; degenerate input (0 or 1
 * fragments, all-empty text) just yields zeros rather than NaN/Infinity.
 *
 * Longest-pause caveat: Gemini Live streams transcription in bursts tied to
 * the server's own recognition/emission cadence, not evenly spaced with the
 * candidate's real speech. The largest gap between consecutive
 * fragment-arrival timestamps is therefore a rough proxy ("did the answer
 * seem to stall out somewhere") rather than a precise measurement of actual
 * silence -- it is influenced by transcription and IPC delivery jitter as
 * much as by real pauses. Presented to the user as an approximation, not a
 * lab-grade figure.
 */
export function computeSpeechMetrics(fragments: readonly SpeechFragment[]): SpeechMetrics {
  const fullText = fragments.map((f) => f.text).join('')
  const fillerMatches = fullText.match(FILLER_WORD_RE)
  const fillerWordCount = fillerMatches !== null ? fillerMatches.length : 0

  let longestPauseMs = 0
  for (let i = 1; i < fragments.length; i++) {
    const gap = fragments[i].timestampMs - fragments[i - 1].timestampMs
    if (gap > longestPauseMs) longestPauseMs = gap
  }

  // WPM is computed over non-empty fragments only (a `finished:true` marker
  // fragment often carries no text of its own) -- and only when both the
  // fragment count and the measured duration clear their respective floors;
  // see MIN_DURATION_FOR_WPM_MS/SpeechMetrics.wpm's doc comments for why.
  const nonEmptyFragments = fragments.filter((f) => f.text.trim().length > 0)
  let wpm: number | null = null
  if (nonEmptyFragments.length >= 2) {
    const firstTimestamp = nonEmptyFragments[0].timestampMs
    const lastTimestamp = nonEmptyFragments[nonEmptyFragments.length - 1].timestampMs
    const durationMs = lastTimestamp - firstTimestamp
    if (durationMs >= MIN_DURATION_FOR_WPM_MS) {
      const wordCount = countWords(fullText)
      wpm = Math.min(MAX_PLAUSIBLE_WPM, Math.round((wordCount / durationMs) * 60_000))
    }
  }

  return { wpm, fillerWordCount, longestPauseMs }
}
