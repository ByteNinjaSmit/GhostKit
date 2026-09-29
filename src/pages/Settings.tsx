import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  SCREENSHOT_HOTKEY_LABEL,
  SHORTCUT_NEXT_HINT_LABEL,
  SHORTCUT_TOGGLE_SESSION_LABEL,
  GHOST_OVERLAY_HOTKEY_LABEL,
  GHOST_CLICKTHROUGH_HOTKEY_LABEL,
  GHOST_PANIC_HOTKEY_LABEL
} from '../../electron/ipc-types'
import type { StealthState, DiagnosticsResult } from '../../electron/ipc-types'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type TestStatus = 'idle' | 'testing' | 'success' | 'error'

function Settings(): JSX.Element {
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [isKeyVisible, setIsKeyVisible] = useState(false)

  const [stealth, setStealth] = useState<StealthState>({
    contentProtected: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    ghostOverlayActive: false,
    ghostClickThrough: false,
    ghostOpacity: 0.95
  })
  const [stealthLoading, setStealthLoading] = useState(false)

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testError, setTestError] = useState<string | null>(null)

  const [diag, setDiag] = useState<DiagnosticsResult | null>(null)
  const [diagRunning, setDiagRunning] = useState(false)

  const handleRunDiagnostics = async (): Promise<void> => {
    setDiagRunning(true)
    setDiag(null)
    try {
      const result = await window.api.runDiagnostics()
      setDiag(result)
    } catch {
      setDiag({ ok: false, checks: [{ name: 'Diagnostics', ok: false, detail: 'Failed to run diagnostics.' }] })
    } finally {
      setDiagRunning(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    // The renderer never reads the key's value back out, only whether one is
    // stored -- the field always starts empty, even if a key is saved.
    window.api
      .hasApiKey()
      .then((stored) => {
        if (cancelled) return
        setHasStoredKey(stored)
      })
      .catch(() => {
        // Best-effort; leave the "stored" state at its default on failure.
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    window.api
      .getStealthState()
      .then(setStealth)
      .catch(() => undefined)
    const unsubscribe = window.api.onStealthStateChanged(setStealth)
    return () => unsubscribe()
  }, [])

  const handleToggleProtection = async (): Promise<void> => {
    setStealthLoading(true)
    try {
      const res = await window.api.setContentProtection(!stealth.contentProtected)
      setStealth((prev) => ({ ...prev, contentProtected: res.protected }))
    } finally {
      setStealthLoading(false)
    }
  }

  const handleToggleAlwaysOnTop = async (): Promise<void> => {
    setStealthLoading(true)
    try {
      const res = await window.api.setAlwaysOnTop(!stealth.alwaysOnTop)
      setStealth((prev) => ({ ...prev, alwaysOnTop: res.alwaysOnTop }))
    } finally {
      setStealthLoading(false)
    }
  }

  const handleToggleSkipTaskbar = async (): Promise<void> => {
    setStealthLoading(true)
    try {
      const res = await window.api.setSkipTaskbar(!stealth.skipTaskbar)
      setStealth((prev) => ({ ...prev, skipTaskbar: res.skipTaskbar }))
    } finally {
      setStealthLoading(false)
    }
  }

  const handleToggleGhostOverlay = async (): Promise<void> => {
    setStealthLoading(true)
    try {
      const res = await window.api.toggleGhostOverlay()
      setStealth((prev) => ({ ...prev, ghostOverlayActive: res.active }))
    } finally {
      setStealthLoading(false)
    }
  }

  const handleSave = (): void => {
    setSaveStatus('saving')
    setSaveError(null)
    // A new key invalidates any previous "test" result.
    setTestStatus('idle')
    setTestError(null)

    window.api
      .setApiKey(apiKeyInput)
      .then((result) => {
        if (result.ok) {
          setSaveStatus('saved')
          setHasStoredKey(true)
        } else {
          setSaveStatus('error')
          setSaveError(result.error ?? 'Failed to save the API key.')
        }
      })
      .catch((err: unknown) => {
        setSaveStatus('error')
        setSaveError(err instanceof Error ? err.message : 'Failed to save the API key.')
      })
  }

  const handleTestKey = (): void => {
    setTestStatus('testing')
    setTestError(null)

    window.api
      .testApiKey()
      .then((result) => {
        if (result.ok) {
          setTestStatus('success')
        } else {
          setTestStatus('error')
          setTestError(result.error ?? 'The API key could not be verified.')
        }
      })
      .catch((err: unknown) => {
        setTestStatus('error')
        setTestError(err instanceof Error ? err.message : 'The API key could not be verified.')
      })
  }

  const handleRemove = (): void => {
    window.api
      .deleteApiKey()
      .then((result) => {
        if (result.ok) {
          setApiKeyInput('')
          setHasStoredKey(false)
          setSaveStatus('idle')
          setSaveError(null)
          setTestStatus('idle')
          setTestError(null)
        } else {
          setSaveStatus('error')
          setSaveError(result.error ?? 'Failed to remove the API key.')
        }
      })
      .catch((err: unknown) => {
        setSaveStatus('error')
        setSaveError(err instanceof Error ? err.message : 'Failed to remove the API key.')
      })
  }

  const isSaving = saveStatus === 'saving'
  const isTesting = testStatus === 'testing'
  const canSave = apiKeyInput.trim().length > 0 && !isSaving

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Gemini API Key</CardTitle>
          <CardDescription>
            MockPilot uses your own Gemini API key to run interviews. The key is stored securely in your
            operating system&apos;s credential manager and is never sent anywhere except directly to Google&apos;s
            API from this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="gemini-api-key" className="text-sm font-medium">
              API key
            </label>
            <div className="flex gap-2">
              <Input
                id="gemini-api-key"
                type={isKeyVisible ? 'text' : 'password'}
                placeholder="Paste your Gemini API key"
                autoComplete="off"
                spellCheck={false}
                value={apiKeyInput}
                onChange={(event) => {
                  setApiKeyInput(event.target.value)
                  setSaveStatus('idle')
                  setSaveError(null)
                }}
              />
              <Button type="button" variant="outline" onClick={() => setIsKeyVisible((visible) => !visible)}>
                {isKeyVisible ? 'Hide' : 'Show'}
              </Button>
            </div>
            {hasStoredKey && (
              <p className="text-xs text-muted-foreground">A key is currently saved for this app.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleSave} disabled={!canSave}>
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="outline" onClick={handleTestKey} disabled={isTesting}>
              {isTesting ? 'Testing…' : 'Test key'}
            </Button>
            {hasStoredKey && (
              <Button type="button" variant="ghost" onClick={handleRemove} disabled={isSaving}>
                Remove key
              </Button>
            )}
          </div>

          {saveStatus === 'saved' && (
            <StatusBanner tone="success">Key saved.</StatusBanner>
          )}
          {saveStatus === 'error' && saveError && <StatusBanner tone="error">{saveError}</StatusBanner>}

          {testStatus === 'success' && (
            <StatusBanner tone="success">Success — the key works and Gemini responded.</StatusBanner>
          )}
          {testStatus === 'error' && testError && <StatusBanner tone="error">{testError}</StatusBanner>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Window Privacy & Content Protection</CardTitle>
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border',
                stealth.contentProtected
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-slate-500/40 bg-slate-500/10 text-slate-400'
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  stealth.contentProtected ? 'bg-emerald-400' : 'bg-slate-400'
                )}
              />
              {stealth.contentProtected ? 'Protection Enabled' : 'Protection Disabled'}
            </span>
          </div>
          <CardDescription>
            Uses Windows display affinity protection (<code>SetWindowDisplayAffinity</code>) to protect your workspace
            from accidental capture during screen sharing and recordings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <div>
                <div className="text-sm font-medium">Screen Capture Protection</div>
                <div className="text-xs text-muted-foreground">
                  Prevents screen-capture tools and meeting screen shares from recording this window.
                </div>
              </div>
              <Button
                type="button"
                variant={stealth.contentProtected ? 'default' : 'outline'}
                size="sm"
                disabled={stealthLoading}
                onClick={handleToggleProtection}
              >
                {stealth.contentProtected ? 'Enabled' : 'Disabled'}
              </Button>
            </div>

            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <div>
                <div className="text-sm font-medium">Always on Top</div>
                <div className="text-xs text-muted-foreground">
                  Keep window visible above other windows.
                </div>
              </div>
              <Button
                type="button"
                variant={stealth.alwaysOnTop ? 'default' : 'outline'}
                size="sm"
                disabled={stealthLoading}
                onClick={handleToggleAlwaysOnTop}
              >
                {stealth.alwaysOnTop ? 'On' : 'Off'}
              </Button>
            </div>

            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <div>
                <div className="text-sm font-medium">Hide from Windows Taskbar</div>
                <div className="text-xs text-muted-foreground">
                  Omit the main window from the Windows taskbar.
                </div>
              </div>
              <Button
                type="button"
                variant={stealth.skipTaskbar ? 'default' : 'outline'}
                size="sm"
                disabled={stealthLoading}
                onClick={handleToggleSkipTaskbar}
              >
                {stealth.skipTaskbar ? 'Hidden' : 'Visible'}
              </Button>
            </div>

            <div className="flex items-center justify-between pt-1">
              <div>
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <span>Floating Assistant Widget</span>
                  <span className="font-mono text-xs text-muted-foreground">({GHOST_OVERLAY_HOTKEY_LABEL})</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Toggle the compact floating assistant window.
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={stealthLoading}
                onClick={handleToggleGhostOverlay}
              >
                {stealth.ghostOverlayActive ? 'Hide Widget' : 'Open Widget'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keyboard shortcuts</CardTitle>
          <CardDescription>
            Window shortcuts only work while MockPilot is the focused window, and are ignored while you are typing in a
            text field or the code editor. Global hotkeys work anywhere in Windows even when other applications are focused.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="font-mono text-xs">{GHOST_OVERLAY_HOTKEY_LABEL}</dt>
            <dd>Toggle floating assistant widget -- global hotkey</dd>
            <dt className="font-mono text-xs">{GHOST_CLICKTHROUGH_HOTKEY_LABEL}</dt>
            <dd>Toggle pass-through mode -- clicks pass through the floating widget to background windows</dd>
            <dt className="font-mono text-xs">{GHOST_PANIC_HOTKEY_LABEL}</dt>
            <dd>Emergency panic hide &amp; mute -- immediately closes floating widget and halts any active audio playback</dd>
            <dt className="font-mono text-xs">{SHORTCUT_TOGGLE_SESSION_LABEL}</dt>
            <dd>Start / stop the interview (Interview page; does nothing while it is still connecting)</dd>
            <dt className="font-mono text-xs">{SHORTCUT_NEXT_HINT_LABEL}</dt>
            <dd>Show the next hint (Coding round page)</dd>
            <dt className="font-mono text-xs">{SCREENSHOT_HOTKEY_LABEL}</dt>
            <dd>Capture a screenshot of the display under the mouse -- global, only while the Coding round page is open; nothing is sent until you confirm</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System diagnostics</CardTitle>
          <CardDescription>
            One-click self-check: confirms your Gemini API key is saved, shows which speech-recognition provider is
            active, and -- for the local faster-whisper provider -- loads the model on your GPU to verify it works (this
            also warms it, so the next interview starts instantly).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Button type="button" onClick={handleRunDiagnostics} disabled={diagRunning}>
              {diagRunning ? 'Running checks…' : 'Run diagnostics'}
            </Button>
          </div>

          {diag !== null && (
            <div className="flex flex-col gap-2">
              {diag.checks.map((check, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
                    check.ok ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10'
                  )}
                >
                  <span aria-hidden className={cn('mt-0.5 font-bold', check.ok ? 'text-success' : 'text-destructive')}>
                    {check.ok ? '✓' : '✗'}
                  </span>
                  <span className="flex flex-col">
                    <span className="font-medium">{check.name}</span>
                    <span className="text-xs text-muted-foreground">{check.detail}</span>
                  </span>
                </div>
              ))}
              <p className={cn('text-sm font-medium', diag.ok ? 'text-success' : 'text-destructive')}>
                {diag.ok ? 'All checks passed — you’re ready to interview.' : 'Some checks failed — see details above.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface StatusBannerProps {
  tone: 'success' | 'error'
  children: ReactNode
}

function StatusBanner({ tone, children }: StatusBannerProps): JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'success' && 'border-success/30 bg-success/10 text-success',
        tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive'
      )}
    >
      {children}
    </div>
  )
}

export default Settings
