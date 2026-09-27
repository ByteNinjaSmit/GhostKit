import { app, BrowserWindow, ipcMain, shell, dialog, session, desktopCapturer, globalShortcut, screen, type IpcMainInvokeEvent, type NativeImage } from 'electron'
import { join } from 'node:path'
import {
  IPC_CHANNELS,
  INTERVIEW_ROLES,
  INTERVIEW_DIFFICULTIES,
  MAX_COMPANY_CHARS,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  MAX_JD_TEXT_CHARS,
  MAX_RESUME_PDF_BYTES,
  CODING_LANGUAGES,
  MAX_CODE_CHARS,
  MAX_PROBLEM_TEXT_CHARS,
  MAX_SCREENSHOT_PREVIEW_CHARS,
  SCREENSHOT_HOTKEY_LABEL,
  GHOST_OVERLAY_HOTKEY,
  GHOST_CLICKTHROUGH_HOTKEY,
  GHOST_PANIC_HOTKEY,
  HISTORY_MAX_PAGE_SIZE,
  HISTORY_MAX_OFFSET,
  HISTORY_MAX_WEAK_AREAS,
  parseFocusTopics
} from './ipc-types'
import type {
  CodeReviewResult,
  CodingLanguage,
  HintsResult,
  HistoryListResult,
  HistorySessionDetailResult,
  HistoryTopicStatsResult,
  HistoryWeakAreasResult,
  InterviewDifficulty,
  InterviewRole,
  InterviewSetup,
  OperationResult,
  RagIndexResult,
  RagStatusResult,
  RunCodeResult,
  SetHotkeyResult,
  TestKeyResult,
  UsageSnapshot,
  StealthState
} from './ipc-types'
import * as keyVault from './services/keyVault'
import * as gemini from './services/gemini'
import * as geminiLive from './services/geminiLive'
import * as rag from './services/rag'
import * as history from './services/history'
import * as codeRunner from './services/codeRunner'
import * as codingAssist from './services/codingAssist'
import * as usage from './services/usage'
import { redact } from './lib/redact'

/** Dev-server origin when running via `electron-vite dev`; `file://` in a packaged build. */
const rendererUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged && rendererUrl !== undefined
const trustedOrigin: string = isDev && rendererUrl !== undefined ? rendererUrl : 'file://'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // Explicit, even though it was already implied by script-src's fallback
  // (worker-src falls back to script-src, then default-src, per the CSP
  // spec) -- both src/audio/pcm-worklet.js's AudioWorklet (Phase 1) and
  // Phase 5's Monaco editor worker rely on this being same-origin-only, and
  // spelling it out here removes any doubt about that across Chromium
  // versions rather than relying on the fallback silently continuing to
  // behave the same way.
  "worker-src 'self'",
  "connect-src 'none'", // renderer never talks to the network directly -- main process only
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ')

/**
 * Dev-only CSP: relaxes exactly what `electron-vite dev` needs (the Vite dev
 * server's own origin, for the React-refresh preamble script, and its HMR
 * websocket) and nothing else. Earlier this phase dropped CSP entirely in
 * dev to fix a blank-screen bug (CSP blocking the preamble) -- that also
 * silently dropped `connect-src 'none'`, which exists specifically to catch
 * a renderer that starts talking to the network directly (relevant right
 * now: Phase 2 puts a Gemini API key in this app). Substituting a narrow dev
 * policy instead keeps that guarantee live in dev too.
 */
const devOrigin = isDev && rendererUrl !== undefined ? new URL(rendererUrl).origin : ''
const devWebSocketOrigin = isDev && rendererUrl !== undefined ? `ws://${new URL(rendererUrl).host}` : ''
const DEV_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${devOrigin}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "worker-src 'self'", // see CSP's own worker-src comment above
  `connect-src ${devOrigin} ${devWebSocketOrigin}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ')

/** Only the app's own renderer frame may invoke privileged IPC channels. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const senderUrl = event.senderFrame?.url
  return senderUrl !== undefined && senderUrl.startsWith(trustedOrigin)
}

const INTERVIEW_ROLE_SET: ReadonlySet<string> = new Set(INTERVIEW_ROLES)
const INTERVIEW_DIFFICULTY_SET: ReadonlySet<string> = new Set(INTERVIEW_DIFFICULTIES)

/**
 * Validates a `GEMINI_LIVE_START` payload -- same "never trust a bare cast"
 * discipline preload.ts applies to push events, applied here to a
 * renderer->main invoke argument instead. `ipcRenderer.invoke` args arrive as
 * `unknown` in spirit even though Electron's types don't say so.
 */
function toInterviewSetup(value: unknown): InterviewSetup | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const role = v['role']
  if (typeof role !== 'string' || !INTERVIEW_ROLE_SET.has(role)) return null

  const difficulty = v['difficulty']
  if (typeof difficulty !== 'string' || !INTERVIEW_DIFFICULTY_SET.has(difficulty)) return null

  const company = v['company']
  if (typeof company !== 'string' || company.length > MAX_COMPANY_CHARS) return null

  const durationMinutes = v['durationMinutes']
  if (
    typeof durationMinutes !== 'number' ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes < MIN_DURATION_MINUTES ||
    durationMinutes > MAX_DURATION_MINUTES
  ) {
    return null
  }

  return {
    role: role as InterviewRole,
    difficulty: difficulty as InterviewDifficulty,
    company,
    durationMinutes: Math.round(durationMinutes)
  }
}

/** Session ids are positive safe integers (AUTOINCREMENT rowids). */
function toSessionId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Validates a `HISTORY_LIST_SESSIONS` payload: integer page size within [1, HISTORY_MAX_PAGE_SIZE] and offset within [0, HISTORY_MAX_OFFSET]. */
function toHistoryListRequest(value: unknown): { limit: number; offset: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const limit = v['limit']
  const offset = v['offset']
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_MAX_PAGE_SIZE) return null
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > HISTORY_MAX_OFFSET) return null
  return { limit, offset }
}

/** Validates a `HISTORY_WEAK_AREAS` payload: an integer in [1, HISTORY_MAX_WEAK_AREAS]. */
function toWeakAreasLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= HISTORY_MAX_WEAK_AREAS ? value : null
}

/** Validates a `RAG_INDEX_MATERIALS` payload. The actual byte/char-length caps are re-enforced inside rag.ts itself -- this is only the shape/type check at the IPC boundary. */
function toRagIndexRequest(value: unknown): { resumePdfBytes: ArrayBuffer | null; jdText: string | null } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const resumePdfBytes = v['resumePdfBytes']
  if (resumePdfBytes !== null && !(resumePdfBytes instanceof ArrayBuffer)) return null
  // Redundant with rag.ts's own check (which is the real authority, and
  // runs before the bytes ever reach pdf-parse) -- kept here too so every
  // IPC-boundary bound lives in one place, matching this file's existing
  // validators for the other channels.
  if (resumePdfBytes instanceof ArrayBuffer && (resumePdfBytes.byteLength === 0 || resumePdfBytes.byteLength > MAX_RESUME_PDF_BYTES)) {
    return null
  }

  const jdText = v['jdText']
  if (jdText !== null && typeof jdText !== 'string') return null
  if (typeof jdText === 'string' && jdText.length > MAX_JD_TEXT_CHARS) return null

  return {
    resumePdfBytes: resumePdfBytes instanceof ArrayBuffer ? resumePdfBytes : null,
    jdText: typeof jdText === 'string' ? jdText : null
  }
}

const CODING_LANGUAGE_SET: ReadonlySet<string> = new Set(CODING_LANGUAGES)

/** Validates a `CODING_RUN_CODE` payload. The actual char-length cap is re-enforced inside codeRunner.ts itself -- this is only the shape/type check at the IPC boundary, same pattern as `toRagIndexRequest`. */
function toRunCodeRequest(value: unknown): { language: CodingLanguage; code: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const language = v['language']
  if (typeof language !== 'string' || !CODING_LANGUAGE_SET.has(language)) return null

  const code = v['code']
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS) return null

  return { language: language as CodingLanguage, code }
}

/** Validates a `CODING_GET_HINTS` payload. */
function toHintsRequest(value: unknown): { problemText: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const problemText = v['problemText']
  if (typeof problemText !== 'string' || problemText.trim().length === 0 || problemText.length > MAX_PROBLEM_TEXT_CHARS) return null

  return { problemText }
}

/** Validates a `CODING_SUBMIT_REVIEW` payload. */
function toSubmitReviewRequest(value: unknown): { problemText: string; language: CodingLanguage; code: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const problemText = v['problemText']
  if (typeof problemText !== 'string' || problemText.trim().length === 0 || problemText.length > MAX_PROBLEM_TEXT_CHARS) return null

  const language = v['language']
  if (typeof language !== 'string' || !CODING_LANGUAGE_SET.has(language)) return null

  const code = v['code']
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS) return null

  return { problemText, language: language as CodingLanguage, code }
}

/**
 * The app windows:
 * - mainWindow: The full application window.
 * - ghostOverlayWindow: Floating, transparent, capture-excluded HUD overlay for meetings.
 */
let mainWindow: BrowserWindow | null = null
let ghostOverlayWindow: BrowserWindow | null = null
let savedOverlayBounds: { x: number; y: number; width: number; height: number } | null = null

let stealthAlwaysOnTop = false
// Default ON: the main window ships without a taskbar button, which (a) keeps it
// off the taskbar/Alt-Tab and (b) makes Windows Task Manager list the process
// under "Background processes" rather than "Apps". This does NOT hide the
// process -- it stays fully visible and named in Task Manager (and flat in the
// Details tab). Because there's no taskbar/Alt-Tab entry, the window is summoned
// with MAIN_WINDOW_HOTKEY (see below). Toggle it off in Settings if you want the
// normal taskbar button back.
let stealthSkipTaskbar = true
let ghostClickThrough = false
let ghostOpacity = 0.95

function getStealthState(): StealthState {
  return {
    contentProtected: mainWindow ? mainWindow.isContentProtected() : true,
    alwaysOnTop: stealthAlwaysOnTop,
    skipTaskbar: stealthSkipTaskbar,
    ghostOverlayActive: ghostOverlayWindow !== null && !ghostOverlayWindow.isDestroyed(),
    ghostClickThrough,
    ghostOpacity
  }
}

function broadcastStealthState(): void {
  sendToRenderer(IPC_CHANNELS.STEALTH_STATE_CHANGED, getStealthState())
}

/** Pushes a main-initiated event to all active windows that are displaying our trusted origin. */
function sendToRenderer(channel: string, payload: unknown): void {
  const targets = [mainWindow, ghostOverlayWindow]
  for (const win of targets) {
    if (win === null || win.isDestroyed()) continue
    if (!win.webContents.getURL().startsWith(trustedOrigin)) continue
    win.webContents.send(channel, payload)
  }
}

/**
 * Phase 2's main->renderer bridge for geminiLive.ts. This is the first
 * main-initiated ("push") IPC in the app -- everything before this was
 * renderer-initiated invoke/handle. Each event is sent on its own typed
 * channel (see IPC_CHANNELS.GEMINI_LIVE_*); preload.ts validates the payload
 * shape again on the way out to the renderer, the same "don't trust a bare
 * cast" discipline as invoke responses get in the other direction.
 */
const liveEventSink: geminiLive.GeminiLiveEventSink = {
  onTranscript: (event) => sendToRenderer(IPC_CHANNELS.GEMINI_LIVE_TRANSCRIPT, event),
  onAudioChunk: (event) => sendToRenderer(IPC_CHANNELS.GEMINI_LIVE_AUDIO_CHUNK, event),
  onConnectionState: (event) => sendToRenderer(IPC_CHANNELS.GEMINI_LIVE_CONNECTION_STATE, event),
  onInterrupted: () => sendToRenderer(IPC_CHANNELS.GEMINI_LIVE_INTERRUPTED, null),
  onAnswerReview: (event) => sendToRenderer(IPC_CHANNELS.GEMINI_LIVE_ANSWER_REVIEW, event)
}

// ---------------------------------------------------------------------------
// Phase 5: screenshot -> problem extraction (capture locally, preview,
// upload only after an explicit click).
//
// MockPilot is explicitly a normal, visible app with no screen-capture
// stealth tricks (see the setDisplayMediaRequestHandler comment below, which
// established that principle for Phase 1's system-audio capture). A global
// hotkey raises the stakes on that promise, so the design makes both silence
// AND silent upload structurally impossible:
//
//  - The hotkey is only registered while the Coding page is showing (see
//    `setHotkeyActive`), not for the app's whole lifetime -- a system-wide
//    registration would steal Ctrl+Shift+S from every other application.
//  - Pressing it (or the in-page button) captures the screen LOCALLY, before
//    MockPilot touches its own window, so the capture shows what the user was
//    looking at rather than MockPilot covering it. Nothing leaves the machine
//    at that point.
//  - Only then is the window brought forward and a downscaled preview pushed
//    to the renderer, which asks "Send to Gemini" / "Discard".
//  - The full-resolution capture is held in memory only (never written to
//    disk), at most one at a time, and dropped on discard, on a 2 minute
//    timeout, when the Coding page goes away, when the window closes/reloads,
//    and once it has been uploaded. Uploading requires the explicit
//    CODING_SCREENSHOT_CONFIRM call, which refuses if nothing is pending.
// ---------------------------------------------------------------------------

const SCREENSHOT_HOTKEY = 'CommandOrControl+Shift+S'

/**
 * Summons (shows + focuses) the main window. With `stealthSkipTaskbar` on there
 * is no taskbar button or Alt-Tab entry, so this is the reliable way to bring
 * the window back after it loses focus or is minimized.
 */
const MAIN_WINDOW_HOTKEY = 'CommandOrControl+Alt+M'

/** Minimum time between accepted captures -- ignores a second hotkey press (or button click) that lands within this window of the last one, so an accidental double-press/hold doesn't fire two captures. */
const SCREENSHOT_DEBOUNCE_MS = 5_000

/** How long a captured-but-unconfirmed screenshot is held in memory before it is discarded. */
const PENDING_CAPTURE_TTL_MS = 2 * 60 * 1000

/** Longest side of the image handed to Gemini. Plenty of resolution for a vision call to read on-screen text without an oversized payload on very high-DPI displays. */
const UPLOAD_MAX_DIMENSION_PX = 1920

/** Preview widths tried in order until the encoded data URL fits `MAX_SCREENSHOT_PREVIEW_CHARS`. */
const PREVIEW_WIDTHS_PX = [960, 640, 400]

/** Guards concurrent captures/uploads app-wide -- same "never trust the UI alone" discipline as codeRunner.ts's runInFlight; the renderer's own button-disabled state is not the only protection. */
let screenshotInFlight = false
let lastScreenshotAtMs = 0

interface PendingCapture {
  image: NativeImage
  timer: NodeJS.Timeout
}

/** The single screenshot awaiting the user's confirm/discard. In memory only. */
let pendingCapture: PendingCapture | null = null

function clearPendingCapture(): void {
  if (pendingCapture === null) return
  clearTimeout(pendingCapture.timer)
  pendingCapture = null
}

function holdPendingCapture(image: NativeImage): void {
  clearPendingCapture()
  const timer = setTimeout(() => {
    if (pendingCapture !== null && pendingCapture.timer === timer) {
      pendingCapture = null
      // Also how the renderer learns to drop its (now dead) preview.
      sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, {
        ok: false,
        error: 'The screenshot preview expired and was discarded. Nothing was sent to Gemini.'
      })
    }
  }, PENDING_CAPTURE_TTL_MS)
  timer.unref()
  pendingCapture = { image, timer }
}

/** Restores/shows/focuses the app window. Called only AFTER the screen has been captured, so it can't end up in the shot. */
function bringWindowForward(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Synchronous accept/reject gate, shared by the hotkey handler and the
 * CODING_SCREENSHOT_CAPTURE_NOW IPC handler -- both trigger paths go through
 * this one function so there's exactly one place that decides "yes, start a
 * capture" and one debounce/concurrency guard for both. Kicks off the actual
 * (async) local capture fire-and-forget on acceptance; the caller only ever
 * learns whether the request was *accepted* (see
 * IPC_CHANNELS.CODING_SCREENSHOT_CAPTURE_NOW's doc comment for why).
 */
function triggerScreenshotCapture(): OperationResult {
  if (screenshotInFlight) {
    return { ok: false, error: 'A screenshot capture is already in progress.' }
  }
  const now = Date.now()
  if (now - lastScreenshotAtMs < SCREENSHOT_DEBOUNCE_MS) {
    return { ok: false, error: 'Please wait a few seconds before capturing another screenshot.' }
  }
  lastScreenshotAtMs = now
  screenshotInFlight = true
  void runScreenshotCapture()
  return { ok: true }
}

/** Captures the display currently under the mouse cursor (not blindly `sources[0]`, which on a multi-monitor setup may be a different screen entirely). Returns `null` if no usable frame came back. */
async function captureCursorDisplay(): Promise<NativeImage | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  let width = Math.max(1, Math.round(display.size.width * display.scaleFactor))
  let height = Math.max(1, Math.round(display.size.height * display.scaleFactor))
  const shrink = Math.min(1, UPLOAD_MAX_DIMENSION_PX / Math.max(width, height))
  width = Math.max(1, Math.round(width * shrink))
  height = Math.max(1, Math.round(height * shrink))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (source === undefined || source.thumbnail.isEmpty()) return null
  return source.thumbnail
}

/** Downscaled JPEG data URL for the preview -- never the full-resolution capture. Returns `null` if even the smallest width doesn't fit the preview cap. */
function makePreviewDataUrl(image: NativeImage): string | null {
  const { width } = image.getSize()
  for (const target of PREVIEW_WIDTHS_PX) {
    const scaled = width > target ? image.resize({ width: target, quality: 'good' }) : image
    const dataUrl = `data:image/jpeg;base64,${scaled.toJPEG(80).toString('base64')}`
    if (dataUrl.length <= MAX_SCREENSHOT_PREVIEW_CHARS) return dataUrl
  }
  return null
}

/**
 * Local half of the screenshot flow: check the API key exists (no point
 * capturing the screen for a feature that can't work), capture, THEN bring
 * the window forward and push the preview. Nothing is uploaded here. Never
 * throws -- a failure pushes one CODING_SCREENSHOT_RESULT error instead.
 */
async function runScreenshotCapture(): Promise<void> {
  try {
    if (!(await keyVault.hasApiKey())) {
      clearPendingCapture()
      bringWindowForward()
      sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, { ok: false, error: 'No API key saved yet. Add one in Settings first.' })
      return
    }

    const image = await captureCursorDisplay()
    const previewDataUrl = image === null ? null : makePreviewDataUrl(image)
    if (image === null || previewDataUrl === null) {
      clearPendingCapture()
      bringWindowForward()
      sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, { ok: false, error: 'Could not capture the screen.' })
      return
    }

    holdPendingCapture(image)
    bringWindowForward()
    sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_PREVIEW, { previewDataUrl })
  } catch (err) {
    console.error('[coding] screenshot capture failed:', redact(String(err)))
    clearPendingCapture()
    bringWindowForward()
    sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, { ok: false, error: 'Could not capture the screen.' })
  } finally {
    screenshotInFlight = false
  }
}

/**
 * The ONLY path that uploads a screenshot: reached solely through the gated
 * CODING_SCREENSHOT_CONFIRM handler, i.e. an explicit click on the preview's
 * "Send to Gemini" button. Takes ownership of the pending capture (so it can
 * only ever be sent once) and refuses if there isn't one.
 */
function confirmPendingScreenshot(): OperationResult {
  if (pendingCapture === null) {
    return { ok: false, error: 'There is no screenshot waiting to be sent -- it may have expired. Capture again.' }
  }
  if (screenshotInFlight) {
    return { ok: false, error: 'A screenshot capture is already in progress.' }
  }
  const { image } = pendingCapture
  clearPendingCapture()
  screenshotInFlight = true
  void runScreenshotUpload(image)
  return { ok: true }
}

/** Upload half of the screenshot flow. Pushes exactly one CODING_SCREENSHOT_RESULT. Never throws. */
async function runScreenshotUpload(image: NativeImage): Promise<void> {
  try {
    const pngBase64 = image.toPNG().toString('base64')
    const result = await codingAssist.extractProblemFromScreenshot(pngBase64)
    sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, result)
  } catch (err) {
    console.error('[coding] screenshot upload failed:', redact(String(err)))
    sendToRenderer(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, { ok: false, error: 'Could not process the screenshot.' })
  } finally {
    screenshotInFlight = false
  }
}

let hotkeyRegistered = false

function unregisterHotkey(): void {
  if (!hotkeyRegistered) return
  globalShortcut.unregister(SCREENSHOT_HOTKEY)
  hotkeyRegistered = false
}

/**
 * Holds the global hotkey only while the Coding page is showing. Turning it
 * off also drops any held capture -- once the user has left the page there is
 * no preview UI left to confirm it from. `register()` never throws; it
 * returns false if another application already owns the accelerator, which is
 * reported to the renderer (so it can say so) rather than only logged.
 */
function setHotkeyActive(active: boolean): SetHotkeyResult {
  if (!active) {
    unregisterHotkey()
    clearPendingCapture()
    return { ok: true, registered: false }
  }
  if (hotkeyRegistered) return { ok: true, registered: true }

  const registered = globalShortcut.register(SCREENSHOT_HOTKEY, () => {
    const result = triggerScreenshotCapture()
    if (!result.ok) {
      console.warn('[coding] screenshot hotkey ignored:', result.error)
    }
  })
  hotkeyRegistered = registered
  if (!registered) {
    console.warn(`[coding] could not register the ${SCREENSHOT_HOTKEY} screenshot hotkey -- it may already be in use by another application.`)
    return { ok: true, registered: false, error: `${SCREENSHOT_HOTKEY_LABEL} is already in use by another application.` }
  }
  return { ok: true, registered: true }
}

/**
 * Window/taskbar icon. Packaged: electron-builder's `extraResources` copies
 * build/icon.png to <resources>/icon.png (a file inside app.asar would not be
 * reliably readable as a native image). Dev: straight from the project's build/.
 */
const windowIconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    icon: windowIconPath,
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'MockPilot',
    webPreferences: {
      // Preload is built as CommonJS (.cjs) -- see electron.vite.config.ts.
      // Electron's sandboxed preload loader does not support ESM `import`.
      preload: join(__dirname, '../preload/preload.cjs'),
      // Non-negotiable security posture: the renderer is untrusted. It gets
      // no Node access and no direct access to the main-process context; all
      // communication goes through the typed contextBridge API in preload.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // Windows SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
  // Ensures the window content is excluded from all screen captures:
  // Zoom, Microsoft Teams, Google Meet, OBS Studio, Discord, etc.
  win.setContentProtection(true)
  if (stealthAlwaysOnTop) {
    win.setAlwaysOnTop(true, 'floating')
  }
  if (stealthSkipTaskbar) {
    win.setSkipTaskbar(true)
  }

  // Only ever hand a window.open()/target="_blank" URL to the OS browser, and
  // only if it's plain https -- shell.openExternal on Windows routes through
  // ShellExecute, which will happily launch any registered protocol handler
  // (file:, ms-msdt:, search-ms:, ...), turning an unchecked URL into a local
  // code-execution pivot.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') {
        void shell.openExternal(url).catch(() => {
          // Best-effort; nothing to recover into if the OS can't open it.
        })
      }
    } catch {
      // Malformed URL -- drop it.
    }
    return { action: 'deny' }
  })

  // Block top-level navigation away from the app's own renderer. Without
  // this, `location.href = 'https://…'` (e.g. from injected content) would
  // load an attacker-controlled page into this same webContents, and it
  // would inherit the preload script and window.api along with it.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(trustedOrigin)) {
      event.preventDefault()
    }
  })

  if (isDev) {
    void win.loadURL(trustedOrigin).catch((err: unknown) => {
      dialog.showErrorBox('MockPilot failed to load', redact(String(err)))
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html')).catch((err: unknown) => {
      dialog.showErrorBox('MockPilot failed to load', redact(String(err)))
    })
  }

  // A closed window can't receive pushed events, and leaving a live session
  // open with nothing consuming it would just leak a websocket -- tear it
  // down the same way Interview.tsx's own teardown() does on unmount.
  win.on('closed', () => {
    geminiLive.stopSession()
    clearPendingCapture()
    unregisterHotkey()
    if (mainWindow === win) {
      mainWindow = null
    }
    broadcastStealthState()
  })

  // A renderer crash, or a reload (Ctrl+R, or any same-origin navigation --
  // will-navigate above only blocks *cross*-origin navigation, a same-origin
  // reload sails right through it), leaves geminiLive's session non-null with
  // nothing left to consume its events or ever call stopSession() again --
  // every future startLiveSession() would then permanently report "already
  // running" for the rest of the app's lifetime, while the socket stays open
  // to Google. Tear the session down on both.
  //
  // The same two events also release the screenshot hotkey and drop any held
  // capture: the Coding page's unmount effect (which normally releases them)
  // never runs on a crash or reload, and neither should outlive the page.
  win.webContents.on('render-process-gone', () => {
    usage.resetCoding()
    geminiLive.stopSession()
    clearPendingCapture()
    unregisterHotkey()
  })
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      usage.resetCoding() // the coding total belongs to this renderer's lifetime
      geminiLive.stopSession()
      clearPendingCapture()
      unregisterHotkey()
    }
  })

  return win
}

/**
 * Creates the floating, transparent, borderless Ghost HUD overlay.
 * Uses SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) to stay
 * 100% invisible to Zoom, Teams, Meet, OBS, and screen sharing.
 */
function createGhostOverlayWindow(): BrowserWindow {
  if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
    ghostOverlayWindow.show()
    ghostOverlayWindow.focus()
    return ghostOverlayWindow
  }

  let width = 520
  let height = 360
  let x: number
  let y: number

  if (savedOverlayBounds) {
    width = savedOverlayBounds.width
    height = savedOverlayBounds.height
    x = savedOverlayBounds.x
    y = savedOverlayBounds.y

    // Ensure the saved coordinates are still on an active display screen
    const display = screen.getDisplayMatching(savedOverlayBounds)
    const wa = display.workArea
    if (x < wa.x - 100 || x > wa.x + wa.width - 50 || y < wa.y - 50 || y > wa.y + wa.height - 50) {
      // Re-anchor if saved bounds ended up off-screen
      x = Math.round(wa.x + wa.width - width - 24)
      y = Math.round(wa.y + 48)
    }
  } else {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    x = Math.round(display.workArea.x + display.workArea.width - width - 24)
    y = Math.round(display.workArea.y + 48)
  }

  const overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 340,
    minHeight: 220,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    hasShadow: false,
    title: 'Assistant',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Crucial: SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
  overlay.setContentProtection(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setOpacity(ghostOpacity)

  if (ghostClickThrough) {
    overlay.setIgnoreMouseEvents(true, { forward: true })
  }

  // Persist window position & bounds as candidate repositions or resizes the overlay
  const updateSavedBounds = (): void => {
    if (!overlay.isDestroyed()) {
      savedOverlayBounds = overlay.getBounds()
    }
  }
  overlay.on('moved', updateSavedBounds)
  overlay.on('resized', updateSavedBounds)

  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlay.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(trustedOrigin)) {
      event.preventDefault()
    }
  })

  if (isDev) {
    void overlay.loadURL(`${trustedOrigin}#overlay`).catch((err: unknown) => {
      console.error('[overlay] failed to load URL:', redact(String(err)))
    })
  } else {
    void overlay.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' }).catch((err: unknown) => {
      console.error('[overlay] failed to load file:', redact(String(err)))
    })
  }

  overlay.once('ready-to-show', () => {
    overlay.show()
    broadcastStealthState()
  })

  overlay.on('closed', () => {
    if (ghostOverlayWindow === overlay) {
      ghostOverlayWindow = null
    }
    broadcastStealthState()
  })

  ghostOverlayWindow = overlay
  broadcastStealthState()
  return overlay
}

function toggleGhostOverlay(): boolean {
  if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
    savedOverlayBounds = ghostOverlayWindow.getBounds()
    ghostOverlayWindow.close()
    ghostOverlayWindow = null
    broadcastStealthState()
    return false
  } else {
    createGhostOverlayWindow()
    return true
  }
}

/**
 * Instant panic dismissal: immediately closes overlay, mutes/aborts active live interview
 * session, clears any held captures, and broadcasts panic signal to renderer.
 */
function panicClose(): void {
  if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
    savedOverlayBounds = ghostOverlayWindow.getBounds()
    ghostOverlayWindow.close()
    ghostOverlayWindow = null
  }
  geminiLive.stopSession()
  clearPendingCapture()
  sendToRenderer(IPC_CHANNELS.STEALTH_PANIC, null)
  broadcastStealthState()
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.KEY_VAULT_HAS, async (event): Promise<boolean> => {
    if (!isTrustedSender(event)) return false
    return keyVault.hasApiKey()
  })

  ipcMain.handle(IPC_CHANNELS.KEY_VAULT_SET, async (event, apiKey: unknown): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 512) {
      return { ok: false, error: 'Invalid API key.' }
    }
    return keyVault.setApiKey(apiKey)
  })

  ipcMain.handle(IPC_CHANNELS.KEY_VAULT_DELETE, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    return keyVault.deleteApiKey()
  })

  ipcMain.handle(IPC_CHANNELS.GEMINI_TEST_KEY, async (event): Promise<TestKeyResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    return gemini.testKey()
  })

  ipcMain.handle(IPC_CHANNELS.GEMINI_LIVE_START, async (event, setup: unknown): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    const validated = toInterviewSetup(setup)
    if (validated === null) return { ok: false, error: 'Invalid interview setup.' }
    // Optional drill focus, carried as an extra key next to the setup fields.
    // Bounded/normalized here (<= 5 labels, each <= 60 raw chars) and again
    // inside geminiLive before it can reach the prompt.
    const focusTopics = parseFocusTopics((setup as Record<string, unknown>)['focusTopics'])
    if (focusTopics === null) return { ok: false, error: 'Invalid focus topics.' }
    return geminiLive.startSession(liveEventSink, validated, focusTopics)
  })

  ipcMain.handle(IPC_CHANNELS.GEMINI_LIVE_STOP, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    return geminiLive.stopSession()
  })

  ipcMain.handle(IPC_CHANNELS.GEMINI_LIVE_SEND_AUDIO, async (event, chunk: unknown): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    // Mic chunks only ever originate as an ArrayBuffer (see preload.ts) --
    // anything else crossing this boundary is rejected outright. The actual
    // byte-length bound (MAX_AUDIO_CHUNK_BYTES) is enforced inside
    // geminiLive.sendAudioChunk itself, which is the single source of truth
    // for "what a valid chunk looks like" regardless of caller.
    if (!(chunk instanceof ArrayBuffer)) {
      return { ok: false, error: 'Invalid audio chunk.' }
    }
    return geminiLive.sendAudioChunk(chunk)
  })

  ipcMain.handle(IPC_CHANNELS.RAG_INDEX_MATERIALS, async (event, payload: unknown): Promise<RagIndexResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    const validated = toRagIndexRequest(payload)
    if (validated === null) return { ok: false, error: 'Invalid request.' }
    return rag.indexMaterials(validated.resumePdfBytes, validated.jdText)
  })

  ipcMain.handle(IPC_CHANNELS.RAG_STATUS, async (event): Promise<RagStatusResult> => {
    if (!isTrustedSender(event)) return { resumeChunkCount: 0, jdChunkCount: 0 }
    return rag.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.RAG_CLEAR_MATERIALS, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    return rag.clearMaterials()
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_LIST_SESSIONS, async (event, payload: unknown): Promise<HistoryListResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.', sessions: [], hasMore: false }
    const validated = toHistoryListRequest(payload)
    if (validated === null) return { ok: false, error: 'Invalid request.', sessions: [], hasMore: false }
    return history.listSessions(validated.limit, validated.offset)
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_GET_SESSION, async (event, sessionId: unknown): Promise<HistorySessionDetailResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    const id = toSessionId(sessionId)
    if (id === null) return { ok: false, error: 'Invalid request.' }
    return history.getSessionDetail(id)
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_TOPIC_STATS, async (event): Promise<HistoryTopicStatsResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.', topics: [], trend: [] }
    return history.getTopicStats()
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_WEAK_AREAS, async (event, limit: unknown): Promise<HistoryWeakAreasResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.', areas: [] }
    const validated = toWeakAreasLimit(limit)
    if (validated === null) return { ok: false, error: 'Invalid request.', areas: [] }
    return history.getWeakAreas(validated)
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_DELETE_SESSION, async (event, sessionId: unknown): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    const id = toSessionId(sessionId)
    if (id === null) return { ok: false, error: 'Invalid request.' }
    // Enforced here, not just by hiding the button: deleting the row a live
    // interview is still appending to would silently lose the rest of it.
    if (geminiLive.getActiveHistorySessionId() === id) {
      return { ok: false, error: 'That session is still in progress. Stop the interview first.' }
    }
    return history.deleteSession(id)
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_CLEAR_ALL, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    if (geminiLive.getActiveHistorySessionId() !== null) {
      return { ok: false, error: 'An interview is in progress. Stop it before clearing history.' }
    }
    return history.clearAllHistory()
  })

  ipcMain.handle(IPC_CHANNELS.CODING_SCREENSHOT_CAPTURE_NOW, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    // Only the API-key check and local capture run behind this; nothing is
    // uploaded until CODING_SCREENSHOT_CONFIRM.
    return triggerScreenshotCapture()
  })

  ipcMain.handle(IPC_CHANNELS.CODING_SCREENSHOT_CONFIRM, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    return confirmPendingScreenshot()
  })

  ipcMain.handle(IPC_CHANNELS.CODING_SCREENSHOT_DISCARD, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    clearPendingCapture()
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.CODING_SET_HOTKEY_ACTIVE, async (event, active: unknown): Promise<SetHotkeyResult> => {
    if (!isTrustedSender(event)) return { ok: false, registered: false, error: 'Unauthorized.' }
    if (typeof active !== 'boolean') return { ok: false, registered: false, error: 'Invalid request.' }
    return setHotkeyActive(active)
  })

  ipcMain.handle(IPC_CHANNELS.USAGE_GET, async (event): Promise<UsageSnapshot> => {
    // Untrusted sender: an all-zero snapshot, never the real counters.
    if (!isTrustedSender(event)) return { ...usage.getSnapshot(), ok: false, categories: usage.emptyCategories() }
    return usage.getSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.CODING_RUN_CODE, async (event, payload: unknown): Promise<RunCodeResult> => {
    if (!isTrustedSender(event)) return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Unauthorized.' }
    const validated = toRunCodeRequest(payload)
    if (validated === null) return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Invalid request.' }
    return codeRunner.runCode(validated.language, validated.code)
  })

  ipcMain.handle(IPC_CHANNELS.CODING_GET_HINTS, async (event, payload: unknown): Promise<HintsResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    const validated = toHintsRequest(payload)
    if (validated === null) return { ok: false, error: 'Invalid request.' }
    return codingAssist.generateHints(validated.problemText)
  })

  ipcMain.handle(IPC_CHANNELS.CODING_SUBMIT_REVIEW, async (event, payload: unknown): Promise<CodeReviewResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    const validated = toSubmitReviewRequest(payload)
    if (validated === null) return { ok: false, error: 'Invalid request.' }
    return codingAssist.reviewCode(validated)
  })

  // Direct 'screen-protection' handler matching user requirement
  ipcMain.handle('screen-protection', async (event, enabled: unknown): Promise<boolean> => {
    if (!isTrustedSender(event)) return false
    const shouldProtect = enabled === true
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(shouldProtect)
    }
    if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
      ghostOverlayWindow.setContentProtection(shouldProtect)
    }
    broadcastStealthState()
    return mainWindow ? mainWindow.isContentProtected() : shouldProtect
  })

  ipcMain.handle(IPC_CHANNELS.SCREEN_PROTECTION_GET, async (event): Promise<boolean> => {
    if (!isTrustedSender(event)) return false
    return mainWindow ? mainWindow.isContentProtected() : true
  })

  ipcMain.handle(IPC_CHANNELS.SCREEN_PROTECTION_SET, async (event, enabled: unknown): Promise<{ ok: boolean; protected: boolean }> => {
    if (!isTrustedSender(event)) return { ok: false, protected: false }
    const shouldProtect = enabled === true
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(shouldProtect)
    }
    if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
      ghostOverlayWindow.setContentProtection(shouldProtect)
    }
    broadcastStealthState()
    const isProt = mainWindow ? mainWindow.isContentProtected() : shouldProtect
    return { ok: true, protected: isProt }
  })

  ipcMain.handle(IPC_CHANNELS.STEALTH_GET_STATE, async (event): Promise<StealthState> => {
    if (!isTrustedSender(event)) return getStealthState()
    return getStealthState()
  })

  ipcMain.handle(IPC_CHANNELS.STEALTH_SET_ALWAYS_ON_TOP, async (event, enabled: unknown): Promise<{ ok: boolean; alwaysOnTop: boolean }> => {
    if (!isTrustedSender(event)) return { ok: false, alwaysOnTop: stealthAlwaysOnTop }
    stealthAlwaysOnTop = enabled === true
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(stealthAlwaysOnTop, 'floating')
    }
    broadcastStealthState()
    return { ok: true, alwaysOnTop: stealthAlwaysOnTop }
  })

  ipcMain.handle(IPC_CHANNELS.STEALTH_SET_SKIP_TASKBAR, async (event, enabled: unknown): Promise<{ ok: boolean; skipTaskbar: boolean }> => {
    if (!isTrustedSender(event)) return { ok: false, skipTaskbar: stealthSkipTaskbar }
    stealthSkipTaskbar = enabled === true
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(stealthSkipTaskbar)
    }
    broadcastStealthState()
    return { ok: true, skipTaskbar: stealthSkipTaskbar }
  })

  ipcMain.handle(IPC_CHANNELS.GHOST_OVERLAY_TOGGLE, async (event): Promise<{ ok: boolean; active: boolean }> => {
    if (!isTrustedSender(event)) return { ok: false, active: false }
    const active = toggleGhostOverlay()
    return { ok: true, active }
  })

  ipcMain.handle(IPC_CHANNELS.GHOST_OVERLAY_CLICK_THROUGH, async (event, clickThrough: unknown): Promise<{ ok: boolean; clickThrough: boolean }> => {
    if (!isTrustedSender(event)) return { ok: false, clickThrough: ghostClickThrough }
    ghostClickThrough = clickThrough === true
    if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
      ghostOverlayWindow.setIgnoreMouseEvents(ghostClickThrough, { forward: true })
    }
    broadcastStealthState()
    return { ok: true, clickThrough: ghostClickThrough }
  })

  ipcMain.handle(IPC_CHANNELS.GHOST_OVERLAY_OPACITY, async (event, opacity: unknown): Promise<{ ok: boolean; opacity: number }> => {
    if (!isTrustedSender(event)) return { ok: false, opacity: ghostOpacity }
    if (typeof opacity === 'number' && opacity >= 0.1 && opacity <= 1.0) {
      ghostOpacity = opacity
      if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
        ghostOverlayWindow.setOpacity(ghostOpacity)
      }
      broadcastStealthState()
    }
    return { ok: true, opacity: ghostOpacity }
  })

  ipcMain.handle(IPC_CHANNELS.STEALTH_PANIC, async (event): Promise<OperationResult> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized.' }
    panicClose()
    return { ok: true }
  })
}

// Belt-and-braces default for any webContents this app ever creates
// (popups, devtools, future views): deny window.open() unless a window's own
// handler (above) explicitly allows it.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

// Single instance (per userData directory -- Electron derives the lock from it,
// so a throwaway `--user-data-dir` gets its own lock). A second MockPilot on the
// same profile would open the same SQLite files, and its history crash-recovery
// (stamp `ended_at` on every session lacking one) would close out the FIRST
// instance's LIVE interview. The second launch quits immediately and the first
// window is brought to the front instead. Works the same in dev and packaged
// builds; the only side effect is that `electron-vite dev` and an installed
// MockPilot cannot run at the same time on the same profile.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

void app
  .whenReady()
  .then(() => {
    if (!gotSingleInstanceLock) return // this launch is quitting; touch nothing (no DB, no windows, no shortcuts)

    // Deny every permission request by default, from any origin but our own;
    // only the mic (`media`, audio only -- NOT video/camera) and system-audio
    // loopback (`display-capture`, requested by getDisplayMedia -- see
    // setDisplayMediaRequestHandler below) are needed, starting in Phase 1.
    // Don't inherit Chromium's defaults for geolocation, notifications, etc.,
    // and don't let `'media'` cover the camera just because Chromium's
    // permission taxonomy bundles audio+video capture under one name.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const origin = 'securityOrigin' in details ? details.securityOrigin : undefined
      if (origin !== undefined && !origin.startsWith(trustedOrigin)) {
        callback(false)
        return
      }
      if (permission === 'display-capture') {
        callback(true)
        return
      }
      if (permission === 'media') {
        const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
        callback(mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio'))
        return
      }
      callback(false)
    })

    // Synchronous counterpart to the request handler above -- Electron's own
    // docs note some web APIs do a permission *check* first and only fall
    // back to a *request* if that check is denied; without this handler,
    // those checks fall through to Chromium's defaults instead of this app's
    // deny-by-default posture.
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      if (!requestingOrigin.startsWith(trustedOrigin)) return false
      if (permission === 'display-capture') return true
      if (permission === 'media') {
        return 'mediaType' in details ? details.mediaType === 'audio' : false
      }
      return false
    })

    // Phase 1: route the renderer's getDisplayMedia({ audio: true }) call
    // (src/audio/capture.ts) to Windows system-audio loopback. The renderer
    // requests video too -- Windows loopback audio capture requires it -- but
    // discards the video track immediately; we still have to hand back a
    // real screen source for the request to succeed at all.
    //
    // MockPilot is explicitly a normal, visible app with no screen-capture
    // stealth tricks -- but silently auto-granting a live screen-video track
    // to *any* caller with no user-visible gate is still the wrong default,
    // so this only proceeds for our own renderer origin, and only in
    // response to a real user gesture (there's no picker UI here, so a
    // user click is the only consent signal available). Thumbnails are
    // fetched at zero size -- desktopCapturer.getSources() otherwise
    // captures a live bitmap of every screen into main-process memory on
    // every call, which this app never uses.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      if (!request.securityOrigin.startsWith(trustedOrigin) || !request.userGesture || !request.audioRequested) {
        callback({})
        return
      }

      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
        .then((sources) => {
          if (sources.length === 0) {
            // No source to hand back. Calling back with an empty object
            // rejects the renderer's pending getDisplayMedia() promise
            // cleanly -- if callback is never invoked at all, that promise
            // hangs forever instead.
            callback({})
            return
          }
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((err: unknown) => {
          console.error('[display-media] failed to enumerate screen sources:', redact(String(err)))
          callback({})
        })
    })

    // Enforce CSP as a response header (covers every load, unlike the <meta>
    // tag in index.html, which only applies to the document that carries it
    // and would evaporate if a navigation-based attack ever got past
    // will-navigate above). The meta tag stays too, as defense-in-depth.
    // Always on, in both dev and prod -- dev gets the narrower DEV_CSP (see
    // its definition above) rather than no policy at all.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [isDev ? DEV_CSP : CSP]
        }
      })
    })

    registerIpcHandlers()
    mainWindow = createMainWindow()

    // Register global shortcuts for Ghost HUD overlay (Ctrl+Alt+G) and Click-Through (Ctrl+Alt+C)
    try {
      globalShortcut.register(GHOST_OVERLAY_HOTKEY, () => {
        toggleGhostOverlay()
      })
    } catch (e) {
      console.warn('[stealth] could not register ghost overlay hotkey:', redact(String(e)))
    }

    try {
      globalShortcut.register(GHOST_CLICKTHROUGH_HOTKEY, () => {
        ghostClickThrough = !ghostClickThrough
        if (ghostOverlayWindow && !ghostOverlayWindow.isDestroyed()) {
          ghostOverlayWindow.setIgnoreMouseEvents(ghostClickThrough, { forward: true })
        }
        broadcastStealthState()
      })
    } catch (e) {
      console.warn('[stealth] could not register ghost clickthrough hotkey:', redact(String(e)))
    }

    try {
      globalShortcut.register(GHOST_PANIC_HOTKEY, () => {
        panicClose()
      })
    } catch (e) {
      console.warn('[stealth] could not register panic hotkey:', redact(String(e)))
    }

    // With no taskbar button / Alt-Tab entry (stealthSkipTaskbar default), this
    // is how the user brings the main window back to the foreground.
    try {
      globalShortcut.register(MAIN_WINDOW_HOTKEY, () => {
        bringWindowForward()
      })
    } catch (e) {
      console.warn('[stealth] could not register main-window hotkey:', redact(String(e)))
    }

    // The screenshot hotkey is deliberately NOT registered here: it is
    // held only while the Coding page is showing (CODING_SET_HOTKEY_ACTIVE),
    // so it doesn't steal Ctrl+Shift+S from other apps the rest of the time.

    // Best-effort: remove run dirs a previous crashed session left behind.
    void codeRunner.sweepStaleRunDirs()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      }
    })
  })
  .catch((err: unknown) => {
    dialog.showErrorBox('MockPilot failed to start', redact(String(err)))
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Checkpoints rag.sqlite3's WAL back into the main file on the way out, so
// deleted/superseded resume/JD text doesn't linger indefinitely in the WAL
// file after a "Clear stored resume/JD" or a re-index.
app.on('before-quit', () => {
  // End a live session first (saves its partial turns / marks it ended in
  // history), then close the DBs. history.closeDb() is FINAL (a `closed` flag),
  // so a review that resolves after this point can't reopen the history DB --
  // its write just fails and is logged.
  geminiLive.stopSession()
  rag.closeDb()
  history.closeDb()
})

// Global shortcuts are process-wide OS registrations that outlive any single
// BrowserWindow -- without this, the Ctrl+Shift+S hotkey would stay bound to
// this process (and keep firing screenshot captures with no window left to
// show them in) even after the app has otherwise quit.
app.on('will-quit', () => {
  clearPendingCapture()
  unregisterHotkey()
  globalShortcut.unregisterAll()
})

// An uncaught rejection/exception in the main process would otherwise crash
// the app silently (window created with `show: false` never gets to
// ready-to-show). Surface it instead of dying invisibly -- and redact, since
// this is exactly where a key-bearing error string would otherwise leak into
// a crash dialog.
process.on('unhandledRejection', (reason) => {
  dialog.showErrorBox('MockPilot', redact(String(reason)))
})
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('MockPilot', redact(err.message))
})
