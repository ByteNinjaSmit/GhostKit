/**
 * player.ts
 *
 * Plays back the interviewer's speech: 24kHz mono PCM16 chunks pushed from
 * the main process (electron/services/geminiLive.ts, delivered via
 * `window.api.onLiveAudioChunk`). Gapless: naively starting an
 * `AudioBufferSourceNode` at `audioContext.currentTime` for each chunk as it
 * arrives produces audible clicks/gaps between chunks (network jitter,
 * IPC/event-loop scheduling jitter) -- instead this keeps a running
 * `nextStartTime` cursor and schedules each chunk to start exactly when the
 * previous one ends, so consecutive chunks play back-to-back as long as they
 * arrive before their scheduled start time.
 *
 * Unlike src/audio/pipeline.ts's captured mic/system-audio taps (which are
 * deliberately routed to a silent `MediaStreamAudioDestinationNode`, never to
 * speakers, to make an accidental feedback loop structurally impossible),
 * this player's whole job *is* to reach `audioContext.destination` -- it's
 * playing the interviewer's voice back to the candidate, not re-monitoring
 * their own mic.
 */

const OUTPUT_SAMPLE_RATE = 24000
/** Small scheduling headroom for the first chunk after a gap -- starting exactly at `currentTime` schedules into the past by the time the audio thread renders it, clipping the render's leading edge. */
const LEAD_IN_SECONDS = 0.05

export interface AudioPlayerHandle {
  /** Queues one PCM16 chunk for gapless playback. */
  enqueue: (chunk: ArrayBuffer) => void
  /** Drops any not-yet-played queued audio and resets the schedule cursor to "now". */
  clear: () => void
  /** Tears down the AudioContext. Safe to call more than once. */
  dispose: () => void
}

export function createAudioPlayer(): AudioPlayerHandle {
  const audioContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
  if (audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => {
      // Best-effort; playback just won't start until something else resumes it.
    })
  }
  const activeSources = new Set<AudioBufferSourceNode>()
  let nextStartTime = 0
  let disposed = false

  const enqueue = (chunk: ArrayBuffer): void => {
    if (disposed) return
    // A well-formed PCM16 chunk is a whole number of 2-byte samples; drop
    // anything else rather than let Int16Array's constructor throw on a
    // misaligned buffer.
    if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) return

    const samples = new Int16Array(chunk)
    const audioBuffer = audioContext.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE)
    const channel = audioBuffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 32768
    }

    const source = audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(audioContext.destination)

    // If the queue ran dry (nextStartTime is in the past), resume from now
    // instead of trying to catch up -- catching up would play everything
    // back faster than realtime, which is worse than a small gap.
    const startAt = Math.max(audioContext.currentTime + LEAD_IN_SECONDS, nextStartTime)
    source.start(startAt)
    nextStartTime = startAt + audioBuffer.duration

    activeSources.add(source)
    source.onended = () => {
      activeSources.delete(source)
    }
  }

  const clear = (): void => {
    activeSources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // Already stopped/ended -- nothing to clean up.
      }
    })
    activeSources.clear()
    nextStartTime = audioContext.currentTime
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clear()
    void audioContext.close().catch(() => {
      // Best-effort; nothing to recover into if it's already closed.
    })
  }

  return { enqueue, clear, dispose }
}
