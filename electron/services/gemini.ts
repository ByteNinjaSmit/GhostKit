/**
 * gemini.ts
 *
 * Thin wrapper around the `@google/genai` SDK. Constructs a `GoogleGenAI`
 * client from the key stored in `keyVault.ts` and exposes a minimal
 * connectivity check used by the Settings screen's "Test key" button.
 *
 * This module runs in the main process ONLY. The renderer never sees the API
 * key and never talks to Google's API directly -- it only ever calls
 * `testKey()` through the IPC bridge defined in `ipc-types.ts`.
 */
import { GoogleGenAI } from '@google/genai'
import type { TestKeyResult } from '../ipc-types'
import { getApiKey } from './keyVault'
import { LiveConnectError } from '../lib/liveConnectError'

/** Upper bound on the Settings "Test key" call (C1: every Gemini call has a time limit). */
const TEST_KEY_TIMEOUT_MS = 20_000

/**
 * Model used for the lightweight connectivity check. Chosen for being fast
 * and cheap, not for interview-quality output (that's a later-phase concern).
 *
 * NOTE: verify this model id is still current against the Gemini API docs
 * (https://ai.google.dev/gemini-api/docs/models) before shipping -- model
 * ids and availability change over time.
 */
const TEST_MODEL_ID = 'gemini-2.5-flash'

/**
 * Performs a minimal `generateContent` call to verify that the stored API
 * key is valid and that the machine can reach the Gemini API. Never throws --
 * all failure modes (missing key, invalid key, network error) are surfaced as
 * a typed `{ ok: false, error }` result so they can safely cross the IPC
 * boundary to the renderer.
 */
export async function testKey(): Promise<TestKeyResult> {
  const apiKey = await getApiKey()
  if (apiKey === null || apiKey.length === 0) {
    return { ok: false, error: 'No API key saved yet. Enter a key and save it first.' }
  }

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: TEST_KEY_TIMEOUT_MS } })
    await ai.models.generateContent({
      model: TEST_MODEL_ID,
      contents: 'Reply with the single word: pong'
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeGeminiError(err) }
  }
}

/**
 * Maps SDK/network failures to fixed, user-facing strings instead of
 * forwarding SDK error text verbatim -- Google's REST transport can embed the
 * API key itself in a request URL's `?key=` parameter, and that text must
 * never reach the renderer or a log.
 *
 * Exported for reuse by `geminiLive.ts` (Phase 2): the Live API's connect
 * failures and this module's `generateContent` failures come from the same
 * SDK and fail in the same shapes (401/403/429/5xx, network errors), so they
 * share this mapping rather than duplicating it.
 */
export function describeGeminiError(err: unknown): string {
  // Live connect failures (pre-setup close / timeout) carry only a numeric close
  // code; 1008 is the server's "policy" close, which is how a retired model id
  // is reported. Checked first: it is not an HTTP status.
  if (err instanceof LiveConnectError) {
    if (err.failure === 'timeout') return 'Timed out connecting to Gemini Live. Check your internet connection and try again.'
    if (err.closeCode === 1008) {
      return 'The Gemini Live model is unavailable (it may have been retired). The app needs an update.'
    }
    return 'Could not connect to Gemini Live.'
  }
  // Checked before extractStatus: a Node `AbortError` (thrown by
  // `httpOptions.timeout` -- see rag.ts's EMBED_TIMEOUT_MS and review.ts's
  // REVIEW_TIMEOUT_MS) is a DOMException whose legacy `.code` is a small
  // integer (20 for ABORT_ERR) that extractStatus would otherwise
  // misidentify as an HTTP status and fall through to the raw-text fallback
  // below -- surfaced in practice as a review/embedding timeout showing the
  // literal string "This operation was aborted" to the user.
  if (isAbortError(err)) {
    return 'The request to Gemini timed out. Try again.'
  }

  const status = extractStatus(err)
  if (status === 401 || status === 403) {
    return 'Google rejected this key. Check that it is correct and has Gemini API access enabled.'
  }
  if (status === 429) {
    return 'Rate limited by Google. Wait a moment and try again.'
  }
  if (status === 400) {
    return 'Gemini rejected this request. Try again.'
  }
  if (status === 404) {
    return 'That Gemini model is unavailable right now. The app may need an update.'
  }
  if (status !== null && status >= 500) {
    return 'The Gemini API is temporarily unavailable. Try again shortly.'
  }
  if (err instanceof TypeError) {
    return 'Could not reach the Gemini API. Check your internet connection.'
  }
  // Anything else: never forward SDK/network error text to a caller, full
  // stop -- earlier this returned a redacted-but-otherwise-raw version of
  // `err.message`, which only strips API-key patterns. Google's error
  // bodies can carry more than that (full request details, model names,
  // etc.), and this module's entire job is guaranteeing callers only ever
  // see a fixed, safe string; callers that want the real detail for
  // diagnosis log it themselves (redacted) before calling this.
  return 'Could not complete the request to Gemini. Try again.'
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { name?: unknown }).name === 'AbortError'
}

function extractStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const rec = err as Record<string, unknown>
  if (typeof rec['status'] === 'number') return rec['status']
  if (typeof rec['code'] === 'number') return rec['code']
  return null
}
