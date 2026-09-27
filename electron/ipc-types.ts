/**
 * Shared IPC contract between the main process and the renderer.
 *
 * This file is the single source of truth for:
 *   - IPC channel names (used by both `preload.ts` and `main.ts`)
 *   - Request/response payload shapes
 *   - The typed `window.api` surface exposed via `contextBridge`
 *
 * IMPORTANT: This file must never import anything from `electron` or Node
 * built-ins, since it is imported by renderer-side code (for typing
 * `window.api`) as well as by the main process and preload script.
 */

/** Canonical IPC channel names. Keep these in sync with the handlers in main.ts. */
export const IPC_CHANNELS = {
  KEY_VAULT_HAS: 'key-vault:has',
  KEY_VAULT_SET: 'key-vault:set',
  KEY_VAULT_DELETE: 'key-vault:delete',
  GEMINI_TEST_KEY: 'gemini:test-key',

  // Phase 2 -- renderer-initiated request/response (ipcRenderer.invoke), same
  // shape as the four channels above. Phase 3: GEMINI_LIVE_START now carries
  // an InterviewSetup payload (see below).
  GEMINI_LIVE_START: 'gemini-live:start',
  GEMINI_LIVE_STOP: 'gemini-live:stop',
  GEMINI_LIVE_SEND_AUDIO: 'gemini-live:send-audio',

  // Phase 2 -- main-initiated push events (mainWindow.webContents.send), the
  // first main->renderer channels in this app. See preload.ts for how these
  // are subscribed to (window.api.onLive*) and validated before a listener
  // callback ever sees the payload.
  GEMINI_LIVE_TRANSCRIPT: 'gemini-live:transcript',
  GEMINI_LIVE_AUDIO_CHUNK: 'gemini-live:audio-chunk',
  GEMINI_LIVE_CONNECTION_STATE: 'gemini-live:connection-state',
  GEMINI_LIVE_INTERRUPTED: 'gemini-live:interrupted',

  // Phase 3 -- resume/JD ingestion (renderer-initiated invoke). The renderer
  // only ever sends raw PDF bytes + pasted JD text up; PDF parsing, chunking,
  // embedding and storage all happen main-process-side (electron/services/rag.ts).
  RAG_INDEX_MATERIALS: 'rag:index-materials',
  RAG_STATUS: 'rag:status',
  RAG_CLEAR_MATERIALS: 'rag:clear-materials',

  // Phase 4 -- main-initiated push event, same shape/discipline as the four
  // GEMINI_LIVE_* push channels above: one per completed candidate answer
  // turn, carrying the structured Gemini review (electron/services/review.ts)
  // plus local speech metrics (electron/lib/speechMetrics.ts).
  GEMINI_LIVE_ANSWER_REVIEW: 'gemini-live:answer-review',

  // Phase 5 -- coding round.
  //
  // Screenshot flow (local capture FIRST, upload only after an explicit click):
  //  1. CODING_SCREENSHOT_CAPTURE_NOW (renderer-initiated invoke, the in-page
  //     button) or the Ctrl+Shift+S global hotkey (registered ONLY while the
  //     Coding page is showing -- see CODING_SET_HOTKEY_ACTIVE) asks main to
  //     capture. It returns only whether the request was *accepted* (not
  //     already running, not debounced, API key present).
  //  2. Main captures the screen locally (nothing leaves the machine), THEN
  //     brings the window forward and pushes CODING_SCREENSHOT_PREVIEW with a
  //     downscaled preview image.
  //  3. The renderer shows the preview with "Send to Gemini" / "Discard".
  //     CODING_SCREENSHOT_CONFIRM uploads the held capture; CODING_SCREENSHOT_DISCARD
  //     drops it. Main holds at most one capture, in memory only, and drops it
  //     on discard/timeout/window close/leaving the Coding page.
  //  4. After a confirm, CODING_SCREENSHOT_RESULT is pushed once the Gemini
  //     vision extraction settles (also pushed for any failure or expiry
  //     along the way, which is how the renderer learns to clear its preview).
  CODING_SCREENSHOT_CAPTURE_NOW: 'coding:screenshot-capture-now',
  CODING_SCREENSHOT_PREVIEW: 'coding:screenshot-preview',
  CODING_SCREENSHOT_CONFIRM: 'coding:screenshot-confirm',
  CODING_SCREENSHOT_DISCARD: 'coding:screenshot-discard',
  CODING_SCREENSHOT_RESULT: 'coding:screenshot-result',
  // Renderer-initiated (invoke): the Coding page tells main whether it is
  // showing, so the global hotkey is held only while it is (a system-wide
  // registration for the app's whole lifetime would steal Ctrl+Shift+S from
  // every other application).
  CODING_SET_HOTKEY_ACTIVE: 'coding:set-hotkey-active',

  // Renderer-initiated (invoke): run the candidate's code locally (main
  // process only -- see electron/services/codeRunner.ts) and generate/submit
  // for the structured post-submission review (electron/services/codingAssist.ts).
  CODING_RUN_CODE: 'coding:run-code',
  CODING_GET_HINTS: 'coding:get-hints',
  CODING_SUBMIT_REVIEW: 'coding:submit-review',

  // Phase 6 -- history & analytics (renderer-initiated invoke). All reads and
  // writes happen main-process-side (electron/services/history.ts); the
  // renderer never touches the database. Sessions/turns/reviews are WRITTEN by
  // geminiLive.ts as the interview runs, never by the renderer.
  HISTORY_LIST_SESSIONS: 'history:list-sessions',
  HISTORY_GET_SESSION: 'history:get-session',
  HISTORY_TOPIC_STATS: 'history:topic-stats',
  HISTORY_WEAK_AREAS: 'history:weak-areas',
  HISTORY_DELETE_SESSION: 'history:delete-session',
  HISTORY_CLEAR_ALL: 'history:clear-all',

  // Phase 7 -- usage meter (renderer-initiated invoke, pull). Token counts are
  // accumulated main-process-side (electron/services/usage.ts).
  USAGE_GET: 'usage:get',

  // Stealth & Screen Protection (Windows SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE)
  SCREEN_PROTECTION_GET: 'screen-protection:get',
  SCREEN_PROTECTION_SET: 'screen-protection:set',
  STEALTH_GET_STATE: 'stealth:get-state',
  STEALTH_SET_ALWAYS_ON_TOP: 'stealth:set-always-on-top',
  STEALTH_SET_SKIP_TASKBAR: 'stealth:set-skip-taskbar',
  GHOST_OVERLAY_TOGGLE: 'ghost-overlay:toggle',
  GHOST_OVERLAY_CLICK_THROUGH: 'ghost-overlay:click-through',
  GHOST_OVERLAY_OPACITY: 'ghost-overlay:opacity',
  STEALTH_STATE_CHANGED: 'stealth:state-changed',
  STEALTH_PANIC: 'stealth:panic'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/**
 * Generic result shape for operations that can fail. IPC handlers should
 * never let a raw Error cross the IPC boundary (it loses its prototype and
 * stack when structured-cloned) -- they must catch and return this instead.
 */
export interface OperationResult {
  ok: boolean
  error?: string
}

/** Result of a Gemini API key connectivity check. */
export interface TestKeyResult {
  ok: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Phase 2: Gemini Live voice interview
// ---------------------------------------------------------------------------

/** Who a piece of live-transcribed speech belongs to. */
export type GeminiLiveSpeaker = 'user' | 'interviewer'

/**
 * One incremental transcript fragment. Gemini Live streams transcription in
 * pieces as speech is recognized/generated rather than one block per turn --
 * the renderer appends `textDelta` onto the current turn's running text for
 * `speaker`, and starts a new turn once a previous one's last fragment had
 * `finished: true` (or the speaker changes).
 */
export interface GeminiLiveTranscriptEvent {
  speaker: GeminiLiveSpeaker
  textDelta: string
  finished: boolean
}

/** One chunk of interviewer speech audio: raw PCM16 bytes, 24kHz, mono, little-endian (Gemini Live's fixed output format). */
export interface GeminiLiveAudioChunkEvent {
  audio: ArrayBuffer
}

export type GeminiLiveConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'

/**
 * Connection-state change for the live session. `message` is only ever a
 * fixed, user-facing string (see electron/services/gemini.ts's
 * `describeGeminiError`) -- never raw SDK/network error text, since that can
 * embed the API key in a `?key=` query parameter.
 */
export interface GeminiLiveConnectionStateEvent {
  state: GeminiLiveConnectionState
  message?: string
}

// ---------------------------------------------------------------------------
// Phase 3: interview setup + RAG (resume/JD ingestion and retrieval)
// ---------------------------------------------------------------------------

/** Fixed role choices offered on the Setup screen. */
export type InterviewRole = 'sde' | 'devops' | 'ai-ml' | 'data' | 'hr'

export const INTERVIEW_ROLES: readonly InterviewRole[] = ['sde', 'devops', 'ai-ml', 'data', 'hr']

/** Human-readable labels for `InterviewRole`, used both by Setup.tsx's <select> and by the prompt-building code in geminiLive.ts/rag.ts. */
export const INTERVIEW_ROLE_LABELS: Readonly<Record<InterviewRole, string>> = {
  sde: 'Software Engineer',
  devops: 'DevOps Engineer',
  'ai-ml': 'AI/ML Engineer',
  data: 'Data Analyst/Engineer',
  hr: 'HR / People'
}

/** Fixed difficulty choices. Threaded directly into the `{{difficulty}}` slot of prompts/interviewer.md ("... (medium level)"). */
export type InterviewDifficulty = 'easy' | 'medium' | 'hard'

export const INTERVIEW_DIFFICULTIES: readonly InterviewDifficulty[] = ['easy', 'medium', 'hard']

/** Per-session interview configuration, chosen on the Setup screen and threaded through to `GEMINI_LIVE_START`. */
export interface InterviewSetup {
  role: InterviewRole
  difficulty: InterviewDifficulty
  /** Free text, capped at `MAX_COMPANY_CHARS`. May be empty -- geminiLive.ts falls back to a generic company name. */
  company: string
  durationMinutes: number
}

/** Sensible defaults so an interview is always startable, even if the user never visits the Setup screen. */
export const DEFAULT_INTERVIEW_SETUP: InterviewSetup = {
  role: 'sde',
  difficulty: 'medium',
  company: '',
  durationMinutes: 15
}

export const MIN_DURATION_MINUTES = 5
export const MAX_DURATION_MINUTES = 90
export const MAX_COMPANY_CHARS = 200

/** Upper bound on a resume PDF's raw byte size, enforced both client-side (Setup.tsx, for a fast UX rejection) and main-process-side (rag.ts, the actual authority -- never trust the renderer's own check). */
export const MAX_RESUME_PDF_BYTES = 8 * 1024 * 1024

/** Upper bound on pasted job-description text, in characters. Enforced both in Setup.tsx (maxLength) and main-process-side in main.ts/rag.ts. */
export const MAX_JD_TEXT_CHARS = 20_000

/** Result of `RAG_INDEX_MATERIALS`: parse -> chunk -> embed -> store for whichever of resume/JD were provided. */
export interface RagIndexResult {
  ok: boolean
  error?: string
  /** Number of chunks stored for the resume, if resume bytes were part of this request. */
  resumeChunkCount?: number
  /** Number of chunks stored for the job description, if JD text was part of this request. */
  jdChunkCount?: number
}

/** Current chunk counts per source, as actually stored -- lets the UI show what's indexed independent of any local per-visit state. */
export interface RagStatusResult {
  resumeChunkCount: number
  jdChunkCount: number
}

// ---------------------------------------------------------------------------
// Phase 4: answer review (structured Gemini feedback + local speech metrics)
// ---------------------------------------------------------------------------

/** STAR-method checklist for one answer, as scored by the review call. */
export interface AnswerReviewStar {
  situation: boolean
  task: boolean
  action: boolean
  result: boolean
}

/**
 * Local (non-Gemini) speech metrics computed purely from transcript-fragment
 * text/timing -- see electron/lib/speechMetrics.ts's doc comments for how
 * each is derived and, for `longestPauseMs`, why it's an approximation.
 */
export interface AnswerSpeechMetrics {
  /** `null` when there wasn't enough signal (too few fragments, or too short a measured duration) to produce a meaningful rate -- see electron/lib/speechMetrics.ts's doc comment. Render as "—", not "0 wpm". */
  wpm: number | null
  fillerWordCount: number
  longestPauseMs: number
}

/**
 * Pushed once per completed candidate answer turn: the structured Gemini
 * review (score/STAR/missing points/technical errors/improved answer/
 * follow-up question) plus that turn's local speech metrics.
 *
 * `answerIndex` is a per-session, monotonically increasing counter assigned
 * by geminiLive.ts at the moment the answer turn finished -- NOT the order
 * these events necessarily *arrive* in, since the review call runs in
 * parallel with (never blocking) the live interview and a fast second answer
 * can resolve before a slower first answer's review does. The renderer keys
 * off `answerIndex`, not arrival order, to attach a result to the right
 * transcript turn.
 *
 * `ok: false` means the Gemini review call itself failed (missing/invalid
 * key, network error, malformed model response, ...) -- `error` is always a
 * fixed, user-facing string (see gemini.ts's `describeGeminiError`), never
 * raw SDK/network error text. `metrics` is populated either way, since it
 * never depends on Gemini.
 */
export interface GeminiLiveAnswerReviewEvent {
  answerIndex: number
  ok: boolean
  error?: string
  score?: number
  star?: AnswerReviewStar
  missingPoints?: string[]
  technicalErrors?: string[]
  improvedAnswer?: string
  followUpQuestion?: string
  /** Phase 6: normalized 1-4 word topic label for the question (see `normalizeTopicLabel`). Absent on a failed review. */
  topic?: string
  metrics: AnswerSpeechMetrics
}

// ---------------------------------------------------------------------------
// Phase 6: topics, focus (drill) sessions, history & analytics
// ---------------------------------------------------------------------------

/** Longest normalized topic label kept, in characters. A longer label is treated as garbage (a sentence, not a label), not truncated. */
export const MAX_TOPIC_CHARS = 40
/** Most words a topic label may have. The review prompt asks for 1-3; a little slack, but a sentence is rejected. */
const MAX_TOPIC_WORDS = 4
/** Label every review falls back to when the model's topic is missing or unusable. Never offered as a weak area (a "general" drill is meaningless). */
export const GENERAL_TOPIC = 'general'

/** Each whitespace-separated word must start with a letter/digit, may then use ` ./&'#-` inside, and may end in at most two `+` (c++). No other shapes. */
const TOPIC_WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}./&'#-]*\+{0,2}$/u
/** Two or more label-punctuation characters in a row (`---`, `..`, `//`, `'#`): the shape a prompt fence / markdown rule / comment takes. */
const TOPIC_PUNCT_RUN_RE = /[./&'#+-]{2,}/u
/** Words that are directives, not topics -- a label containing one is rejected outright (best-effort; the focus list is also rendered as a JSON array inside a data fence, see geminiLive.ts). Whole-word match, so "forgetting curve" is unaffected. */
const TOPIC_DIRECTIVE_WORDS: ReadonlySet<string> = new Set(['ignore', 'disregard', 'forget', 'override', 'bypass', 'jailbreak', 'instruction', 'instructions'])

/**
 * Normalizes a topic label (model-produced, or renderer-supplied for a drill)
 * to lowercase, single-spaced, letters/digits and a few label punctuation
 * characters only (` +#./&'-`). Returns `null` for anything that isn't a
 * plausible short label: non-string, empty after cleaning, more than
 * `MAX_TOPIC_WORDS` words, or longer than `MAX_TOPIC_CHARS`.
 *
 * Phase 7 tightening -- REJECTED (not "repaired"): any word that does not start
 * with a letter/digit (so `---`, `.net`, `&`, `'x` fail); any run of two or more
 * punctuation characters (`--`, `..`, `//`; the one exception is `c++`-style
 * `++` directly at the end of a word); `+` anywhere but the end of a word; and
 * labels containing a directive word (`ignore`, `disregard`, `override`,
 * `instructions`, ...). A label can therefore never mimic the `--- end focus
 * areas ---` fence or a markdown rule. Braces, colons, quotes, newlines and
 * brackets are still stripped to spaces first, so no template placeholder or
 * structural punctuation survives. Natural-language words themselves cannot be
 * filtered ("system design" is legitimate), so the residual risk -- a <=4 word,
 * <=40 char phrase of plain words -- is bounded by that size cap and by the
 * prompt rendering the list as a JSON array inside a reference-data fence.
 * Plain labels ("system design", "c++", "react hooks", "sql", "node.js") pass.
 * Pure, so main, preload and renderer can all share it.
 */
export function normalizeTopicLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 400) return null
  const cleaned = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} +#./&'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0 || cleaned.length > MAX_TOPIC_CHARS) return null
  const words = cleaned.split(' ')
  if (words.length > MAX_TOPIC_WORDS) return null
  for (const word of words) {
    if (!TOPIC_WORD_RE.test(word) || TOPIC_DIRECTIVE_WORDS.has(word)) return null
    // `c++` is the one legitimate punctuation run; strip a trailing `++`/`+` before the run check.
    if (TOPIC_PUNCT_RUN_RE.test(word.replace(/\+{1,2}$/, ''))) return null
  }
  return cleaned
}

/** Drill sessions carry at most this many focus topics. */
export const MAX_FOCUS_TOPICS = 5
/** Raw (pre-normalization) length cap per focus topic accepted from the renderer. */
export const MAX_FOCUS_TOPIC_INPUT_CHARS = 60

/**
 * Validates + normalizes a `focusTopics` value. `undefined`/`null` mean "not a
 * drill" (`[]`). Returns `null` (reject the request) for a non-array, more
 * than `MAX_FOCUS_TOPICS` entries, or any entry that isn't a string within
 * `MAX_FOCUS_TOPIC_INPUT_CHARS`. Entries that normalize to nothing usable are
 * dropped; duplicates are removed.
 */
export function parseFocusTopics(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_FOCUS_TOPICS) return null
  const out: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.length > MAX_FOCUS_TOPIC_INPUT_CHARS) return null
    const label = normalizeTopicLabel(item)
    if (label !== null && label !== GENERAL_TOPIC && !out.includes(label)) out.push(label)
  }
  return out
}

/** Minimum number of persisted reviews a topic needs before it can be ranked as a weak area, so one bad answer can't dominate. */
export const MIN_WEAK_AREA_SAMPLES = 2
/** A topic is only a "weak area" if its average score is below this (7 = "would pass at this level" in prompts/review.md). */
export const WEAK_AREA_SCORE_THRESHOLD = 7

/** Page-size / payload bounds for the history IPC channels. Enforced in main.ts (request) and history.ts (query), re-checked in preload.ts (response). */
export const HISTORY_MAX_PAGE_SIZE = 100
export const HISTORY_MAX_OFFSET = 100_000
export const HISTORY_MAX_TURNS_RETURNED = 500
export const HISTORY_MAX_REVIEWS_RETURNED = 200
export const HISTORY_MAX_TOPICS_RETURNED = 50
export const HISTORY_MAX_TREND_POINTS = 1_000
export const HISTORY_MAX_WEAK_AREAS = 10

/** One past session, as listed on the History page. `avgScore` is computed from the session's persisted reviews at read time (`null` when it has none). */
export interface HistorySessionSummary {
  id: number
  /** ms since epoch. */
  startedAt: number
  /** ms since epoch; `null` while the session is still live. */
  endedAt: number | null
  role: InterviewRole
  difficulty: InterviewDifficulty
  company: string
  durationMinutes: number
  /** Non-empty only for a drill session. */
  focusTopics: string[]
  answerCount: number
  avgScore: number | null
}

export interface HistoryListResult {
  ok: boolean
  error?: string
  sessions: HistorySessionSummary[]
  /** True when more sessions exist past `offset + sessions.length`. */
  hasMore: boolean
}

export interface HistoryTurn {
  id: number
  idx: number
  speaker: GeminiLiveSpeaker
  text: string
  startedAt: number
  finishedAt: number
}

/** A persisted answer review. Deliberately not the same shape as the live `GeminiLiveAnswerReviewEvent` (always `ok`, has a turn link + timestamp); src/lib/historyMapping.ts converts for display. */
export interface HistoryReview {
  id: number
  answerIndex: number
  /** The candidate turn this answer was transcribed into, when that write succeeded. */
  turnId: number | null
  question: string
  score: number
  star: AnswerReviewStar
  missingPoints: string[]
  technicalErrors: string[]
  improvedAnswer: string
  followUpQuestion: string
  metrics: AnswerSpeechMetrics
  topic: string
  createdAt: number
}

export interface HistorySessionDetailResult {
  ok: boolean
  error?: string
  session?: HistorySessionSummary
  turns?: HistoryTurn[]
  reviews?: HistoryReview[]
  /** True when the session had more turns than `HISTORY_MAX_TURNS_RETURNED`. */
  turnsTruncated?: boolean
}

export interface TopicStat {
  topic: string
  count: number
  /** 1-10, one decimal. */
  avgScore: number
}

/** Average score for one topic on one local calendar day. */
export interface TopicTrendPoint {
  topic: string
  /** Local date, `YYYY-MM-DD`. */
  day: string
  avgScore: number
  count: number
}

export interface HistoryTopicStatsResult {
  ok: boolean
  error?: string
  /** Every topic with at least one review, most-reviewed first (capped). */
  topics: TopicStat[]
  /** Per-day series for the most-reviewed topics over the last 90 days, oldest first. */
  trend: TopicTrendPoint[]
}

export interface HistoryWeakAreasResult {
  ok: boolean
  error?: string
  /** Weakest first. See `MIN_WEAK_AREA_SAMPLES` / `WEAK_AREA_SCORE_THRESHOLD` for the ranking rule. */
  areas: TopicStat[]
}

// ---------------------------------------------------------------------------
// Phase 5: coding round (screenshot->problem extraction, local code
// execution, hint ladder, post-submission review)
// ---------------------------------------------------------------------------

/** Fixed language choices offered on the coding-round page. */
export type CodingLanguage = 'python' | 'javascript' | 'java' | 'cpp'

export const CODING_LANGUAGES: readonly CodingLanguage[] = ['python', 'javascript', 'java', 'cpp']

export const CODING_LANGUAGE_LABELS: Readonly<Record<CodingLanguage, string>> = {
  python: 'Python',
  javascript: 'JavaScript',
  java: 'Java',
  cpp: 'C++'
}

/**
 * Upper bound on submitted code, in characters, enforced at the IPC boundary
 * in main.ts (never trust the renderer alone) -- a multi-megabyte "code"
 * string is not legitimate input for a coding-round exercise, and would
 * otherwise be handed straight to a spawned interpreter/compiler and to a
 * Gemini review prompt.
 */
export const MAX_CODE_CHARS = 20_000

/**
 * Upper bound on the coding-round problem statement, in characters --
 * applies both to what Gemini's screenshot extraction is allowed to return
 * (electron/services/codingAssist.ts clamps its own output) and to what the
 * renderer can send back up for hints/review (main.ts re-enforces this at
 * the IPC boundary, same "never trust the renderer" discipline as every
 * other bound in this app). Vision extraction of a busy/wrong screen could
 * otherwise return a lot of garbage text.
 */
export const MAX_PROBLEM_TEXT_CHARS = 8_000

/**
 * Result of one `CODING_RUN_CODE` call. Always resolves (never a bare
 * thrown error crossing IPC) -- `error` is set for a run that never
 * produced a normal exit (runtime not found, spawn failure, unexpected
 * internal failure); `timedOut`/non-zero `exitCode` are ordinary outcomes of
 * the candidate's own code, not failures of this channel itself.
 */
export interface RunCodeResult {
  stdout: string
  stderr: string
  /** `null` when the process never produced a normal exit (killed for a timeout/output-cap, or never started at all). */
  exitCode: number | null
  timedOut: boolean
  /** True when the compile step (Java/C++) exceeded its own, longer budget -- distinct from `timedOut`, which is the 5s run budget. */
  compileTimedOut?: boolean
  error?: string
}

/** Longest `data:` URL accepted for a screenshot preview (a downscaled JPEG is a few hundred KB; this is a defensive ceiling enforced in preload.ts). */
export const MAX_SCREENSHOT_PREVIEW_CHARS = 2_000_000

/** Pushed on `CODING_SCREENSHOT_PREVIEW`: the locally captured, downscaled screenshot awaiting the user's explicit "Send to Gemini" / "Discard" choice. Nothing has been uploaded when this fires. */
export interface ScreenshotPreviewEvent {
  /** `data:image/jpeg;base64,...`, at most `MAX_SCREENSHOT_PREVIEW_CHARS` long. */
  previewDataUrl: string
}

/** Result of `CODING_SET_HOTKEY_ACTIVE`. `registered: false` with `ok: true` means the accelerator could not be claimed (another application owns it). */
export interface SetHotkeyResult {
  ok: boolean
  /** Whether the global hotkey is registered right now (always false after `active: false`). */
  registered: boolean
  error?: string
}

/** The accelerator shown in the UI -- kept next to the type so main.ts and CodingRound.tsx can't drift. */
export const SCREENSHOT_HOTKEY_LABEL = 'Ctrl+Shift+S'

/** Global hotkeys for Ghost HUD and Click-Through toggles. */
export const GHOST_OVERLAY_HOTKEY = 'CommandOrControl+Alt+G'
export const GHOST_OVERLAY_HOTKEY_LABEL = 'Ctrl+Alt+G'
export const GHOST_CLICKTHROUGH_HOTKEY = 'CommandOrControl+Alt+C'
export const GHOST_CLICKTHROUGH_HOTKEY_LABEL = 'Ctrl+Alt+C'
export const GHOST_PANIC_HOTKEY = 'CommandOrControl+Alt+X'
export const GHOST_PANIC_HOTKEY_LABEL = 'Ctrl+Alt+X'

/**
 * State of Windows capture exclusion and stealth overlay.
 * Uses Windows SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
 * to make windows completely invisible to Zoom, Teams, Meet, OBS, etc.
 */
export interface StealthState {
  /** Whether SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) is active on the application window. */
  contentProtected: boolean
  /** Whether the window stays floating on top of all meeting windows. */
  alwaysOnTop: boolean
  /** Whether the window is excluded from the Windows Taskbar and Alt+Tab switcher. */
  skipTaskbar: boolean
  /** Whether the floating transparent Ghost HUD overlay is currently open. */
  ghostOverlayActive: boolean
  /** Whether the Ghost HUD overlay allows clicks to pass through to the background window. */
  ghostClickThrough: boolean
  /** Window opacity of the Ghost HUD (0.1 to 1.0). */
  ghostOpacity: number
}

/** Preload API directly exposed on window.screenProtection as requested by user. */
export interface ScreenProtectionApi {
  enable: () => Promise<boolean>
  disable: () => Promise<boolean>
  isEnabled: () => Promise<boolean>
  toggle: () => Promise<boolean>
}

/** Result of one screenshot -> problem-statement extraction. Pushed on `CODING_SCREENSHOT_RESULT`. */
export interface ScreenshotResultEvent {
  ok: boolean
  error?: string
  /** Present only when `ok` is true. Already clamped to `MAX_PROBLEM_TEXT_CHARS`. */
  problemText?: string
}

/** Result of one `CODING_GET_HINTS` call. */
export interface HintsResult {
  ok: boolean
  error?: string
  /** Exactly 4 entries, in reveal order (nudge, pattern, approach, complexity) -- see prompts/hints.md. Present only when `ok` is true. */
  hints?: string[]
}

/** Result of one `CODING_SUBMIT_REVIEW` call. */
export interface CodeReviewResult {
  ok: boolean
  error?: string
  timeComplexity?: string
  spaceComplexity?: string
  edgeCasesMissed?: string[]
  comparisonToOptimal?: string
  overallFeedback?: string
}

// ---------------------------------------------------------------------------
// Phase 7: usage meter + in-app shortcuts
// ---------------------------------------------------------------------------

/** Labels for the window-scoped (NOT global) shortcuts, shown in the UI. Kept next to the types so the pages and Settings can't drift. */
export const SHORTCUT_TOGGLE_SESSION_LABEL = 'Ctrl+Shift+Space'
export const SHORTCUT_NEXT_HINT_LABEL = 'Ctrl+Shift+H'

/**
 * Where a Gemini call's tokens are filed:
 *  - `live`: the Live audio session itself (interview scope)
 *  - `reviews`: per-answer reviews (interview scope)
 *  - `embeddings`: the session-start resume/JD retrieval query (interview scope; ESTIMATED -- the embeddings API reports no token counts)
 *  - `coding`: hints, code review and screenshot extraction (coding scope, not tied to an interview session)
 */
export type UsageCategoryId = 'live' | 'reviews' | 'embeddings' | 'coding'

export const USAGE_CATEGORY_IDS: readonly UsageCategoryId[] = ['live', 'reviews', 'embeddings', 'coding']

/** Sanity ceilings enforced in preload.ts on every number crossing the usage IPC (no real session approaches these). */
export const USAGE_MAX_TOKENS = 1_000_000_000
export const USAGE_MAX_CALLS = 10_000_000
export const USAGE_MAX_COST_USD = 100_000
export const USAGE_MAX_SESSION_TOKEN = 1_000_000_000

/** Accumulated usage for one category. All numbers finite and non-negative. */
export interface UsageBucket {
  promptTokens: number
  outputTokens: number
  /** prompt + output (thinking tokens included in output); the provider's own total is used only when it reported no components at all -- it is inconsistent across the Live and generateContent APIs. */
  totalTokens: number
  /** Number of calls/messages that reported (or were estimated to have) usage. */
  calls: number
  /** Estimated cost in USD for the priced part of this bucket. Approximate -- see the price table in electron/services/usage.ts. */
  costUsd: number
  /** Tokens belonging to a model with NO entry in the price table; excluded from `costUsd`. */
  unpricedTokens: number
  /** True when part of the cost had to be computed at the plain text rate because audio/text token detail was unavailable. */
  roughCost: boolean
  /** True when the token counts themselves are estimated from text length rather than reported by the API. */
  estimatedTokens: boolean
}

export interface UsageSnapshot {
  ok: boolean
  /** True while an interview session is live (interview-scope buckets are accumulating); false when idle or after Stop, when they hold the FINAL totals of the last session until the next Start. */
  sessionActive: boolean
  /** Monotonic id of the interview session the interview-scope buckets belong to (0 = none yet since launch). A renderer that just pressed Start must ignore snapshots whose token is not newer than the one it saw before Start -- those are the previous session's frozen totals. */
  sessionToken: number
  categories: Record<UsageCategoryId, UsageBucket>
  /** Date the price table was last reviewed (`YYYY-MM-DD`). Shown next to every cost so nobody mistakes it for a bill. */
  pricesAsOf: string
}

/**
 * The typed API surface exposed on `window.api` by `electron/preload.ts`.
 * The renderer must only ever talk to the main process through this object.
 */
export interface MockPilotApi {
  /**
   * Whether a Gemini API key is currently stored. The renderer never reads
   * the key itself back out -- the key is write-only from its perspective;
   * only the main process ever holds the plaintext value.
   */
  hasApiKey: () => Promise<boolean>
  /** Persists the Gemini API key to the OS credential store. */
  setApiKey: (apiKey: string) => Promise<OperationResult>
  /** Removes the stored Gemini API key from the OS credential store. */
  deleteApiKey: () => Promise<OperationResult>
  /** Performs a minimal live call against the Gemini API to verify the stored key works. */
  testApiKey: () => Promise<TestKeyResult>

  /**
   * Opens a Gemini Live voice-interview session using the given setup (role,
   * difficulty, company, duration). Fails if one is already running or no API
   * key is saved. Resume/JD chunks are looked up main-process-side from
   * whatever was last stored via `indexInterviewMaterials` -- they are not
   * re-sent here. `focusTopics` (Phase 6, optional) turns the session into a
   * targeted drill: at most `MAX_FOCUS_TOPICS` short topic labels, validated and
   * re-normalized main-side before they reach the interviewer prompt.
   */
  startLiveSession: (setup: InterviewSetup, focusTopics?: readonly string[]) => Promise<OperationResult>
  /** Closes the current Gemini Live session, if any. Safe to call when nothing is running. */
  stopLiveSession: () => Promise<OperationResult>
  /**
   * Sends one mic PCM16 chunk (16kHz mono, from src/audio/pipeline.ts's
   * worklet) to the active live session. Mic audio only -- never
   * system-audio loopback, see electron/services/geminiLive.ts's doc
   * comment for why.
   */
  sendMicChunk: (chunk: ArrayBuffer) => Promise<OperationResult>

  /** Subscribes to live transcript fragments. Returns an unsubscribe function. */
  onLiveTranscript: (callback: (event: GeminiLiveTranscriptEvent) => void) => () => void
  /** Subscribes to interviewer audio-out chunks. Returns an unsubscribe function. */
  onLiveAudioChunk: (callback: (event: GeminiLiveAudioChunkEvent) => void) => () => void
  /** Subscribes to live-session connection-state changes. Returns an unsubscribe function. */
  onLiveConnectionState: (callback: (event: GeminiLiveConnectionStateEvent) => void) => () => void
  /**
   * Subscribes to barge-in signals: the candidate started talking over the
   * interviewer and Gemini stopped generating. The subscriber should drop
   * any queued/abandoned interviewer audio (see src/audio/player.ts's
   * `clear()`). Returns an unsubscribe function.
   */
  onLiveInterrupted: (callback: () => void) => () => void
  /**
   * Subscribes to per-answer review results: a structured Gemini review plus
   * local speech metrics for one completed candidate answer turn (see
   * `GeminiLiveAnswerReviewEvent`'s doc comment on why `answerIndex`, not
   * arrival order, identifies which turn a result belongs to). Returns an
   * unsubscribe function.
   */
  onLiveAnswerReview: (callback: (event: GeminiLiveAnswerReviewEvent) => void) => () => void

  /**
   * Sends the raw bytes of a resume PDF (if any) and/or pasted job
   * description text (if any) to the main process to be parsed (PDF only),
   * chunked, embedded and stored for later retrieval by
   * `startLiveSession`. Pass `null` for whichever source wasn't
   * changed/provided -- a `null` source is left untouched in storage rather
   * than being cleared. Never throws; resolves to a typed result.
   */
  indexInterviewMaterials: (resumePdfBytes: ArrayBuffer | null, jdText: string | null) => Promise<RagIndexResult>
  /** Current stored resume/JD chunk counts, for display -- reflects actual storage, not just what the last Setup-screen visit indexed. */
  getRagStatus: () => Promise<RagStatusResult>
  /** Deletes all stored resume/JD chunks. There is no other way to remove this data once indexed. */
  clearInterviewMaterials: () => Promise<OperationResult>

  /**
   * Manually triggers the same local screen capture the global hotkey does.
   * Resolves once the request is accepted or rejected (already in flight /
   * debounced / no API key) -- the captured preview arrives via
   * `onCodingScreenshotPreview`, and nothing is uploaded until
   * `confirmScreenshot` is called.
   */
  captureScreenshotNow: () => Promise<OperationResult>
  /** Fired once a screenshot has been captured LOCALLY, carrying a downscaled preview. Nothing has been sent anywhere yet. Returns an unsubscribe function. */
  onCodingScreenshotPreview: (callback: (event: ScreenshotPreviewEvent) => void) => () => void
  /** Uploads the currently held capture to Gemini for problem extraction. Fails if there is no pending capture (discarded/expired). The outcome arrives via `onCodingScreenshotResult`. */
  confirmScreenshot: () => Promise<OperationResult>
  /** Drops the currently held capture without uploading it. Safe to call when there is none. */
  discardScreenshot: () => Promise<OperationResult>
  /** Fired once a confirmed screenshot's Gemini extraction settles, ok or not -- and for a failure/expiry of a pending capture. Returns an unsubscribe function. */
  onCodingScreenshotResult: (callback: (event: ScreenshotResultEvent) => void) => () => void
  /** Registers (`true`) or releases (`false`) the global Ctrl+Shift+S hotkey. The Coding page calls this on mount/unmount so the hotkey is only held while that page is showing. */
  setScreenshotHotkeyActive: (active: boolean) => Promise<SetHotkeyResult>

  /**
   * Runs `code` locally as `language` (main process only -- see
   * electron/services/codeRunner.ts) and returns its captured
   * stdout/stderr/exit code. Bounded to a 5s run timeout (15s for a compile step) and a capped
   * output size regardless of what the code does. Only one run may be in
   * flight at a time app-wide; a second call while one is running is
   * rejected (`error` set) rather than queued or run concurrently.
   */
  runCode: (language: CodingLanguage, code: string) => Promise<RunCodeResult>
  /**
   * Generates all 4 hint-ladder levels for `problemText` in one Gemini call.
   * The renderer is expected to cache the result per problem text itself
   * (re-calling this for the same problem text re-spends a Gemini call --
   * this function has no memory of its own).
   */
  getHints: (problemText: string) => Promise<HintsResult>
  /** Requests the structured post-submission review (complexity, missed edge cases, comparison to an optimal approach) for one submitted solution. */
  submitCodeReview: (problemText: string, language: CodingLanguage, code: string) => Promise<CodeReviewResult>

  /** Past sessions, newest first, `limit` (1..HISTORY_MAX_PAGE_SIZE) at a time starting at `offset`. */
  listHistorySessions: (limit: number, offset: number) => Promise<HistoryListResult>
  /** One session with its transcript turns and per-answer reviews (both capped). */
  getHistorySession: (sessionId: number) => Promise<HistorySessionDetailResult>
  /** Per-topic averages plus a per-day trend series for the most-reviewed topics. */
  getHistoryTopicStats: () => Promise<HistoryTopicStatsResult>
  /** Weakest topics (see MIN_WEAK_AREA_SAMPLES / WEAK_AREA_SCORE_THRESHOLD), at most `limit` (1..HISTORY_MAX_WEAK_AREAS). */
  getHistoryWeakAreas: (limit: number) => Promise<HistoryWeakAreasResult>
  /** Permanently deletes one session, its transcript and its reviews. Refused while that session is still running. */
  deleteHistorySession: (sessionId: number) => Promise<OperationResult>
  /** Permanently deletes ALL history. Refused while a session is running. */
  clearAllHistory: () => Promise<OperationResult>

  /** Current usage estimate (tokens + approximate cost). Interview-scope categories reset at each interview Start; the coding category accumulates since app launch/reload. Never throws. */
  getUsage: () => Promise<UsageSnapshot>

  /** Returns the current stealth and capture protection state. */
  getStealthState: () => Promise<StealthState>
  /** Enables or disables Windows SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE). */
  setContentProtection: (enable: boolean) => Promise<{ ok: boolean; protected: boolean }>
  /** Sets whether the window stays floating above other windows. */
  setAlwaysOnTop: (enable: boolean) => Promise<{ ok: boolean; alwaysOnTop: boolean }>
  /** Sets whether the window is excluded from the Windows Taskbar and Alt+Tab switcher. */
  setSkipTaskbar: (enable: boolean) => Promise<{ ok: boolean; skipTaskbar: boolean }>
  /** Toggles the borderless, transparent, capture-excluded Ghost HUD overlay. */
  toggleGhostOverlay: () => Promise<{ ok: boolean; active: boolean }>
  /** Sets whether the Ghost HUD overlay allows mouse clicks to click through to the background. */
  setGhostClickThrough: (clickThrough: boolean) => Promise<{ ok: boolean; clickThrough: boolean }>
  /** Sets the opacity of the Ghost HUD overlay (0.1 to 1.0). */
  setGhostOpacity: (opacity: number) => Promise<{ ok: boolean; opacity: number }>
  /** Subscribes to changes in stealth or capture protection state. Returns an unsubscribe function. */
  onStealthStateChanged: (callback: (state: StealthState) => void) => () => void
  /** Instant panic trigger: immediately closes overlay, mutes audio, and aborts active sessions. */
  triggerPanic: () => Promise<OperationResult>
  /** Subscribes to panic signal to immediately drop queued audio playback and reset state. */
  onPanic: (callback: () => void) => () => void
}
