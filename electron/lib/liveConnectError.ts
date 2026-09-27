/**
 * liveConnectError.ts
 *
 * Typed failure for "the Gemini Live socket never became usable": either the
 * server closed it before `setupComplete` (e.g. close code 1008 -- the model id
 * is unknown/retired) or the connect timed out. Carries ONLY a numeric close
 * code -- the close `reason` text is deliberately never captured (server text
 * must not reach a log or the renderer). `gemini.ts`'s `describeGeminiError`
 * maps it to a fixed user-facing string. Lives in `lib/` so both `gemini.ts`
 * and `geminiLive.ts` can import it without a cycle.
 */
export type LiveConnectFailure = 'closed' | 'timeout'

export class LiveConnectError extends Error {
  readonly failure: LiveConnectFailure
  /** WebSocket close code when `failure === 'closed'` and the server sent a sane one, else `null`. */
  readonly closeCode: number | null

  constructor(failure: LiveConnectFailure, closeCode: number | null) {
    super(failure === 'timeout' ? 'Timed out connecting to Gemini Live.' : 'Gemini Live closed the connection before setup completed.')
    this.name = 'LiveConnectError'
    this.failure = failure
    this.closeCode = closeCode
  }
}

/** Extracts a bounded integer close code from a websocket CloseEvent-like value; never touches `reason`. */
export function closeCodeOf(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) return null
  const code = (event as { code?: unknown }).code
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 4999 ? code : null
}
