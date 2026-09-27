/**
 * pcm-worklet.js
 *
 * AudioWorkletProcessor that resamples a live audio stream down to 16kHz
 * mono PCM16 and buffers it into 100ms (1600-sample) chunks.
 *
 * Deliberately plain JS, not TypeScript: this file runs in a separate
 * AudioWorkletGlobalScope that the browser loads via a raw
 * `audioContext.audioWorklet.addModule(url)` fetch, outside of React's
 * normal module graph. It is referenced from pipeline.ts as
 * `new URL('./pcm-worklet.js', import.meta.url)`, a pattern Vite recognizes
 * statically and handles as a plain static asset (copied byte-for-byte, with
 * a hashed filename in the production build) in both `electron-vite dev` and
 * `electron-vite build` -- no separate TS-for-worklets build step needed, and
 * none of this project's tsconfigs include this file, so it isn't
 * typechecked as part of `npm run typecheck` either. Verified by running the
 * dev server and confirming the worklet loads and posts chunks (see
 * pipeline.ts and Interview.tsx for the consumer).
 *
 * Phase 1 has no real consumer for the emitted chunks yet (streaming them to
 * Gemini Live is Phase 2) -- `port.postMessage` still fires every 100ms so
 * the pipeline is proven to produce correctly-sized chunks end-to-end;
 * pipeline.ts's `port.onmessage` handler just counts them for now.
 */
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    /** Target output sample rate for the PCM chunks. */
    this.targetSampleRate = 16000
    /** Samples per emitted chunk at the target rate (100ms @ 16kHz). */
    this.chunkSize = 1600

    // Two cascaded single-pole IIR low-pass filters (~5.5kHz cutoff, -12dB/
    // octave combined), applied before decimation. Naive decimation (just
    // dropping samples) would alias energy above the new Nyquist limit
    // (8kHz) back down into the audible band and hurt downstream
    // transcription accuracy. A single pole at 7.5kHz was tried first but is
    // only -3.3dB at 8kHz -- not enough attenuation right where it matters;
    // cascading two poles at a lower cutoff gets meaningfully more headroom
    // without needing a proper FIR design.
    const cutoffHz = 5500
    const dt = 1 / sampleRate // `sampleRate` is a global in AudioWorkletGlobalScope
    const rc = 1 / (2 * Math.PI * cutoffHz)
    this.filterAlpha = dt / (rc + dt)
    this.filterState1 = 0
    this.filterState2 = 0

    // Fractional-accumulator decimator: works for any native context sample
    // rate (48000, 44100, ...), not just exact integer multiples of 16000.
    this.decimationRatio = sampleRate / this.targetSampleRate
    this.decimationAccumulator = 0

    // A native rate below the 16kHz target would make the accumulator grow
    // unbounded (it's only designed to skip samples, not repeat them) and
    // silently emit a mislabelled stream. Bail out loudly instead.
    this.unsupportedRate = this.decimationRatio < 1
    if (this.unsupportedRate) {
      this.port.postMessage({ error: 'unsupported-sample-rate', sampleRate })
    }

    this.chunkBuffer = new Int16Array(this.chunkSize)
    this.chunkOffset = 0
  }

  process(inputs) {
    if (this.unsupportedRate) {
      return false
    }

    const input = inputs[0]
    const channel = input && input[0]
    if (!channel) {
      // No input connected yet (e.g. the graph hasn't warmed up) -- stay
      // alive and try again on the next render quantum.
      return true
    }

    for (let i = 0; i < channel.length; i++) {
      this.filterState1 += this.filterAlpha * (channel[i] - this.filterState1)
      this.filterState2 += this.filterAlpha * (this.filterState1 - this.filterState2)

      this.decimationAccumulator += 1
      if (this.decimationAccumulator < this.decimationRatio) {
        continue
      }
      this.decimationAccumulator -= this.decimationRatio

      const clamped = Math.max(-1, Math.min(1, this.filterState2))
      this.chunkBuffer[this.chunkOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.chunkOffset++

      if (this.chunkOffset >= this.chunkSize) {
        this.port.postMessage(this.chunkBuffer.buffer, [this.chunkBuffer.buffer])
        this.chunkBuffer = new Int16Array(this.chunkSize)
        this.chunkOffset = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-worklet-processor', PCMWorkletProcessor)
