/**
 * liveAdapterBase.ts
 *
 * Shared base for every ASR adapter backed by a Gemini Live (bidiGenerateContent)
 * session. Owns the session lifecycle -- connect (via liveConnect), reconnect
 * once per healthy period using the session-resumption handle, send audio, stop --
 * and maps LiveServerMessages onto the provider-neutral ASREvent contract.
 *
 * A concrete adapter (native-audio vs half-cascade) differs ONLY in its
 * `model`/`responseModalities`/`realtimeInputConfig` -- everything else (the
 * proven timeout race, the reconnect-once cap, the message mapping, the stale-
 * generation guard) is identical and lives here so the two adapters cannot
 * drift apart. That single-difference surface is the whole point: it makes a
 * fair A/B possible.
 *
 * State ownership vs geminiLive.ts: this base owns ASR/session concerns ONLY.
 * It does NOT run the interviewer silence-endpoint timer, assemble turns, call
 * the answer model, write history, or meter usage. usageMetadata seen on a Live
 * message is surfaced verbatim through `onUsage` so the consumer can meter it
 * without this base importing usage.ts (a dedicated STT adapter would report
 * usage completely differently -- keeping it out of the ASREvent union keeps
 * that union provider-neutral).
 */
import { Modality } from '@google/genai'
import type { LiveServerMessage, Session, LiveConnectConfig } from '@google/genai'
import type { ASRAdapter, ASREvent, ASREventSink, ASRSessionConfig } from './asrAdapter'
import type { OperationResult } from '../../ipc-types'
import { liveConnect, safeCloseSession } from './liveConnect'
import { getApiKey } from '../keyVault'
import { describeGeminiError } from '../gemini'
import { redact } from '../../lib/redact'

/** pcm-worklet.js emits 100ms @16kHz mono Int16 = 3200 bytes; cap ~10x (matches geminiLive.MAX_AUDIO_CHUNK_BYTES). */
const MAX_AUDIO_CHUNK_BYTES = 32 * 1024
/** Matches geminiLive.RECONNECT_DELAY_MS. */
const RECONNECT_DELAY_MS = 1000

/** What a concrete Live adapter supplies -- the ONLY thing that differs between native-audio and half-cascade. */
export interface LiveAdapterProfile {
  readonly id: string
  readonly model: string
  /** [AUDIO] for native-audio (forced), [TEXT] for a half-cascade model that supports text-only (skips the heavy audio-out turn). */
  readonly responseModalities: Modality[]
  /**
   * Per-adapter Live config beyond modalities/systemInstruction/transcription
   * (which the base fills). e.g. realtimeInputConfig.automaticActivityDetection
   * tuning. Merged over the base config; may override.
   */
  extraConfig?(sessionConfig: ASRSessionConfig): Partial<LiveConnectConfig>
}

export abstract class LiveAdapterBase implements ASRAdapter {
  readonly id: string
  private readonly profile: LiveAdapterProfile

  private session: Session | null = null
  private sink: ASREventSink | null = null
  private config: ASRSessionConfig | null = null
  private apiKey: string | null = null
  private resumptionHandle: string | null = null
  /** Bumped on every start/stop -- late socket callbacks captured under a stale value are discarded (same role as geminiLive.generation). */
  private generation = 0
  private connecting = false
  /** Caps auto-reconnect to one attempt per healthy period (matches geminiLive.reconnectUsed). */
  private reconnectUsed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(profile: LiveAdapterProfile) {
    this.profile = profile
    this.id = profile.id
  }

  /** Optional usage sink -- the consumer sets this to meter Live token usage without the base importing usage.ts. */
  onUsage: ((model: string, usageMetadata: unknown) => void) | null = null

  async start(config: ASRSessionConfig, sink: ASREventSink): Promise<OperationResult> {
    if (this.session !== null || this.connecting) {
      return { ok: false, error: 'A live ASR session is already running.' }
    }
    this.connecting = true
    let myGeneration: number | null = null
    try {
      const apiKey = await getApiKey()
      if (apiKey === null || apiKey.length === 0) {
        return { ok: false, error: 'No API key saved yet. Add one in Settings first.' }
      }
      myGeneration = ++this.generation
      // A reconnect could have landed during the keytar await; close+drop it.
      if (this.session !== null) {
        safeCloseSession(this.session)
        this.session = null
      }
      this.sink = sink
      this.config = config
      this.apiKey = apiKey
      this.resumptionHandle = null
      this.reconnectUsed = false
      this.clearReconnectTimer()

      const newSession = await this.dial(apiKey, null, myGeneration)
      if (myGeneration !== this.generation) {
        safeCloseSession(newSession)
        return { ok: false, error: 'Cancelled.' }
      }
      this.session = newSession
      this.emit(myGeneration, { type: 'session_ready', origin: 'provider', resumed: false })
      return { ok: true }
    } catch (err) {
      if (myGeneration !== null && myGeneration === this.generation) {
        this.generation++
        this.clearReconnectTimer()
        const stray = this.session
        this.session = null
        this.sink = null
        if (stray !== null) safeCloseSession(stray)
      }
      return { ok: false, error: describeGeminiError(err) }
    } finally {
      this.connecting = false
    }
  }

  sendAudio(chunk: ArrayBuffer, _capturedAtMs: number): OperationResult {
    if (this.session === null) {
      return { ok: false, error: 'No live ASR session is running.' }
    }
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      return { ok: false, error: 'Invalid audio chunk size.' }
    }
    try {
      const base64 = Buffer.from(chunk).toString('base64')
      this.session.sendRealtimeInput({
        audio: { data: base64, mimeType: `audio/pcm;rate=${this.config?.inputSampleRate ?? 16000}` }
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: describeGeminiError(err) }
    }
  }

  stop(): OperationResult {
    this.generation++ // invalidate in-flight connect/reconnect callbacks
    this.clearReconnectTimer()
    if (this.sink !== null) {
      try {
        this.sink({ type: 'session_closed', origin: 'inferred', code: null })
      } catch {
        // best effort
      }
    }
    const current = this.session
    this.session = null
    this.sink = null
    this.config = null
    this.apiKey = null
    this.resumptionHandle = null
    if (current !== null) safeCloseSession(current)
    return { ok: true }
  }

  // --- internals -----------------------------------------------------------

  private buildConfig(sessionConfig: ASRSessionConfig, resumeHandle: string | null): LiveConnectConfig {
    const base: LiveConnectConfig = {
      responseModalities: this.profile.responseModalities,
      inputAudioTranscription:
        sessionConfig.languageCodes !== undefined ? { languageCodes: [...sessionConfig.languageCodes] } : {},
      outputAudioTranscription: {},
      thinkingConfig: { includeThoughts: false },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumeHandle !== null ? { handle: resumeHandle } : {}
    }
    if (sessionConfig.systemInstruction !== undefined) {
      base.systemInstruction = sessionConfig.systemInstruction
    }
    return { ...base, ...(this.profile.extraConfig?.(sessionConfig) ?? {}) }
  }

  private async dial(apiKey: string, resumeHandle: string | null, myGeneration: number): Promise<Session> {
    if (this.config === null) throw new Error('No session config.')
    return liveConnect({
      apiKey,
      model: this.profile.model,
      config: this.buildConfig(this.config, resumeHandle),
      handlers: {
        onMessage: (message) => this.handleMessage(myGeneration, message),
        onClose: (code) => this.handleClose(myGeneration, code)
      }
    })
  }

  private handleMessage(myGeneration: number, message: LiveServerMessage): void {
    if (myGeneration !== this.generation || this.sink === null) return

    if (message.usageMetadata !== undefined) {
      this.onUsage?.(this.profile.model, message.usageMetadata)
    }
    const newHandle = message.sessionResumptionUpdate?.newHandle
    if (newHandle !== undefined && newHandle.length > 0) {
      this.resumptionHandle = newHandle
    }

    const content = message.serverContent
    const interim = content?.interimInputTranscription?.text
    if (typeof interim === 'string' && interim.trim().length > 0) {
      this.emit(myGeneration, { type: 'interim_transcript', origin: 'provider', speaker: 'interviewer', text: interim })
    }
    if (content?.inputTranscription) {
      this.emit(myGeneration, {
        type: 'final_transcript',
        origin: 'provider',
        speaker: 'interviewer',
        textDelta: content.inputTranscription.text ?? '',
        providerFinal: content.inputTranscription.finished === true
      })
    }
    if (content?.interrupted === true) {
      this.emit(myGeneration, { type: 'interrupted', origin: 'provider' })
    }
    if (content?.turnComplete === true) {
      // The provider's own turn boundary. UNTRUSTED as a "human question ended"
      // signal for native-audio (it marks the MODEL's output turn) -- surfaced
      // so the TurnController can weigh it, tagged provider so it is not
      // confused with a locally-inferred endpoint.
      this.emit(myGeneration, { type: 'speech_end', origin: 'provider', speaker: 'interviewer', atMono: nowMono() })
    }
    // message.data (the model's synthesized AUDIO output) is intentionally not
    // surfaced -- no consumer plays it back.
  }

  private handleClose(myGeneration: number, code: number | null): void {
    if (myGeneration !== this.generation) return
    this.session = null

    if (this.reconnectUsed) {
      this.emit(myGeneration, {
        type: 'provider_error',
        origin: 'provider',
        message: 'Connection to Gemini was lost and the automatic reconnect failed. Start again.',
        willRetry: false
      })
      this.emit(myGeneration, { type: 'session_closed', origin: 'provider', code })
      this.sink = null
      return
    }
    this.reconnectUsed = true

    const apiKey = this.apiKey
    if (apiKey === null) {
      this.emit(myGeneration, { type: 'session_closed', origin: 'provider', code })
      this.sink = null
      return
    }

    this.emit(myGeneration, {
      type: 'provider_error',
      origin: 'provider',
      message: 'Connection dropped -- reconnecting…',
      willRetry: true
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.dial(apiKey, this.resumptionHandle, myGeneration)
        .then((newSession) => {
          if (myGeneration !== this.generation) {
            safeCloseSession(newSession)
            return
          }
          this.session = newSession
          this.reconnectUsed = false
          this.emit(myGeneration, { type: 'session_ready', origin: 'provider', resumed: true })
        })
        .catch((err: unknown) => {
          if (myGeneration !== this.generation) return
          this.emit(myGeneration, { type: 'provider_error', origin: 'provider', message: describeGeminiError(err), willRetry: false })
          this.emit(myGeneration, { type: 'session_closed', origin: 'provider', code })
          this.sink = null
        })
    }, RECONNECT_DELAY_MS)
  }

  private emit(myGeneration: number, event: ASREvent): void {
    if (myGeneration !== this.generation || this.sink === null) return
    try {
      this.sink(event)
    } catch (err) {
      console.error('[asr] event sink threw:', redact(String(err)))
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

function nowMono(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}
