import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  HISTORY_MAX_PAGE_SIZE,
  HISTORY_MAX_REVIEWS_RETURNED,
  HISTORY_MAX_TOPICS_RETURNED,
  HISTORY_MAX_TREND_POINTS,
  HISTORY_MAX_TURNS_RETURNED,
  HISTORY_MAX_WEAK_AREAS,
  INTERVIEW_DIFFICULTIES,
  INTERVIEW_ROLES,
  IPC_CHANNELS,
  MAX_FOCUS_TOPICS,
  MAX_SCREENSHOT_PREVIEW_CHARS,
  MAX_TOPIC_CHARS,
  USAGE_CATEGORY_IDS,
  USAGE_MAX_CALLS,
  USAGE_MAX_COST_USD,
  USAGE_MAX_SESSION_TOKEN,
  USAGE_MAX_TOKENS
} from './ipc-types'
import type {
  AnswerReviewStar,
  AnswerSpeechMetrics,
  CodeReviewResult,
  CodingLanguage,
  GeminiLiveAnswerReviewEvent,
  GeminiLiveAudioChunkEvent,
  GeminiLiveConnectionStateEvent,
  GeminiLiveTranscriptEvent,
  HintsResult,
  HistoryListResult,
  HistoryReview,
  HistorySessionDetailResult,
  HistorySessionSummary,
  HistoryTopicStatsResult,
  HistoryTurn,
  HistoryWeakAreasResult,
  InterviewDifficulty,
  InterviewRole,
  InterviewSetup,
  MockPilotApi,
  OperationResult,
  RagIndexResult,
  RagStatusResult,
  RunCodeResult,
  ScreenshotPreviewEvent,
  ScreenshotResultEvent,
  SetHotkeyResult,
  TestKeyResult,
  TopicStat,
  TopicTrendPoint,
  UsageBucket,
  UsageCategoryId,
  UsageSnapshot,
  ScreenProtectionApi,
  StealthState
} from './ipc-types'

/**
 * The only surface the renderer ever talks to. Every call is a typed,
 * explicit IPC round-trip into the main process -- there is no generic
 * "invoke any channel" escape hatch, and nothing here touches Node or
 * Electron internals directly (sandbox: true means this script itself runs
 * in a sandboxed, isolated context).
 *
 * `ipcRenderer.invoke` resolves to `Promise<any>` -- the shapes below are
 * validated at runtime, not just asserted, so a malformed/unexpected reply
 * from the main process can't silently masquerade as a well-typed result.
 */
function toOperationResult(value: unknown): OperationResult {
  if (typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean') {
    // Rebuilt field by field: `error` is only forwarded when it really is a string.
    const v = value as { ok: boolean; error?: unknown }
    const result: OperationResult = { ok: v.ok }
    if (typeof v.error === 'string') result.error = v.error
    return result
  }
  return { ok: false, error: 'Malformed response from main process.' }
}

function toBoolean(value: unknown): boolean {
  return value === true
}

function toStealthState(value: unknown): StealthState {
  const fallback: StealthState = {
    contentProtected: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    ghostOverlayActive: false,
    ghostClickThrough: false,
    ghostOpacity: 0.95
  }
  if (typeof value !== 'object' || value === null) return fallback
  const v = value as Record<string, unknown>
  return {
    contentProtected: v['contentProtected'] === true,
    alwaysOnTop: v['alwaysOnTop'] === true,
    skipTaskbar: v['skipTaskbar'] === true,
    ghostOverlayActive: v['ghostOverlayActive'] === true,
    ghostClickThrough: v['ghostClickThrough'] === true,
    ghostOpacity: typeof v['ghostOpacity'] === 'number' ? v['ghostOpacity'] : 0.95
  }
}

function toProtectedResult(value: unknown): { ok: boolean; protected: boolean } {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return { ok: v['ok'] === true, protected: v['protected'] === true }
  }
  return { ok: false, protected: false }
}

function toAlwaysOnTopResult(value: unknown): { ok: boolean; alwaysOnTop: boolean } {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return { ok: v['ok'] === true, alwaysOnTop: v['alwaysOnTop'] === true }
  }
  return { ok: false, alwaysOnTop: false }
}

function toSkipTaskbarResult(value: unknown): { ok: boolean; skipTaskbar: boolean } {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return { ok: v['ok'] === true, skipTaskbar: v['skipTaskbar'] === true }
  }
  return { ok: false, skipTaskbar: false }
}

function toGhostOverlayResult(value: unknown): { ok: boolean; active: boolean } {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return { ok: v['ok'] === true, active: v['active'] === true }
  }
  return { ok: false, active: false }
}

function toGhostClickThroughResult(value: unknown): { ok: boolean; clickThrough: boolean } {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return { ok: v['ok'] === true, clickThrough: v['clickThrough'] === true }
  }
  return { ok: false, clickThrough: false }
}

function toGhostOpacityResult(value: unknown): { ok: boolean; opacity: number } {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return { ok: v['ok'] === true, opacity: typeof v['opacity'] === 'number' ? v['opacity'] : 1.0 }
  }
  return { ok: false, opacity: 1.0 }
}

/** Same "don't trust a bare cast" discipline as `toOperationResult`, for `RAG_INDEX_MATERIALS`'s richer result shape. */
function toRagIndexResult(value: unknown): RagIndexResult {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, error: 'Malformed response from main process.' }
  }
  const v = value as Record<string, unknown>
  const result: RagIndexResult = { ok: v['ok'] === true }
  if (typeof v['error'] === 'string') result.error = v['error']
  if (typeof v['resumeChunkCount'] === 'number') result.resumeChunkCount = v['resumeChunkCount']
  if (typeof v['jdChunkCount'] === 'number') result.jdChunkCount = v['jdChunkCount']
  return result
}

/** Same "don't trust a bare cast" discipline, for `RAG_STATUS`'s result shape. */
function toRagStatusResult(value: unknown): RagStatusResult {
  if (typeof value !== 'object' || value === null) {
    return { resumeChunkCount: 0, jdChunkCount: 0 }
  }
  const v = value as Record<string, unknown>
  return {
    resumeChunkCount: typeof v['resumeChunkCount'] === 'number' ? v['resumeChunkCount'] : 0,
    jdChunkCount: typeof v['jdChunkCount'] === 'number' ? v['jdChunkCount'] : 0
  }
}

/**
 * Validates a main->renderer push payload before it ever reaches a
 * subscriber's callback. `ipcRenderer.on` hands back `unknown` in spirit
 * (Electron types it loosely) -- the same "don't trust a bare cast"
 * discipline `toOperationResult`/`toBoolean` apply to invoke *responses*
 * applies here too, just in the other direction. A malformed event is
 * dropped (logged, not thrown) rather than forwarded -- a renderer-side bug
 * reading a bad payload must not be how a main-process bug becomes a
 * renderer crash.
 */
function toLiveTranscriptEvent(value: unknown): GeminiLiveTranscriptEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if ((v['speaker'] !== 'user' && v['speaker'] !== 'interviewer') || typeof v['textDelta'] !== 'string' || typeof v['finished'] !== 'boolean') {
    return null
  }
  return { speaker: v['speaker'], textDelta: v['textDelta'], finished: v['finished'] }
}

function toLiveAudioChunkEvent(value: unknown): GeminiLiveAudioChunkEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const audio = (value as Record<string, unknown>)['audio']
  if (!(audio instanceof ArrayBuffer)) return null
  return { audio }
}

const LIVE_CONNECTION_STATES = new Set(['connecting', 'open', 'reconnecting', 'closed', 'error'])

function toLiveConnectionStateEvent(value: unknown): GeminiLiveConnectionStateEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['state'] !== 'string' || !LIVE_CONNECTION_STATES.has(v['state'])) return null
  if (v['message'] !== undefined && typeof v['message'] !== 'string') return null
  return {
    state: v['state'] as GeminiLiveConnectionStateEvent['state'],
    message: typeof v['message'] === 'string' ? v['message'] : undefined
  }
}

function toStarChecklist(value: unknown): AnswerReviewStar | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (
    typeof v['situation'] !== 'boolean' ||
    typeof v['task'] !== 'boolean' ||
    typeof v['action'] !== 'boolean' ||
    typeof v['result'] !== 'boolean'
  ) {
    return null
  }
  return { situation: v['situation'], task: v['task'], action: v['action'], result: v['result'] }
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item): item is string => typeof item === 'string') ? value : null
}

function toAnswerSpeechMetrics(value: unknown): AnswerSpeechMetrics | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const wpmRaw = v['wpm']
  let wpm: number | null
  if (wpmRaw === null) {
    wpm = null
  } else if (typeof wpmRaw === 'number' && Number.isFinite(wpmRaw) && wpmRaw >= 0) {
    wpm = wpmRaw
  } else {
    return null
  }

  const fillerWordCount = v['fillerWordCount']
  if (typeof fillerWordCount !== 'number' || !Number.isFinite(fillerWordCount) || fillerWordCount < 0) return null

  const longestPauseMs = v['longestPauseMs']
  if (typeof longestPauseMs !== 'number' || !Number.isFinite(longestPauseMs) || longestPauseMs < 0) return null

  return { wpm, fillerWordCount, longestPauseMs }
}

/**
 * Same "don't trust a bare cast" discipline as `toLiveTranscriptEvent` etc.
 * -- every field of a Phase 4 answer-review push event is checked before it
 * ever reaches a renderer callback. Optional fields (`error`/`score`/`star`/
 * ...) are validated for type when present, rather than only checked for
 * presence, so a malformed main-process bug can't smuggle a wrongly-typed
 * value past this boundary either.
 */
function toLiveAnswerReviewEvent(value: unknown): GeminiLiveAnswerReviewEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const answerIndex = v['answerIndex']
  if (typeof answerIndex !== 'number' || !Number.isInteger(answerIndex) || answerIndex < 0) return null
  if (typeof v['ok'] !== 'boolean') return null

  const metrics = toAnswerSpeechMetrics(v['metrics'])
  if (metrics === null) return null

  const event: GeminiLiveAnswerReviewEvent = { answerIndex, ok: v['ok'], metrics }

  if (v['error'] !== undefined) {
    if (typeof v['error'] !== 'string') return null
    event.error = v['error']
  }
  if (v['score'] !== undefined) {
    const score = v['score']
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 1 || score > 10) return null
    event.score = score
  }
  if (v['star'] !== undefined) {
    const star = toStarChecklist(v['star'])
    if (star === null) return null
    event.star = star
  }
  if (v['missingPoints'] !== undefined) {
    const missingPoints = toStringArray(v['missingPoints'])
    if (missingPoints === null) return null
    event.missingPoints = missingPoints
  }
  if (v['technicalErrors'] !== undefined) {
    const technicalErrors = toStringArray(v['technicalErrors'])
    if (technicalErrors === null) return null
    event.technicalErrors = technicalErrors
  }
  if (v['improvedAnswer'] !== undefined) {
    if (typeof v['improvedAnswer'] !== 'string') return null
    event.improvedAnswer = v['improvedAnswer']
  }
  if (v['followUpQuestion'] !== undefined) {
    if (typeof v['followUpQuestion'] !== 'string') return null
    event.followUpQuestion = v['followUpQuestion']
  }
  if (v['topic'] !== undefined) {
    const topic = v['topic']
    if (typeof topic !== 'string' || topic.length === 0 || topic.length > MAX_TOPIC_CHARS) return null
    event.topic = topic
  }

  return event
}

// ---------------------------------------------------------------------------
// Phase 6: history result validators. Every field is checked (type, integer-ness,
// range, array cap) -- a malformed or oversized reply becomes a plain failure
// result, never a partially-trusted one.
// ---------------------------------------------------------------------------

const ROLE_SET: ReadonlySet<string> = new Set(INTERVIEW_ROLES)
const DIFFICULTY_SET: ReadonlySet<string> = new Set(INTERVIEW_DIFFICULTIES)
const HISTORY_MALFORMED = 'Malformed response from main process.'
/** Generous per-string ceiling on history text crossing IPC (main caps stored text far lower). */
const HISTORY_MAX_TEXT_CHARS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBoundedString(value: unknown, max = HISTORY_MAX_TEXT_CHARS): value is string {
  return typeof value === 'string' && value.length <= max
}

function isTopicString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOPIC_CHARS
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10
}

function toBoundedStringArray(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const items = value as unknown[]
  return items.every((item): item is string => isBoundedString(item)) ? (items as string[]) : null
}

function toHistorySessionSummary(value: unknown): HistorySessionSummary | null {
  if (!isRecord(value)) return null
  const { id, startedAt, endedAt, role, difficulty, company, durationMinutes, answerCount, avgScore } = value
  if (!isPositiveInt(id) || !isNonNegInt(startedAt)) return null
  if (endedAt !== null && !isNonNegInt(endedAt)) return null
  if (typeof role !== 'string' || !ROLE_SET.has(role)) return null
  if (typeof difficulty !== 'string' || !DIFFICULTY_SET.has(difficulty)) return null
  if (!isBoundedString(company, 400)) return null
  if (!isNonNegInt(durationMinutes) || !isNonNegInt(answerCount)) return null
  if (avgScore !== null && !isScore(avgScore)) return null
  const focusTopics = toBoundedStringArray(value['focusTopics'], MAX_FOCUS_TOPICS)
  if (focusTopics === null || !focusTopics.every(isTopicString)) return null
  return {
    id,
    startedAt,
    endedAt,
    role: role as InterviewRole,
    difficulty: difficulty as InterviewDifficulty,
    company,
    durationMinutes,
    focusTopics,
    answerCount,
    avgScore
  }
}

function toHistoryListResult(value: unknown): HistoryListResult {
  const fail = (error: string): HistoryListResult => ({ ok: false, error, sessions: [], hasMore: false })
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return fail(HISTORY_MALFORMED)
  if (value['ok'] !== true) return fail(typeof value['error'] === 'string' ? value['error'] : HISTORY_MALFORMED)
  const raw = value['sessions']
  if (!Array.isArray(raw) || raw.length > HISTORY_MAX_PAGE_SIZE || typeof value['hasMore'] !== 'boolean') return fail(HISTORY_MALFORMED)
  const sessions: HistorySessionSummary[] = []
  for (const item of raw as unknown[]) {
    const session = toHistorySessionSummary(item)
    // One malformed row is skipped, not allowed to blank the whole list (the array size cap above still fails a wholly wrong reply).
    if (session === null) continue
    sessions.push(session)
  }
  return { ok: true, sessions, hasMore: value['hasMore'] }
}

function toHistoryTurn(value: unknown): HistoryTurn | null {
  if (!isRecord(value)) return null
  const { id, idx, speaker, text, startedAt, finishedAt } = value
  if (!isPositiveInt(id) || !isNonNegInt(idx) || !isNonNegInt(startedAt) || !isNonNegInt(finishedAt)) return null
  if (speaker !== 'user' && speaker !== 'interviewer') return null
  if (!isBoundedString(text)) return null
  return { id, idx, speaker, text, startedAt, finishedAt }
}

function toHistoryReview(value: unknown): HistoryReview | null {
  if (!isRecord(value)) return null
  const { id, answerIndex, turnId, question, score, improvedAnswer, followUpQuestion, topic, createdAt } = value
  if (!isPositiveInt(id) || !isNonNegInt(answerIndex) || !isNonNegInt(createdAt)) return null
  if (turnId !== null && !isPositiveInt(turnId)) return null
  if (!isBoundedString(question) || !isBoundedString(improvedAnswer) || !isBoundedString(followUpQuestion)) return null
  if (typeof score !== 'number' || !Number.isInteger(score) || !isScore(score)) return null
  if (!isTopicString(topic)) return null
  const star = toStarChecklist(value['star'])
  const metrics = toAnswerSpeechMetrics(value['metrics'])
  const missingPoints = toBoundedStringArray(value['missingPoints'], 50)
  const technicalErrors = toBoundedStringArray(value['technicalErrors'], 50)
  if (star === null || metrics === null || missingPoints === null || technicalErrors === null) return null
  return { id, answerIndex, turnId, question, score, star, missingPoints, technicalErrors, improvedAnswer, followUpQuestion, metrics, topic, createdAt }
}

function toHistorySessionDetailResult(value: unknown): HistorySessionDetailResult {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return { ok: false, error: HISTORY_MALFORMED }
  if (value['ok'] !== true) return { ok: false, error: typeof value['error'] === 'string' ? value['error'] : HISTORY_MALFORMED }
  const session = toHistorySessionSummary(value['session'])
  const rawTurns = value['turns']
  const rawReviews = value['reviews']
  if (session === null || !Array.isArray(rawTurns) || !Array.isArray(rawReviews) || typeof value['turnsTruncated'] !== 'boolean') {
    return { ok: false, error: HISTORY_MALFORMED }
  }
  if (rawTurns.length > HISTORY_MAX_TURNS_RETURNED || rawReviews.length > HISTORY_MAX_REVIEWS_RETURNED) {
    return { ok: false, error: HISTORY_MALFORMED }
  }
  const turns: HistoryTurn[] = []
  for (const item of rawTurns as unknown[]) {
    const turn = toHistoryTurn(item)
    if (turn === null) return { ok: false, error: HISTORY_MALFORMED }
    turns.push(turn)
  }
  const reviews: HistoryReview[] = []
  for (const item of rawReviews as unknown[]) {
    const review = toHistoryReview(item)
    if (review === null) return { ok: false, error: HISTORY_MALFORMED }
    reviews.push(review)
  }
  return { ok: true, session, turns, reviews, turnsTruncated: value['turnsTruncated'] }
}

function toTopicStat(value: unknown): TopicStat | null {
  if (!isRecord(value)) return null
  const { topic, count, avgScore } = value
  if (!isTopicString(topic) || !isPositiveInt(count) || !isScore(avgScore)) return null
  return { topic, count, avgScore }
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function toTopicTrendPoint(value: unknown): TopicTrendPoint | null {
  if (!isRecord(value)) return null
  const { topic, day, avgScore, count } = value
  if (!isTopicString(topic) || typeof day !== 'string' || !ISO_DAY_RE.test(day)) return null
  if (!isScore(avgScore) || !isPositiveInt(count)) return null
  return { topic, day, avgScore, count }
}

function toHistoryTopicStatsResult(value: unknown): HistoryTopicStatsResult {
  const fail = (error: string): HistoryTopicStatsResult => ({ ok: false, error, topics: [], trend: [] })
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return fail(HISTORY_MALFORMED)
  if (value['ok'] !== true) return fail(typeof value['error'] === 'string' ? value['error'] : HISTORY_MALFORMED)
  const rawTopics = value['topics']
  const rawTrend = value['trend']
  if (!Array.isArray(rawTopics) || !Array.isArray(rawTrend)) return fail(HISTORY_MALFORMED)
  if (rawTopics.length > HISTORY_MAX_TOPICS_RETURNED || rawTrend.length > HISTORY_MAX_TREND_POINTS) return fail(HISTORY_MALFORMED)
  const topics: TopicStat[] = []
  for (const item of rawTopics as unknown[]) {
    const stat = toTopicStat(item)
    if (stat === null) continue // skip one bad row rather than blank the chart
    topics.push(stat)
  }
  const trend: TopicTrendPoint[] = []
  for (const item of rawTrend as unknown[]) {
    const point = toTopicTrendPoint(item)
    if (point === null) continue
    trend.push(point)
  }
  return { ok: true, topics, trend }
}

function toHistoryWeakAreasResult(value: unknown): HistoryWeakAreasResult {
  const fail = (error: string): HistoryWeakAreasResult => ({ ok: false, error, areas: [] })
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return fail(HISTORY_MALFORMED)
  if (value['ok'] !== true) return fail(typeof value['error'] === 'string' ? value['error'] : HISTORY_MALFORMED)
  const raw = value['areas']
  if (!Array.isArray(raw) || raw.length > HISTORY_MAX_WEAK_AREAS) return fail(HISTORY_MALFORMED)
  const areas: TopicStat[] = []
  for (const item of raw as unknown[]) {
    const stat = toTopicStat(item)
    if (stat === null) continue
    areas.push(stat)
  }
  return { ok: true, areas }
}

/** Same "don't trust a bare cast" discipline as `toOperationResult`, for `CODING_RUN_CODE`'s richer result shape. */
function toRunCodeResult(value: unknown): RunCodeResult {
  if (typeof value !== 'object' || value === null) {
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Malformed response from main process.' }
  }
  const v = value as Record<string, unknown>
  const result: RunCodeResult = {
    stdout: typeof v['stdout'] === 'string' ? v['stdout'] : '',
    stderr: typeof v['stderr'] === 'string' ? v['stderr'] : '',
    exitCode: typeof v['exitCode'] === 'number' ? v['exitCode'] : null,
    timedOut: v['timedOut'] === true
  }
  if (v['compileTimedOut'] === true) result.compileTimedOut = true
  if (typeof v['error'] === 'string') result.error = v['error']
  return result
}

/** Same "don't trust a bare cast" discipline, for `CODING_GET_HINTS`'s result shape. Requires exactly 4 non-empty hint strings when `ok` -- a malformed/short array is treated as a failure rather than partially trusted. */
function toHintsResult(value: unknown): HintsResult {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, error: 'Malformed response from main process.' }
  }
  const v = value as Record<string, unknown>
  if (v['ok'] !== true) {
    const result: HintsResult = { ok: false }
    if (typeof v['error'] === 'string') result.error = v['error']
    return result
  }
  const hints = toStringArray(v['hints'])
  if (hints === null || hints.length !== 4) {
    return { ok: false, error: 'Malformed response from main process.' }
  }
  return { ok: true, hints }
}

/** Same "don't trust a bare cast" discipline, for `CODING_SUBMIT_REVIEW`'s result shape. */
function toCodeReviewResult(value: unknown): CodeReviewResult {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, error: 'Malformed response from main process.' }
  }
  const v = value as Record<string, unknown>
  if (v['ok'] !== true) {
    const result: CodeReviewResult = { ok: false }
    if (typeof v['error'] === 'string') result.error = v['error']
    return result
  }
  const timeComplexity = v['timeComplexity']
  const spaceComplexity = v['spaceComplexity']
  const edgeCasesMissed = toStringArray(v['edgeCasesMissed'])
  const comparisonToOptimal = v['comparisonToOptimal']
  const overallFeedback = v['overallFeedback']
  if (
    typeof timeComplexity !== 'string' ||
    typeof spaceComplexity !== 'string' ||
    edgeCasesMissed === null ||
    typeof comparisonToOptimal !== 'string' ||
    typeof overallFeedback !== 'string'
  ) {
    return { ok: false, error: 'Malformed response from main process.' }
  }
  return { ok: true, timeComplexity, spaceComplexity, edgeCasesMissed, comparisonToOptimal, overallFeedback }
}

/** Validates a `CODING_SCREENSHOT_RESULT` push payload -- same discipline as `toLiveAnswerReviewEvent` etc. Returns `null` (dropped, not forwarded) on anything malformed. */
function toScreenshotResultEvent(value: unknown): ScreenshotResultEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return null

  const event: ScreenshotResultEvent = { ok: v['ok'] }
  if (v['error'] !== undefined) {
    if (typeof v['error'] !== 'string') return null
    event.error = v['error']
  }
  if (v['problemText'] !== undefined) {
    if (typeof v['problemText'] !== 'string') return null
    event.problemText = v['problemText']
  }
  return event
}

/** Validates a `CODING_SCREENSHOT_PREVIEW` push payload: must be a length-capped JPEG `data:` URL, nothing else -- the renderer renders it in an <img>, so any other scheme/type is dropped rather than forwarded. */
const PREVIEW_DATA_URL_PREFIX = 'data:image/jpeg;base64,'

function toScreenshotPreviewEvent(value: unknown): ScreenshotPreviewEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const previewDataUrl = (value as Record<string, unknown>)['previewDataUrl']
  if (
    typeof previewDataUrl !== 'string' ||
    previewDataUrl.length <= PREVIEW_DATA_URL_PREFIX.length ||
    previewDataUrl.length > MAX_SCREENSHOT_PREVIEW_CHARS ||
    !previewDataUrl.startsWith(PREVIEW_DATA_URL_PREFIX)
  ) {
    return null
  }
  return { previewDataUrl }
}

/** Same "don't trust a bare cast" discipline, for `CODING_SET_HOTKEY_ACTIVE`'s result shape. */
function toSetHotkeyResult(value: unknown): SetHotkeyResult {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, registered: false, error: 'Malformed response from main process.' }
  }
  const v = value as Record<string, unknown>
  const result: SetHotkeyResult = { ok: v['ok'] === true, registered: v['registered'] === true }
  if (typeof v['error'] === 'string') result.error = v['error']
  return result
}

// ---------------------------------------------------------------------------
// Phase 7: usage snapshot validator. Every number must be finite, non-negative
// and under its ceiling; anything else makes the whole reply a plain failure.
// ---------------------------------------------------------------------------

function boundedNumber(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
}

function toUsageBucket(value: unknown): UsageBucket | null {
  if (!isRecord(value)) return null
  const { promptTokens, outputTokens, totalTokens, calls, costUsd, unpricedTokens, roughCost, estimatedTokens } = value
  if (
    !boundedNumber(promptTokens, USAGE_MAX_TOKENS) ||
    !boundedNumber(outputTokens, USAGE_MAX_TOKENS) ||
    !boundedNumber(totalTokens, USAGE_MAX_TOKENS) ||
    !boundedNumber(unpricedTokens, USAGE_MAX_TOKENS) ||
    !boundedNumber(calls, USAGE_MAX_CALLS) ||
    !boundedNumber(costUsd, USAGE_MAX_COST_USD) ||
    typeof roughCost !== 'boolean' ||
    typeof estimatedTokens !== 'boolean'
  ) {
    return null
  }
  return { promptTokens, outputTokens, totalTokens, calls, costUsd, unpricedTokens, roughCost, estimatedTokens }
}

const PRICES_AS_OF_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

function toUsageSnapshot(value: unknown): UsageSnapshot {
  const zero: UsageBucket = { promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, costUsd: 0, unpricedTokens: 0, roughCost: false, estimatedTokens: false }
  const fail: UsageSnapshot = {
    ok: false,
    sessionActive: false,
    sessionToken: 0,
    categories: { live: zero, reviews: zero, embeddings: zero, coding: zero },
    pricesAsOf: '1970-01-01'
  }
  if (!isRecord(value) || value['ok'] !== true || typeof value['sessionActive'] !== 'boolean') return fail
  const sessionToken = value['sessionToken']
  if (!boundedNumber(sessionToken, USAGE_MAX_SESSION_TOKEN) || !Number.isInteger(sessionToken)) return fail
  const pricesAsOf = value['pricesAsOf']
  if (typeof pricesAsOf !== 'string' || !PRICES_AS_OF_RE.test(pricesAsOf)) return fail
  const rawCategories = value['categories']
  if (!isRecord(rawCategories)) return fail
  const parsed: Partial<Record<UsageCategoryId, UsageBucket>> = {}
  for (const id of USAGE_CATEGORY_IDS) {
    const bucket = toUsageBucket(rawCategories[id])
    if (bucket === null) return fail
    parsed[id] = bucket
  }
  const { live, reviews, embeddings, coding } = parsed
  if (live === undefined || reviews === undefined || embeddings === undefined || coding === undefined) return fail
  return { ok: true, sessionActive: value['sessionActive'], sessionToken, categories: { live, reviews, embeddings, coding }, pricesAsOf }
}

/**
 * Wraps `ipcRenderer.on`/`removeListener` for one push channel: validates
 * each payload, forwards only well-formed ones to `callback`, and returns an
 * unsubscribe function so a caller (e.g. a React effect's cleanup) can't
 * leak a listener across Start/Stop cycles or unmounts.
 */
function subscribe<T>(channel: string, validate: (value: unknown) => T | null, callback: (event: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    const validated = validate(payload)
    if (validated === null) {
      console.warn(`[preload] dropped malformed payload on ${channel}`)
      return
    }
    callback(validated)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** Same contract as `subscribe()`, for a push channel whose payload carries no data -- just a signal that something happened. */
function subscribeSignal(channel: string, callback: () => void): () => void {
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: MockPilotApi = {
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.KEY_VAULT_HAS).then(toBoolean),

  setApiKey: (apiKey: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.KEY_VAULT_SET, apiKey).then(toOperationResult),

  deleteApiKey: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.KEY_VAULT_DELETE).then(toOperationResult),

  testApiKey: (): Promise<TestKeyResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GEMINI_TEST_KEY).then(toOperationResult),

  startLiveSession: (setup: InterviewSetup, focusTopics?: readonly string[]): Promise<OperationResult> =>
    ipcRenderer
      .invoke(IPC_CHANNELS.GEMINI_LIVE_START, focusTopics !== undefined && focusTopics.length > 0 ? { ...setup, focusTopics: [...focusTopics] } : setup)
      .then(toOperationResult),

  stopLiveSession: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GEMINI_LIVE_STOP).then(toOperationResult),

  sendMicChunk: (chunk: ArrayBuffer): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GEMINI_LIVE_SEND_AUDIO, chunk).then(toOperationResult),

  onLiveTranscript: (callback: (event: GeminiLiveTranscriptEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.GEMINI_LIVE_TRANSCRIPT, toLiveTranscriptEvent, callback),

  onLiveAudioChunk: (callback: (event: GeminiLiveAudioChunkEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.GEMINI_LIVE_AUDIO_CHUNK, toLiveAudioChunkEvent, callback),

  onLiveConnectionState: (callback: (event: GeminiLiveConnectionStateEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.GEMINI_LIVE_CONNECTION_STATE, toLiveConnectionStateEvent, callback),

  onLiveInterrupted: (callback: () => void): (() => void) =>
    subscribeSignal(IPC_CHANNELS.GEMINI_LIVE_INTERRUPTED, callback),

  onLiveAnswerReview: (callback: (event: GeminiLiveAnswerReviewEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.GEMINI_LIVE_ANSWER_REVIEW, toLiveAnswerReviewEvent, callback),

  indexInterviewMaterials: (resumePdfBytes: ArrayBuffer | null, jdText: string | null): Promise<RagIndexResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_INDEX_MATERIALS, { resumePdfBytes, jdText }).then(toRagIndexResult),

  getRagStatus: (): Promise<RagStatusResult> => ipcRenderer.invoke(IPC_CHANNELS.RAG_STATUS).then(toRagStatusResult),

  clearInterviewMaterials: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_CLEAR_MATERIALS).then(toOperationResult),

  captureScreenshotNow: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_SCREENSHOT_CAPTURE_NOW).then(toOperationResult),

  onCodingScreenshotPreview: (callback: (event: ScreenshotPreviewEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.CODING_SCREENSHOT_PREVIEW, toScreenshotPreviewEvent, callback),

  confirmScreenshot: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_SCREENSHOT_CONFIRM).then(toOperationResult),

  discardScreenshot: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_SCREENSHOT_DISCARD).then(toOperationResult),

  onCodingScreenshotResult: (callback: (event: ScreenshotResultEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.CODING_SCREENSHOT_RESULT, toScreenshotResultEvent, callback),

  setScreenshotHotkeyActive: (active: boolean): Promise<SetHotkeyResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_SET_HOTKEY_ACTIVE, active).then(toSetHotkeyResult),

  runCode: (language: CodingLanguage, code: string): Promise<RunCodeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_RUN_CODE, { language, code }).then(toRunCodeResult),

  getHints: (problemText: string): Promise<HintsResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_GET_HINTS, { problemText }).then(toHintsResult),

  submitCodeReview: (problemText: string, language: CodingLanguage, code: string): Promise<CodeReviewResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODING_SUBMIT_REVIEW, { problemText, language, code }).then(toCodeReviewResult),

  listHistorySessions: (limit: number, offset: number): Promise<HistoryListResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_LIST_SESSIONS, { limit, offset }).then(toHistoryListResult),

  getHistorySession: (sessionId: number): Promise<HistorySessionDetailResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_SESSION, sessionId).then(toHistorySessionDetailResult),

  getHistoryTopicStats: (): Promise<HistoryTopicStatsResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_TOPIC_STATS).then(toHistoryTopicStatsResult),

  getHistoryWeakAreas: (limit: number): Promise<HistoryWeakAreasResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_WEAK_AREAS, limit).then(toHistoryWeakAreasResult),

  deleteHistorySession: (sessionId: number): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE_SESSION, sessionId).then(toOperationResult),

  clearAllHistory: (): Promise<OperationResult> => ipcRenderer.invoke(IPC_CHANNELS.HISTORY_CLEAR_ALL).then(toOperationResult),

  getUsage: (): Promise<UsageSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.USAGE_GET).then(toUsageSnapshot, () => toUsageSnapshot(null)),

  getStealthState: (): Promise<StealthState> =>
    ipcRenderer.invoke(IPC_CHANNELS.STEALTH_GET_STATE).then(toStealthState),

  setContentProtection: (enable: boolean): Promise<{ ok: boolean; protected: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCREEN_PROTECTION_SET, enable).then(toProtectedResult),

  setAlwaysOnTop: (enable: boolean): Promise<{ ok: boolean; alwaysOnTop: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.STEALTH_SET_ALWAYS_ON_TOP, enable).then(toAlwaysOnTopResult),

  setSkipTaskbar: (enable: boolean): Promise<{ ok: boolean; skipTaskbar: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.STEALTH_SET_SKIP_TASKBAR, enable).then(toSkipTaskbarResult),

  toggleGhostOverlay: (): Promise<{ ok: boolean; active: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GHOST_OVERLAY_TOGGLE).then(toGhostOverlayResult),

  setGhostClickThrough: (clickThrough: boolean): Promise<{ ok: boolean; clickThrough: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GHOST_OVERLAY_CLICK_THROUGH, clickThrough).then(toGhostClickThroughResult),

  setGhostOpacity: (opacity: number): Promise<{ ok: boolean; opacity: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GHOST_OVERLAY_OPACITY, opacity).then(toGhostOpacityResult),

  onStealthStateChanged: (callback: (state: StealthState) => void): (() => void) =>
    subscribe(IPC_CHANNELS.STEALTH_STATE_CHANGED, toStealthState, callback),

  triggerPanic: (): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.STEALTH_PANIC).then(toOperationResult),

  onPanic: (callback: () => void): (() => void) =>
    subscribeSignal(IPC_CHANNELS.STEALTH_PANIC, callback)
}

/** Preload screenProtection object explicitly matching the user request. */
const screenProtection: ScreenProtectionApi = {
  enable: () => ipcRenderer.invoke(IPC_CHANNELS.SCREEN_PROTECTION_SET, true).then(toBoolean),
  disable: () => ipcRenderer.invoke(IPC_CHANNELS.SCREEN_PROTECTION_SET, false).then(toBoolean),
  isEnabled: () => ipcRenderer.invoke(IPC_CHANNELS.SCREEN_PROTECTION_GET).then(toBoolean),
  toggle: () =>
    ipcRenderer
      .invoke(IPC_CHANNELS.SCREEN_PROTECTION_GET)
      .then((current: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SCREEN_PROTECTION_SET, !toBoolean(current)))
      .then(toBoolean)
}

contextBridge.exposeInMainWorld('screenProtection', screenProtection)
contextBridge.exposeInMainWorld('api', api)
