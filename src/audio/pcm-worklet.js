/**
 * pcm-worklet.js
 *
 * Studio-grade AudioWorkletProcessor that transforms live audio (system loopback
 * or microphone) into broadcast-quality 16kHz mono PCM16 audio for Gemini Live.
 *
 * Features:
 * 1. Multi-channel downmixing (clean stereo -> mono sum).
 * 2. DC-blocking sub-audible filter (removes DC bias and low-frequency rumble).
 * 3. Smooth anti-aliasing filter + continuous fractional linear interpolation
 *    (eliminates aliasing and decimation phase-jitter across 48kHz, 44.1kHz, etc.).
 * 4. Adaptive Voice Leveler / Pre-Amp (boosts quiet meeting speech cleanly
 *    with a soft-knee hyperbolic tangent limiter to prevent any clipping).
 * 5. Emits exact 100ms (1600-sample) 16kHz Little-Endian Int16 buffers.
 */
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    this.targetSampleRate = 16000
    this.chunkSize = 1600 // 100ms @ 16kHz

    // Sample rate ratio:
    this.ratio = sampleRate / this.targetSampleRate
    this.timeInInput = 0
    this.prevFiltered = 0

    // DC Blocking filter: y[n] = x[n] - x[n-1] + R * y[n-1], R = 0.995 (~15Hz cutoff)
    this.dcPrevIn = 0
    this.dcPrevOut = 0

    // Cascaded 2-pole lowpass filter for anti-aliasing (~7.2kHz cutoff)
    const cutoffHz = 7200
    const dt = 1 / sampleRate
    const rc = 1 / (2 * Math.PI * cutoffHz)
    this.lpfAlpha = dt / (rc + dt)
    this.lpfState1 = 0
    this.lpfState2 = 0

    // Adaptive voice leveler (AGC) & soft limiter
    this.envelope = 0.08
    this.currentGain = 2.0 // Default boost for system audio from Zoom/Meet
    this.targetPeak = 0.65 // Target speech amplitude (~ -3.7 dBFS)

    this.chunkBuffer = new Int16Array(this.chunkSize)
    this.chunkOffset = 0

    // Reusable scratch buffer for downmixing/filtering to eliminate ~375 allocations/sec
    this.scratchFiltered = new Float32Array(128)

    // Recycled ArrayBuffer pool for zero-allocation 100ms chunk emission
    this.bufferPool = []
    this.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer && event.data.byteLength === this.chunkSize * 2) {
        this.bufferPool.push(event.data)
      }
    }

    this.unsupportedRate = this.ratio < 1
    if (this.unsupportedRate) {
      this.port.postMessage({ error: 'unsupported-sample-rate', sampleRate })
    }
  }

  process(inputs) {
    if (this.unsupportedRate) return false

    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true
    }

    const numChannels = input.length
    const channel0 = input[0]
    const quantumLen = channel0.length // typically 128 in Web Audio

    // 1. Downmix & Filter each input sample in this quantum using reusable scratch buffer
    if (this.scratchFiltered.length < quantumLen) {
      this.scratchFiltered = new Float32Array(quantumLen)
    }
    const filtered = this.scratchFiltered
    for (let i = 0; i < quantumLen; i++) {
      let mixed = 0
      for (let ch = 0; ch < numChannels; ch++) {
        mixed += input[ch][i]
      }
      mixed /= numChannels

      // DC Blocker
      const dcOut = mixed - this.dcPrevIn + 0.995 * this.dcPrevOut
      this.dcPrevIn = mixed
      this.dcPrevOut = dcOut

      // 2-pole Anti-aliasing Lowpass Filter
      this.lpfState1 += this.lpfAlpha * (dcOut - this.lpfState1)
      this.lpfState2 += this.lpfAlpha * (this.lpfState1 - this.lpfState2)
      filtered[i] = this.lpfState2
    }

    // 2. Fractional Linear Resampling across quantum boundary:
    while (this.timeInInput < quantumLen) {
      const idx = Math.floor(this.timeInInput)
      const frac = this.timeInInput - idx

      const s0 = idx === 0 ? this.prevFiltered : filtered[idx - 1]
      const s1 = filtered[idx]
      const rawSample = s0 + frac * (s1 - s0)

      // 3. Adaptive Speech Leveler & Soft Limiter
      const absSample = Math.abs(rawSample)
      if (absSample > this.envelope) {
        this.envelope += 0.05 * (absSample - this.envelope) // Fast attack
      } else {
        this.envelope += 0.00015 * (absSample - this.envelope) // Smooth release
      }

      // Voice activity threshold: only boost active speech, don't amplify pure noise floor
      if (this.envelope > 0.005) {
        const desiredGain = Math.min(4.5, this.targetPeak / Math.max(0.04, this.envelope))
        // Faster attack (0.01 ~= 100ms time constant at 16kHz output) so the
        // START of a quiet question is boosted promptly rather than ~500ms in --
        // ramping up (quiet speech appearing) is quicker than ramping down.
        const coeff = desiredGain > this.currentGain ? 0.01 : 0.003
        this.currentGain += coeff * (desiredGain - this.currentGain)
      } else {
        // Return gently to nominal gain when silent
        this.currentGain += 0.001 * (2.0 - this.currentGain)
      }

      const boosted = rawSample * this.currentGain
      // TRANSPARENT soft limiter: leave normal speech LINEAR (tanh on every
      // sample distorted all speech, e.g. 0.65 -> 0.57 plus harmonics, feeding
      // the ASR persistently colored audio). Only soft-knee the part that
      // exceeds the threshold, so peaks still can't clip but ordinary speech
      // reaches the model undistorted -- clearer recognition.
      const LIMIT_THRESHOLD = 0.8
      const ab = boosted < 0 ? -boosted : boosted
      let limited
      if (ab <= LIMIT_THRESHOLD) {
        limited = boosted
      } else {
        const range = 1 - LIMIT_THRESHOLD
        const compressed = LIMIT_THRESHOLD + range * Math.tanh((ab - LIMIT_THRESHOLD) / range)
        limited = boosted < 0 ? -compressed : compressed
      }

      const intSample = Math.round(limited < 0 ? limited * 0x8000 : limited * 0x7fff)
      this.chunkBuffer[this.chunkOffset++] = intSample

      if (this.chunkOffset >= this.chunkSize) {
        const outBuf = this.chunkBuffer.buffer
        this.port.postMessage(outBuf, [outBuf])
        const recycled = this.bufferPool.pop()
        this.chunkBuffer = recycled ? new Int16Array(recycled) : new Int16Array(this.chunkSize)
        this.chunkOffset = 0
      }

      this.timeInInput += this.ratio
    }

    this.timeInInput -= quantumLen
    this.prevFiltered = filtered[quantumLen - 1]

    return true
  }
}

registerProcessor('pcm-worklet-processor', PCMWorkletProcessor)
