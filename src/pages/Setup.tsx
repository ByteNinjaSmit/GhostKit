import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  INTERVIEW_ROLES,
  INTERVIEW_ROLE_LABELS,
  INTERVIEW_DIFFICULTIES,
  MAX_RESUME_PDF_BYTES,
  MAX_JD_TEXT_CHARS,
  MAX_COMPANY_CHARS,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES
} from '../../electron/ipc-types'
import type { InterviewSetup, RagStatusResult } from '../../electron/ipc-types'

type RagStatus = 'idle' | 'processing' | 'done' | 'error'
type ClearStatus = 'idle' | 'clearing' | 'error'

interface SetupProps {
  setup: InterviewSetup
  onSetupChange: (setup: InterviewSetup) => void
}

/**
 * Interview setup screen: the fixed role/difficulty/company/duration fields
 * are lifted straight into App.tsx's state via `onSetupChange` (no local
 * "save" step -- they're cheap, synchronous, and always have a sensible
 * default even if this screen is never visited, see DEFAULT_INTERVIEW_SETUP).
 *
 * The resume upload and pasted job description are a separate, async
 * pipeline: this component only ever reads the resume file's raw bytes
 * (`File.arrayBuffer()`, a local read, not a network call) and hands them
 * off to the main process via `window.api.indexInterviewMaterials` --
 * parsing, chunking, embedding and storage all happen there (see
 * electron/services/rag.ts). Nothing here blocks on it beyond showing a
 * "Processing…" state; Interview.tsx doesn't need this screen's local state
 * at all, since retrieval happens main-process-side at session-start time
 * from whatever was last stored.
 */
function Setup({ setup, onSetupChange }: SetupProps): JSX.Element {
  const [resumeFile, setResumeFile] = useState<File | null>(null)
  const [resumeFileError, setResumeFileError] = useState<string | null>(null)
  const [jdText, setJdText] = useState('')
  const [ragStatus, setRagStatus] = useState<RagStatus>('idle')
  const [ragMessage, setRagMessage] = useState<string | null>(null)
  const [durationInput, setDurationInput] = useState(String(setup.durationMinutes))
  // Sourced from main (not derived from whatever this screen happened to
  // process most recently) so it reflects what's actually stored even after
  // navigating away and back, or after a fresh app launch.
  const [indexStatus, setIndexStatus] = useState<RagStatusResult | null>(null)
  const [clearStatus, setClearStatus] = useState<ClearStatus>('idle')
  const [clearError, setClearError] = useState<string | null>(null)

  const refreshIndexStatus = (): void => {
    window.api
      .getRagStatus()
      .then(setIndexStatus)
      .catch(() => {
        // Best-effort; the page still works without this readout.
      })
  }

  useEffect(() => {
    refreshIndexStatus()
  }, [])

  const handleResumeFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null
    setRagStatus('idle')
    setRagMessage(null)

    if (file === null) {
      setResumeFile(null)
      setResumeFileError(null)
      return
    }

    // Client-side pre-check only, for a fast/friendly rejection -- rag.ts
    // enforces the real size cap main-process-side regardless of what this
    // check says (never trust the renderer's own claim about a file).
    const looksLikePdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!looksLikePdf) {
      setResumeFile(null)
      setResumeFileError('Please choose a PDF file.')
      event.target.value = ''
      return
    }
    if (file.size === 0 || file.size > MAX_RESUME_PDF_BYTES) {
      setResumeFile(null)
      setResumeFileError(`PDF must be under ${Math.floor(MAX_RESUME_PDF_BYTES / (1024 * 1024))} MB.`)
      event.target.value = ''
      return
    }

    setResumeFileError(null)
    setResumeFile(file)
  }

  const canProcess = (resumeFile !== null || jdText.trim().length > 0) && ragStatus !== 'processing'

  const handleProcess = (): void => {
    if (!canProcess) return
    setRagStatus('processing')
    setRagMessage(null)

    void (async () => {
      try {
        const resumeBytes = resumeFile !== null ? await resumeFile.arrayBuffer() : null
        const jdTrimmed = jdText.trim()
        const result = await window.api.indexInterviewMaterials(resumeBytes, jdTrimmed.length > 0 ? jdTrimmed : null)

        if (result.ok) {
          setRagStatus('done')
          const parts: string[] = []
          if (result.resumeChunkCount !== undefined) {
            parts.push(`resume: ${result.resumeChunkCount} chunk${result.resumeChunkCount === 1 ? '' : 's'}`)
          }
          if (result.jdChunkCount !== undefined) {
            parts.push(`job description: ${result.jdChunkCount} chunk${result.jdChunkCount === 1 ? '' : 's'}`)
          }
          setRagMessage(parts.length > 0 ? `Indexed -- ${parts.join(', ')}.` : 'Indexed.')
          refreshIndexStatus()
        } else {
          setRagStatus('error')
          setRagMessage(result.error ?? 'Failed to process the resume/job description.')
        }
      } catch (err) {
        setRagStatus('error')
        setRagMessage(err instanceof Error ? err.message : 'Failed to process the resume/job description.')
      }
    })()
  }

  const handleClear = (): void => {
    if (clearStatus === 'clearing') return
    setClearStatus('clearing')
    setClearError(null)

    void window.api
      .clearInterviewMaterials()
      .then((result) => {
        if (result.ok) {
          setClearStatus('idle')
          setRagStatus('idle')
          setRagMessage(null)
          setResumeFile(null)
          setJdText('')
          refreshIndexStatus()
        } else {
          setClearStatus('error')
          setClearError(result.error ?? 'Failed to clear stored materials.')
        }
      })
      .catch((err: unknown) => {
        setClearStatus('error')
        setClearError(err instanceof Error ? err.message : 'Failed to clear stored materials.')
      })
  }

  const hasIndexedMaterials = indexStatus !== null && (indexStatus.resumeChunkCount > 0 || indexStatus.jdChunkCount > 0)

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Interview setup</CardTitle>
          <CardDescription>
            Choose what kind of interview to run. Optionally add your resume and the job description so the
            interviewer can ask grounded questions -- both can be skipped, the interview still works without them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Role" htmlFor="setup-role">
              <Select
                id="setup-role"
                value={setup.role}
                onChange={(event) => onSetupChange({ ...setup, role: event.target.value as InterviewSetup['role'] })}
              >
                {INTERVIEW_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {INTERVIEW_ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Difficulty" htmlFor="setup-difficulty">
              <Select
                id="setup-difficulty"
                value={setup.difficulty}
                onChange={(event) => onSetupChange({ ...setup, difficulty: event.target.value as InterviewSetup['difficulty'] })}
              >
                {INTERVIEW_DIFFICULTIES.map((difficulty) => (
                  <option key={difficulty} value={difficulty}>
                    {difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Company" htmlFor="setup-company">
              <Input
                id="setup-company"
                value={setup.company}
                maxLength={MAX_COMPANY_CHARS}
                placeholder="e.g. Acme Corp"
                onChange={(event) => onSetupChange({ ...setup, company: event.target.value })}
              />
            </Field>

            <Field label={`Duration (minutes, ${MIN_DURATION_MINUTES}-${MAX_DURATION_MINUTES})`} htmlFor="setup-duration">
              <Input
                id="setup-duration"
                type="number"
                min={MIN_DURATION_MINUTES}
                max={MAX_DURATION_MINUTES}
                value={durationInput}
                onChange={(event) => {
                  // Keep whatever the user is typing as-is (so typing "3"
                  // then "0" isn't clamped back to 5 after the first
                  // keystroke) -- only clamp into range on blur, below.
                  setDurationInput(event.target.value)
                }}
                onBlur={() => {
                  const parsed = Number(durationInput)
                  const clamped = Number.isFinite(parsed)
                    ? Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(parsed)))
                    : setup.durationMinutes
                  setDurationInput(String(clamped))
                  onSetupChange({ ...setup, durationMinutes: clamped })
                }}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <label htmlFor="resume-upload" className="text-sm font-medium">
              Resume (PDF, optional)
            </label>
            <input
              id="resume-upload"
              type="file"
              accept="application/pdf,.pdf"
              onChange={handleResumeFileChange}
              className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
            />
            {resumeFileError && <StatusBanner tone="error">{resumeFileError}</StatusBanner>}
            {resumeFile && !resumeFileError && (
              <p className="text-xs text-muted-foreground">
                Selected: {resumeFile.name} ({Math.ceil(resumeFile.size / 1024)} KB)
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="jd-text" className="text-sm font-medium">
              Job description (optional)
            </label>
            <Textarea
              id="jd-text"
              placeholder="Paste the job description here…"
              maxLength={MAX_JD_TEXT_CHARS}
              value={jdText}
              onChange={(event) => setJdText(event.target.value)}
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              {jdText.length} / {MAX_JD_TEXT_CHARS} characters
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleProcess} disabled={!canProcess}>
              {ragStatus === 'processing' ? 'Processing…' : 'Process resume & job description'}
            </Button>
            {hasIndexedMaterials && (
              <Button type="button" variant="ghost" onClick={handleClear} disabled={clearStatus === 'clearing'}>
                {clearStatus === 'clearing' ? 'Clearing…' : 'Clear stored resume/JD'}
              </Button>
            )}
          </div>

          {indexStatus && (
            <p className="text-xs text-muted-foreground">
              Currently stored -- resume: {indexStatus.resumeChunkCount} chunk{indexStatus.resumeChunkCount === 1 ? '' : 's'}, job
              description: {indexStatus.jdChunkCount} chunk{indexStatus.jdChunkCount === 1 ? '' : 's'}. This data is used for every
              interview until cleared or replaced -- it isn't scoped to one session.
            </p>
          )}

          {ragStatus === 'done' && ragMessage && <StatusBanner tone="success">{ragMessage}</StatusBanner>}
          {ragStatus === 'error' && ragMessage && <StatusBanner tone="error">{ragMessage}</StatusBanner>}
          {clearStatus === 'error' && clearError && <StatusBanner tone="error">{clearError}</StatusBanner>}
        </CardContent>
      </Card>
    </div>
  )
}

interface FieldProps {
  label: string
  htmlFor: string
  children: ReactNode
}

function Field({ label, htmlFor, children }: FieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
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

export default Setup
