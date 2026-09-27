/**
 * capture.ts
 *
 * Renderer-side audio capture for Phase 1: grabs the two raw MediaStreams
 * (system-audio loopback + microphone) that the rest of the audio pipeline
 * (pipeline.ts, pcm-worklet.js) consumes. This module never throws -- every
 * `getDisplayMedia`/`getUserMedia` failure mode is caught and mapped to a
 * typed `CaptureError`, so a raw `DOMException` never reaches a React
 * component uncaught.
 *
 * System audio: Windows loopback capture is only exposed through
 * `getDisplayMedia`, which normally implies screen *video* too. The video
 * track is real (electron/main.ts's setDisplayMediaRequestHandler hands back
 * an actual screen source), but we only want the audio, so the video track
 * is stopped immediately after the stream resolves.
 *
 * Concurrency: `startCapture()` is guarded both before its first `await`
 * (the `pending` latch, so two overlapping calls can't both pass the
 * "nothing running" check) and after every `await` inside `doStart()` (the
 * `cancelRequested` flag, set by `stopCapture()`), so a `stopCapture()` that
 * arrives mid-start reliably kills the session that's still coming up
 * instead of racing it.
 */

export interface CaptureStreams {
  system: MediaStream
  mic: MediaStream
}

export type CaptureErrorKind =
  | 'already-running'
  | 'cancelled'
  | 'mic-permission-denied'
  | 'mic-not-found'
  | 'mic-unavailable'
  | 'system-audio-permission-denied'
  | 'system-audio-no-source'
  | 'system-audio-unsupported'
  | 'system-audio-unavailable'
  | 'unsupported-environment'

export interface CaptureError {
  kind: CaptureErrorKind
  message: string
}

export type CaptureResult = { ok: true; streams: CaptureStreams } | { ok: false; error: CaptureError }

/** Source whose track ended unexpectedly (device unplugged, share revoked, output device changed, ...). */
export type CaptureSource = 'system' | 'mic'

/** Module-level state: at most one capture session (running or starting) at a time. */
let activeStreams: CaptureStreams | null = null
let pending: Promise<CaptureResult> | null = null
let cancelRequested = false

/**
 * Starts system-audio + mic capture. Resolves with both streams, or a typed
 * error describing exactly what went wrong (permission denial, missing
 * device, unsupported platform, etc.) so the UI can render something
 * specific instead of a generic failure.
 *
 * `onEnded`, if given, is called (at most once per source) if either
 * track ends on its own after capture starts -- e.g. the user revokes
 * screen-share from the OS, unplugs the mic, or the default audio device
 * changes. Without this, the caller has no way to notice capture silently
 * went dead.
 */
export function startCapture(onEnded?: (source: CaptureSource) => void): Promise<CaptureResult> {
  if (activeStreams !== null || pending !== null) {
    return Promise.resolve({
      ok: false,
      error: { kind: 'already-running', message: 'Capture is already running. Stop it before starting again.' }
    })
  }

  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
    return Promise.resolve({
      ok: false,
      error: { kind: 'unsupported-environment', message: 'Media capture is not available in this environment.' }
    })
  }

  cancelRequested = false
  const started = doStart(onEnded).finally(() => {
    pending = null
  })
  pending = started
  return started
}

/** Stops every track in both streams (or cancels an in-flight start) and clears the active-session guard. Safe to call when nothing is running. */
export function stopCapture(): void {
  cancelRequested = true
  if (activeStreams === null) return
  stopStream(activeStreams.system)
  stopStream(activeStreams.mic)
  activeStreams = null
}

async function doStart(onEnded?: (source: CaptureSource) => void): Promise<CaptureResult> {
  const systemResult = await captureSystemAudio()
  if (!systemResult.ok) {
    return systemResult
  }
  if (cancelRequested) {
    stopStream(systemResult.stream)
    return { ok: false, error: { kind: 'cancelled', message: 'Capture was stopped before it finished starting.' } }
  }

  // Attempt mic capture as a secondary input / meter, but do not fail system audio capture if mic is absent
  let micStream: MediaStream
  const micResult = await captureMic()
  if (micResult.ok) {
    micStream = micResult.stream
    attachEndedListener(micStream, 'mic', onEnded)
  } else {
    console.warn('[capture] Microphone capture was unavailable, proceeding with system audio only:', micResult.error.message)
    micStream = new MediaStream()
  }

  if (cancelRequested) {
    stopStream(systemResult.stream)
    stopStream(micStream)
    return { ok: false, error: { kind: 'cancelled', message: 'Capture was stopped before it finished starting.' } }
  }

  attachEndedListener(systemResult.stream, 'system', onEnded)

  activeStreams = { system: systemResult.stream, mic: micStream }
  return { ok: true, streams: activeStreams }
}

function attachEndedListener(stream: MediaStream, source: CaptureSource, onEnded?: (source: CaptureSource) => void): void {
  if (!onEnded) return
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => onEnded(source), { once: true })
  })
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop()
  })
}

type StreamResult = { ok: true; stream: MediaStream } | { ok: false; error: CaptureError }

async function captureSystemAudio(): Promise<StreamResult> {
  if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    return {
      ok: false,
      error: {
        kind: 'system-audio-unsupported',
        message: 'System audio capture is not supported on this platform.'
      }
    }
  }

  let stream: MediaStream
  try {
    // Windows loopback audio capture requires requesting video alongside it;
    // the video track is discarded immediately below. We explicitly disable
    // echoCancellation, noiseSuppression, and autoGainControl so Chromium does not
    // destroy or cancel out the system loopback audio from Windows meetings.
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false
      },
      video: true
    })
  } catch (err) {
    return { ok: false, error: classifyDisplayMediaError(err) }
  }

  stream.getVideoTracks().forEach((track) => {
    track.stop()
    stream.removeTrack(track)
  })

  if (stream.getAudioTracks().length === 0) {
    stopStream(stream)
    return {
      ok: false,
      error: {
        kind: 'system-audio-no-source',
        message: 'No system audio track was available to capture.'
      }
    }
  }

  return { ok: true, stream }
}

async function captureMic(): Promise<StreamResult> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    return { ok: true, stream }
  } catch (err) {
    return { ok: false, error: classifyUserMediaError(err) }
  }
}

function classifyDisplayMediaError(err: unknown): CaptureError {
  const name = domExceptionName(err)
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // Chromium maps both an explicit user denial AND "nothing to hand
      // back" (main process had no screen source, or rejected the request)
      // to this same error name -- the renderer can't tell them apart, so
      // the copy has to cover both without pointing the user at the wrong fix.
      return {
        kind: 'system-audio-permission-denied',
        message:
          'System audio capture could not start. Make sure this window is focused when you click Start, ' +
          'that your screen is unlocked, and that you are not on Remote Desktop or a VM with no local display ' +
          '(loopback audio needs an active screen). Then try again. See the app log for the exact cause.'
      }
    case 'NotFoundError':
      return {
        kind: 'system-audio-no-source',
        message: 'No screen or audio source was available to capture.'
      }
    case 'NotSupportedError':
      return {
        kind: 'system-audio-unsupported',
        message: 'System audio capture is not supported on this platform.'
      }
    default:
      return {
        kind: 'system-audio-unavailable',
        message: 'Could not capture system audio. Try again.'
      }
  }
}

function classifyUserMediaError(err: unknown): CaptureError {
  const name = domExceptionName(err)
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        kind: 'mic-permission-denied',
        message: 'Microphone access was denied. Allow microphone access for MockPilot and try again.'
      }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        kind: 'mic-not-found',
        message: 'No microphone was found on this system.'
      }
    default:
      return {
        kind: 'mic-unavailable',
        message: 'Could not access the microphone. Try again.'
      }
  }
}

function domExceptionName(err: unknown): string | null {
  if (err instanceof DOMException) return err.name
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: unknown }).name
    return typeof name === 'string' ? name : null
  }
  return null
}
