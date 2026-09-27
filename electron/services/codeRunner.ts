/**
 * codeRunner.ts
 *
 * Main-process-only service that runs a candidate's submitted code locally
 * for Phase 5's coding round. This is the highest-risk addition in this
 * phase (local process execution triggered by IPC), so the discipline here
 * is stricter than anywhere else in the app:
 *
 *  - No shell interpolation, ever. Every process is spawned via
 *    `child_process.spawn` with a literal argument array (`shell` is never
 *    set, so it defaults to `false`) -- never `exec`, never a
 *    concatenated/templated command string. The candidate's code is written
 *    to a temp file and the language's own interpreter/compiler is invoked
 *    as a direct executable with that file's (relative) name as a plain
 *    argument and the temp dir as `cwd`; the code's *contents* are never
 *    interpolated into a command line at all.
 *  - Bounded run time, enforced in layers -- best effort, NOT an
 *    unconditional guarantee against every process the candidate's code
 *    might spawn:
 *      1. a 5s run budget (15s for a compile step), enforced by killing the
 *         whole process TREE (`taskkill /T /F` on Windows, since a plain
 *         `child.kill()` only ever kills the direct child and leaves any
 *         grandchild the code spawned running), with `SIGKILL` as fallback;
 *      2. results resolve on the child's `'exit'` (plus a short grace period
 *         for trailing output), NOT on `'close'` -- `'close'` waits for every
 *         inherited copy of the stdout/stderr pipes to close, which a
 *         grandchild can hold open forever; after that the pipes are
 *         destroyed outright;
 *      3. an absolute per-process watchdog that force-resolves no matter what;
 *      4. a post-run sweep that kills any leftover descendants of the
 *         processes we spawned (found by parent-PID + creation time, since a
 *         dead parent can no longer be tree-killed) before the temp dir is
 *         removed.
 *    Layers 3-4 are what keep `runInFlight` and the temp dir from leaking
 *    even when the candidate's code does something hostile; a process that
 *    manages to escape ALL of them (e.g. by reparenting itself) is out of
 *    scope for this module -- there is no sandbox/Job Object here.
 *    Applied PER PROCESS, not as one shared budget across compile+run for
 *    a compiled language (Java/C++).
 *  - Capped stdout/stderr: the process is killed the moment either stream
 *    exceeds `MAX_OUTPUT_BYTES`, not just truncated after the fact -- an
 *    infinite `print` loop must not be allowed to keep consuming memory/CPU
 *    for the rest of the budget just because the *displayed* output was
 *    already capped. Java and Node also get a 256MB heap cap.
 *  - Cleanup: the temp directory (source file + any compiled artifact -- a
 *    `.class` file, a compiled `.exe`) is deleted (with retries, since
 *    Windows holds files open briefly after a kill) in a bounded background
 *    task that runs regardless of success, non-zero exit, timeout-kill,
 *    output-cap-kill, or spawn failure; `sweepStaleRunDirs` additionally
 *    removes any dir a previous crashed session left behind.
 *  - No absolute path (the temp dir contains the Windows username) is ever
 *    put in a spawn-error message, and the temp dir is scrubbed out of
 *    captured output too.
 *  - Concurrency: `runInFlight` guards this main-process-side, independent
 *    of whatever the renderer's "Run" button disabled state claims -- same
 *    "never trust the UI alone" discipline as `geminiLive.ts`'s
 *    `connecting` latch and `rag.ts`'s `indexRequestId`. Only one run at a
 *    time, app-wide.
 *
 * Windows-only, matching this app's target platform (electron-builder.yml
 * only configures a `win` target): `python`, `node`, `javac`/`java`, and
 * `g++` are resolved via PATH the same way any other `.exe` is under
 * `child_process.spawn` without `shell: true` -- Windows' own
 * CreateProcess/SearchPath already does PATH+PATHEXT resolution for a bare
 * executable name, which is why this works without a shell (the historical
 * "need shell:true on Windows" gotcha is specific to `.cmd`/`.bat` script
 * wrappers like `npm.cmd`, not real `.exe` binaries like these).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redact } from '../lib/redact'
import { MAX_CODE_CHARS } from '../ipc-types'
import type { CodingLanguage, RunCodeResult } from '../ipc-types'

/** Hard timeout per spawned *run* process. See module doc comment for why this is per-process rather than a shared compile+run budget. */
const RUN_TIMEOUT_MS = 5_000

/** Separate, longer budget for a compile step (javac/g++ are legitimately slower than a typical solution's run, especially on a cold start). */
const COMPILE_TIMEOUT_MS = 15_000

/** After a process exits, how long to wait for its trailing stdout/stderr to drain before the pipes are destroyed and the result is returned regardless. Also the delay between a kill and the pipe destroy. */
const PIPE_GRACE_MS = 500

/** Extra time past a process's own timeout before the absolute watchdog force-resolves it, no matter what state it is in. */
const WATCHDOG_EXTRA_MS = 2_000

/** Cap on buffered stdout/stderr, per stream. A tight `print`/`System.out.println` loop could otherwise emit gigabytes within the budget -- the process is killed the instant either stream crosses this, not just truncated after continuing to run. */
const MAX_OUTPUT_BYTES = 200 * 1024

/** Temp dir name prefix, shared by creation and the stale-dir sweep. */
const RUN_DIR_PREFIX = 'mockpilot-run-'

/** `sweepStaleRunDirs` only deletes dirs older than this, so it can never touch a dir a live run is using. */
const STALE_RUN_DIR_AGE_MS = 60 * 60 * 1000

/** Guards concurrent runs main-process-side -- see module doc comment. Not per-session/per-window, deliberately app-wide: this app only ever has one window/one candidate running code at a time, and a single shared spawned-process budget is simpler to reason about than per-window tracking would be. */
let runInFlight = false

interface LangSpec {
  sourceName: string
  compile?: { cmd: string; args: string[]; label: string }
  run: { cmd: string; args: string[]; label: string; isCompiledProgram: boolean; env?: NodeJS.ProcessEnv }
}

/**
 * Java specifically requires the file name to match its `public class` name
 * -- rather than parsing the candidate's code to discover that name
 * (fragile, and itself a small injection-adjacent surface: a crafted class
 * name could contain characters awkward for a filename), this fixes the
 * required class name to `Main` and documents the constraint in the UI
 * (src/pages/CodingRound.tsx shows this next to the language select when
 * Java is chosen). This is the same simplification online-judge-style tools
 * commonly make.
 */
const JAVA_CLASS_NAME = 'Main'

/**
 * Every process runs with `cwd` set to the run's temp dir, so source/compiler
 * arguments are bare relative names -- tracebacks and compiler errors then
 * don't carry an absolute path containing the user's Windows username. Only
 * the compiled C++ binary needs its absolute path (CreateProcess resolves a
 * relative application name against the *parent's* cwd, not the child's).
 * `label` is the fixed display name used in any user-facing spawn error --
 * never the command itself, which for the compiled binary is an absolute path.
 */
function languageSpec(language: CodingLanguage, dir: string): LangSpec {
  switch (language) {
    case 'python':
      return { sourceName: 'main.py', run: {
          cmd: 'python',
          args: ['main.py'],
          label: 'python',
          isCompiledProgram: false,
          // Piped stdout otherwise defaults to the Windows ANSI code page, which
          // can't encode most non-ASCII output and crashes the print().
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        }
      }
    case 'javascript':
      return {
        sourceName: 'main.js',
        run: { cmd: 'node', args: ['--max-old-space-size=256', 'main.js'], label: 'node', isCompiledProgram: false }
      }
    case 'java':
      return {
        sourceName: `${JAVA_CLASS_NAME}.java`,
        compile: { cmd: 'javac', args: [`${JAVA_CLASS_NAME}.java`], label: 'javac' },
        run: { cmd: 'java', args: ['-Xmx256m', '-cp', '.', JAVA_CLASS_NAME], label: 'java', isCompiledProgram: false }
      }
    case 'cpp':
      // g++ (MinGW) only -- not clang++ as a fallback. Keeping this to one
      // required compiler keeps the "not installed" error message
      // unambiguous (there's exactly one thing to tell the user to install)
      // rather than a confusing two-step probe-then-report.
      return {
        sourceName: 'main.cpp',
        compile: { cmd: 'g++', args: ['main.cpp', '-o', 'main.exe'], label: 'g++' },
        run: { cmd: join(dir, 'main.exe'), args: [], label: 'your compiled program', isCompiledProgram: true }
      }
  }
}

interface ExecOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  error?: string
}

interface ExecOptions {
  /** Fixed display name for spawn errors -- never contains a path. */
  label: string
  /** True for the compiled-binary run step: ENOENT/EPERM/EACCES there almost always means antivirus, not a missing runtime. */
  isCompiledProgram: boolean
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Every successfully spawned PID is appended here so the post-run sweep can look for leftover descendants. */
  spawnedPids: number[]
}

/** Maps a spawn-time error to a fixed, user-facing message. `ENOENT` specifically means the interpreter/compiler itself isn't on PATH -- the single most likely real-world failure mode here, since this app bundles none of these runtimes. Never forwards the raw error message, and never interpolates a command (which can be an absolute path with the user's name in it) -- only the fixed `label`. */
function describeSpawnError(err: unknown, label: string, isCompiledProgram: boolean): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined
  if (isCompiledProgram) {
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES') {
      return 'The compiled program could not be started — it may have been blocked by antivirus.'
    }
    return `Could not run ${label}.`
  }
  if (code === 'ENOENT') {
    return `"${label}" was not found. Make sure it is installed and on your PATH, then try again.`
  }
  return `Could not run "${label}".`
}

/**
 * Kills `child` AND everything it spawned. On Windows `child.kill()` only
 * terminates the direct child -- a grandchild (Python `subprocess.Popen`,
 * C++ `system()`, ...) would keep running (and keep the stdio pipes open), so
 * `taskkill /T /F` is run with an argument array (no shell). `SIGKILL` on the
 * child directly is the fallback if taskkill fails or there's no PID. Never throws.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  const killDirect = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
  if (process.platform === 'win32' && pid !== undefined) {
    try {
      // taskkill first, and only fall back to a direct kill if it fails:
      // killing the parent first would sever the tree link before taskkill
      // had a chance to enumerate the children.
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, (err) => {
        if (err) killDirect()
      })
    } catch {
      killDirect()
    }
    return
  }
  killDirect()
}

/**
 * Spawns one process with a literal argument array (no shell) and resolves
 * once it exits (plus a short pipe-drain grace), times out, is killed for
 * exceeding the output cap, fails to spawn at all, or hits the absolute
 * watchdog. Never rejects -- every outcome is represented in the resolved
 * `ExecOutcome` -- and, crucially, never waits on `'close'` alone: `'close'`
 * needs every inherited copy of the stdout/stderr pipes to close, which a
 * grandchild process the candidate's code spawned can hold open forever.
 */
function execBounded(cmd: string, args: string[], cwd: string, opts: ExecOptions): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let outputExceeded = false
    let child: ChildProcess

    try {
      child = spawn(cmd, args, { cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, error: describeSpawnError(err, opts.label, opts.isCompiledProgram) })
      return
    }
    if (child.pid !== undefined) opts.spawnedPids.push(child.pid)

    let graceTimer: NodeJS.Timeout | null = null
    let destroyTimer: NodeJS.Timeout | null = null
    let runTimer: NodeJS.Timeout | null = null
    let watchdogTimer: NodeJS.Timeout | null = null

    const destroyStreams = (): void => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }

    const finish = (outcome: ExecOutcome): void => {
      if (settled) return
      settled = true
      for (const t of [graceTimer, destroyTimer, runTimer, watchdogTimer]) {
        if (t !== null) clearTimeout(t)
      }
      // Whatever still holds a pipe end open, MockPilot's side of it goes away
      // now so no pending read can keep this process's handles alive.
      destroyStreams()
      resolve(outcome)
    }

    const normalOutcome = (exitCode: number | null): ExecOutcome => ({
      stdout,
      stderr,
      // A tree-kill via taskkill /F makes the child exit with code 1, not a
      // signal -- don't report that as the candidate's own exit code.
      exitCode: timedOut || outputExceeded ? null : exitCode,
      timedOut
    })

    const kill = (): void => {
      killTree(child)
      if (destroyTimer === null) destroyTimer = setTimeout(destroyStreams, PIPE_GRACE_MS)
    }

    runTimer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)

    // Absolute backstop: force-resolves even if 'exit' never fires (kill
    // failed, process stuck in the kernel, ...) so runInFlight and the temp
    // dir cleanup can never be held hostage by a misbehaving process.
    watchdogTimer = setTimeout(() => {
      timedOut = true
      killTree(child)
      finish(normalOutcome(null))
    }, opts.timeoutMs + WATCHDOG_EXTRA_MS)

    const killForOutputCap = (): void => {
      if (outputExceeded) return
      outputExceeded = true
      kill()
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      if (outputExceeded) return
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stdout += '\n…[output truncated -- exceeded the output size limit]'
        killForOutputCap()
        return
      }
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (outputExceeded) return
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        stderr += '\n…[output truncated -- exceeded the output size limit]'
        killForOutputCap()
        return
      }
      stderr += chunk
    })
    // destroy() on a pipe can surface as an 'error' event; without a listener
    // that would be an uncaught exception in the main process.
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)

    child.on('error', (err) => {
      // Once a PID exists the process *did* spawn; a later 'error' is a
      // failed kill/IPC, and 'exit'/the watchdog still settle this promise.
      if (child.pid !== undefined) return
      finish({ stdout, stderr, exitCode: null, timedOut: false, error: describeSpawnError(err, opts.label, opts.isCompiledProgram) })
    })

    // 'exit' -- not 'close' -- is what ends the wait. Give trailing output a
    // brief window to drain; 'close' (all pipes closed) short-circuits it in
    // the normal case, and the grace timer covers the case where a
    // grandchild is still holding the pipes.
    child.on('exit', (code) => {
      if (graceTimer === null) graceTimer = setTimeout(() => finish(normalOutcome(code)), PIPE_GRACE_MS)
    })
    child.on('close', (code) => finish(normalOutcome(code)))
  })
}

/**
 * Best-effort backstop after a run: kills any process still alive that
 * descends from one of `rootPids` and was created after the run started. A
 * grandchild whose parent has already exited can't be reached by
 * `taskkill /T` (the tree link is gone once the parent is), but Windows still
 * records the dead parent's PID in the orphan's ParentProcessId -- so the
 * descendant set is rebuilt from a process snapshot. Only integers we
 * produced ourselves are interpolated into the script. Never throws.
 */
function killLeftoverDescendants(rootPids: number[], sinceMs: number): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  const pids = rootPids.filter((p) => Number.isInteger(p) && p > 0)
  if (pids.length === 0) return Promise.resolve()
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$since=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(sinceMs) - 1000}).LocalDateTime`,
    "$set=New-Object 'System.Collections.Generic.HashSet[int]'",
    `foreach($r in @(${pids.join(',')})){[void]$set.Add([int]$r)}`,
    '$procs=@(Get-CimInstance Win32_Process)',
    "$victims=New-Object 'System.Collections.Generic.List[int]'",
    '$changed=$true',
    'while($changed){$changed=$false;foreach($p in $procs){$id=[int]$p.ProcessId;if($id -ne $PID -and -not $set.Contains($id) -and $set.Contains([int]$p.ParentProcessId) -and $p.CreationDate -ge $since){[void]$set.Add($id);$victims.Add($id);$changed=$true}}}',
    'foreach($v in $victims){Stop-Process -Id $v -Force}'
  ].join(';')
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, () => resolve())
    } catch {
      resolve()
    }
  })
}

/** Background cleanup for one run: sweep leftover descendants (an orphan keeps the temp dir locked as its cwd), then remove the dir with retries. Bounded end to end, never throws. */
async function cleanupRun(dir: string, spawnedPids: number[], startedAtMs: number): Promise<void> {
  await killLeftoverDescendants(spawnedPids, startedAtMs)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((err: unknown) => {
    console.warn('[coding] failed to clean up run temp dir:', redact(String(err)))
  })
}

/**
 * Best-effort startup sweep: deletes `mockpilot-run-*` dirs in the OS temp
 * dir older than an hour (left behind by a crash/kill mid-run in an earlier
 * session). The age floor means it can never touch a dir a live run owns.
 * Never throws.
 */
export async function sweepStaleRunDirs(): Promise<void> {
  try {
    const base = tmpdir()
    const entries = await readdir(base)
    const cutoff = Date.now() - STALE_RUN_DIR_AGE_MS
    for (const name of entries) {
      if (!name.startsWith(RUN_DIR_PREFIX)) continue
      const full = join(base, name)
      try {
        const info = await stat(full)
        if (info.isDirectory() && info.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        }
      } catch {
        // In use / permissions -- leave it.
      }
    }
  } catch (err) {
    console.warn('[coding] stale run-dir sweep failed:', redact(String(err)))
  }
}

/** Replaces every occurrence of the run's temp dir (either slash style) in captured output, so an absolute path containing the user's name never reaches the renderer. */
function scrubDir(text: string, dir: string): string {
  if (text.length === 0) return text
  let out = text.split(dir).join('.')
  const forward = dir.replaceAll('\\', '/')
  if (forward !== dir) out = out.split(forward).join('.')
  return out
}

function scrubOutcome(outcome: ExecOutcome, dir: string): ExecOutcome {
  return { ...outcome, stdout: scrubDir(outcome.stdout, dir), stderr: scrubDir(outcome.stderr, dir) }
}

/**
 * Writes `code` to a fresh temp file (a random subdirectory under
 * `os.tmpdir()`, unique per run) and runs it as `language`, honoring every
 * bound described in this module's doc comment. Always schedules cleanup of
 * the temp directory before returning, regardless of outcome. Never throws.
 */
export async function runCode(language: CodingLanguage, code: string): Promise<RunCodeResult> {
  if (code.length === 0 || code.length > MAX_CODE_CHARS) {
    // Redundant with the IPC-boundary check in main.ts -- kept here too so
    // this module is safe to call from anywhere, not just that one path.
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Code is empty or too long to run.' }
  }
  if (runInFlight) {
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Another run is already in progress. Wait for it to finish.' }
  }
  runInFlight = true

  let dir: string | null = null
  const spawnedPids: number[] = []
  const startedAtMs = Date.now()
  try {
    dir = join(tmpdir(), `${RUN_DIR_PREFIX}${randomUUID()}`)
    await mkdir(dir, { recursive: true })

    const spec = languageSpec(language, dir)
    await writeFile(join(dir, spec.sourceName), code, 'utf-8')

    if (spec.compile) {
      const compileResult = scrubOutcome(
        await execBounded(spec.compile.cmd, spec.compile.args, dir, {
          label: spec.compile.label,
          isCompiledProgram: false,
          timeoutMs: COMPILE_TIMEOUT_MS,
          spawnedPids
        }),
        dir
      )
      // A compile that errored, timed out, or failed to spawn never gets to
      // the run step -- there's nothing to run. A non-zero exit is the
      // candidate's own compile error, surfaced via stderr like any other
      // outcome (not this channel's own `error` field).
      if (compileResult.timedOut) {
        return { ...compileResult, timedOut: false, compileTimedOut: true }
      }
      if (compileResult.error !== undefined || compileResult.exitCode !== 0) {
        return compileResult
      }
    }

    return scrubOutcome(
      await execBounded(spec.run.cmd, spec.run.args, dir, {
        label: spec.run.label,
        isCompiledProgram: spec.run.isCompiledProgram,
        env: spec.run.env,
        timeoutMs: RUN_TIMEOUT_MS,
        spawnedPids
      }),
      dir
    )
  } catch (err) {
    console.error('[coding] runCode failed unexpectedly:', redact(String(err)))
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: 'Could not run the code.' }
  } finally {
    runInFlight = false
    if (dir !== null) {
      // Not awaited: the result must not wait on the (bounded) descendant
      // sweep + retrying rm, and runInFlight is already released above.
      void cleanupRun(dir, spawnedPids, startedAtMs)
    }
  }
}
