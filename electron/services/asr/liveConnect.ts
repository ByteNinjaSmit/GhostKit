/**
 * liveConnect.ts
 *
 * The battle-tested Gemini Live handshake, extracted from geminiLive.ts's
 * `openConnection` so both the live path and the ASR adapters can share ONE
 * copy of the race/timeout/early-close logic instead of drifting reimplementations.
 * It is pure plumbing: it opens ONE session, races the handshake against a
 * timeout and an early-close, wires the caller's message/close/error handlers,
 * and returns the Session. It owns NO module state -- no generation counter, no
 * reconnect, no `session` singleton. Those stay with whoever calls it.
 *
 * Why the timeout race exists (verbatim from the original): `ai.live.connect()`
 * does NOT reject on a failed handshake -- a bad key, an offline network, or a
 * dead/retired model id just leaves the promise pending forever. Without the
 * timeout, a connect that can never succeed hangs the caller indefinitely with
 * no socket to close (it is owned inside the SDK closure). A close BEFORE
 * `setupComplete` is a failed start (rejected typed via LiveConnectError), not a
 * dropped session -- the caller must not treat it as a reconnectable drop.
 */
import { GoogleGenAI } from '@google/genai'
import type { LiveServerMessage, Session, LiveConnectConfig } from '@google/genai'
import { LiveConnectError, closeCodeOf } from '../../lib/liveConnectError'
import { redact } from '../../lib/redact'

/** Matches geminiLive's CONNECT_TIMEOUT_MS -- see its doc comment for the 15s rationale. */
const CONNECT_TIMEOUT_MS = 15000

export interface LiveConnectHandlers {
  /** Fires only AFTER setupComplete (the connect resolved). Pre-setup messages never reach here. */
  onMessage: (message: LiveServerMessage) => void
  /** Fires only for a close AFTER setup (a real dropped session). A pre-setup close rejects the connect instead. */
  onClose: (code: number | null) => void
}

export interface LiveConnectParams {
  apiKey: string
  model: string
  config: LiveConnectConfig
  handlers: LiveConnectHandlers
}

/**
 * Opens one Live session. Resolves with the Session once setupComplete arrives;
 * rejects with a LiveConnectError on timeout or a close-before-setup. A late
 * handshake that resolves after we've already given up is closed, never leaked.
 */
export async function liveConnect(params: LiveConnectParams): Promise<Session> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey })

  // `abandoned` guards the callbacks against acting on a connection we've
  // already given up on -- set ONLY in the branches that reject (timeout, or a
  // close before setup), never on success. `connected` flips true once the
  // connect resolves; a close before that is a failed start, not a drop.
  let abandoned = false
  let connected = false
  let rejectEarlyClose: (err: Error) => void = () => {}
  const earlyClosePromise = new Promise<never>((_, reject) => {
    rejectEarlyClose = reject
  })
  const timer: { handle?: ReturnType<typeof setTimeout> } = {}

  const connectPromise = ai.live.connect({
    model: params.model,
    config: params.config,
    callbacks: {
      onopen: () => {
        // Websocket-level open only -- readiness is emitted by the caller once
        // the Session is actually assigned (see geminiLive's original note).
      },
      onmessage: (message: LiveServerMessage) => {
        if (abandoned) return
        params.handlers.onMessage(message)
      },
      onerror: (event: unknown) => {
        // onclose always follows and drives reconnection/state -- diagnostic only, redacted.
        console.error('[asr][liveConnect] websocket error at', new Date().toISOString(), ':', redact(describeSocketEvent(event)))
      },
      onclose: (event: unknown) => {
        if (abandoned) return
        console.warn(
          '[asr][liveConnect] socket closed at',
          new Date().toISOString(),
          '(code:',
          closeCodeOf(event) ?? 'unknown',
          connected ? ', after setup)' : ', before setup)'
        )
        if (!connected) {
          abandoned = true
          rejectEarlyClose(new LiveConnectError('closed', closeCodeOf(event)))
          return
        }
        params.handlers.onClose(closeCodeOf(event))
      }
    }
  })
  // The SDK promise may settle after the race is already decided.
  connectPromise.catch(() => {})

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer.handle = setTimeout(() => {
      abandoned = true
      reject(new LiveConnectError('timeout', null))
    }, CONNECT_TIMEOUT_MS)
  })

  try {
    const opened = await Promise.race([connectPromise, timeoutPromise, earlyClosePromise])
    connected = true
    return opened
  } catch (err) {
    // If the underlying connect() eventually resolves after we've given up
    // (a late handshake), don't leak the socket -- close it when it shows up.
    abandoned = true
    void connectPromise
      .then((lateSession: Session) => {
        safeCloseSession(lateSession)
      })
      .catch(() => {
        // Already failed on its own; nothing to close.
      })
    throw err
  } finally {
    if (timer.handle !== undefined) clearTimeout(timer.handle)
  }
}

/** Closes a session, swallowing+redacting any error. Shared so adapters don't each reimplement it. */
export function safeCloseSession(target: Session): void {
  try {
    target.close()
  } catch (err) {
    console.warn('[asr][liveConnect] error while closing session:', redact(String(err)))
  }
}

function describeSocketEvent(event: unknown): string {
  if (event instanceof Error) return event.message
  if (typeof event === 'object' && event !== null && 'message' in event) {
    const message = (event as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Unknown websocket event.'
}
