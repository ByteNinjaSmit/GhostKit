/**
 * rag.ts
 *
 * Main-process-only service implementing Phase 3's resume/JD RAG pipeline:
 * PDF bytes / pasted text -> chunk -> embed (gemini-embedding-001) -> store
 * (sqlite-vec) -> retrieve top-k chunks at interview-start time. Mirrors the
 * other services in this directory: never throws across its public API,
 * never lets a raw SDK/network/filesystem error string cross into a log or
 * the renderer (routed through `describeGeminiError`/`redact`), and is never
 * imported by renderer or preload code.
 *
 * Storage: a small SQLite database at
 * `app.getPath('userData')/rag.sqlite3` (NOT the app install directory,
 * which is read-only once packaged). Two independent table pairs --
 * `resume_chunks`/`resume_vectors` and `jd_chunks`/`jd_vectors` -- rather
 * than one shared table with a `source` column. sqlite-vec's `vec0` virtual
 * tables support a "partition key" column for filtering a single table by
 * source, but that feature's exact syntax couldn't be confirmed against the
 * installed 0.1.9 package (no bundled docs, no network access while writing
 * this). Two plain per-source tables only depend on the well-established
 * core `vec0` KNN query shape (`SELECT rowid, distance FROM vec_table WHERE
 * embedding MATCH ? ORDER BY distance LIMIT ?`), which is safer to rely on
 * without being able to verify anything more exotic live.
 *
 * Re-indexing replaces a source's entire chunk set: a fresh resume upload
 * (or JD paste) always fully overwrites whatever was stored for that source
 * before, rather than accumulating duplicate/stale chunks across sessions.
 * The two sources are independent -- re-indexing the JD never touches
 * whatever resume chunks are already stored, and vice versa (see
 * `indexMaterials`'s doc comment). When BOTH sources are part of one call,
 * they're written in a single transaction (see `replaceMaterials`) so a
 * failure partway through can never leave one source updated and the other
 * not, reported as a plain failure either way.
 */
import { app } from 'electron'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import pdfParse from 'pdf-parse'
import { GoogleGenAI } from '@google/genai'
import { getApiKey } from './keyVault'
import { describeGeminiError } from './gemini'
import * as usage from './usage'
import { redact } from '../lib/redact'
import { INTERVIEW_ROLE_LABELS, MAX_JD_TEXT_CHARS, MAX_RESUME_PDF_BYTES } from '../ipc-types'
import type { InterviewRole, RagIndexResult, RagStatusResult, OperationResult } from '../ipc-types'

/**
 * Embedding model + fixed output dimensionality. gemini-embedding-001
 * supports Matryoshka truncation to a handful of documented reduced sizes
 * (768 / 1536 / 3072, full is 3072) -- 768 is used here to keep the sqlite-vec
 * table and every embedding call cheap; the dimension is fixed for the
 * lifetime of the on-disk index, since a KNN comparison between vectors of
 * two different sizes is meaningless. If this ever changes, `rag.sqlite3`
 * must be deleted/migrated (the schema hard-codes the vector width below).
 */
const EMBED_MODEL_ID = 'gemini-embedding-001'
const EMBED_DIM = 768

/**
 * Per-request timeout for embedding HTTP calls. Without this, a hung
 * request (network stall, Google-side slowness) blocks indexMaterials
 * indefinitely (Setup.tsx sits on "Processing…" forever) and, worse, blocks
 * geminiLive.ts's openConnection -> buildInterviewerSystemInstruction ->
 * retrieveChunks call chain the same way CONNECT_TIMEOUT_MS was added to
 * geminiLive.ts to fix for ai.live.connect() itself -- a hang here reopens
 * that exact hole one call earlier, with startSession()'s `connecting` latch
 * stuck true (and therefore every future Start refused) until this settles.
 */
const EMBED_TIMEOUT_MS = 8000

/** Top-k chunks returned per source at retrieval time. */
const TOP_K = 4

/** Rough per-chunk target (a token is ~0.75 words, so 300 words ~= 400 tokens). */
const CHUNK_TARGET_WORDS = 300

/** Defensive cap on parsed/pasted text before chunking -- independent of the upstream PDF byte-size cap, since a small PDF can still decompress to a lot of text. */
const MAX_EXTRACTED_TEXT_CHARS = 100_000

/** Defensive cap on how many chunks a single source can produce/embed, regardless of input size. */
const MAX_CHUNKS_PER_SOURCE = 40

/**
 * Hard cap on the final joined chunk text substituted into the prompt
 * template's `{{resume_chunks}}`/`{{jd_chunks}}` slots. A few thousand
 * characters is plenty of grounding context; this exists specifically so a
 * huge resume/JD (or an adversarial one aiming at prompt injection via sheer
 * volume) can't blow out the system prompt. See geminiLive.ts's and
 * promptTemplate.ts's doc comments on why that bound matters (prompt-size
 * blowout / prompt-injection surface from unbounded user-supplied text).
 */
const MAX_PROMPT_CHUNK_CHARS = 4000

/** Number of chunks embedded per `embedContent` call. */
const EMBED_BATCH_SIZE = 16

/**
 * Page count cap for `pdf-parse` (which runs an old, unmaintained,
 * eval-enabled pdf.js build on the main event loop, synchronously per page --
 * see `parseResumePdf`'s doc comment). A resume is never legitimately
 * hundreds of pages; this bounds how much main-process work one upload can
 * demand regardless of a crafted file's page count.
 */
const MAX_PDF_PAGES = 30

/** Wall-clock cap on the whole PDF parse call, so a pathological file can't wedge indexMaterials (and therefore Setup.tsx's "Processing…" state) indefinitely. Doesn't abort the underlying synchronous work (pdf.js exposes no cancellation), but bounds how long the app *waits* on it -- see the doc comment on parseResumePdf for the fuller picture and what's deferred to a later phase. */
const PDF_PARSE_TIMEOUT_MS = 20_000

type Source = 'resume' | 'jd'

let db: Database.Database | null = null

/** Lazily opens (and schema-initializes) the RAG sqlite database. Throws on failure -- callers must catch. */
function getDb(): Database.Database {
  if (db !== null) return db
  const dbPath = join(app.getPath('userData'), 'rag.sqlite3')
  const instance = new Database(dbPath)
  instance.pragma('journal_mode = WAL')
  // Overwrite freed pages instead of leaving deleted resume/JD text sitting
  // in SQLite's freelist -- this file holds personal data.
  instance.pragma('secure_delete = ON')

  // sqlite-vec's getLoadablePath() resolves via `require.resolve`, which
  // under a packaged (asar) build reports a path *inside* app.asar (e.g.
  // ...\resources\app.asar\node_modules\sqlite-vec-windows-x64\vec0.dll).
  // SQLite's native extension loader calls straight into the OS's dynamic
  // library loader (LoadLibrary on Windows) for that path -- unlike Node's
  // own patched `fs`, that call does not go through Electron's asar
  // redirection, so it cannot load a DLL from inside the archive. The actual
  // file lives on disk at the `app.asar.unpacked` mirror of that same path
  // (see electron-builder.yml's asarUnpack entry for this package) --
  // rewriting the resolved path to point there fixes it. This is a no-op in
  // dev (an unpackaged `require.resolve` path never contains "app.asar").
  const loadablePath = sqliteVec.getLoadablePath().replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
  instance.loadExtension(loadablePath)

  instance.exec(`
    CREATE TABLE IF NOT EXISTS resume_chunks (
      id INTEGER PRIMARY KEY,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS resume_vectors USING vec0(embedding float[${EMBED_DIM}]);
    CREATE TABLE IF NOT EXISTS jd_chunks (
      id INTEGER PRIMARY KEY,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS jd_vectors USING vec0(embedding float[${EMBED_DIM}]);
  `)
  db = instance
  return db
}

/** Closes the database cleanly (checkpoints the WAL back into the main file) -- called on app quit so deleted/superseded resume/JD text doesn't linger in `rag.sqlite3-wal` indefinitely. Safe to call when never opened. */
export function closeDb(): void {
  if (db === null) return
  const instance = db
  db = null
  try {
    instance.pragma('wal_checkpoint(TRUNCATE)')
    instance.close()
  } catch (err) {
    console.warn('[rag] error while closing the local index:', redact(String(err)))
  }
}

/**
 * Minimal fields this module actually reads off a pdf.js page object, used
 * to type the custom `pagerender` callback below without resorting to `any`
 * (pdf-parse's own type declarations type `pageData` as `any` -- since that
 * target parameter type is `any`, a function typed against this narrower
 * shape is still assignable to it).
 */
interface PdfPageTextItem {
  str: string
  transform: number[]
}
interface PdfPageTextContent {
  items: PdfPageTextItem[]
}
interface PdfPageData {
  getTextContent: (options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<PdfPageTextContent>
}

/**
 * Renders one PDF page's text, stopping (returning '') once `remaining.value`
 * has been exhausted by prior pages -- bounds total extracted text across
 * the whole document without needing to know the page count up front.
 * Mirrors pdf-parse's own default `render_page`'s line-join logic (grouping
 * items on the same `transform[5]` Y-coordinate onto one line).
 */
function renderPageBounded(remaining: { value: number }) {
  return async (pageData: PdfPageData): Promise<string> => {
    if (remaining.value <= 0) return ''
    const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    let lastY: number | undefined
    let text = ''
    for (const item of content.items) {
      if (lastY === undefined || lastY === item.transform[5]) {
        text += item.str
      } else {
        text += '\n' + item.str
      }
      lastY = item.transform[5]
    }
    remaining.value -= text.length
    return text
  }
}

/**
 * Parses a resume PDF's raw bytes into plain text, main-process-side (the
 * renderer only ever reads the file's bytes off disk -- it never parses
 * them). Rejects anything empty, over `MAX_RESUME_PDF_BYTES`, or not
 * PDF-shaped (magic-byte check) before ever touching `pdf-parse`.
 *
 * `pdf-parse` bundles an old (2017), unmaintained pdf.js build that runs
 * synchronously on the main event loop with eval-based function compilation
 * enabled -- it is not sandboxed. `MAX_PDF_PAGES`/the bounded `pagerender`
 * callback/`PDF_PARSE_TIMEOUT_MS` bound how much work one upload can demand
 * (page count, total extracted text, wall-clock wait), but don't fully
 * eliminate the risk of a single pathological page's content taking a long
 * time to decompress before those bounds are checked. Properly isolating
 * this (a `utilityProcess` with a hard kill timeout, or a maintained
 * `pdfjs-dist` with eval disabled) is real future work, not done here.
 */
async function parseResumePdf(bytes: ArrayBuffer): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESUME_PDF_BYTES) {
    return { ok: false, error: 'Resume PDF is empty or too large.' }
  }

  const buf = Buffer.from(bytes)
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, error: 'That file does not look like a PDF.' }
  }

  const remaining = { value: MAX_EXTRACTED_TEXT_CHARS }
  try {
    const parsed = await Promise.race([
      pdfParse(buf, { max: MAX_PDF_PAGES, pagerender: renderPageBounded(remaining) }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('PDF parsing timed out.')), PDF_PARSE_TIMEOUT_MS)
      })
    ])
    const text = parsed.text.trim()
    if (text.length === 0) {
      // A page-image-only / scanned PDF parses "successfully" (pdf-parse
      // swallows per-page errors and returns '' for that page) but yields no
      // text at all -- without this check, indexMaterials would go on to
      // replace any previously-stored resume with an empty chunk set and
      // report success, silently wiping real data on a bad upload.
      return { ok: false, error: 'No selectable text found in this PDF (is it a scanned image?).' }
    }
    return { ok: true, text: text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text }
  } catch (err) {
    console.error('[rag] failed to parse resume PDF:', redact(String(err)))
    return { ok: false, error: 'Could not read the resume PDF. Make sure it is a valid, unencrypted PDF file.' }
  }
}

/** True for a blank line, a markdown-style heading ("# ...", "## ..."), or a short ALL-CAPS line -- common resume/JD section-header shapes ("EXPERIENCE", "Projects", "Skills"). */
function isSectionBreak(line: string): 'blank' | 'heading' | 'text' {
  const trimmed = line.trim()
  if (trimmed.length === 0) return 'blank'
  if (/^#{1,6}\s/.test(trimmed)) return 'heading'
  if (trimmed.length <= 40 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) return 'heading'
  return 'text'
}

/** Splits text into paragraph/section-sized pieces on blank lines and heading-like lines. Doesn't need to be sophisticated -- just needs to avoid slicing mid-sentence where an obvious break exists. */
function splitIntoSections(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const sections: string[] = []
  let current: string[] = []

  for (const line of lines) {
    const kind = isSectionBreak(line)
    if (kind === 'blank') {
      if (current.length > 0) {
        sections.push(current.join('\n'))
        current = []
      }
      continue
    }
    if (kind === 'heading' && current.length > 0) {
      sections.push(current.join('\n'))
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n'))

  return sections.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Breaks one section into `CHUNK_TARGET_WORDS`-sized word windows if it's more than 2x that on its own (e.g. a PDF that extracted as one long unbroken paragraph with no blank-line/heading breaks at all) -- otherwise a single oversized section became a single chunk with no upper bound, well past gemini-embedding-001's input limit. Returns `[section]` unchanged when it's already a reasonable size. */
function splitLongSection(section: string): string[] {
  const words = section.split(/\s+/).filter(Boolean)
  if (words.length <= CHUNK_TARGET_WORDS * 2) return [section]
  const pieces: string[] = []
  for (let i = 0; i < words.length; i += CHUNK_TARGET_WORDS) {
    pieces.push(words.slice(i, i + CHUNK_TARGET_WORDS).join(' '))
  }
  return pieces
}

/** Groups sections into ~`CHUNK_TARGET_WORDS`-sized chunks, capped at `MAX_CHUNKS_PER_SOURCE`. */
function chunkText(text: string): string[] {
  const sections = splitIntoSections(text).flatMap(splitLongSection)
  const chunks: string[] = []
  let buffer: string[] = []
  let bufferWords = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    chunks.push(buffer.join('\n\n'))
    buffer = []
    bufferWords = 0
  }

  for (const section of sections) {
    const words = section.split(/\s+/).filter(Boolean).length
    if (bufferWords > 0 && bufferWords + words > CHUNK_TARGET_WORDS) {
      flush()
    }
    buffer.push(section)
    bufferWords += words
  }
  flush()

  return chunks.slice(0, MAX_CHUNKS_PER_SOURCE)
}

/** Embeds `texts` in batches of `EMBED_BATCH_SIZE`, returning one vector per input text in the same order. Throws (SDK/network/timeout errors) -- callers translate via `describeGeminiError`. */
async function embedTexts(
  apiKey: string,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  usageToken: number | null = null
): Promise<number[][]> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: EMBED_TIMEOUT_MS } })
  const vectors: number[][] = []

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    const response = await ai.models.embedContent({
      model: EMBED_MODEL_ID,
      contents: batch,
      config: { taskType, outputDimensionality: EMBED_DIM }
    })
    // The embeddings API reports no token counts, so this is an ESTIMATE from
    // text length. Only session-start retrieval passes a token; Setup-page
    // indexing (outside any interview) is deliberately not metered.
    usage.recordEmbeddingEstimate(usageToken, EMBED_MODEL_ID, batch)
    const embeddings = response.embeddings ?? []
    if (embeddings.length !== batch.length) {
      throw new Error('Embedding response did not match the number of chunks sent.')
    }
    for (const embedding of embeddings) {
      const values = embedding.values
      if (values === undefined || values.length !== EMBED_DIM) {
        throw new Error('Embedding response was missing vector values.')
      }
      vectors.push(values)
    }
  }

  return vectors
}

function tableNames(source: Source): { chunks: string; vectors: string } {
  return source === 'resume' ? { chunks: 'resume_chunks', vectors: 'resume_vectors' } : { chunks: 'jd_chunks', vectors: 'jd_vectors' }
}

/** Replaces one source's entire chunk set (both the text table and its vec0 companion). Must run inside a transaction -- see `replaceMaterials`, its only caller. `chunks.length` must equal `vectors.length`. */
function writeSourceChunks(instance: Database.Database, source: Source, chunks: string[], vectors: number[][]): void {
  const { chunks: chunksTable, vectors: vectorsTable } = tableNames(source)
  instance.prepare(`DELETE FROM ${vectorsTable}`).run()
  instance.prepare(`DELETE FROM ${chunksTable}`).run()
  const insertChunk = instance.prepare(`INSERT INTO ${chunksTable} (chunk_index, text) VALUES (?, ?)`)
  const insertVector = instance.prepare(`INSERT INTO ${vectorsTable} (rowid, embedding) VALUES (?, ?)`)
  chunks.forEach((text, index) => {
    const info = insertChunk.run(index, text)
    // vec0's rowid column rejects a plain JS `number` here even though the
    // value is a whole number in range -- confirmed empirically against the
    // installed better-sqlite3/sqlite-vec versions ("Only integers are
    // allowed for primary key values on vectors" otherwise). Binding as
    // BigInt makes better-sqlite3 use sqlite3_bind_int64, which vec0 accepts.
    insertVector.run(BigInt(info.lastInsertRowid), JSON.stringify(vectors[index]))
  })
}

/**
 * Writes whichever of resume/JD are non-null in ONE transaction. This is
 * what makes indexMaterials's "both sources, one request" case atomic: if
 * this throws partway through (a constraint violation, disk error, ...),
 * SQLite rolls back everything, so a request that touches both sources can
 * never leave one committed and the other not while still being reported to
 * the user as a plain failure.
 */
function replaceMaterials(
  instance: Database.Database,
  resumeChunks: string[] | null,
  resumeVectors: number[][],
  jdChunks: string[] | null,
  jdVectors: number[][]
): void {
  const tx = instance.transaction(() => {
    if (resumeChunks !== null) writeSourceChunks(instance, 'resume', resumeChunks, resumeVectors)
    if (jdChunks !== null) writeSourceChunks(instance, 'jd', jdChunks, jdVectors)
  })
  tx()
}

/** Bumped on every `indexMaterials` call; lets a call that's still embedding when a newer one starts recognize it's been superseded and skip writing stale data over the newer request's result -- same generation-token discipline capture.ts/geminiLive.ts use for their own concurrency guards. */
let indexRequestId = 0

/**
 * Parses (if resume bytes given), chunks, embeds and stores whichever of
 * resume/JD are provided. A `null` source is left completely untouched in
 * storage -- e.g. re-processing just a pasted JD never clears a
 * previously-uploaded resume. A non-null source (even one that parses/trims
 * to empty text) fully replaces that source's stored chunks.
 *
 * Runs the embedding calls sequentially (resume batch, then JD batch) rather
 * than in parallel -- simpler error attribution, and this only ever runs
 * once per Setup-screen interaction, not on a hot path. Nothing is written
 * to storage until AFTER both sources' embeddings have succeeded (see
 * `replaceMaterials`) -- a failure partway through never leaves a partial
 * update committed while still reporting failure to the user.
 */
export async function indexMaterials(resumePdfBytes: ArrayBuffer | null, jdText: string | null): Promise<RagIndexResult> {
  const myRequest = ++indexRequestId

  const jdProvided = jdText !== null
  if (resumePdfBytes === null && !jdProvided) {
    return { ok: false, error: 'Nothing to process -- add a resume or job description first.' }
  }

  let resumeText: string | null = null
  if (resumePdfBytes !== null) {
    const parsed = await parseResumePdf(resumePdfBytes)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    resumeText = parsed.text
  }

  const jdTrimmed = jdProvided ? (jdText as string).trim().slice(0, MAX_JD_TEXT_CHARS) : null

  const needsEmbedding = (resumeText !== null && resumeText.length > 0) || (jdTrimmed !== null && jdTrimmed.length > 0)
  let apiKey: string | null = null
  if (needsEmbedding) {
    apiKey = await getApiKey()
    if (apiKey === null || apiKey.length === 0) {
      return { ok: false, error: 'No API key saved yet. Add one in Settings first.' }
    }
  }

  const resumeChunks = resumeText !== null ? chunkText(resumeText) : null
  const jdChunks = jdTrimmed !== null ? chunkText(jdTrimmed) : null

  let resumeVectors: number[][] = []
  let jdVectors: number[][] = []
  try {
    if (resumeChunks !== null && resumeChunks.length > 0 && apiKey !== null) {
      resumeVectors = await embedTexts(apiKey, resumeChunks, 'RETRIEVAL_DOCUMENT')
    }
    if (jdChunks !== null && jdChunks.length > 0 && apiKey !== null) {
      jdVectors = await embedTexts(apiKey, jdChunks, 'RETRIEVAL_DOCUMENT')
    }
  } catch (err) {
    return { ok: false, error: describeGeminiError(err) }
  }

  if (myRequest !== indexRequestId) {
    // A newer indexMaterials() call started (and will finish) after this
    // one -- don't let a slower, now-stale request overwrite whatever the
    // newer one writes.
    return { ok: false, error: 'Superseded by a newer request.' }
  }

  let instance: Database.Database
  try {
    instance = getDb()
  } catch (err) {
    console.error('[rag] failed to open the local index:', redact(String(err)))
    return { ok: false, error: 'Could not access the local search index.' }
  }

  try {
    replaceMaterials(instance, resumeChunks, resumeVectors, jdChunks, jdVectors)
  } catch (err) {
    // A SQLite/sqlite-vec error here (e.g. a constraint violation) is not a
    // Gemini/network failure -- describeGeminiError's fallback would
    // otherwise mislabel it (its own fallback message literally says
    // "...while testing the API key") and forward the raw error text with
    // only key-pattern redaction, not path/detail redaction. Report a fixed
    // message instead.
    console.error('[rag] failed to store chunks in the local index:', redact(String(err)))
    return { ok: false, error: 'Could not save to the local search index.' }
  }

  return {
    ok: true,
    resumeChunkCount: resumeChunks !== null ? resumeChunks.length : undefined,
    jdChunkCount: jdChunks !== null ? jdChunks.length : undefined
  }
}

/** Current chunk counts per source -- lets the UI show what's actually stored (and persist that across navigation, since it's sourced from main rather than component-local state) rather than only ever reflecting the last thing indexed in this render. Never throws; returns zeros if the index can't be opened. */
export function getStatus(): RagStatusResult {
  try {
    const instance = getDb()
    const resumeChunkCount = (instance.prepare('SELECT COUNT(*) AS c FROM resume_chunks').get() as { c: number }).c
    const jdChunkCount = (instance.prepare('SELECT COUNT(*) AS c FROM jd_chunks').get() as { c: number }).c
    return { resumeChunkCount, jdChunkCount }
  } catch (err) {
    console.error('[rag] failed to read index status:', redact(String(err)))
    return { resumeChunkCount: 0, jdChunkCount: 0 }
  }
}

/**
 * Deletes all stored resume/JD chunks. This is personal data (a candidate's
 * actual resume/JD text) with no other deletion path otherwise -- it would
 * silently persist across every future interview, regardless of company or
 * role, until the app's data directory was manually deleted.
 */
export function clearMaterials(): OperationResult {
  try {
    const instance = getDb()
    const tx = instance.transaction(() => {
      instance.prepare('DELETE FROM resume_vectors').run()
      instance.prepare('DELETE FROM resume_chunks').run()
      instance.prepare('DELETE FROM jd_vectors').run()
      instance.prepare('DELETE FROM jd_chunks').run()
    })
    tx()
    instance.pragma('wal_checkpoint(TRUNCATE)')
    return { ok: true }
  } catch (err) {
    console.error('[rag] failed to clear the local index:', redact(String(err)))
    return { ok: false, error: 'Could not clear the local search index.' }
  }
}

export interface RetrievedChunks {
  /** Joined top-k resume chunk text, or `null` if nothing has ever been indexed for this source (caller should fall back to stub text). */
  resumeChunks: string | null
  jdChunks: string | null
}

/**
 * Retrieves the top ~`TOP_K` chunks per source, using a fixed representative
 * query built from the chosen role rather than a real user question -- there
 * is no candidate question yet at session-start time (retrieval runs once,
 * before the interview begins, to ground the system prompt). This is a
 * coarse proxy: "what's relevant to a <role> interview" rather than anything
 * query-specific. Good enough for grounding an opening system prompt; a
 * later phase with per-turn retrieval (e.g. re-querying against the
 * candidate's actual last answer) would do better, but that's out of scope
 * here.
 *
 * Never throws -- any failure (no key, embedding error/timeout, sqlite/
 * extension unavailable, nothing indexed) resolves to `{ resumeChunks: null,
 * jdChunks: null }` so the caller (geminiLive.ts) can fall back to its stub
 * text rather than blocking interview start. `embedTexts`'s own
 * EMBED_TIMEOUT_MS bounds how long this can take before failing that way.
 */
export async function retrieveChunks(role: InterviewRole, usageToken: number | null = null): Promise<RetrievedChunks> {
  try {
    const instance = getDb()
    const resumeCount = (instance.prepare('SELECT COUNT(*) AS c FROM resume_chunks').get() as { c: number }).c
    const jdCount = (instance.prepare('SELECT COUNT(*) AS c FROM jd_chunks').get() as { c: number }).c
    if (resumeCount === 0 && jdCount === 0) {
      return { resumeChunks: null, jdChunks: null }
    }

    const apiKey = await getApiKey()
    if (apiKey === null || apiKey.length === 0) {
      return { resumeChunks: null, jdChunks: null }
    }

    const roleLabel = INTERVIEW_ROLE_LABELS[role]
    const resumeChunks =
      resumeCount > 0
        ? await retrieveTopChunks(instance, apiKey, 'resume', `Resume experience, projects, and skills relevant to a ${roleLabel} role.`, usageToken)
        : null
    const jdChunks =
      jdCount > 0
        ? await retrieveTopChunks(instance, apiKey, 'jd', `Job description requirements and responsibilities for a ${roleLabel} role.`, usageToken)
        : null

    return { resumeChunks, jdChunks }
  } catch (err) {
    console.error('[rag] retrieval failed, falling back to stub context:', redact(String(err)))
    return { resumeChunks: null, jdChunks: null }
  }
}

async function retrieveTopChunks(
  instance: Database.Database,
  apiKey: string,
  source: Source,
  queryText: string,
  usageToken: number | null
): Promise<string | null> {
  const vectors = await embedTexts(apiKey, [queryText], 'RETRIEVAL_QUERY', usageToken)
  const queryVector = vectors[0]
  if (queryVector === undefined) return null

  const { chunks: chunksTable, vectors: vectorsTable } = tableNames(source)
  const rows = instance
    .prepare(
      `SELECT c.text AS text
       FROM ${chunksTable} c
       JOIN (
         SELECT rowid, distance FROM ${vectorsTable} WHERE embedding MATCH ? ORDER BY distance LIMIT ?
       ) v ON v.rowid = c.id
       ORDER BY v.distance`
    )
    .all(JSON.stringify(queryVector), TOP_K) as Array<{ text: string }>

  if (rows.length === 0) return null

  const joined = rows.map((row) => row.text).join('\n\n---\n\n')
  return joined.length > MAX_PROMPT_CHUNK_CHARS ? `${joined.slice(0, MAX_PROMPT_CHUNK_CHARS)}…` : joined
}
