import { useEffect, useRef, useState } from 'react'
import type {
  GeminiLiveAnswerReviewEvent,
  GeminiLiveConnectionStateEvent,
  GeminiLiveTranscriptEvent,
  HintsResult,
  StealthState
} from '../../electron/ipc-types'
import {
  GHOST_CLICKTHROUGH_HOTKEY_LABEL,
  GHOST_OVERLAY_HOTKEY_LABEL,
  GHOST_PANIC_HOTKEY_LABEL
} from '../../electron/ipc-types'
import { cn } from '@/lib/utils'

interface TranscriptItem {
  id: number
  speaker: 'user' | 'interviewer'
  text: string
  finished: boolean
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

  // Quick Hints / Cheat tab state
  const [quickPrompt, setQuickPrompt] = useState('')
  const [hintsLoading, setHintsLoading] = useState(false)
  const [hintsResult, setHintsResult] = useState<HintsResult | null>(null)
  const [hintsLevel, setHintsLevel] = useState<number>(0)

  // Quick notepad state
  const [notes, setNotes] = useState('• Maintain calm posture & eye contact\n• Clarify constraints: input size, edge cases\n• Think aloud: state brute-force then optimize')

  const nextIdRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

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
      setTranscripts((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.speaker === event.speaker && !last.finished) {
          const updated = prev.slice(0, -1)
          updated.push({ ...last, text: last.text + event.textDelta, finished: event.finished })
          return updated
        }
        return [
          ...prev,
          {
            id: ++nextIdRef.current,
            speaker: event.speaker,
            text: event.textDelta,
            finished: event.finished
          }
        ]
      })
    })

    const unsubscribeConn = window.api.onLiveConnectionState((event: GeminiLiveConnectionStateEvent) => {
      setConnState(event.state)
    })

    const unsubscribeReview = window.api.onLiveAnswerReview((event: GeminiLiveAnswerReviewEvent) => {
      setLatestReview(event)
    })

    const unsubscribePanic = window.api.onPanic(() => {
      setTranscripts([])
      setHintsResult(null)
    })

    return () => {
      unsubscribeStealth()
      unsubscribeTranscript()
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
  }, [transcripts, latestReview])

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
      className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/85 text-slate-100 shadow-2xl backdrop-blur-xl transition-opacity duration-150 select-none"
    >
      {/* Draggable Titlebar */}
      <header
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        className="flex cursor-default items-center justify-between border-b border-slate-800/80 bg-slate-900/70 px-3 py-1.5 text-xs select-none"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-400 text-[11px] tracking-wide">Assistant</span>
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

      {/* Click-through alert banner */}
      {stealthState.ghostClickThrough && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-3 py-1 text-[11px] text-amber-300 flex items-center justify-between">
          <span>Click-through ON: Clicks pass to windows behind. Press <b>{GHOST_CLICKTHROUGH_HOTKEY_LABEL}</b> to restore clicks.</span>
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
      <nav className="flex items-center justify-between border-b border-slate-800/60 bg-slate-900/40 px-3 py-1 text-xs">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('live')}
            className={cn(
              'px-2 py-0.5 font-medium transition-colors rounded text-xs',
              activeTab === 'live' ? 'bg-cyan-500/20 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Live Assist
            {connState === 'open' && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('hints')}
            className={cn(
              'px-2 py-0.5 font-medium transition-colors rounded text-xs',
              activeTab === 'hints' ? 'bg-cyan-500/20 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Quick Hints
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notes')}
            className={cn(
              'px-2 py-0.5 font-medium transition-colors rounded text-xs',
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
              <div className="flex flex-col items-center justify-center py-6 text-center text-slate-400">
                <span className="text-2xl mb-1">🎧</span>
                <p className="font-medium text-slate-300">Live AI Assistant Ready</p>
                <p className="text-[11px] text-slate-500 mt-1 max-w-xs">
                  {connState === 'open'
                    ? 'Session is live! Interviewer & candidate speech will appear here.'
                    : 'Start an interview in MockPilot to stream real-time transcripts & answers.'}
                </p>
              </div>
            )}

            {transcripts.map((t) => (
              <div
                key={t.id}
                className={cn(
                  'rounded-lg p-2.5 text-xs',
                  t.speaker === 'interviewer'
                    ? 'border border-cyan-800/50 bg-cyan-950/40 text-cyan-100'
                    : 'border border-slate-800 bg-slate-900/60 text-slate-200'
                )}
              >
                <div className="flex items-center justify-between font-semibold text-[10px] uppercase tracking-wider mb-1 opacity-80">
                  <span className={t.speaker === 'interviewer' ? 'text-cyan-400' : 'text-slate-400'}>
                    {t.speaker === 'interviewer' ? 'Interviewer' : 'You'}
                  </span>
                  {!t.finished && <span className="text-[9px] text-amber-400 animate-pulse">speaking…</span>}
                </div>
                <div className="whitespace-pre-wrap">{t.text}</div>
              </div>
            ))}

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
