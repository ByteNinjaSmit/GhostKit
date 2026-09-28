/**
 * fasterWhisperAdapter.ts
 *
 * OPTIONAL, NON-DEFAULT local ASR route: a fully offline speech-to-text path
 * backed by a faster-whisper (CTranslate2) Python sidecar. Implements the same
 * ASRAdapter contract as the Gemini Live adapters, so the interview pipeline
 * neither knows nor cares that transcription is now local -- captions,
 * endpointing (TurnController), and answer generation (still cloud
 * gemini-2.5-flash) are unchanged.
 *
 * WHY it exists: removes cloud-ASR network latency and keeps interviewer audio
 * on-device (privacy), and -- most relevant to this app -- has NO conversational
 * output turn, so it cannot exhibit the native-audio model's next-question
 * starvation (docs/audio-latency-audit.md §3). Trade-offs: model load time,
 * local GPU/CPU contention, packaging a Python runtime, and the windowing/
 * partial-reconciliation work the sidecar must do (faster-whisper transcribes
 * segments, it is not a streaming endpoint). Verify on the target machine before
 * ever making it default -- this file ships it behind the factory as an opt-in.
 *
 * PROCESS MODEL: Electron main spawns `python faster_whisper_service.py`. Audio
 * goes to the child's stdin as length-prefixed PCM frames (4-byte LE length +
 * PCM16 bytes). The child emits line-delimited JSON events on stdout; stderr is
 * logs only. Nothing here runs on the renderer/UI thread; the child is a
 * separate OS process, so inference never blocks Electron.
 *
 * FAILURE POLICY: if the sidecar cannot start (no Python, missing deps, bad
 * model), `start` fails typed -- the caller keeps the cloud adapter. The app
 * must remain usable without this component (it is optional by construction).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import type { ASRAdapter, ASREvent, ASREventSink, ASRSessionConfig } from './asrAdapter'
import type { OperationResult } from '../../ipc-types'
import { redact } from '../../lib/redact'

/** Max PCM frame accepted (matches the Live adapters' bound). */
const MAX_AUDIO_CHUNK_BYTES = 32 * 1024
/** How long to wait for the sidecar's `ready` event before giving up (model load can be slow first time). */
const READY_TIMEOUT_MS = 30_000

export interface FasterWhisperOptions {
  /** Python executable. Default: env GHOSTKIT_WHISPER_PYTHON or 'python'. */
  pythonPath?: string
  /** Path to faster_whisper_service.py. Default: scripts/asr-sidecar relative to cwd (dev); override for a packaged app. */
  scriptPath?: string
  /** faster-whisper model size/name. Default: env GHOSTKIT_WHISPER_MODEL or 'small'. */
  model?: string
  /** 'cuda' | 'cpu'. Default: env GHOSTKIT_WHISPER_DEVICE or 'cuda'. */
  device?: string
}

export class FasterWhisperAsrAdapter implements ASRAdapter {
  readonly id = 'faster-whisper-local'
  private readonly opts: Required<FasterWhisperOptions>

  private child: ChildProcessWithoutNullStreams | null = null
  private sink: ASREventSink | null = null
  private generation = 0
  private stdoutBuf = ''

  constructor(options: FasterWhisperOptions = {}) {
    this.opts = {
      pythonPath: options.pythonPath ?? process.env.GHOSTKIT_WHISPER_PYTHON ?? 'python',
      scriptPath: options.scriptPath ?? resolve(process.cwd(), 'scripts', 'asr-sidecar', 'faster_whisper_service.py'),
      model: options.model ?? process.env.GHOSTKIT_WHISPER_MODEL ?? 'small',
      device: options.device ?? process.env.GHOSTKIT_WHISPER_DEVICE ?? 'cuda'
    }
  }

  async start(config: ASRSessionConfig, sink: ASREventSink): Promise<OperationResult> {
    if (this.child !== null) return { ok: false, error: 'A local ASR session is already running.' }
    const myGeneration = ++this.generation
    this.sink = sink
    this.stdoutBuf = ''

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        this.opts.pythonPath,
        [
          this.opts.scriptPath,
          '--model', this.opts.model,
          '--device', this.opts.device,
          '--sample-rate', String(config.inputSampleRate)
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
    } catch (err) {
      this.sink = null
      return { ok: false, error: `Could not launch the local ASR sidecar: ${redact(String(err))}` }
    }
    this.child = child

    // A spawn that fails asynchronously (ENOENT: python not found) surfaces via
    // 'error', not a throw -- reject the ready wait on it.
    const ready = new Promise<OperationResult>((resolvePromise) => {
      let settled = false
      const settle = (result: OperationResult): void => {
        if (settled) return
        settled = true
        resolvePromise(result)
      }
      const timeout = setTimeout(() => settle({ ok: false, error: 'Local ASR sidecar did not become ready in time.' }), READY_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(timeout)
        settle({ ok: false, error: `Local ASR sidecar failed to start: ${redact(String(err))}` })
      })
      child.on('exit', (code) => {
        clearTimeout(timeout)
        settle({ ok: false, error: `Local ASR sidecar exited (code ${code ?? 'unknown'}) before it was ready.` })
        this.handleChildGone(myGeneration, code)
      })
      child.stderr.on('data', (buf: Buffer) => {
        // Sidecar logs only -- never transcript text (the sidecar is responsible
        // for not writing transcripts here). Redacted regardless.
        console.warn('[asr][faster-whisper]', redact(buf.toString().trimEnd()))
      })
      child.stdout.on('data', (buf: Buffer) => {
        this.onStdout(myGeneration, buf, () => {
          clearTimeout(timeout)
          settle({ ok: true })
        })
      })
    })

    const result = await ready
    if (!result.ok) {
      this.stop()
    } else if (myGeneration !== this.generation) {
      // stop() landed during startup.
      this.stop()
      return { ok: false, error: 'Cancelled.' }
    } else {
      this.emit(myGeneration, { type: 'session_ready', origin: 'provider', resumed: false })
    }
    return result
  }

  sendAudio(chunk: ArrayBuffer, _capturedAtMs: number): OperationResult {
    const child = this.child
    if (child === null || child.stdin.destroyed) return { ok: false, error: 'No local ASR session is running.' }
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_AUDIO_CHUNK_BYTES) return { ok: false, error: 'Invalid audio chunk size.' }
    try {
      const header = Buffer.allocUnsafe(4)
      header.writeUInt32LE(chunk.byteLength, 0)
      child.stdin.write(header)
      child.stdin.write(Buffer.from(chunk))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: redact(String(err)) }
    }
  }

  stop(): OperationResult {
    this.generation++
    const child = this.child
    this.child = null
    if (this.sink !== null) {
      try {
        this.sink({ type: 'session_closed', origin: 'inferred', code: null })
      } catch {
        // best effort
      }
    }
    this.sink = null
    if (child !== null) {
      try {
        child.stdin.end()
      } catch {
        // ignore
      }
      child.kill()
    }
    return { ok: true }
  }

  // --- internals -----------------------------------------------------------

  /** Parses line-delimited JSON events off stdout. `onReady` fires once on the first `ready`. */
  private onStdout(myGeneration: number, buf: Buffer, onReady: () => void): void {
    if (myGeneration !== this.generation) return
    this.stdoutBuf += buf.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line.length === 0) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        console.warn('[asr][faster-whisper] non-JSON line on stdout (ignored)')
        continue
      }
      this.dispatch(myGeneration, msg, onReady)
    }
  }

  private dispatch(myGeneration: number, msg: unknown, onReady: () => void): void {
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') return
    const m = msg as { type: string; text?: unknown; message?: unknown }
    switch (m.type) {
      case 'ready':
        onReady()
        break
      case 'speech_start':
        this.emit(myGeneration, { type: 'speech_start', origin: 'provider', speaker: 'interviewer', atMono: nowMono() })
        break
      case 'speech_end':
        this.emit(myGeneration, { type: 'speech_end', origin: 'provider', speaker: 'interviewer', atMono: nowMono() })
        break
      case 'partial':
        if (typeof m.text === 'string' && m.text.trim().length > 0) {
          this.emit(myGeneration, { type: 'interim_transcript', origin: 'provider', speaker: 'interviewer', text: m.text })
        }
        break
      case 'final':
        if (typeof m.text === 'string') {
          // The sidecar sends whole committed segments; forward as a committed
          // delta. providerFinal true -- but TurnController still owns the
          // question boundary (a question may span multiple final segments).
          this.emit(myGeneration, { type: 'final_transcript', origin: 'provider', speaker: 'interviewer', textDelta: m.text, providerFinal: true })
        }
        break
      case 'error':
        this.emit(myGeneration, {
          type: 'provider_error',
          origin: 'provider',
          message: typeof m.message === 'string' ? redact(m.message) : 'Local ASR error.',
          willRetry: false
        })
        break
      default:
        break
    }
  }

  private handleChildGone(myGeneration: number, code: number | null): void {
    if (myGeneration !== this.generation) return
    this.child = null
    this.emit(myGeneration, { type: 'session_closed', origin: 'provider', code })
    this.sink = null
  }

  private emit(myGeneration: number, event: ASREvent): void {
    if (myGeneration !== this.generation || this.sink === null) return
    try {
      this.sink(event)
    } catch (err) {
      console.error('[asr][faster-whisper] sink threw:', redact(String(err)))
    }
  }
}

function nowMono(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}
