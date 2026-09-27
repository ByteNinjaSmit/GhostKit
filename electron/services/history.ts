/**
 * history.ts
 *
 * Main-process-only service implementing Phase 6's session history and
 * analytics store: interview sessions, their transcript turns, per-answer
 * reviews, and the topic labels those reviews are filed under. Mirrors
 * `rag.ts`: a plain `better-sqlite3` database under
 * `app.getPath('userData')` (its own file, `history.sqlite3` -- deliberately
 * NOT inside `rag.sqlite3`, so clearing/deleting one store can never touch the
 * other and this one needs no vec extension), lazy open, WAL, `secure_delete`,
 * `closeDb()` on quit, parameterized SQL only, one-transaction multi-row
 * writes, fixed user-facing error strings (raw SQLite text and filesystem
 * paths never leave this module -- they are logged through `redact` at most),
 * and never throws across its public API. Never imported by renderer or
 * preload code.
 *
 * PRIVACY: this file holds full interview transcripts and answers -- the most
 * sensitive data in the app. It is local-only (nothing here is ever sent
 * anywhere; the same text already went to Gemini during the interview itself),
 * `secure_delete = ON` makes deleted rows get overwritten instead of lingering
 * in free pages, deletes are followed by `wal_checkpoint(TRUNCATE)` so they do
 * not linger in the WAL either, and the UI offers per-session Delete and Clear
 * all history (each behind a confirm step).
 *
 * WRITE PATH (called by geminiLive.ts while an interview runs): `createSession`,
 * `appendTurn`, `addReview`, `endSession`. Each is fire-and-forget-safe -- they
 * catch everything, log a redacted message, and return a null/false sentinel,
 * so a history failure can never break, block or crash the live interview.
 * better-sqlite3 is synchronous; each call is one small statement (or one small
 * transaction), fine to run inline.
 *
 * SESSION IDENTITY: `sessions.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so an
 * id is never reused, even after that session (or all history) is deleted. A
 * late-resolving review that captured session id N at answer time therefore
 * either lands on session N's own row or fails its foreign key and is dropped;
 * it can never land on a newer session that happened to be assigned N.
 * The one exception is `resetDatabaseFiles` (Clear all when the DB can't be
 * opened): deleting the file resets AUTOINCREMENT, so the recreated database's
 * `sqlite_sequence` is SEEDED from `maxSessionIdSeen` (the highest id this
 * process ever handed out) -- new ids always start above any id a still
 * in-flight review captured, which is then dropped by its FK.
 *
 * HOT-PATH SAFETY: the write path runs synchronously inside the Live message
 * handler, so a locked database must never stall audio/IPC. The connection uses
 * a 100 ms busy timeout (not better-sqlite3's 5 s default) -- a turn that can't
 * get the write lock in that time is dropped (logged), not waited for -- and an
 * open failure (corrupt file, newer schema, unwritable dir) is remembered for
 * OPEN_RETRY_COOLDOWN_MS so it is not re-opened, re-migrated and re-logged on
 * every turn. `closeDb()` (app quit) is final: late writes never reopen it.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Database from 'better-sqlite3'
import { redact } from '../lib/redact'
import {
  GENERAL_TOPIC,
  HISTORY_MAX_OFFSET,
  HISTORY_MAX_PAGE_SIZE,
  HISTORY_MAX_REVIEWS_RETURNED,
  HISTORY_MAX_TOPICS_RETURNED,
  HISTORY_MAX_TREND_POINTS,
  HISTORY_MAX_TURNS_RETURNED,
  HISTORY_MAX_WEAK_AREAS,
  INTERVIEW_DIFFICULTIES,
  INTERVIEW_ROLES,
  MIN_WEAK_AREA_SAMPLES,
  WEAK_AREA_SCORE_THRESHOLD,
  normalizeTopicLabel,
  parseFocusTopics
} from '../ipc-types'
import type {
  AnswerReviewStar,
  AnswerSpeechMetrics,
  GeminiLiveSpeaker,
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
  OperationResult,
  TopicStat,
  TopicTrendPoint
} from '../ipc-types'

/** Stored-text caps. A ~90s spoken answer is a couple of KB; these only bound pathological input. */
const MAX_TURN_CHARS = 6_000
const MAX_QUESTION_CHARS = 2_000
const MAX_IMPROVED_ANSWER_CHARS = 6_000
const MAX_FOLLOW_UP_CHARS = 1_000
const MAX_LIST_ITEM_CHARS = 1_000
const MAX_LIST_ITEMS = 20
const MAX_COMPANY_CHARS_STORED = 200

/** Trend window and how many topics get a trend series. */
const TREND_WINDOW_DAYS = 90
const TREND_TOPIC_LIMIT = 6

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Bumped when the schema changes; add a `case` to `migrate` for each bump (never edit an old case). */
const LATEST_SCHEMA_VERSION = 1

const DB_FILE_NAME = 'history.sqlite3'
/** Max time a statement waits for another connection's lock. Deliberately tiny: see HOT-PATH SAFETY above. */
const BUSY_TIMEOUT_MS = 100
/** After a failed open, don't try again for this long (every turn would otherwise retry). `clearAllHistory` clears it. */
const OPEN_RETRY_COOLDOWN_MS = 60_000

let db: Database.Database | null = null
/** Set by `closeDb()` (app quit). Final for this process: `getDb()` throws afterwards. */
let closed = false
/** ms epoch of the last failed open, `null` when the last open succeeded / none yet. */
let openFailedAt: number | null = null
/** Highest `sessions.id` this process has handed out; used to seed AUTOINCREMENT after a file reset. */
let maxSessionIdSeen = 0

const ROLE_SET: ReadonlySet<string> = new Set(INTERVIEW_ROLES)
const DIFFICULTY_SET: ReadonlySet<string> = new Set(INTERVIEW_DIFFICULTIES)

function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Applies every schema step above the database's current `PRAGMA user_version`,
 * in one transaction, so a later phase can add a column/table without asking
 * anyone to delete their history. A database from a NEWER build (version above
 * what this code knows) is refused rather than guessed at.
 */
function migrate(instance: Database.Database): void {
  const current = instance.pragma('user_version', { simple: true })
  const version = typeof current === 'number' ? current : 0
  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(`history database schema v${version} is newer than this app supports (v${LATEST_SCHEMA_VERSION})`)
  }
  if (version === LATEST_SCHEMA_VERSION) return

  const tx = instance.transaction(() => {
    switch (version) {
      case 0:
        instance.exec(`
          CREATE TABLE sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            role TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            company TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL,
            focus_topics TEXT
          );
          CREATE INDEX idx_sessions_started ON sessions (started_at DESC);

          CREATE TABLE topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
          );

          CREATE TABLE turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            speaker TEXT NOT NULL CHECK (speaker IN ('user', 'interviewer')),
            text TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER NOT NULL,
            UNIQUE (session_id, idx)
          );

          CREATE TABLE reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
            answer_index INTEGER NOT NULL,
            turn_id INTEGER REFERENCES turns (id) ON DELETE SET NULL,
            question TEXT NOT NULL,
            score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
            star_situation INTEGER NOT NULL,
            star_task INTEGER NOT NULL,
            star_action INTEGER NOT NULL,
            star_result INTEGER NOT NULL,
            missing_points TEXT NOT NULL,
            technical_errors TEXT NOT NULL,
            improved_answer TEXT NOT NULL,
            follow_up TEXT NOT NULL,
            wpm REAL,
            filler_count INTEGER NOT NULL,
            longest_pause_ms INTEGER NOT NULL,
            topic_id INTEGER NOT NULL REFERENCES topics (id),
            created_at INTEGER NOT NULL,
            UNIQUE (session_id, answer_index)
          );
          CREATE INDEX idx_reviews_session ON reviews (session_id);
          CREATE INDEX idx_reviews_topic ON reviews (topic_id, created_at);
          CREATE INDEX idx_reviews_turn ON reviews (turn_id);
        `)
      // idx_reviews_turn lives in this v1 block on purpose: no shipped build ever created a
      // v1 database (verified before the change -- no history.sqlite3 existed), so v1 was still
      // editable. From here on, schema changes are a new `case` + a version bump.
      // (none yet -- a v2 would add `case 1:` here and bump LATEST_SCHEMA_VERSION)
    }
    instance.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`)
  })
  tx()
}

function historyDbPath(): string {
  return join(app.getPath('userData'), DB_FILE_NAME)
}

/** Opens, configures, migrates and crash-recovers the database. Throws on any failure (the handle is closed first). */
function openDb(): Database.Database {
  const instance = new Database(historyDbPath(), { timeout: BUSY_TIMEOUT_MS })
  try {
    instance.pragma('journal_mode = WAL')
    // WAL + NORMAL is crash-safe for the database (a power cut can lose the last
    // few commits, never corrupt it) and avoids an fsync per turn on the hot path.
    instance.pragma('synchronous = NORMAL')
    // Overwrite freed pages instead of leaving deleted transcript text in
    // SQLite's freelist -- this file holds the most sensitive data in the app.
    instance.pragma('secure_delete = ON')
    // Per-connection and off by default: without it, ON DELETE CASCADE (the
    // only thing keeping turns/reviews from orphaning) silently does nothing.
    instance.pragma('foreign_keys = ON')
    migrate(instance)
    seedSessionSequence(instance)
    // Nothing can be live at first open (this runs before this process has
    // created any session -- and app.requestSingleInstanceLock() in main.ts
    // guarantees no OTHER MockPilot process has one either), so any row still
    // lacking `ended_at` is left over from a crash / forced kill.
    const recover = instance.transaction(() => {
      // A crashed session that never recorded a turn is worth nothing: remove it
      // (endSession does the same for a clean stop).
      instance
        .prepare('DELETE FROM sessions WHERE ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.id)')
        .run()
      // The rest are closed out at their last activity so they aren't shown as
      // "in progress" forever.
      instance
        .prepare(
          `UPDATE sessions
           SET ended_at = COALESCE((SELECT MAX(finished_at) FROM turns WHERE turns.session_id = sessions.id), started_at)
           WHERE ended_at IS NULL`
        )
        .run()
    })
    recover()
  } catch (err) {
    try {
      instance.close()
    } catch {
      // Already failing; nothing more to do with this handle.
    }
    throw err
  }
  return instance
}

/** After a file reset the AUTOINCREMENT counter restarts at 1; raise it to `maxSessionIdSeen` so an id captured before the reset can never be reused. */
function seedSessionSequence(instance: Database.Database): void {
  if (maxSessionIdSeen <= 0) return
  const row = instance.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sessions'").get() as { seq: number } | undefined
  if (row === undefined) {
    instance.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('sessions', ?)").run(maxSessionIdSeen)
  } else if (row.seq < maxSessionIdSeen) {
    instance.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'sessions'").run(maxSessionIdSeen)
  }
}

/** Lazily opens (and schema-initializes/migrates) the history database. Throws on failure or after `closeDb()` -- callers must catch. */
function getDb(): Database.Database {
  if (closed) throw new Error('history database is closed')
  if (db !== null) return db
  if (openFailedAt !== null && Date.now() - openFailedAt < OPEN_RETRY_COOLDOWN_MS) {
    throw new Error('history database is unavailable (recent open failure)')
  }
  try {
    db = openDb()
    openFailedAt = null
    return db
  } catch (err) {
    openFailedAt = Date.now()
    console.error('[history] could not open the history database; history is skipped for the next minute:', redact(String(err)))
    throw err
  }
}

/** Closes the database cleanly (checkpoints the WAL back into the main file) -- called on app quit so deleted transcript text doesn't linger in `history.sqlite3-wal`. Final: afterwards `getDb()` never reopens (a late review can't resurrect it). Safe to call when never opened. */
export function closeDb(): void {
  closed = true
  if (db === null) return
  const instance = db
  db = null
  try {
    instance.pragma('wal_checkpoint(TRUNCATE)')
    instance.close()
  } catch (err) {
    console.warn('[history] error while closing the history database:', redact(String(err)))
  }
}

/**
 * Last-resort reset: closes any open handle and deletes the database files
 * (fixed names under userData -- never a caller-supplied path), so the next
 * open recreates an empty database. Used by `clearAllHistory` when the DB
 * can't be opened/cleared normally (corrupt file, newer schema) -- otherwise
 * the user would have no way to delete their transcripts. Returns whether every
 * file is gone.
 */
function resetDatabaseFiles(): boolean {
  if (closed) return false
  if (db !== null) {
    try {
      db.close()
    } catch (err) {
      console.warn('[history] error while closing the history database before reset:', redact(String(err)))
    }
    db = null
  }
  const base = historyDbPath()
  let allGone = true
  for (const file of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      unlinkSync(file)
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
      if (code !== 'ENOENT') {
        allGone = false
        console.error('[history] could not delete a history database file (code:', typeof code === 'string' ? code : 'unknown', ')')
      }
    }
  }
  if (allGone) openFailedAt = null
  return allGone
}

/** Best-effort WAL truncation after a delete, so removed transcript text doesn't sit in the -wal file. Never throws. */
function checkpointAfterDelete(instance: Database.Database): void {
  try {
    instance.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    console.warn('[history] wal checkpoint after delete failed:', redact(String(err)))
  }
}

// ---------------------------------------------------------------------------
// Write path (geminiLive.ts). Never throws.
// ---------------------------------------------------------------------------

/**
 * Inserts a new session row for a live interview that just opened. Returns its
 * id, or `null` on any failure (the interview simply goes unrecorded).
 * `focusTopics` is re-normalized here regardless of what the caller did.
 */
export function createSession(setup: InterviewSetup, focusTopics: readonly string[]): number | null {
  try {
    const instance = getDb()
    const topics = parseFocusTopics([...focusTopics]) ?? []
    const info = instance
      .prepare(
        `INSERT INTO sessions (started_at, ended_at, role, difficulty, company, duration_minutes, focus_topics)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        setup.role,
        setup.difficulty,
        clampText(setup.company.trim(), MAX_COMPANY_CHARS_STORED),
        Math.round(setup.durationMinutes),
        topics.length > 0 ? JSON.stringify(topics) : null
      )
    const id = Number(info.lastInsertRowid)
    if (id > maxSessionIdSeen) maxSessionIdSeen = id
    return id
  } catch (err) {
    console.error('[history] failed to create a session row:', redact(String(err)))
    return null
  }
}

/**
 * Appends one finished transcript turn to a session. `idx` is assigned in SQL
 * (max + 1 for that session) so there is no in-memory counter to fall out of
 * step with the database. Returns the new turn's id, or `null` (bad input,
 * unknown/deleted session -- the FK rejects it -- or any other failure).
 */
export function appendTurn(sessionId: number, speaker: GeminiLiveSpeaker, text: string, startedAt: number, finishedAt: number): number | null {
  try {
    if (!isPositiveSafeInt(sessionId)) return null
    const trimmed = text.trim()
    if (trimmed.length === 0) return null
    const instance = getDb()
    const info = instance
      .prepare(
        `INSERT INTO turns (session_id, idx, speaker, text, started_at, finished_at)
         VALUES (?, (SELECT COALESCE(MAX(idx), -1) + 1 FROM turns WHERE session_id = ?), ?, ?, ?, ?)`
      )
      .run(sessionId, sessionId, speaker, clampText(trimmed, MAX_TURN_CHARS), Math.round(startedAt), Math.round(finishedAt))
    return Number(info.lastInsertRowid)
  } catch (err) {
    console.error('[history] failed to append a turn:', redact(String(err)))
    return null
  }
}

export interface NewReviewRecord {
  sessionId: number
  answerIndex: number
  turnId: number | null
  question: string
  score: number
  star: AnswerReviewStar
  missingPoints: readonly string[]
  technicalErrors: readonly string[]
  improvedAnswer: string
  followUpQuestion: string
  topic: string
  metrics: AnswerSpeechMetrics
}

function boundedList(items: readonly string[]): string {
  return JSON.stringify(items.slice(0, MAX_LIST_ITEMS).map((item) => clampText(item, MAX_LIST_ITEM_CHARS)))
}

/**
 * Persists one successful (`ok: true`) review. The topic upsert and the review
 * insert run in ONE transaction. Returns whether it was written; a session
 * that no longer exists (deleted meanwhile) fails its FK and returns `false`.
 */
export function addReview(record: NewReviewRecord): boolean {
  try {
    if (!isPositiveSafeInt(record.sessionId) || !Number.isSafeInteger(record.answerIndex) || record.answerIndex < 0) return false
    if (!Number.isFinite(record.score)) return false
    const score = Math.round(Math.min(10, Math.max(1, record.score)))
    const topic = normalizeTopicLabel(record.topic) ?? GENERAL_TOPIC
    const instance = getDb()

    const tx = instance.transaction(() => {
      instance.prepare('INSERT OR IGNORE INTO topics (name) VALUES (?)').run(topic)
      const topicRow = instance.prepare('SELECT id FROM topics WHERE name = ?').get(topic) as { id: number } | undefined
      if (topicRow === undefined) throw new Error('topic row missing after upsert')
      instance
        .prepare(
          `INSERT INTO reviews (
             session_id, answer_index, turn_id, question, score,
             star_situation, star_task, star_action, star_result,
             missing_points, technical_errors, improved_answer, follow_up,
             wpm, filler_count, longest_pause_ms, topic_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.sessionId,
          record.answerIndex,
          record.turnId !== null && isPositiveSafeInt(record.turnId) ? record.turnId : null,
          clampText(record.question, MAX_QUESTION_CHARS),
          score,
          record.star.situation ? 1 : 0,
          record.star.task ? 1 : 0,
          record.star.action ? 1 : 0,
          record.star.result ? 1 : 0,
          boundedList(record.missingPoints),
          boundedList(record.technicalErrors),
          clampText(record.improvedAnswer, MAX_IMPROVED_ANSWER_CHARS),
          clampText(record.followUpQuestion, MAX_FOLLOW_UP_CHARS),
          record.metrics.wpm,
          Math.max(0, Math.round(record.metrics.fillerWordCount)),
          Math.max(0, Math.round(record.metrics.longestPauseMs)),
          topicRow.id,
          Date.now()
        )
    })
    tx()
    return true
  } catch (err) {
    console.error('[history] failed to save a review:', redact(String(err)))
    return false
  }
}

/**
 * Marks a session ended. A session that never recorded a single turn (the
 * interview was opened and immediately stopped) has nothing worth keeping and
 * is removed instead of cluttering the list. Idempotent; never throws.
 */
export function endSession(sessionId: number): void {
  try {
    if (!isPositiveSafeInt(sessionId)) return
    const instance = getDb()
    const tx = instance.transaction(() => {
      instance.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), sessionId)
      const turnCount = (instance.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?').get(sessionId) as { c: number }).c
      if (turnCount === 0) {
        instance.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      }
    })
    tx()
  } catch (err) {
    console.error('[history] failed to end a session:', redact(String(err)))
  }
}

// ---------------------------------------------------------------------------
// Read path (IPC). Never throws; failures become fixed strings.
// ---------------------------------------------------------------------------

interface SessionRow {
  id: number
  started_at: number
  ended_at: number | null
  role: string
  difficulty: string
  company: string
  duration_minutes: number
  focus_topics: string | null
  answer_count: number
  avg_score: number | null
}

/** Shared SELECT for a session summary; `avg_score` is computed at read time from the session's reviews, never stored, so it can't go stale. */
const SESSION_SUMMARY_SELECT = `
  SELECT s.id, s.started_at, s.ended_at, s.role, s.difficulty, s.company, s.duration_minutes, s.focus_topics,
         (SELECT COUNT(*) FROM reviews r WHERE r.session_id = s.id) AS answer_count,
         (SELECT AVG(r.score) FROM reviews r WHERE r.session_id = s.id) AS avg_score
  FROM sessions s`

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Weak areas use two decimals: a 6.96 average must not round to a "7" that reads as passing while the topic is flagged < 7. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function parseStoredFocusTopics(raw: string | null): string[] {
  if (raw === null) return []
  try {
    return parseFocusTopics(JSON.parse(raw) as unknown) ?? []
  } catch {
    return []
  }
}

function toSummary(row: SessionRow): HistorySessionSummary {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    role: (ROLE_SET.has(row.role) ? row.role : 'sde') as InterviewRole,
    difficulty: (DIFFICULTY_SET.has(row.difficulty) ? row.difficulty : 'medium') as InterviewDifficulty,
    company: row.company,
    durationMinutes: row.duration_minutes,
    focusTopics: parseStoredFocusTopics(row.focus_topics),
    answerCount: row.answer_count,
    avgScore: row.avg_score === null ? null : round1(row.avg_score)
  }
}

/** Sessions newest-first, one page at a time. `limit`/`offset` are clamped to the shared bounds regardless of the caller. */
export function listSessions(limit: number, offset: number): HistoryListResult {
  try {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(HISTORY_MAX_PAGE_SIZE, Math.max(1, limit)) : HISTORY_MAX_PAGE_SIZE
    const safeOffset = Number.isSafeInteger(offset) ? Math.min(HISTORY_MAX_OFFSET, Math.max(0, offset)) : 0
    const instance = getDb()
    // One extra row tells us whether another page exists without a COUNT(*).
    const rows = instance
      .prepare(`${SESSION_SUMMARY_SELECT} ORDER BY s.started_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .all(safeLimit + 1, safeOffset) as SessionRow[]
    return { ok: true, sessions: rows.slice(0, safeLimit).map(toSummary), hasMore: rows.length > safeLimit }
  } catch (err) {
    console.error('[history] failed to list sessions:', redact(String(err)))
    return { ok: false, error: 'Could not read session history.', sessions: [], hasMore: false }
  }
}

interface TurnRow {
  id: number
  idx: number
  speaker: string
  text: string
  started_at: number
  finished_at: number
}

interface ReviewRow {
  id: number
  answer_index: number
  turn_id: number | null
  question: string
  score: number
  star_situation: number
  star_task: number
  star_action: number
  star_result: number
  missing_points: string
  technical_errors: string
  improved_answer: string
  follow_up: string
  wpm: number | null
  filler_count: number
  longest_pause_ms: number
  topic: string
  created_at: number
}

function parseStoredStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, MAX_LIST_ITEMS)
  } catch {
    return []
  }
}

function toReview(row: ReviewRow): HistoryReview {
  return {
    id: row.id,
    answerIndex: row.answer_index,
    turnId: row.turn_id,
    question: row.question,
    score: row.score,
    star: {
      situation: row.star_situation === 1,
      task: row.star_task === 1,
      action: row.star_action === 1,
      result: row.star_result === 1
    },
    missingPoints: parseStoredStringList(row.missing_points),
    technicalErrors: parseStoredStringList(row.technical_errors),
    improvedAnswer: row.improved_answer,
    followUpQuestion: row.follow_up,
    metrics: { wpm: row.wpm, fillerWordCount: row.filler_count, longestPauseMs: row.longest_pause_ms },
    topic: row.topic,
    createdAt: row.created_at
  }
}

/** One session with its turns (capped at `HISTORY_MAX_TURNS_RETURNED`, in order) and reviews (capped at `HISTORY_MAX_REVIEWS_RETURNED`). */
export function getSessionDetail(sessionId: number): HistorySessionDetailResult {
  try {
    if (!isPositiveSafeInt(sessionId)) return { ok: false, error: 'Invalid session.' }
    const instance = getDb()
    const sessionRow = instance.prepare(`${SESSION_SUMMARY_SELECT} WHERE s.id = ?`).get(sessionId) as SessionRow | undefined
    if (sessionRow === undefined) return { ok: false, error: 'That session no longer exists.' }

    const turnRows = instance
      .prepare('SELECT id, idx, speaker, text, started_at, finished_at FROM turns WHERE session_id = ? ORDER BY idx ASC LIMIT ?')
      .all(sessionId, HISTORY_MAX_TURNS_RETURNED + 1) as TurnRow[]
    const turns: HistoryTurn[] = turnRows.slice(0, HISTORY_MAX_TURNS_RETURNED).map((row) => ({
      id: row.id,
      idx: row.idx,
      speaker: row.speaker === 'user' ? 'user' : 'interviewer',
      text: row.text,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }))

    const reviewRows = instance
      .prepare(
        `SELECT r.id, r.answer_index, r.turn_id, r.question, r.score,
                r.star_situation, r.star_task, r.star_action, r.star_result,
                r.missing_points, r.technical_errors, r.improved_answer, r.follow_up,
                r.wpm, r.filler_count, r.longest_pause_ms, t.name AS topic, r.created_at
         FROM reviews r JOIN topics t ON t.id = r.topic_id
         WHERE r.session_id = ? ORDER BY r.answer_index ASC LIMIT ?`
      )
      .all(sessionId, HISTORY_MAX_REVIEWS_RETURNED) as ReviewRow[]

    return {
      ok: true,
      session: toSummary(sessionRow),
      turns,
      reviews: reviewRows.map(toReview),
      turnsTruncated: turnRows.length > HISTORY_MAX_TURNS_RETURNED
    }
  } catch (err) {
    console.error('[history] failed to read a session:', redact(String(err)))
    return { ok: false, error: 'Could not read that session.' }
  }
}

interface TopicStatRow {
  topic: string
  c: number
  avg_score: number
}

/**
 * Per-topic count/average over every persisted review (most-reviewed first,
 * capped), plus a per-local-day average series for the `TREND_TOPIC_LIMIT`
 * most-reviewed topics over the last `TREND_WINDOW_DAYS` days. The day bucket
 * is the machine's local calendar day; two sessions on one day share a point.
 */
export function getTopicStats(): HistoryTopicStatsResult {
  try {
    const instance = getDb()
    const topicRows = instance
      .prepare(
        `SELECT t.name AS topic, COUNT(*) AS c, AVG(r.score) AS avg_score
         FROM reviews r JOIN topics t ON t.id = r.topic_id
         GROUP BY t.id ORDER BY c DESC, t.name ASC LIMIT ?`
      )
      .all(HISTORY_MAX_TOPICS_RETURNED) as TopicStatRow[]
    const topics: TopicStat[] = topicRows.map((row) => ({ topic: row.topic, count: row.c, avgScore: round1(row.avg_score) }))

    const cutoff = Date.now() - TREND_WINDOW_DAYS * MS_PER_DAY
    const trendRows = instance
      .prepare(
        `SELECT t.name AS topic,
                date(r.created_at / 1000, 'unixepoch', 'localtime') AS day,
                AVG(r.score) AS avg_score, COUNT(*) AS c
         FROM reviews r JOIN topics t ON t.id = r.topic_id
         WHERE r.created_at >= ?
           AND r.topic_id IN (
             SELECT topic_id FROM reviews WHERE created_at >= ?
             GROUP BY topic_id ORDER BY COUNT(*) DESC, topic_id ASC LIMIT ?
           )
         GROUP BY r.topic_id, day
         ORDER BY day ASC, t.name ASC
         LIMIT ?`
      )
      .all(cutoff, cutoff, TREND_TOPIC_LIMIT, HISTORY_MAX_TREND_POINTS) as Array<{ topic: string; day: string; avg_score: number; c: number }>
    const trend: TopicTrendPoint[] = trendRows.map((row) => ({ topic: row.topic, day: row.day, avgScore: round1(row.avg_score), count: row.c }))

    return { ok: true, topics, trend }
  } catch (err) {
    console.error('[history] failed to compute topic stats:', redact(String(err)))
    return { ok: false, error: 'Could not read session history.', topics: [], trend: [] }
  }
}

/**
 * Weak areas: topics ranked by LOWEST average score, subject to
 *  - at least `MIN_WEAK_AREA_SAMPLES` persisted reviews (a single bad answer
 *    must not dominate the ranking),
 *  - an average below `WEAK_AREA_SCORE_THRESHOLD` (7 = "would pass at this
 *    level" in prompts/review.md -- a topic you already pass is not weak), and
 *  - not the catch-all `'general'` label (drilling "general" is meaningless).
 * Ties break on more reviews first (more evidence), then name. All-time
 * average; no recency weighting yet.
 */
export function getWeakAreas(limit: number): HistoryWeakAreasResult {
  try {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(HISTORY_MAX_WEAK_AREAS, Math.max(1, limit)) : HISTORY_MAX_WEAK_AREAS
    const instance = getDb()
    const rows = instance
      .prepare(
        `SELECT t.name AS topic, COUNT(*) AS c, AVG(r.score) AS avg_score
         FROM reviews r JOIN topics t ON t.id = r.topic_id
         WHERE t.name <> ?
         GROUP BY t.id
         HAVING COUNT(*) >= ? AND AVG(r.score) < ?
         ORDER BY avg_score ASC, c DESC, t.name ASC
         LIMIT ?`
      )
      .all(GENERAL_TOPIC, MIN_WEAK_AREA_SAMPLES, WEAK_AREA_SCORE_THRESHOLD, safeLimit) as TopicStatRow[]
    return { ok: true, areas: rows.map((row) => ({ topic: row.topic, count: row.c, avgScore: round2(row.avg_score) })) }
  } catch (err) {
    console.error('[history] failed to compute weak areas:', redact(String(err)))
    return { ok: false, error: 'Could not read session history.', areas: [] }
  }
}

/** Topics no review points at any more are removed, so a deleted session's labels don't linger. Must run inside the caller's transaction. */
function deleteOrphanTopics(instance: Database.Database): void {
  instance.prepare('DELETE FROM topics WHERE id NOT IN (SELECT DISTINCT topic_id FROM reviews)').run()
}

/**
 * Permanently deletes one session; its turns and reviews go with it via
 * `ON DELETE CASCADE` (foreign keys are enabled per connection in `getDb`).
 * Idempotent -- deleting an already-gone session is `ok`. Callers (main.ts)
 * must refuse to delete the session that is currently running.
 */
export function deleteSession(sessionId: number): OperationResult {
  try {
    if (!isPositiveSafeInt(sessionId)) return { ok: false, error: 'Invalid session.' }
    const instance = getDb()
    const tx = instance.transaction(() => {
      instance.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      deleteOrphanTopics(instance)
    })
    tx()
    checkpointAfterDelete(instance)
    return { ok: true }
  } catch (err) {
    console.error('[history] failed to delete a session:', redact(String(err)))
    return { ok: false, error: 'Could not delete that session.' }
  }
}

/**
 * Deletes ALL history (sessions, turns, reviews, topics) in one transaction,
 * then truncates the WAL, like rag.ts's `clearMaterials`. Session ids keep
 * counting up afterwards (AUTOINCREMENT) so a stale in-flight write can never
 * land on a session created after the clear.
 *
 * If the database can't be opened or cleared (corrupt file, a newer schema than
 * this build knows, a lock), it falls back to `resetDatabaseFiles` -- deleting
 * the files outright -- so "Clear all history" always works and is the way out
 * of a broken database. The recreated file's id sequence is seeded (see
 * `seedSessionSequence`) so an in-flight review can't land on a reused id.
 */
export function clearAllHistory(): OperationResult {
  try {
    const instance = getDb()
    const tx = instance.transaction(() => {
      instance.prepare('DELETE FROM reviews').run()
      instance.prepare('DELETE FROM turns').run()
      instance.prepare('DELETE FROM sessions').run()
      instance.prepare('DELETE FROM topics').run()
    })
    tx()
    checkpointAfterDelete(instance)
    return { ok: true }
  } catch (err) {
    console.error('[history] failed to clear history normally, resetting the database files:', redact(String(err)))
    return resetDatabaseFiles() ? { ok: true } : { ok: false, error: 'Could not clear history.' }
  }
}
