import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import LevelMeter from '@/components/LevelMeter'
import Transcript, { type TranscriptTurn, type ProvisionalCaption } from '@/components/Transcript'
import FeedbackCard from '@/components/FeedbackCard'
import UsageMeter from '@/components/UsageMeter'
import { useWindowShortcut } from '@/lib/useWindowShortcut'
import { useUsage } from '@/lib/useUsage'
import { startCapture, stopCapture, type CaptureSource, type CaptureStreams } from '@/audio/capture'
import { createAudioPipeline, type AudioPipelineHandle } from '@/audio/pipeline'
import { createAudioPlayer, type AudioPlayerHandle } from '@/audio/player'
import { INTERVIEW_ROLE_LABELS, SHORTCUT_TOGGLE_SESSION_LABEL } from '../../electron/ipc-types'
import type {
  GeminiLiveAnswerReviewEvent,
  GeminiLiveAudioChunkEvent,
  GeminiLiveConnectionState,
  GeminiLiveConnectionStateEvent,
  GeminiLiveTurnFinishedEvent,
  GeminiLiveTranscriptEvent,
  GeminiLiveTranslationEvent,
  InterviewSetup
} from '../../electron/ipc-types'

type CaptureState = 'idle' | 'starting' | 'running'
/** `'idle'` is a local-only value (no session has ever started); the rest mirror `GeminiLiveConnectionState`. */
type LiveState = 'idle' | GeminiLiveConnectionState

interface InterviewProps {
  /** Chosen on the Setup screen (or DEFAULT_INTERVIEW_SETUP if it was never visited -- see App.tsx). Passed through to `startLiveSession` on every Start; resume/JD chunks are looked up main-process-side from whatever rag.ts has stored, not re-sent from here. */
  setup: InterviewSetup
  /** Phase 6 drill: topic labels chosen on the History page (empty = a normal interview). Sent along with `setup` on Start; main re-validates and bounds them before they reach the prompt. */
  focusTopics: string[]
  onClearFocus: () => void
}

function Interview({ setup, focusTopics, onClearFocus }: InterviewProps): JSX.Element {
  const [captureState, setCaptureState] = useState<CaptureState>('idle')
  const [liveState, setLiveState] = useState<LiveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [workletActive, setWorkletActive] = useState<boolean | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[]>([])
  const [provisionalCaption, setProvisionalCaption] = useState<ProvisionalCaption | null>(null)
  /**
   * Per-answer reviews, keyed by `answerIndex` (see GeminiLiveAnswerReviewEvent's
   * doc comment) rather than arrival order -- kept sorted ascending by
   * answerIndex on every update so a fast second answer's review landing
   * before a slower first answer's still renders in question order.
   * This list is the live view; the same reviews are also saved to history main-process-side (electron/services/history.ts).
   */
  const [reviews, setReviews] = useState<GeminiLiveAnswerReviewEvent[]>([])
  /** Focus topics of the drill session currently running. `focusTopics` (App state) is ONE-SHOT: cleared once a drill has started, so a later normal interview isn't silently a drill. */
  const [activeDrill, setActiveDrill] = useState<string[]>([])

  const pipelineRef = useRef<AudioPipelineHandle | null>(null)
  const streamsRef = useRef<CaptureStreams | null>(null)
  const playerRef = useRef<AudioPlayerHandle | null>(null)
  const mountedRef = useRef(true)
  const nextTurnIdRef = useRef(0)
  // Mirrors `liveState === 'open'`, readable synchronously from the mic-chunk
  // callback (a plain state value would be stale there -- that callback is
  // registered once per pipeline and doesn't re-run on every state change).
  const liveOpenRef = useRef(false)
  // Bumped on every start/stop; an in-flight start whose id no longer
  // matches when it resolves (component unmounted, or Stop/Start was clicked
  // again while it was still coming up) tears itself down instead of
  // publishing stale streams/pipeline into refs and state.
  const startIdRef = useRef(0)
  // Counts Starts so the usage meter can clear the previous session's numbers immediately.
  const [startCount, setStartCount] = useState(0)

  // Tears down everything: Web Audio graph/context, capture tracks, the
  // playback context, and the Gemini Live session. Safe to call whether or
  // not any of it is actually running.
  const teardown = (): void => {
    pipelineRef.current?.dispose()
    pipelineRef.current = null
    stopCapture()
    streamsRef.current = null
    playerRef.current?.dispose()
    playerRef.current = null
    liveOpenRef.current = false
    setProvisionalCaption(null)
    void window.api.stopLiveSession()
  }

  const handleTranscript = (event: GeminiLiveTranscriptEvent): void => {
    if (!mountedRef.current) return
    setProvisionalCaption(null)
    let delta = event.textDelta
    if (event.speaker === 'assistant') {
      delta = delta
        .replace(/\*\*(?:Awaiting Prompt Clarity|Awaiting User Input|Acknowledge Audio Clarity|Maintaining Silence)[^*]*\*\*/gi, '')
        .replace(/I'm designed to be a silent observer until prompted\.[^.\n]*\.?/gi, '')
        .replace(/I'm currently maintaining silence[^.\n]*\.?/gi, '')
    }
    setTranscriptTurns((turns) => {
      const last = turns[turns.length - 1]
      if (last && last.speaker === event.speaker && !last.finished) {
        const updated = turns.slice(0, -1)
        updated.push({ ...last, text: last.text + delta, finished: event.finished })
        return updated
      }
      const turn: TranscriptTurn = {
        id: nextTurnIdRef.current++,
        speaker: event.speaker,
        text: delta,
        finished: event.finished
      }
      return [...turns, turn]
    })
  }

  const handleAudioChunk = (_event: GeminiLiveAudioChunkEvent): void => {
    // Silent on speakers: the AI responses are rendered as text on screen
  }

  const handleInterrupted = (): void => {
    setProvisionalCaption(null)
    playerRef.current?.clear()
  }

  const handleTurnFinished = (event: GeminiLiveTurnFinishedEvent): void => {
    if (!mountedRef.current) return
    setProvisionalCaption(null)
    // Authoritative override -- see GeminiLiveTurnFinishedEvent's doc comment.
    setTranscriptTurns((turns) => {
      const lastIdx = turns.map((t) => t.speaker).lastIndexOf(event.speaker)
      if (lastIdx === -1) return turns
      const updated = [...turns]
      updated[lastIdx] = { ...updated[lastIdx], turnId: event.turnId, finished: true }
      return updated
    })
  }

  const handleTranslation = (event: GeminiLiveTranslationEvent): void => {
    if (!mountedRef.current) return
    setTranscriptTurns((turns) => {
      const idx = turns.findIndex((t) => t.turnId === event.turnId)
      if (idx === -1) return turns
      const updated = [...turns]
      updated[idx] = { ...updated[idx], text: event.translatedText }
      return updated
    })
  }

  const handleAnswerReview = (event: GeminiLiveAnswerReviewEvent): void => {
    if (!mountedRef.current) return
    setReviews((prev) => {
      const withoutDuplicate = prev.filter((r) => r.answerIndex !== event.answerIndex)
      return [...withoutDuplicate, event].sort((a, b) => a.answerIndex - b.answerIndex)
    })
  }

  const handleConnectionState = (event: GeminiLiveConnectionStateEvent): void => {
    if (!mountedRef.current) return
    liveOpenRef.current = event.state === 'open'
    setLiveState(event.state)
    if (event.state === 'closed') {
      if (pipelineRef.current !== null || streamsRef.current !== null) {
        pipelineRef.current?.dispose()
        pipelineRef.current = null
        stopCapture()
        streamsRef.current = null
        playerRef.current?.dispose()
        playerRef.current = null
        setCaptureState('idle')
        setWorkletActive(null)
      }
    }
    if (event.state === 'error') {
      setError(event.message ?? 'The interview session hit an error and could not continue.')
    }
  }

  // No leaked tracks/contexts/sessions/listeners if the user navigates away
  // mid-interview -- including mid-*start*, before the async chain below has
  // finished.
  useEffect(() => {
    mountedRef.current = true

    const unsubscribeTranscript = window.api.onLiveTranscript(handleTranscript)
    const unsubscribeInterim = window.api.onLiveInterimTranscript((event) => {
      if (!mountedRef.current) return
      if (event.text.trim().length > 0) {
        setProvisionalCaption({ speaker: event.speaker, text: event.text })
      } else {
        setProvisionalCaption(null)
      }
    })
    const unsubscribeAudio = window.api.onLiveAudioChunk(handleAudioChunk)
    const unsubscribeState = window.api.onLiveConnectionState(handleConnectionState)
    const unsubscribeInterrupted = window.api.onLiveInterrupted(handleInterrupted)
    const unsubscribeTurnFinished = window.api.onLiveTurnFinished(handleTurnFinished)
    const unsubscribeTranslation = window.api.onLiveTranslation(handleTranslation)
    const unsubscribeAnswerReview = window.api.onLiveAnswerReview(handleAnswerReview)
    const unsubscribePanic = window.api.onPanic(() => {
      teardown()
    })

    window.api
      .hasApiKey()
      .then((stored) => {
        if (mountedRef.current) setHasApiKey(stored)
      })
      .catch(() => {
        // Best-effort; Start will still surface "no API key" if it's actually missing.
      })

    return () => {
      mountedRef.current = false
      startIdRef.current++
      teardown()
      unsubscribeTranscript()
      unsubscribeInterim()
      unsubscribeAudio()
      unsubscribeState()
      unsubscribeInterrupted()
      unsubscribeTurnFinished()
      unsubscribeTranslation()
      unsubscribeAnswerReview()
      unsubscribePanic()
    }
  }, [])

  const handleStreamEnded = (source: CaptureSource): void => {
    if (!mountedRef.current) return
    startIdRef.current++
    teardown()
    setCaptureState('idle')
    setLiveState('idle')
    setWorkletActive(null)
    setError(
      source === 'mic'
        ? 'Microphone was disconnected or access was revoked. Start the interview again.'
        : 'System audio sharing was stopped. Start the interview again.'
    )
  }

  const handleStart = (): void => {
    if (captureState !== 'idle') return
    if (hasApiKey === false) {
      setError('No API key saved yet. Add one on the Settings page, then start the interview.')
      return
    }

    const id = ++startIdRef.current
    setStartCount((n) => n + 1)
    setCaptureState('starting')
    setLiveState('connecting')
    setError(null)
    setWorkletActive(null)
    setTranscriptTurns([])
    setProvisionalCaption(null)
    setReviews([])
    nextTurnIdRef.current = 0
    liveOpenRef.current = false

    void (async () => {
      // Concurrently start audio capture and the Gemini Live session connection
      const capturePromise = startCapture(handleStreamEnded)
      const livePromise = window.api.startLiveSession(setup, focusTopics)

      // Initialize audio pipeline as soon as capture streams are acquired,
      // concurrently with the network live session connection establishment
      const pipelinePromise = capturePromise.then(async (captureResult) => {
        if (!captureResult.ok) {
          return { ok: false as const, error: captureResult.error }
        }
        if (!mountedRef.current || id !== startIdRef.current) {
          stopCapture()
          return { ok: false as const, error: new Error('Cancelled.') }
        }

        streamsRef.current = captureResult.streams

        try {
          const player = createAudioPlayer()
          const pipeline = await createAudioPipeline(captureResult.streams, {
            onSystemChunk: (chunk, capturedAtMs) => {
              if (liveOpenRef.current) {
                window.api.streamMicChunk(chunk, capturedAtMs)
              }
            }
          })
          return { ok: true as const, pipeline, player }
        } catch (err) {
          stopCapture()
          streamsRef.current = null
          return { ok: false as const, error: err instanceof Error ? err : new Error(String(err)) }
        }
      })

      const [pipelineResult, liveResult] = await Promise.all([pipelinePromise, livePromise])

      if (!mountedRef.current || id !== startIdRef.current) {
        if (pipelineResult.ok) {
          pipelineResult.pipeline.dispose()
          pipelineResult.player.dispose()
        }
        stopCapture()
        streamsRef.current = null
        if (liveResult.ok) void window.api.stopLiveSession()
        return
      }

      if (!pipelineResult.ok) {
        setError(pipelineResult.error.message)
        setCaptureState('idle')
        setLiveState('idle')
        if (liveResult.ok) void window.api.stopLiveSession()
        return
      }

      if (!liveResult.ok) {
        pipelineResult.pipeline.dispose()
        pipelineResult.player.dispose()
        stopCapture()
        streamsRef.current = null
        setError(liveResult.error ?? 'Failed to start the interview session.')
        setCaptureState('idle')
        setLiveState('idle')
        return
      }

      // The drill has started: consume the one-shot focus (App state) and remember it for display.
      setActiveDrill(focusTopics)
      if (focusTopics.length > 0) onClearFocus()

      playerRef.current = pipelineResult.player
      pipelineRef.current = pipelineResult.pipeline
      setWorkletActive(pipelineResult.pipeline.isWorkletActive())
      setCaptureState('running')
    })().catch((err: unknown) => {
      // Safety net: everything above already catches its own failures, but
      // an unanticipated throw here must not become a silently stuck
      // "Starting…" UI with capture/session left dangling.
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to start the interview.')
      teardown()
      setCaptureState('idle')
      setLiveState('idle')
    })
  }

  const handleStop = (): void => {
    if (captureState === 'idle') return
    startIdRef.current++ // invalidates an in-flight start, if Stop was hit during "starting"
    teardown()
    setCaptureState('idle')
    setLiveState('idle')
    setWorkletActive(null)
  }

  const isRunning = captureState === 'running'
  const isStarting = captureState === 'starting'

  const usageSnapshot = useUsage(captureState !== 'idle', 2000, startCount, true)

  // Ctrl+Shift+Space (window-scoped, see useWindowShortcut): goes through the
  // exact handlers the buttons use, so startIdRef's generation token and the
  // `captureState !== 'idle'` guards apply unchanged. While a Start is still
  // in flight ('starting') it is a deliberate no-op -- an accidental double
  // press must neither double-start nor cancel a connect; the Stop button
  // remains available for that.
  useWindowShortcut({ code: 'Space' }, () => {
    if (captureState === 'idle') handleStart()
    else if (captureState === 'running') handleStop()
  })

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Interview</CardTitle>
          <CardDescription>
            A realistic spoken interview over the Gemini Live API: your microphone streams to the interviewer, its
            spoken responses play back here, and the transcript builds live below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            {INTERVIEW_ROLE_LABELS[setup.role]} · {setup.difficulty} · {setup.company.trim().length > 0 ? setup.company : 'unspecified company'} ·{' '}
            {setup.durationMinutes} min -- change these on the Setup page.
          </p>

          {focusTopics.length > 0 && (
            <StatusBanner tone="info">
              <span className="flex flex-wrap items-center gap-2">
                Drill session: the next interview will focus on {focusTopics.join(', ')} (one time only).
                <Button type="button" variant="outline" size="sm" onClick={onClearFocus} disabled={captureState !== 'idle'}>
                  Clear focus
                </Button>
              </span>
            </StatusBanner>
          )}

          {focusTopics.length === 0 && activeDrill.length > 0 && captureState !== 'idle' && (
            <StatusBanner tone="info">Drill session in progress: the interviewer is focusing on {activeDrill.join(', ')}.</StatusBanner>
          )}

          <p className="text-xs text-muted-foreground">
            Transcripts and feedback from this interview are saved locally on this machine (see the History page, where you can delete them).
          </p>

          {hasApiKey === false && (
            <StatusBanner tone="error">
              No Gemini API key is saved yet. Add one on the Settings page before starting an interview.
            </StatusBanner>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={handleStart}
              disabled={captureState !== 'idle' || hasApiKey === false}
              title={`Start (${SHORTCUT_TOGGLE_SESSION_LABEL})`}
            >
              {isStarting ? 'Starting…' : 'Start interview'}
            </Button>
            <Button type="button" variant="outline" onClick={handleStop} disabled={captureState === 'idle' && liveState !== 'open'} title={`Stop (${SHORTCUT_TOGGLE_SESSION_LABEL})`}>
              Stop interview
            </Button>
            {(isRunning || liveState === 'open') && <LiveStateBadge state={liveState} />}
          </div>

          {liveState === 'open' && captureState === 'idle' && (
            <StatusBanner tone="info">
              Live session is active via the Floating Overlay Widget. AI text responses are streaming in real-time.
            </StatusBanner>
          )}

          <p className="text-xs text-muted-foreground">Shortcut: {SHORTCUT_TOGGLE_SESSION_LABEL} starts/stops the interview while this window is focused.</p>

          <UsageMeter snapshot={usageSnapshot} categories={['live', 'reviews', 'embeddings']} title="This session" finalLabel />

          {error && <StatusBanner tone="error">{error}</StatusBanner>}

          {isStarting && (
            <p className="text-sm text-muted-foreground">
              Waiting for the microphone/system-audio permission prompts and the interviewer to connect…
            </p>
          )}

          {isRunning && liveState === 'reconnecting' && (
            <StatusBanner tone="info">Connection dropped -- reconnecting…</StatusBanner>
          )}

          <div className="flex flex-col gap-4">
            <LevelMeter
              label="System audio"
              active={isRunning}
              getLevel={() => pipelineRef.current?.getSystemLevel() ?? 0}
            />
            <LevelMeter label="Microphone" active={isRunning} getLevel={() => pipelineRef.current?.getMicLevel() ?? 0} />
          </div>

          {isRunning && workletActive === false && (
            <StatusBanner tone="error">
              The PCM worklet failed to load. Level meters still work, but no audio is being sent to the
              interviewer. Check the console for the underlying error.
            </StatusBanner>
          )}

          {isRunning && liveState === 'open' && <AudioHealthBanner pipelineRef={pipelineRef} />}

          {isRunning && workletActive === true && <ChunkCounter pipelineRef={pipelineRef} />}

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-sm font-medium">Transcript</span>
            <Transcript turns={transcriptTurns} provisionalCaption={provisionalCaption} />
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-sm font-medium">Feedback</span>
            <FeedbackCard reviews={reviews} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function LiveStateBadge({ state }: { state: LiveState }): JSX.Element {
  const label: Record<LiveState, string> = {
    idle: 'Not connected',
    connecting: 'Connecting…',
    open: 'Connected',
    reconnecting: 'Reconnecting…',
    closed: 'Closed',
    error: 'Error'
  }
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-medium',
        state === 'open' && 'bg-success/10 text-success',
        (state === 'connecting' || state === 'reconnecting') && 'bg-secondary text-secondary-foreground',
        (state === 'closed' || state === 'idle') && 'bg-secondary/60 text-muted-foreground',
        state === 'error' && 'bg-destructive/10 text-destructive'
      )}
    >
      {label[state]}
    </span>
  )
}

interface ChunkCounterProps {
  pipelineRef: RefObject<AudioPipelineHandle | null>
}

/**
 * Small live readout proving the worklet chain is actually producing PCM
 * chunks, not just that it loaded (isWorkletActive() only confirms
 * `addModule` succeeded). Polled on an interval rather than
 * requestAnimationFrame -- this is a status number, not an animation, and
 * doesn't need 60fps.
 */
function ChunkCounter({ pipelineRef }: ChunkCounterProps): JSX.Element {
  const textRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const id = window.setInterval(() => {
      const pipeline = pipelineRef.current
      if (!pipeline || !textRef.current) return
      textRef.current.textContent = `PCM chunks — mic: ${pipeline.micChunkCount()}, system: ${pipeline.systemChunkCount()}`
    }, 500)
    return () => window.clearInterval(id)
  }, [pipelineRef])

  return <p ref={textRef} className="text-xs text-muted-foreground" />
}

/**
 * Phase 7 correctness: while the live session is OPEN, poll the system-audio
 * frame health and warn if chunks have stopped arriving -- so the UI never
 * shows a healthy "Connected/Listening" state when audio is not actually
 * reaching the interviewer model. Stale = no chunk for >1s (the worklet
 * produces one every ~100ms; 1s is 10x the cadence, well clear of jitter).
 * Polled, not per-frame -- this is a status check, not an animation.
 */
function AudioHealthBanner({ pipelineRef }: ChunkCounterProps): JSX.Element | null {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const id = window.setInterval(() => {
      const health = pipelineRef.current?.getSystemAudioHealth()
      if (!health) return
      setStale(health.msSinceLastChunk !== null && health.msSinceLastChunk > 1000)
    }, 500)
    return () => window.clearInterval(id)
  }, [pipelineRef])

  if (!stale) return null
  return (
    <StatusBanner tone="error">
      Audio unavailable — system-audio frames have stopped reaching the interviewer. Check that system-audio sharing is
      still active; the transcript will not update until it resumes.
    </StatusBanner>
  )
}

interface StatusBannerProps {
  tone: 'success' | 'error' | 'info'
  children: ReactNode
}

function StatusBanner({ tone, children }: StatusBannerProps): JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'success' && 'border-success/30 bg-success/10 text-success',
        tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
        tone === 'info' && 'border-border bg-secondary/40 text-muted-foreground'
      )}
    >
      {children}
    </div>
  )
}

export default Interview
