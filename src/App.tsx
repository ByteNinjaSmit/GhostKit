import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import Settings from '@/pages/Settings'
import Interview from '@/pages/Interview'
import Setup from '@/pages/Setup'
import History from '@/pages/History'
import CodingRound, { INITIAL_CODING_WORK, type CodingWork } from '@/pages/CodingRound'
import { DEFAULT_INTERVIEW_SETUP } from '../electron/ipc-types'
import type { InterviewSetup } from '../electron/ipc-types'

type View = 'setup' | 'interview' | 'coding' | 'history' | 'settings'

interface ScreenshotToast {
  tone: 'info' | 'success' | 'error'
  message: string
}

function App(): JSX.Element {
  // Setup lands first (see Setup.tsx's doc comment) but is never a hard
  // gate -- DEFAULT_INTERVIEW_SETUP means Interview's Start always has a
  // usable setup even if this screen is never visited, matching
  // geminiLive.ts's "no RAG data -> fall back gracefully" behavior for the
  // resume/JD side of the same requirement.
  const [view, setView] = useState<View>('setup')
  const [setup, setSetup] = useState<InterviewSetup>(DEFAULT_INTERVIEW_SETUP)
  // Phase 6: focus topics for a drill session, set by History's "Drill weak
  // areas" and carried (lifted here, no router) to the Interview page, which
  // passes them to startLiveSession and shows them with a way to clear them.
  const [focusTopics, setFocusTopics] = useState<string[]>([])

  // Phase 5: the coding round is a separate, independently-reachable page
  // (not something you switch to mid-voice-interview -- the master spec
  // describes it as a distinct interview phase, and there's no clean, obvious
  // way to interleave it with the Live voice session without a lot of extra
  // machinery this phase doesn't need). Its working state (code per language,
  // problem text, cached hints, review result) lives here, in App.tsx, which
  // is mounted for the app's entire lifetime: the page itself unmounts on
  // every navigation (that unmount is what releases the global screenshot
  // hotkey), and switching tabs must not throw the candidate's work away.
  const [codingWork, setCodingWork] = useState<CodingWork>(INITIAL_CODING_WORK)

  // Screenshot flow state. The locally captured preview is held here (the
  // listeners below are mounted for the whole app lifetime, so a push can
  // never be lost to a page transition) and rendered by CodingRound. Nothing
  // is uploaded until the user clicks "Send to Gemini" there.
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null)
  const [screenshotSending, setScreenshotSending] = useState(false)
  const [screenshotToast, setScreenshotToast] = useState<ScreenshotToast | null>(null)
  const toastIdRef = useRef(0)
  const viewRef = useRef<View>(view)

  useEffect(() => {
    viewRef.current = view
    // Leaving the Coding page drops any preview (main drops its held capture
    // at the same moment, when the page releases the hotkey).
    if (view !== 'coding') {
      setScreenshotPreview(null)
      setScreenshotSending(false)
    }
  }, [view])

  const showToast = (tone: ScreenshotToast['tone'], message: string): void => {
    const id = ++toastIdRef.current
    setScreenshotToast({ tone, message })
    // Auto-dismiss, but only if a newer toast hasn't already replaced this
    // one -- guards against a slow-to-fire timer clearing a toast that isn't
    // its own.
    window.setTimeout(() => {
      if (toastIdRef.current === id) setScreenshotToast(null)
    }, 6000)
  }

  useEffect(() => {
    // Screenshot events NEVER change the current page: the hotkey/capture
    // button only exist while the Coding page is showing, and forcing a page
    // switch from here would unmount <Interview> and end a live voice session.
    const unsubscribePreview = window.api.onCodingScreenshotPreview((event) => {
      if (viewRef.current !== 'coding') {
        // The user left the Coding page after requesting a capture -- there's
        // nowhere to show the preview, so drop the held capture.
        void window.api.discardScreenshot().catch(() => undefined)
        return
      }
      setScreenshotSending(false)
      setScreenshotPreview(event.previewDataUrl)
      showToast('info', 'Screenshot captured on this computer -- nothing has been sent. Choose "Send to Gemini" or "Discard".')
    })
    const unsubscribeResult = window.api.onCodingScreenshotResult((event) => {
      setScreenshotPreview(null)
      setScreenshotSending(false)
      const problemText = event.problemText
      if (event.ok && problemText !== undefined) {
        setCodingWork((prev) => ({ ...prev, problemText }))
        showToast('success', 'Problem extracted from the screenshot.')
      } else {
        showToast('error', event.error ?? 'Could not extract a problem from the screenshot.')
      }
    })
    return () => {
      unsubscribePreview()
      unsubscribeResult()
    }
  }, [])

  const handleScreenshotConfirm = (): void => {
    if (screenshotPreview === null || screenshotSending) return
    setScreenshotSending(true)
    showToast('info', 'Sending the screenshot to Gemini…')
    void window.api
      .confirmScreenshot()
      .then((result) => {
        // On success the outcome arrives via the result push above.
        if (!result.ok) {
          setScreenshotPreview(null)
          setScreenshotSending(false)
          showToast('error', result.error ?? 'Could not send the screenshot.')
        }
      })
      .catch(() => {
        setScreenshotPreview(null)
        setScreenshotSending(false)
        showToast('error', 'Could not send the screenshot.')
      })
  }

  const handleScreenshotDiscard = (): void => {
    if (screenshotSending) return
    setScreenshotPreview(null)
    void window.api.discardScreenshot().catch(() => undefined)
    showToast('info', 'Screenshot discarded. Nothing was sent.')
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <span className="text-lg font-semibold">MockPilot</span>
        <nav className="flex gap-1">
          <NavButton label="Setup" active={view === 'setup'} onClick={() => setView('setup')} />
          <NavButton label="Interview" active={view === 'interview'} onClick={() => setView('interview')} />
          <NavButton label="Coding round" active={view === 'coding'} onClick={() => setView('coding')} />
          <NavButton label="History" active={view === 'history'} onClick={() => setView('history')} />
          <NavButton label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
        </nav>
      </header>

      {screenshotToast && (
        <div
          role="status"
          className={cn(
            'border-b px-6 py-2 text-sm',
            screenshotToast.tone === 'info' && 'border-border bg-secondary/40 text-muted-foreground',
            screenshotToast.tone === 'success' && 'border-success/30 bg-success/10 text-success',
            screenshotToast.tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive'
          )}
        >
          {screenshotToast.message}
        </div>
      )}

      <main className="flex-1 overflow-y-auto">
        {view === 'setup' && <Setup setup={setup} onSetupChange={setSetup} />}
        {view === 'interview' && <Interview setup={setup} focusTopics={focusTopics} onClearFocus={() => setFocusTopics([])} />}
        {view === 'coding' && (
          <CodingRound
            work={codingWork}
            onWorkChange={(update) => setCodingWork(update)}
            screenshotPreview={screenshotPreview}
            screenshotSending={screenshotSending}
            onScreenshotConfirm={handleScreenshotConfirm}
            onScreenshotDiscard={handleScreenshotDiscard}
          />
        )}
        {view === 'history' && (
          <History
            onDrill={(topics) => {
              setFocusTopics(topics)
              setView('interview')
            }}
          />
        )}
        {view === 'settings' && <Settings />}
      </main>
    </div>
  )
}

interface NavButtonProps {
  label: string
  active: boolean
  onClick: () => void
}

function NavButton({ label, active, onClick }: NavButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-secondary/60'
      )}
    >
      {label}
    </button>
  )
}

export default App
