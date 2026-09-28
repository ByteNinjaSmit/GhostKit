import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_INTERVIEW_SETUP,
  GHOST_CLICKTHROUGH_HOTKEY_LABEL,
  GHOST_OVERLAY_HOTKEY_LABEL,
  GHOST_PANIC_HOTKEY_LABEL,
  type GeminiLiveAnswerReviewEvent,
  type GeminiLiveConnectionStateEvent,
  type GeminiLiveSpeaker,
  type GeminiLiveTranscriptEvent,
  type GeminiLiveTranslationEvent,
  type GeminiLiveTurnFinishedEvent,
  type HintsResult,
  type StealthState
} from '../../electron/ipc-types'
import { startCapture, stopCapture, type CaptureStreams } from '@/audio/capture'
import { createAudioPipeline, type AudioPipelineHandle } from '@/audio/pipeline'
import { cn } from '@/lib/utils'

interface TranscriptItem {
  id: number
  speaker: GeminiLiveSpeaker
  text: string
  finished: boolean
  /** Set once an 'interviewer' item's history row exists (see onLiveInterviewerTurn) -- lets a later onLiveTranslation event find and replace this item's text. */
  turnId?: number
}

export default function GhostOverlay(): JSX.Element {
  const [stealthState, setStealthState] = useState<StealthState>({
    contentProtected: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    ghostOverlayActive: true,
    ghostClickThrough: false,
    ghostOpacity: 0.95
  })

  const [activeTab, setActiveTab] = useState<'live' | 'hints' | 'notes'>('live')
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([])
  const [connState, setConnState] = useState<GeminiLiveConnectionStateEvent['state']>('closed')
  const [latestReview, setLatestReview] = useState<GeminiLiveAnswerReviewEvent | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [provisionalCaption, setProvisionalCaption] = useState<string | null>(null)

  // Quick Hints / Cheat tab state
  const [quickPrompt, setQuickPrompt] = useState('')
  const [hintsLoading, setHintsLoading] = useState(false)
  const [hintsResult, setHintsResult] = useState<HintsResult | null>(null)
  const [hintsLevel, setHintsLevel] = useState<number>(0)

  // Quick notepad state
  const [notes, setNotes] = useState('• Maintain calm posture & eye contact\n• Clarify constraints: input size, edge cases\n• Think aloud: state brute-force then optimize')

  const nextIdRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pipelineRef = useRef<AudioPipelineHandle | null>(null)
  const streamsRef = useRef<CaptureStreams | null>(null)

  const teardown = (): void => {
    pipelineRef.current?.dispose()
    pipelineRef.current = null
    stopCapture()
    streamsRef.current = null
    setProvisionalCaption(null)
  }

  // Set html/body background to transparent for the overlay window
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'

    window.api
      .getStealthState()
      .then((state) => setStealthState(state))
      .catch(() => undefined)

    const unsubscribeStealth = window.api.onStealthStateChanged((state) => {
      setStealthState(state)
    })

    const unsubscribeTranscript = window.api.onLiveTranscript((event: GeminiLiveTranscriptEvent) => {
      setProvisionalCaption(null)
      let delta = event.textDelta
      if (event.speaker === 'assistant') {
        delta = delta
          .replace(/\*\*(?:Awaiting Prompt Clarity|Awaiting User Input|Acknowledge Audio Clarity|Maintaining Silence)[^*]*\*\*/gi, '')
          .replace(/I'm designed to be a silent observer until prompted\.[^.\n]*\.?/gi, '')
          .replace(/I'm currently maintaining silence[^.\n]*\.?/gi, '')
      }
      setTranscripts((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.speaker === event.speaker && !last.finished) {
          const updated = prev.slice(0, -1)
          updated.push({ ...last, text: last.text + delta, finished: event.finished })
          return updated
        }
        return [
          ...prev,
          {
            id: ++nextIdRef.current,
            speaker: event.speaker,
            text: delta,
            finished: event.finished
          }
        ]
      })
    })

    const unsubscribeInterim = window.api.onLiveInterimTranscript((event) => {
      if (event.text.trim().length > 0) {
        setProvisionalCaption(event.text)
      } else {
        setProvisionalCaption(null)
      }
    })

    const unsubscribeTurnFinished = window.api.onLiveTurnFinished((event: GeminiLiveTurnFinishedEvent) => {
      setProvisionalCaption(null)
      // Authoritative override: force the last item for this speaker to
      // `finished: true` regardless of what its own fragments last reported
      // (see GeminiLiveTurnFinishedEvent's doc comment -- Gemini's per-fragment
      // `finished` flag is unreliable and otherwise leaves bubbles stuck on
      // "listening…"/"generating…" indefinitely). Also tags `turnId` so a
      // later translation event for an 'interviewer' turn can find it.
      setTranscripts((prev) => {
        const lastIdx = prev.map((t) => t.speaker).lastIndexOf(event.speaker)
        if (lastIdx === -1) return prev
        const updated = [...prev]
        updated[lastIdx] = { ...updated[lastIdx], turnId: event.turnId, finished: true }
        return updated
      })
    })

    const unsubscribeTranslation = window.api.onLiveTranslation((event: GeminiLiveTranslationEvent) => {
      setTranscripts((prev) => {
        const idx = prev.findIndex((t) => t.turnId === event.turnId)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], text: event.translatedText }
        return updated
      })
    })

    const unsubscribeConn = window.api.onLiveConnectionState((event: GeminiLiveConnectionStateEvent) => {
      setConnState(event.state)
      if (event.state === 'closed') {
        teardown()
        setIsStarting(false)
      }
      if (event.state === 'error') {
        setSessionError(event.message ?? 'Live session encountered an error.')
        teardown()
        setIsStarting(false)
      }
    })

    const unsubscribeReview = window.api.onLiveAnswerReview((event: GeminiLiveAnswerReviewEvent) => {
      setLatestReview(event)
    })

    const unsubscribePanic = window.api.onPanic(() => {
      teardown()
      setTranscripts([])
      setProvisionalCaption(null)
      setHintsResult(null)
      setIsStarting(false)
    })

    return () => {
      teardown()
      unsubscribeStealth()
      unsubscribeTranscript()
      unsubscribeInterim()
      unsubscribeTurnFinished()
      unsubscribeTranslation()
      unsubscribeConn()
      unsubscribeReview()
      unsubscribePanic()
    }
  }, [])

  // Auto-scroll transcripts
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [transcripts, latestReview, provisionalCaption])

  const handleToggleClickThrough = async (): Promise<void> => {
    const nextVal = !stealthState.ghostClickThrough
    await window.api.setGhostClickThrough(nextVal)
  }

  const handleSetOpacity = async (val: number): Promise<void> => {
    await window.api.setGhostOpacity(val)
  }

  const handleClose = async (): Promise<void> => {
    await window.api.toggleGhostOverlay()
  }

  const handleToggleInterview = async (): Promise<void> => {
    if (connState === 'open') {
      teardown()
      await window.api.stopLiveSession()
      return
    }

    if (isStarting) return

    setSessionError(null)
    setIsStarting(true)

    try {
      const hasKey = await window.api.hasApiKey()
      if (!hasKey) {
        setSessionError('No API key saved yet. Please add one in Settings.')
        setIsStarting(false)
        return
      }

      setProvisionalCaption(null)

      // Start capture and live session connection in parallel
      const capturePromise = startCapture(() => {
        teardown()
        void window.api.stopLiveSession()
      })
      const livePromise = window.api.startLiveSession(DEFAULT_INTERVIEW_SETUP)

      // Initialize audio pipeline as soon as capture streams are acquired
      const pipelinePromise = capturePromise.then(async (captureResult) => {
        if (!captureResult.ok) {
          return { ok: false as const, error: captureResult.error }
        }
        streamsRef.current = captureResult.streams
        const pipeline = await createAudioPipeline(captureResult.streams, {
          onSystemChunk: (chunk, capturedAtMs) => {
            window.api.streamMicChunk(chunk, capturedAtMs)
          }
        })
        return { ok: true as const, pipeline }
      })

      const [pipelineResult, liveResult] = await Promise.all([pipelinePromise, livePromise])

      if (!pipelineResult.ok) {
        setSessionError(pipelineResult.error.message)
        if (liveResult.ok) void window.api.stopLiveSession()
        return
      }

      if (!liveResult.ok) {
        pipelineResult.pipeline.dispose()
        stopCapture()
        streamsRef.current = null
        setSessionError(liveResult.error ?? 'Failed to connect live AI session.')
        return
      }

      pipelineRef.current = pipelineResult.pipeline
    } catch (err) {
      teardown()
      setSessionError(err instanceof Error ? err.message : 'Could not start interview.')
    } finally {
      setIsStarting(false)
    }
  }

  const handleCopyText = (id: number, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  const handleAskQuickHints = async (): Promise<void> => {
    if (!quickPrompt.trim() || hintsLoading) return
    setHintsLoading(true)
    setHintsResult(null)
    setHintsLevel(0)
    try {
      const res = await window.api.getHints(quickPrompt.trim())
      setHintsResult(res)
    } catch {
      setHintsResult({ ok: false, error: 'Could not generate hints.' })
    } finally {
      setHintsLoading(false)
    }
  }

  return (
    <div
      id="ghost-overlay-root"
      style={{ opacity: stealthState.ghostOpacity }}
      className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/90 text-slate-100 shadow-2xl backdrop-blur-xl transition-opacity duration-150 select-none"
    >
      {/* Draggable Titlebar */}
      <header
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        className="flex cursor-default items-center justify-between border-b border-slate-800/80 bg-slate-900/80 px-3 py-1.5 text-xs select-none"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-cyan-400 text-xs tracking-wider">GHOSTKIT</span>
            {connState === 'open' && (
              <span className="flex items-center gap-1 rounded bg-cyan-950/80 px-1.5 py-0.5 text-[9px] font-medium text-cyan-300 border border-cyan-700/50">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
                SYSTEM AUDIO
              </span>
            )}
          </div>

          {/* Start / Stop Interview Button in Header */}
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button
              type="button"
              onClick={handleToggleInterview}
              disabled={isStarting}
              title={connState === 'open' ? 'Stop live interview' : 'Start live system-audio interview'}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-all shadow-md',
                connState === 'open'
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/60 animate-pulse'
                  : isStarting
                  ? 'bg-amber-600/80 text-white cursor-wait'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/60'
              )}
            >
              {connState === 'open' ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-white" />
                  <span>⏹ Stop Interview</span>
                </>
              ) : isStarting ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-amber-200 animate-spin" />
                  <span>⏳ Starting…</span>
                </>
              ) : (
                <>
                  <span>▶</span>
                  <span>Start Interview</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Action Controls (No-Drag) */}
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} className="flex items-center gap-1.5">
          {/* Opacity presets */}
          <div className="flex items-center gap-0.5 rounded bg-slate-800/60 p-0.5 text-[10px]">
            {[0.4, 0.7, 0.95].map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => handleSetOpacity(op)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors',
                  Math.abs(stealthState.ghostOpacity - op) < 0.05
                    ? 'bg-cyan-500/30 text-cyan-200'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {Math.round(op * 100)}%
              </button>
            ))}
          </div>

          {/* Click-through toggle */}
          <button
            type="button"
            onClick={handleToggleClickThrough}
            title={`Toggle Click-Through (${GHOST_CLICKTHROUGH_HOTKEY_LABEL}). Passes clicks directly to Zoom/VSCode.`}
            className={cn(
              'rounded px-2 py-0.5 text-[10px] font-medium transition-colors border',
              stealthState.ghostClickThrough
                ? 'bg-amber-950/80 text-amber-300 border-amber-500/50'
                : 'bg-slate-800/60 text-slate-300 border-slate-700/60 hover:bg-slate-700/60'
            )}
          >
            {stealthState.ghostClickThrough ? '🖱️ Pass-Through' : '🖱️ Clickable'}
          </button>

          {/* Close button */}
          <button
            type="button"
            onClick={handleClose}
            title={`Close (${GHOST_OVERLAY_HOTKEY_LABEL}) • Panic (${GHOST_PANIC_HOTKEY_LABEL})`}
            className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-rose-950/60 hover:text-rose-300"
          >
            ✕
          </button>
        </div>
      </header>

      {/* Error alert banner */}
      {sessionError && (
        <div className="bg-rose-950/90 border-b border-rose-800 px-3 py-1.5 text-[11px] text-rose-200 flex items-center justify-between">
          <span>⚠️ {sessionError}</span>
          <button
            type="button"
            onClick={() => setSessionError(null)}
            className="text-rose-400 hover:text-rose-100 font-bold ml-2 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Click-through alert banner */}
      {stealthState.ghostClickThrough && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-3 py-1 text-[11px] text-amber-300 flex items-center justify-between">
          <span>Click-through ON: Clicks pass through. Press <b>{GHOST_CLICKTHROUGH_HOTKEY_LABEL}</b> to restore clicks.</span>
          <button
            type="button"
            onClick={handleToggleClickThrough}
            className="underline hover:text-amber-100 text-[10px]"
          >
            Turn off
          </button>
        </div>
      )}

      {/* Navigation tabs */}
      <nav className="flex items-center justify-between border-b border-slate-800/60 bg-slate-900/50 px-3 py-1 text-xs">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('live')}
            className={cn(
              'px-2.5 py-1 font-medium transition-colors rounded text-xs flex items-center gap-1.5',
              activeTab === 'live' ? 'bg-cyan-500/20 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Live Assist
            {connState === 'open' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('hints')}
            className={cn(
              'px-2.5 py-1 font-medium transition-colors rounded text-xs',
              activeTab === 'hints' ? 'bg-cyan-500/20 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Quick Hints
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notes')}
            className={cn(
              'px-2.5 py-1 font-medium transition-colors rounded text-xs',
              activeTab === 'notes' ? 'bg-cyan-500/20 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Notes
          </button>
        </div>

        <div className="text-[10px] text-slate-400">
          Toggle: <span className="font-mono text-cyan-400">{GHOST_OVERLAY_HOTKEY_LABEL}</span>
        </div>
      </nav>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-3 text-xs leading-relaxed" ref={scrollRef}>
        {activeTab === 'live' && (
          <div className="flex flex-col gap-2.5">
            {transcripts.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center text-slate-400">
                <span className="text-3xl mb-2">🎧</span>
                <p className="font-semibold text-slate-200 text-sm">GhostKit AI Live Copilot</p>
                <p className="text-[11px] text-slate-400 mt-1 max-w-xs leading-normal">
                  {connState === 'open'
                    ? 'Listening to live system audio conversation! Live transcription & on-screen text answers will stream here.'
                    : 'Click "Start Interview" above to capture live system audio and receive instant on-screen solutions.'}
                </p>
                {connState !== 'open' && (
                  <button
                    type="button"
                    onClick={handleToggleInterview}
                    disabled={isStarting}
                    className="mt-3 rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-500"
                  >
                    ▶ Start Interview Assist
                  </button>
                )}
              </div>
            )}

            {transcripts.map((t) => {
              const isInterviewer = t.speaker === 'interviewer'
              const isAssistant = t.speaker === 'assistant'
              return (
                <div
                  key={t.id}
                  className={cn(
                    'group relative rounded-lg p-3 text-xs transition-all shadow-md',
                    isInterviewer
                      ? 'border border-cyan-800/60 bg-cyan-950/40 text-cyan-50'
                      : isAssistant
                      ? 'border border-purple-600/60 bg-gradient-to-br from-purple-950/60 via-slate-900/80 to-slate-950/90 text-purple-100 shadow-purple-950/30'
                      : 'border border-slate-800 bg-slate-900/60 text-slate-200'
                  )}
                >
                  <div className="flex items-center justify-between font-semibold text-[10px] uppercase tracking-wider mb-1.5 opacity-90">
                    <span
                      className={cn(
                        'flex items-center gap-1.5',
                        isInterviewer ? 'text-cyan-400' : isAssistant ? 'text-purple-300 font-bold' : 'text-slate-400'
                      )}
                    >
                      {isInterviewer && <span>🎧 Interviewer (System Audio)</span>}
                      {isAssistant && <span>⚡ GhostKit AI (Response)</span>}
                      {!isInterviewer && !isAssistant && <span>Candidate</span>}
                    </span>

                    <div className="flex items-center gap-1.5">
                      {!t.finished && (
                        <span className="flex items-center gap-1 text-[9px] text-amber-400 animate-pulse">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                          {isInterviewer ? 'listening…' : 'generating…'}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCopyText(t.id, t.text)}
                        title="Copy text"
                        className="opacity-0 group-hover:opacity-100 transition-opacity rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] text-slate-300 hover:text-white"
                      >
                        {copiedId === t.id ? 'Copied ✓' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  <div className="whitespace-pre-wrap leading-relaxed font-sans text-[12px] select-text">
                    {t.text}
                  </div>
                </div>
              )
            })}

            {provisionalCaption && (
              <div className="flex flex-col gap-1 rounded-lg border border-cyan-500/50 bg-cyan-950/30 p-2.5 shadow-md">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-500"></span>
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                    🎧 Interviewer (Speaking live…)
                  </span>
                </div>
                <p className="text-xs italic leading-relaxed text-cyan-100/90">
                  {provisionalCaption}
                </p>
              </div>
            )}

            {latestReview && (latestReview.score !== undefined || latestReview.improvedAnswer) && (
              <div className="mt-2 rounded-lg border border-purple-800/60 bg-purple-950/30 p-2.5">
                <div className="text-[10px] font-bold uppercase text-purple-300 mb-1">
                  💡 Turn Feedback {latestReview.score !== undefined && `(Score: ${latestReview.score}/5)`}
                  {latestReview.topic && ` • ${latestReview.topic}`}
                </div>
                {latestReview.improvedAnswer && (
                  <div className="text-[11px] text-purple-100 whitespace-pre-wrap">
                    {latestReview.improvedAnswer}
                  </div>
                )}
                {latestReview.missingPoints && latestReview.missingPoints.length > 0 && (
                  <div className="mt-1 text-[10px] text-purple-200">
                    <span className="font-semibold text-purple-300">Missed points: </span>
                    {latestReview.missingPoints.join('; ')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'hints' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="quick-prompt" className="text-[11px] font-medium text-slate-300">
                Ask Gemini for Instant Hints / Solution Approach
              </label>
              <div className="flex gap-2">
                <input
                  id="quick-prompt"
                  type="text"
                  placeholder="e.g. Find median of two sorted arrays in O(log(min(m, n)))"
                  value={quickPrompt}
                  onChange={(e) => setQuickPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleAskQuickHints()
                  }}
                  className="flex-1 rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={hintsLoading || !quickPrompt.trim()}
                  onClick={() => void handleAskQuickHints()}
                  className="rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-cyan-500 disabled:opacity-50"
                >
                  {hintsLoading ? '…' : 'Hints'}
                </button>
              </div>
            </div>

            {hintsResult && hintsResult.ok && hintsResult.hints && (
              <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-cyan-400">
                    Hint Level {hintsLevel + 1} of {hintsResult.hints.length}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={hintsLevel <= 0}
                      onClick={() => setHintsLevel((l) => Math.max(0, l - 1))}
                      className="rounded bg-slate-800 px-2 py-0.5 text-[10px] hover:bg-slate-700 disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={hintsLevel >= (hintsResult.hints?.length ?? 1) - 1}
                      onClick={() => setHintsLevel((l) => Math.min((hintsResult.hints?.length ?? 1) - 1, l + 1))}
                      className="rounded bg-slate-800 px-2 py-0.5 text-[10px] hover:bg-slate-700 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>

                <div className="mt-1 text-slate-200 text-xs whitespace-pre-wrap leading-relaxed">
                  {hintsResult.hints[hintsLevel]}
                </div>
              </div>
            )}

            {hintsResult && !hintsResult.ok && (
              <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-2 text-rose-300 text-[11px]">
                {hintsResult.error ?? 'Failed to get hints.'}
              </div>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="flex h-full flex-col gap-2">
            <span className="text-[11px] text-slate-400 font-medium">Quick Personal Scratchpad (never uploaded):</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Paste notes, framework outlines, or questions to ask the interviewer..."
              className="h-44 w-full resize-none rounded-md border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
