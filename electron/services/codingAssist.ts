/**
 * codingAssist.ts
 *
 * Main-process-only service for Phase 5's three Gemini calls that support
 * the coding round: screenshot -> problem-statement extraction, the 4-level
 * hint ladder, and the post-submission code review. Grouped in one file
 * (rather than three) because all three are small, structurally similar
 * `generateContent` calls sharing the same client-construction, timeout,
 * error-handling and response-validation discipline -- unlike
 * `electron/services/codeRunner.ts` (local process execution, a completely
 * different risk profile), which stays its own file.
 *
 * Mirrors `review.ts`/`rag.ts`: constructs a fresh `GoogleGenAI` client per
 * call with a bounded `httpOptions.timeout` (this app has shipped an
 * unbounded-Gemini-call hang three times before -- `ai.live.connect()` in
 * Phase 2, `embedContent()` in Phase 3, and `reviewAnswer()`'s own call one
 * layer up in Phase 4 -- every new call here gets a timeout from the start),
 * never lets a raw SDK/network error string cross into a log or the
 * renderer (routed through `describeGeminiError`/`redact`), never trusts
 * `responseSchema` alone (every response is independently validated), never
 * throws across its public API, and is never imported by renderer or
 * preload code.
 */
import { GoogleGenAI, Type } from '@google/genai'
import type { Schema } from '@google/genai'
import { getApiKey } from './keyVault'
import { describeGeminiError } from './gemini'
import * as usage from './usage'
import { redact } from '../lib/redact'
import { renderPromptTemplate } from '../lib/promptTemplate'
import { MAX_CODE_CHARS, MAX_PROBLEM_TEXT_CHARS } from '../ipc-types'
import type { CodeReviewResult, CodingLanguage, HintsResult, ScreenshotResultEvent } from '../ipc-types'

/**
 * Model used for all three calls in this file. `gemini-2.5-flash` is the
 * same id `gemini.ts`'s `TEST_MODEL_ID` and `review.ts`'s `REVIEW_MODEL_ID`
 * already use successfully against this project's real key (see
 * review.ts's doc comment for the "-pro" line's reliability problems at
 * this prompt size, which apply equally here) -- it also lists vision
 * (image input) support on https://ai.google.dev/gemini-api/docs/models,
 * confirmed live for `extractProblemFromScreenshot` below during this
 * phase's own development (2026-09-24) against the real API with this
 * project's real key. NOTE: re-verify against that page before shipping --
 * model ids and availability change over time, same caveat every other
 * model-id constant in this app carries.
 */
const MODEL_ID = 'gemini-2.5-flash'

/**
 * Per-request timeout, shared by all three calls in this file. Same
 * non-negotiable pattern as `review.ts`'s `REVIEW_TIMEOUT_MS` -- these are
 * "the model has to think" calls (vision extraction, 4-level hint
 * generation, a structured code review), not a cheap single-embedding call,
 * so this is set to the same 20s reference value rather than
 * `rag.ts`'s tighter 8s `EMBED_TIMEOUT_MS`. `httpOptions.timeout` is the
 * SDK's own request-level timeout (a real HTTP timeout, not a
 * `Promise.race` wrapper -- see review.ts's doc comment for why that
 * distinction matters), so every call below is bounded from the moment it's
 * written, not discovered by a later review.
 */
const TIMEOUT_MS = 20_000

/** Defensive cap on the problem-text substituted into the hints/code-review prompt templates -- mirrors review.ts's MAX_QUESTION_CHARS/MAX_ANSWER_CHARS reasoning. Redundant with the IPC-boundary check in main.ts (MAX_PROBLEM_TEXT_CHARS), kept here too so every bound lives in one place regardless of caller. */
function clampProblem(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_PROBLEM_TEXT_CHARS ? `${trimmed.slice(0, MAX_PROBLEM_TEXT_CHARS)}…` : trimmed
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item): item is string => typeof item === 'string') ? value : null
}

// ---------------------------------------------------------------------------
// Screenshot -> problem-statement extraction
// ---------------------------------------------------------------------------

/** Sentinel the model is instructed to return verbatim (see prompts/screenshot-extract.md) when no coding problem is visible in the screenshot at all. */
const NO_PROBLEM_SENTINEL = 'NO_PROBLEM_FOUND'

/** Tolerant sentinel match: the model may wrap it in backticks/quotes, add trailing punctuation, or change case. Only letters/underscores are compared, so a real problem statement (which is far longer) can never collapse into a match. */
function isNoProblemSentinel(text: string): boolean {
  return text.replace(/[^A-Za-z_]/g, '').toUpperCase() === NO_PROBLEM_SENTINEL
}

/**
 * Sends a screenshot (PNG bytes, base64-encoded) to Gemini and asks it to
 * transcribe the coding problem statement visible on screen. `pngBase64` is
 * captured entirely main-process-side (electron/main.ts's
 * `runScreenshotCapture`, via `desktopCapturer`), held in memory until the
 * user explicitly confirms the upload, and never crosses the IPC boundary
 * from the renderer, so there's no renderer-supplied-size concern
 * the way there is for e.g. the resume PDF upload -- the only defensive cap
 * that matters here is on the *output* text (see `clampProblem`'s use
 * below), which this function's own doc comment on `MAX_PROBLEM_TEXT_CHARS`
 * explains (a busy/wrong screen can make the model transcribe a lot of
 * garbage).
 *
 * Never throws -- every failure mode (no key, network/timeout, malformed
 * response, nothing found) resolves to a typed result with a fixed,
 * user-facing message.
 */
export async function extractProblemFromScreenshot(pngBase64: string): Promise<ScreenshotResultEvent> {
  const apiKey = await getApiKey()
  if (apiKey === null || apiKey.length === 0) {
    return { ok: false, error: 'No API key saved yet. Add one in Settings first.' }
  }

  let prompt: string
  try {
    prompt = await renderPromptTemplate('screenshot-extract.md', {})
  } catch (err) {
    console.error(
      '[coding-assist] failed to load the screenshot-extraction prompt template (code:',
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown',
      ')'
    )
    return { ok: false, error: 'Could not load the screenshot prompt. Try reinstalling the app.' }
  }

  try {
    // Captured BY VALUE before the call: if the renderer reloads mid-call (usage.resetCoding), this call's tokens are dropped, not added to the fresh total.
    const usageEpoch = usage.currentCodingEpoch()
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT_MS } })
    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [{ inlineData: { data: pngBase64, mimeType: 'image/png' } }, prompt]
    })
    usage.recordCoding(usageEpoch, MODEL_ID, response.usageMetadata)

    // Only a `finishReason` of exactly 'STOP' means the model finished
    // normally. Anything else (MAX_TOKENS, RECITATION, SAFETY, ...) can still
    // come back with *partial* text -- accepting that would present a
    // truncated/half-refused transcription as the whole problem statement.
    const finishReason = response.candidates?.[0]?.finishReason
    const text = response.text
    if (finishReason === 'RECITATION' || finishReason === 'SAFETY' || finishReason === 'BLOCKLIST' || finishReason === 'PROHIBITED_CONTENT') {
      // Confirmed live during this phase's own development (2026-09-24,
      // real API key): a screenshot of a very well-known, verbatim problem
      // statement (a synthetic "Two Sum" image, LeetCode's exact wording)
      // came back with `candidates[0].finishReason === 'RECITATION'` and no
      // text at all -- Gemini's own recitation safety filter refusing to
      // reproduce copyrighted-verbatim text, not a bug in this call. Worth
      // a more specific message than the generic fallbacks below, since a
      // candidate is likely to hit this on exactly the kind of well-known
      // interview problem this feature is most useful for.
      return { ok: false, error: 'Gemini declined to transcribe this screenshot (likely a well-known problem it avoided reproducing verbatim). Try pasting the problem text manually instead.' }
    }
    if (finishReason === 'MAX_TOKENS') {
      return { ok: false, error: "Gemini's transcription was cut off before it finished. Try pasting the problem text manually instead." }
    }
    if (text === undefined || text.trim().length === 0) {
      return { ok: false, error: 'Gemini returned an empty response for the screenshot.' }
    }
    if (finishReason !== 'STOP') {
      return { ok: false, error: 'Gemini did not finish transcribing the screenshot. Try again, or paste the problem text manually.' }
    }
    const trimmed = text.trim()
    if (isNoProblemSentinel(trimmed)) {
      return { ok: false, error: 'No coding problem was found in the screenshot.' }
    }
    return { ok: true, problemText: clampProblem(trimmed) }
  } catch (err) {
    console.error('[coding-assist] screenshot extraction failed:', redact(String(err)))
    return { ok: false, error: describeGeminiError(err) }
  }
}

// ---------------------------------------------------------------------------
// Hint ladder
// ---------------------------------------------------------------------------

const HINTS_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    hints: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      minItems: '4',
      maxItems: '4',
      description: 'Exactly 4 escalating hints: nudge, pattern, approach, complexity -- in that order.'
    }
  },
  required: ['hints']
}

/**
 * Generates all 4 hint-ladder levels for `problemText` in a single Gemini
 * call (one call for all 4 levels, not 4 separate calls -- simpler, and
 * avoids 4x the latency/quota of one call per "Show next hint" click).
 * Caching per problem so re-clicking "next hint" doesn't re-call Gemini is
 * the caller's responsibility (src/pages/CodingRound.tsx keeps the result in
 * component state keyed by the problem text it was generated for) -- this
 * function is stateless and always makes a fresh call.
 *
 * Never throws -- every failure mode resolves to a typed result with a
 * fixed, user-facing message.
 */
export async function generateHints(problemText: string): Promise<HintsResult> {
  const apiKey = await getApiKey()
  if (apiKey === null || apiKey.length === 0) {
    return { ok: false, error: 'No API key saved yet. Add one in Settings first.' }
  }

  let prompt: string
  try {
    prompt = await renderPromptTemplate('hints.md', { problem: clampProblem(problemText) })
  } catch (err) {
    console.error(
      '[coding-assist] failed to load the hints prompt template (code:',
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown',
      ')'
    )
    return { ok: false, error: 'Could not load the hints prompt. Try reinstalling the app.' }
  }

  try {
    // Captured BY VALUE before the call: if the renderer reloads mid-call (usage.resetCoding), this call's tokens are dropped, not added to the fresh total.
    const usageEpoch = usage.currentCodingEpoch()
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT_MS } })
    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: HINTS_RESPONSE_SCHEMA
      }
    })

    usage.recordCoding(usageEpoch, MODEL_ID, response.usageMetadata)
    const hints = parseHintsJson(response.text)
    if (hints === null) {
      console.error('[coding-assist] Gemini hints response did not match the expected shape')
      return { ok: false, error: 'The hints response was malformed. Try again.' }
    }
    return { ok: true, hints }
  } catch (err) {
    console.error('[coding-assist] hint generation failed:', redact(String(err)))
    return { ok: false, error: describeGeminiError(err) }
  }
}

/** `responseSchema` constrains the model's output but is never trusted alone (same "don't trust a bare cast" discipline as every IPC boundary in this app) -- this requires exactly 4 non-empty strings, not "at least 4" or "roughly 4". */
function parseHintsJson(text: string | undefined): string[] | null {
  if (text === undefined || text.trim().length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const hints = toStringArray((raw as Record<string, unknown>)['hints'])
  if (hints === null || hints.length !== 4 || hints.some((h) => h.trim().length === 0)) return null
  // The prompt forbids code at every level, but a prompt is a request, not a
  // guarantee -- a hint that contains a fenced block or reads like several
  // lines of source would hand over the solution the ladder exists to
  // withhold, so the whole response is rejected rather than shown.
  if (hints.some(looksLikeCode)) return null
  return hints.map(clampHint)
}

/** Per-hint length cap, in characters. A hint is a few sentences; anything past this is the model rambling (or dumping a solution). */
const MAX_HINT_CHARS = 1_000

function clampHint(hint: string): string {
  const trimmed = hint.trim()
  return trimmed.length > MAX_HINT_CHARS ? `${trimmed.slice(0, MAX_HINT_CHARS)}…` : trimmed
}

/** Line shapes that read as source code rather than prose: statement terminators, brace/arrow syntax, common declaration/keyword openers, or a deeply indented line. */
const CODE_LINE_RE = /(;\s*$)|(\{\s*$)|(^\s*\}\s*;?\s*$)|(=>)|(^\s*(def|class|function|for|while|if|elif|else|return|import|from|public|private|static|#include|int|void|const|let|var)\b[^.]*[:{(=;])|(^\s{4,}\S)/

/** True for a hint containing a ``` fence, or 3+ code-looking lines. */
function looksLikeCode(hint: string): boolean {
  if (hint.includes('```')) return true
  let codeLines = 0
  for (const line of hint.split(/\r?\n/)) {
    if (CODE_LINE_RE.test(line)) codeLines += 1
  }
  return codeLines >= 3
}

// ---------------------------------------------------------------------------
// Post-submission code review
// ---------------------------------------------------------------------------

const CODE_REVIEW_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    timeComplexity: { type: Type.STRING },
    spaceComplexity: { type: Type.STRING },
    edgeCasesMissed: { type: Type.ARRAY, items: { type: Type.STRING } },
    comparisonToOptimal: { type: Type.STRING },
    overallFeedback: { type: Type.STRING }
  },
  required: ['timeComplexity', 'spaceComplexity', 'edgeCasesMissed', 'comparisonToOptimal', 'overallFeedback']
}

export interface ReviewCodeInput {
  problemText: string
  language: CodingLanguage
  code: string
}

/**
 * Requests a structured review (time/space complexity, missed edge cases,
 * comparison to an optimal approach, overall feedback) for one submitted
 * solution. Unlike `problemText` (grounding context, safe to truncate --
 * see `clampProblem`), `code` is the actual thing being reviewed: silently
 * truncating it would make the model review a partial program and report a
 * wrong Big-O for code that isn't what the candidate actually wrote, so an
 * over-length `code` is rejected outright here rather than clamped. The IPC
 * boundary (main.ts) already enforces `MAX_CODE_CHARS` before this is ever
 * called -- this is a defensive re-check, not the primary bound.
 *
 * Never throws -- every failure mode resolves to a typed result with a
 * fixed, user-facing message.
 */
export async function reviewCode(input: ReviewCodeInput): Promise<CodeReviewResult> {
  if (input.code.length === 0 || input.code.length > MAX_CODE_CHARS) {
    return { ok: false, error: 'Code is empty or too long to review.' }
  }

  const apiKey = await getApiKey()
  if (apiKey === null || apiKey.length === 0) {
    return { ok: false, error: 'No API key saved yet. Add one in Settings first.' }
  }

  let prompt: string
  try {
    prompt = await renderPromptTemplate('code-review.md', {
      problem: clampProblem(input.problemText),
      language: input.language,
      code: input.code
    })
  } catch (err) {
    console.error(
      '[coding-assist] failed to load the code-review prompt template (code:',
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown',
      ')'
    )
    return { ok: false, error: 'Could not load the review prompt. Try reinstalling the app.' }
  }

  try {
    // Captured BY VALUE before the call: if the renderer reloads mid-call (usage.resetCoding), this call's tokens are dropped, not added to the fresh total.
    const usageEpoch = usage.currentCodingEpoch()
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT_MS } })
    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: CODE_REVIEW_RESPONSE_SCHEMA
      }
    })

    usage.recordCoding(usageEpoch, MODEL_ID, response.usageMetadata)
    const parsed = parseCodeReviewJson(response.text)
    if (parsed === null) {
      console.error('[coding-assist] Gemini code-review response did not match the expected schema')
      return { ok: false, error: 'The review response was malformed. Try again.' }
    }
    return { ok: true, ...parsed }
  } catch (err) {
    console.error('[coding-assist] code review failed:', redact(String(err)))
    return { ok: false, error: describeGeminiError(err) }
  }
}

type ParsedCodeReview = Pick<CodeReviewResult, 'timeComplexity' | 'spaceComplexity' | 'edgeCasesMissed' | 'comparisonToOptimal' | 'overallFeedback'>

function parseCodeReviewJson(text: string | undefined): ParsedCodeReview | null {
  if (text === undefined || text.trim().length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>

  const timeComplexity = v['timeComplexity']
  if (typeof timeComplexity !== 'string') return null
  const spaceComplexity = v['spaceComplexity']
  if (typeof spaceComplexity !== 'string') return null
  const edgeCasesMissed = toStringArray(v['edgeCasesMissed'])
  if (edgeCasesMissed === null) return null
  const comparisonToOptimal = v['comparisonToOptimal']
  if (typeof comparisonToOptimal !== 'string') return null
  const overallFeedback = v['overallFeedback']
  if (typeof overallFeedback !== 'string') return null

  return { timeComplexity, spaceComplexity, edgeCasesMissed, comparisonToOptimal, overallFeedback }
}
