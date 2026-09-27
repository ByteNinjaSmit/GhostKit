import { useEffect, useRef, useState, type ReactNode } from 'react'
import Editor from '@monaco-editor/react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { configureMonaco } from '@/lib/monacoSetup'
import CodeReviewFeedback from '@/components/CodeReviewFeedback'
import UsageMeter from '@/components/UsageMeter'
import { useWindowShortcut } from '@/lib/useWindowShortcut'
import { useUsage } from '@/lib/useUsage'
import {
  CODING_LANGUAGES,
  CODING_LANGUAGE_LABELS,
  MAX_CODE_CHARS,
  MAX_PROBLEM_TEXT_CHARS,
  SCREENSHOT_HOTKEY_LABEL,
  SHORTCUT_NEXT_HINT_LABEL
} from '../../electron/ipc-types'
import type { CodeReviewResult, CodingLanguage, RunCodeResult } from '../../electron/ipc-types'

// Runs once, at module load, before this page's first render -- see
// monacoSetup.ts's doc comment for why this has to happen before any
// <Editor> mounts.
configureMonaco()

/** Monaco's built-in language id per CodingLanguage -- 1:1 for these four (no aliasing needed). */
const MONACO_LANGUAGE: Readonly<Record<CodingLanguage, string>> = {
  python: 'python',
  javascript: 'javascript',
  java: 'java',
  cpp: 'cpp'
}

/**
 * Starter code per language. Java's stub matters beyond convenience: this
 * app's local runner (electron/services/codeRunner.ts) writes the candidate's
 * code to a fixed `Main.java` and compiles/runs it as public class `Main` --
 * it does not parse the candidate's code to discover a different class name.
 * Renaming the public class away from `Main` will fail to compile; the UI
 * repeats this constraint below the language select whenever Java is chosen.
 */
const STARTER_CODE: Readonly<Record<CodingLanguage, string>> = {
  python: '# Write your solution here\n',
  javascript: '// Write your solution here\n',
  java: 'public class Main {\n    public static void main(String[] args) {\n        // Write your solution here\n    }\n}\n',
  cpp: '#include <iostream>\nusing namespace std;\n\nint main() {\n    // Write your solution here\n    return 0;\n}\n'
}

/**
 * Everything the candidate would be upset to lose by clicking over to another
 * page: their code per language, the problem text, the hints fetched for it,
 * and the review result. Lives in App.tsx (mounted for the app's whole
 * lifetime) rather than in this page, which unmounts on every navigation --
 * unmounting is what releases the global screenshot hotkey (see the effect
 * below), so this state can't live in a component that stays mounted for the
 * same effect.
 */
export interface CodingWork {
  language: CodingLanguage
  codeByLanguage: Record<CodingLanguage, string>
  problemText: string
  /** Cached hint ladder plus the exact problem text it was generated for -- only shown while that still equals the current problem text. */
  hints: { problemKey: string; hints: string[]; revealedCount: number } | null
  review: { result: CodeReviewResult | null; error: string | null }
}

export const INITIAL_CODING_WORK: CodingWork = {
  language: 'python',
  codeByLanguage: STARTER_CODE,
  problemText: '',
  hints: null,
  review: { result: null, error: null }
}

type RunStatus = 'idle' | 'running'
type HintsStatus = 'idle' | 'loading'
type ReviewStatus = 'idle' | 'submitting'
type CaptureStatus = 'idle' | 'requesting'
/** `unknown` until main answers the register request; `unavailable` means another app owns the accelerator (or registration failed). */
type HotkeyState = 'unknown' | 'registered' | 'unavailable'

interface CodingRoundProps {
  work: CodingWork
  onWorkChange: (update: (prev: CodingWork) => CodingWork) => void
  /** Locally captured screenshot preview awaiting the user's explicit choice; `null` when none. Nothing has been uploaded while this is showing. */
  screenshotPreview: string | null
  /** True from the moment "Send to Gemini" is clicked until the extraction result comes back. */
  screenshotSending: boolean
  onScreenshotConfirm: () => void
  onScreenshotDiscard: () => void
}

function CodingRound({
  work,
  onWorkChange,
  screenshotPreview,
  screenshotSending,
  onScreenshotConfirm,
  onScreenshotDiscard
}: CodingRoundProps): JSX.Element {
  const { language, codeByLanguage, problemText } = work
  const code = codeByLanguage[language]

  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runResult, setRunResult] = useState<RunCodeResult | null>(null)

  const [hintsStatus, setHintsStatus] = useState<HintsStatus>('idle')
  const [hintsError, setHintsError] = useState<string | null>(null)

  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('idle')

  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('idle')
  const [captureError, setCaptureError] = useState<string | null>(null)

  const [hotkeyState, setHotkeyState] = useState<HotkeyState>('unknown')

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The global screenshot hotkey exists only while this page is showing: it is
  // registered on mount and released on unmount (main.ts also releases it on
  // window close/reload/quit). Registering it for the app's whole lifetime
  // would steal Ctrl+Shift+S from every other application. The result is
  // surfaced -- if another app already owns the accelerator, the "press the
  // hotkey" hint is hidden and a warning shown instead.
  useEffect(() => {
    let cancelled = false
    void window.api
      .setScreenshotHotkeyActive(true)
      .then((result) => {
        if (!cancelled) setHotkeyState(result.ok && result.registered ? 'registered' : 'unavailable')
      })
      .catch(() => {
        if (!cancelled) setHotkeyState('unavailable')
      })
    return () => {
      cancelled = true
      void window.api.setScreenshotHotkeyActive(false).catch(() => {
        // Best-effort; main also releases it on window close/reload/quit.
      })
    }
  }, [])

  const activeHints = work.hints !== null && work.hints.problemKey === problemText ? work.hints : null

  const handleLanguageChange = (next: CodingLanguage): void => {
    onWorkChange((prev) => ({ ...prev, language: next }))
    setRunResult(null)
  }

  const handleCodeChange = (value: string | undefined): void => {
    const next = value ?? ''
    onWorkChange((prev) => ({ ...prev, codeByLanguage: { ...prev.codeByLanguage, [prev.language]: next } }))
  }

  const codeTooLong = code.length > MAX_CODE_CHARS
  const codeEmpty = code.trim().length === 0
  const codeBlocked = codeTooLong || codeEmpty

  const handleRun = (): void => {
    if (runStatus === 'running' || codeBlocked) return
    setRunStatus('running')
    setRunResult(null)

    void window.api
      .runCode(language, code)
      .then((result) => {
        if (!mountedRef.current) return
        setRunResult(result)
        setRunStatus('idle')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setRunResult({ stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Failed to run the code.' })
        setRunStatus('idle')
      })
  }

  const canRequestHints = problemText.trim().length > 0 && hintsStatus !== 'loading'

  const handleNextHint = (): void => {
    if (!canRequestHints) return

    if (activeHints !== null) {
      onWorkChange((prev) =>
        prev.hints === null ? prev : { ...prev, hints: { ...prev.hints, revealedCount: Math.min(4, prev.hints.revealedCount + 1) } }
      )
      return
    }

    const requestedFor = problemText
    setHintsStatus('loading')
    setHintsError(null)
    void window.api
      .getHints(requestedFor)
      .then((result) => {
        if (result.ok && result.hints !== undefined) {
          const fetched = result.hints
          // Applied even if this page was navigated away from meanwhile --
          // the result is keyed by the problem text it belongs to, so it can
          // never be shown against a different problem.
          onWorkChange((prev) => ({ ...prev, hints: { problemKey: requestedFor, hints: fetched, revealedCount: 1 } }))
        }
        if (!mountedRef.current) return
        setHintsStatus('idle')
        if (!(result.ok && result.hints !== undefined)) setHintsError(result.error ?? 'Could not generate hints.')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setHintsStatus('idle')
        setHintsError('Could not generate hints.')
      })
  }

  const handleSubmit = (): void => {
    if (reviewStatus === 'submitting' || codeBlocked) return
    if (problemText.trim().length === 0) {
      onWorkChange((prev) => ({
        ...prev,
        review: { result: null, error: 'Add a problem statement first (paste one, or capture a screenshot).' }
      }))
      return
    }
    setReviewStatus('submitting')
    onWorkChange((prev) => ({ ...prev, review: { result: null, error: null } }))

    void window.api
      .submitCodeReview(problemText, language, code)
      .then((result) => {
        onWorkChange((prev) => ({
          ...prev,
          review: result.ok
            ? { result, error: null }
            : { result: null, error: result.error ?? 'Could not generate a review.' }
        }))
        if (!mountedRef.current) return
        setReviewStatus('idle')
      })
      .catch(() => {
        onWorkChange((prev) => ({ ...prev, review: { result: null, error: 'Could not generate a review.' } }))
        if (!mountedRef.current) return
        setReviewStatus('idle')
      })
  }

  const handleManualCapture = (): void => {
    if (captureStatus === 'requesting') return
    setCaptureStatus('requesting')
    setCaptureError(null)
    void window.api
      .captureScreenshotNow()
      .then((result) => {
        if (!mountedRef.current) return
        setCaptureStatus('idle')
        if (!result.ok) setCaptureError(result.error ?? 'Could not start screenshot capture.')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setCaptureStatus('idle')
        setCaptureError('Could not start screenshot capture.')
      })
  }

  const revealedCount = activeHints?.revealedCount ?? 0
  const nextHintLabel = activeHints !== null && revealedCount >= 4 ? 'All hints revealed' : 'Show next hint'
  const nextHintDisabled = !canRequestHints || (activeHints !== null && revealedCount >= 4)

  // Ctrl+Shift+H (window-scoped): the same handler as the button, gated by the
  // same disabled state, and ignored while the Monaco editor or a text field has focus.
  useWindowShortcut({ code: 'KeyH' }, () => {
    if (!nextHintDisabled) handleNextHint()
  })

  const usageSnapshot = useUsage(true, 5000, 0)
  const isCompiled = language === 'java' || language === 'cpp'

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Coding round</CardTitle>
          <CardDescription>
            Capture a coding problem from your screen ({hotkeyState === 'registered' ? `press ${SCREENSHOT_HOTKEY_LABEL} while this page is open, or ` : ''}
            use the button below), or paste one in directly. Write your solution, run it locally, use hints if you get
            stuck, then submit for a structured review.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hotkeyState === 'unavailable' && (
            <StatusBanner tone="error">
              The {SCREENSHOT_HOTKEY_LABEL} hotkey could not be registered -- another application probably already uses
              it. Use the "Capture screenshot" button instead.
            </StatusBanner>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="coding-problem" className="text-sm font-medium">
                Problem statement
              </label>
              <Button type="button" variant="outline" size="sm" onClick={handleManualCapture} disabled={captureStatus === 'requesting'}>
                {captureStatus === 'requesting' ? 'Requesting…' : 'Capture screenshot'}
              </Button>
            </div>

            {screenshotPreview !== null && (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <span className="text-sm font-medium">Screenshot preview</span>
                <img
                  src={screenshotPreview}
                  alt="Preview of the captured screenshot"
                  className="max-h-72 w-full rounded-md border border-border bg-secondary/40 object-contain"
                />
                <p className="text-xs text-muted-foreground">
                  Captured on this computer only -- nothing has been sent anywhere yet. Send it to Gemini to extract the
                  problem text, or discard it.
                </p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={onScreenshotConfirm} disabled={screenshotSending}>
                    {screenshotSending ? 'Sending to Gemini…' : 'Send to Gemini'}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={onScreenshotDiscard} disabled={screenshotSending}>
                    Discard
                  </Button>
                </div>
              </div>
            )}

            <Textarea
              id="coding-problem"
              placeholder="Paste a problem statement here, or capture one from your screen…"
              maxLength={MAX_PROBLEM_TEXT_CHARS}
              value={problemText}
              onChange={(event) => onWorkChange((prev) => ({ ...prev, problemText: event.target.value }))}
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              {problemText.length} / {MAX_PROBLEM_TEXT_CHARS} characters -- a screenshot is captured on this computer
              first and shown to you as a preview; it is only sent to Gemini after you click "Send to Gemini".
              {hotkeyState === 'registered' && ` ${SCREENSHOT_HOTKEY_LABEL} works while this page is open.`}
            </p>
            {captureError && <StatusBanner tone="error">{captureError}</StatusBanner>}
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <label htmlFor="coding-language" className="text-sm font-medium">
              Language
            </label>
            <Select
              id="coding-language"
              value={language}
              onChange={(event) => handleLanguageChange(event.target.value as CodingLanguage)}
              className="max-w-xs"
            >
              {CODING_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {CODING_LANGUAGE_LABELS[lang]}
                </option>
              ))}
            </Select>
            {language === 'java' && (
              <p className="text-xs text-muted-foreground">
                Your public class must be named <code>Main</code> -- the runner compiles/runs this as{' '}
                <code>Main.java</code>.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-md border border-border">
              <Editor
                height="360px"
                language={MONACO_LANGUAGE[language]}
                value={code}
                onChange={handleCodeChange}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  automaticLayout: true
                }}
              />
            </div>
            <p className={cn('text-xs', codeTooLong ? 'text-destructive' : 'text-muted-foreground')}>
              {code.length} / {MAX_CODE_CHARS} characters
              {codeTooLong && ' -- too long to run or submit; shorten your code.'}
              {!codeTooLong && codeEmpty && ' -- write some code to run or submit.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleRun} disabled={runStatus === 'running' || codeBlocked}>
              {runStatus === 'running' ? 'Running…' : 'Run'}
            </Button>
            <Button type="button" variant="outline" onClick={handleNextHint} disabled={nextHintDisabled} title={`${SHORTCUT_NEXT_HINT_LABEL} (while this window is focused and the editor is not)`}>
              {hintsStatus === 'loading' ? 'Loading hint…' : `${nextHintLabel} (${SHORTCUT_NEXT_HINT_LABEL})`}
            </Button>
            <Button type="button" variant="secondary" onClick={handleSubmit} disabled={reviewStatus === 'submitting' || codeBlocked}>
              {reviewStatus === 'submitting' ? 'Submitting…' : 'Submit for review'}
            </Button>
          </div>

          <UsageMeter snapshot={usageSnapshot} categories={['coding']} title="Coding calls since launch" />

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-sm font-medium">Run output</span>
            <RunOutputPanel status={runStatus} result={runResult} compiled={isCompiled} />
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-sm font-medium">Hints</span>
            {hintsError && <StatusBanner tone="error">{hintsError}</StatusBanner>}
            <HintsPanel hints={activeHints?.hints ?? null} revealedCount={revealedCount} />
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-sm font-medium">Review</span>
            <CodeReviewFeedback review={work.review.result} error={work.review.error} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

interface RunOutputPanelProps {
  status: RunStatus
  result: RunCodeResult | null
  /** Java/C++: there is a separate compile step with its own, longer budget. */
  compiled: boolean
}

function RunOutputPanel({ status, result, compiled }: RunOutputPanelProps): JSX.Element {
  if (status === 'running') {
    return (
      <p className="text-sm text-muted-foreground">
        {compiled ? 'Compiling (up to 15s), then running (up to 5s)…' : 'Running (up to 5s)…'}
      </p>
    )
  }
  if (result === null) {
    return <p className="text-sm text-muted-foreground">Run your code to see its output here.</p>
  }
  if (result.error !== undefined) {
    return <StatusBanner tone="error">{result.error}</StatusBanner>
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {result.compileTimedOut === true && <StatusBanner tone="error">Compilation timed out after 15 seconds and was stopped.</StatusBanner>}
      {result.timedOut && <StatusBanner tone="error">Timed out after 5 seconds and was stopped.</StatusBanner>}
      {result.compileTimedOut !== true && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Exit code: {result.exitCode ?? '—'}</span>
        </div>
      )}
      {result.stdout.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">stdout</span>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/40 p-2 text-xs">{result.stdout}</pre>
        </div>
      )}
      {result.stderr.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">stderr</span>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-xs text-destructive">{result.stderr}</pre>
        </div>
      )}
      {result.stdout.length === 0 && result.stderr.length === 0 && !result.timedOut && result.compileTimedOut !== true && (
        <p className="text-xs text-muted-foreground">(no output)</p>
      )}
    </div>
  )
}

const HINT_LEVEL_LABELS = ['Nudge', 'Pattern', 'Approach', 'Complexity']

function HintsPanel({ hints, revealedCount }: { hints: string[] | null; revealedCount: number }): JSX.Element {
  if (hints === null || revealedCount === 0) {
    return <p className="text-sm text-muted-foreground">Click "Show next hint" for a nudge -- hints unlock one level at a time and never show a full solution.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {hints.slice(0, revealedCount).map((hint, index) => (
        <div key={index} className="rounded-md border border-border p-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Level {index + 1} -- {HINT_LEVEL_LABELS[index]}
          </span>
          <p className="mt-1 leading-snug">{hint}</p>
        </div>
      ))}
    </div>
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

export default CodingRound
