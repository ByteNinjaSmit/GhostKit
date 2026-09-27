/**
 * pipeline.ts
 *
 * Wires the two raw capture streams (system loopback + mic, from capture.ts)
 * into a Web Audio graph with two parallel taps per stream:
 *
 *  1. An `AnalyserNode`, read on-demand by the level meters. This is the
 *     standard, cheap way to drive a UI meter: it always reflects the
 *     *current* signal, and the UI samples it at its own render rate (rAF)
 *     independent of audio-thread timing -- no message-passing needed.
 *  2. An `AudioWorkletNode` running pcm-worklet.js, which resamples to
 *     16kHz mono PCM16 and buffers 100ms chunks, counted via
 *     `micChunkCount`/`systemChunkCount` either way. Phase 2 adds a real
 *     consumer for the *mic* worklet's chunks: an optional `onMicChunk`
 *     callback (see `createAudioPipeline`'s second parameter), fired once
 *     per chunk with the raw transferable `ArrayBuffer`. This module stays
 *     deliberately Gemini-agnostic -- it has no idea a live session exists --
 *     the caller (src/pages/Interview.tsx) owns forwarding those chunks to
 *     `window.api.sendMicChunk`. System-audio chunks are never forwarded
 *     anywhere beyond the chunk counter: see geminiLive.ts's doc comment for
 *     why only the mic stream should ever reach the interviewer model.
 *
 * Both taps read from the same `MediaStreamAudioSourceNode` per stream, so a
 * worklet load failure (`addModule` rejecting -- caught below, not fatal)
 * never breaks the meters. A worklet load failure is logged and reflected in
 * `isWorkletActive()` rather than being silent -- otherwise the app looks
 * fully healthy (meters move) even though no PCM chunks are being produced.
 *
 * Every tap is routed into a shared `MediaStreamAudioDestinationNode`
 * ("silentSink"). Unlike routing through `audioContext.destination`, this
 * node has no path to any hardware output at all -- it's the standard
 * Web-Audio technique for keeping a graph reliably pulled every render
 * quantum (a node with no consumer isn't guaranteed to be processed)
 * *without* a live route to speakers. That matters here specifically:
 * routing captured mic/system audio anywhere near `audioContext.destination`
 * means a single future one-line change (or stray debug `.connect()`) could
 * start audibly looping the user's own mic/system audio back out -- this
 * node structurally can't do that, there's nothing to accidentally unmute.
 */
import type { CaptureStreams } from './capture'

const WORKLET_NAME = 'pcm-worklet-processor'

export interface AudioPipelineHandle {
  /** Current mic amplitude, 0 (silent) - 1 (full scale). */
  getMicLevel: () => number
  /** Current system-audio amplitude, 0 (silent) - 1 (full scale). */
  getSystemLevel: () => number
  /** Number of 100ms PCM16 chunks the mic worklet has produced so far. */
  micChunkCount: () => number
  /** Number of 100ms PCM16 chunks the system-audio worklet has produced so far. */
  systemChunkCount: () => number
  /** Whether the PCM worklet chain loaded successfully (false if `addModule` failed). */
  isWorkletActive: () => boolean
  /** Tears down every node and closes the AudioContext. Safe to call more than once. */
  dispose: () => void
}

export interface AudioPipelineOptions {
  /**
   * Called once per mic PCM16 chunk (100ms, 16kHz mono) as it arrives from
   * the worklet. Optional -- Phase 1 callers (or a pipeline started before a
   * live session exists) can omit it and just get the chunk counter. Never
   * called for system-audio chunks.
   */
  onMicChunk?: (chunk: ArrayBuffer) => void
}

export async function createAudioPipeline(
  streams: CaptureStreams,
  options: AudioPipelineOptions = {}
): Promise<AudioPipelineHandle> {
  const audioContext = new AudioContext()

  let workletActive = true
  try {
    await audioContext.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url))
  } catch (err) {
    // Meters still work off the AnalyserNode taps below even if the worklet
    // itself can't load -- see the module doc comment -- but this must not
    // be silent, since the app would otherwise look fully healthy.
    console.warn('[pipeline] PCM worklet failed to load; level meters still work, but no PCM chunks will be produced:', err)
    workletActive = false
  }

  // See module doc comment: this replaces a zero-gain GainNode->destination
  // chain, which kept the graph pulled but still had a (theoretical) path to
  // hardware output. This node has none.
  const silentSink = audioContext.createMediaStreamDestination()

  try {
    const mic = createTap(audioContext, streams.mic, workletActive, silentSink, options.onMicChunk)
    const system = createTap(audioContext, streams.system, workletActive, silentSink)

    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => {
        // Best-effort; meters/chunks just read as silent until resumed.
      })
    }

    let disposed = false

    return {
      getMicLevel: () => readLevel(mic.analyser, mic.levelBuffer),
      getSystemLevel: () => readLevel(system.analyser, system.levelBuffer),
      micChunkCount: () => mic.chunkCount.count,
      systemChunkCount: () => system.chunkCount.count,
      isWorkletActive: () => workletActive,
      dispose: () => {
        if (disposed) return
        disposed = true
        mic.disconnect()
        system.disconnect()
        void audioContext.close().catch(() => {
          // Best-effort; nothing to recover into if it's already closed.
        })
      }
    }
  } catch (err) {
    void audioContext.close().catch(() => {
      // Best-effort cleanup on the failure path.
    })
    throw err
  }
}

interface Tap {
  analyser: AnalyserNode
  levelBuffer: Uint8Array<ArrayBuffer>
  chunkCount: { count: number }
  disconnect: () => void
}

function createTap(
  audioContext: AudioContext,
  stream: MediaStream,
  workletActive: boolean,
  silentSink: MediaStreamAudioDestinationNode,
  onChunk?: (chunk: ArrayBuffer) => void
): Tap {
  const source = audioContext.createMediaStreamSource(stream)

  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6
  const levelBuffer = new Uint8Array(analyser.fftSize)

  source.connect(analyser)
  analyser.connect(silentSink)

  const chunkCount = { count: 0 }
  let workletNode: AudioWorkletNode | null = null
  if (workletActive) {
    workletNode = new AudioWorkletNode(audioContext, WORKLET_NAME, {
      channelCount: 1,
      channelCountMode: 'explicit'
    })
    workletNode.port.onmessage = (event: MessageEvent<unknown>): void => {
      if (event.data instanceof ArrayBuffer) {
        chunkCount.count += 1
        onChunk?.(event.data)
      } else {
        // The worklet posts a plain object instead of an ArrayBuffer only to
        // report a problem (e.g. an unsupported native sample rate) -- see
        // pcm-worklet.js.
        console.warn('[pipeline] PCM worklet reported a problem:', event.data)
      }
    }
    source.connect(workletNode)
    workletNode.connect(silentSink)
  }

  return {
    analyser,
    levelBuffer,
    chunkCount,
    disconnect: () => {
      source.disconnect()
      analyser.disconnect()
      if (workletNode) {
        workletNode.port.onmessage = null
        workletNode.port.close()
        workletNode.disconnect()
      }
    }
  }
}

/** Peak amplitude in the analyser's current time-domain buffer, 0-1. */
function readLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer)
  let peak = 0
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.abs(buffer[i] - 128) / 128
    if (sample > peak) peak = sample
  }
  return peak
}
