/**
 * translate.ts
 *
 * Main-process-only helper: translates the interviewer's transcribed
 * question into English for on-screen display. Gemini Live's own
 * `inputAudioTranscription` (geminiLive.ts) transcribes speech in whatever
 * language/script it was actually spoken in -- e.g. Devanagari for Hindi --
 * it does not translate. This module is a separate, tiny `generateContent`
 * call fired fire-and-forget from geminiLive.ts once an interviewer turn's
 * text is final, same posture as review.ts's per-answer review: never
 * blocks the live session, never throws, bounded by TRANSLATE_TIMEOUT_MS.
 */
import { GoogleGenAI } from '@google/genai'
import { getApiKey } from './keyVault'
import * as usage from './usage'
import { redact } from '../lib/redact'

/** Same known-working model as gemini.ts/review.ts/codingAssist.ts -- see review.ts's REVIEW_MODEL_ID doc comment for why this id specifically. */
const TRANSLATE_MODEL_ID = 'gemini-2.5-flash'

/**
 * A translation is a much smaller/cheaper call than review.ts's structured
 * review, so this is bounded tighter -- a slow one shouldn't sit around
 * uselessly (the interviewer has likely moved on by the time it would
 * resolve anyway). 10s is the actual floor, though: the API itself rejects
 * `httpOptions.timeout` below 10_000 with a 400 ("Manually set deadline 8s
 * is too short. Minimum allowed deadline is 10s") -- confirmed against the
 * real API, this is not documented anywhere in the SDK's types.
 */
const TRANSLATE_TIMEOUT_MS = 10_000

/** Defensive cap, mirrors review.ts's MAX_QUESTION_CHARS. */
const MAX_INPUT_CHARS = 2_000

export interface TranslateResult {
  ok: boolean
  text?: string
}

function clamp(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/**
 * Returns `text` translated into fluent English, or `{ ok: false }` on any
 * failure (no key, network/timeout, empty response) -- callers keep showing
 * the original transcription in that case rather than blocking on a retry.
 */
export async function translateToEnglish(text: string, usageToken: number | null): Promise<TranslateResult> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false }

  const apiKey = await getApiKey()
  if (apiKey === null || apiKey.length === 0) return { ok: false }

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: TRANSLATE_TIMEOUT_MS } })
    const response = await ai.models.generateContent({
      model: TRANSLATE_MODEL_ID,
      contents:
        'Translate the following job-interview question into fluent, natural English. ' +
        "It may already be in English, or a mix of English and another language -- if so, just clean it up. " +
        'Output ONLY the translated sentence, with no quotes, labels, or explanation:\n\n' +
        clamp(trimmed, MAX_INPUT_CHARS)
    })
    // Session-scoped auxiliary call, same bucket as review.ts's per-answer
    // review -- not worth a dedicated usage category for a call this small.
    usage.recordSession(usageToken, 'reviews', TRANSLATE_MODEL_ID, response.usageMetadata)

    const out = response.text?.trim()
    if (out === undefined || out.length === 0) return { ok: false }
    return { ok: true, text: out }
  } catch (err) {
    console.error('[translate] translation call failed:', redact(String(err)))
    return { ok: false }
  }
}
