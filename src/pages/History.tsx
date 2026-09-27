import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import ConfirmButton from '@/components/history/ConfirmButton'
import SessionList from '@/components/history/SessionList'
import SessionDetail from '@/components/history/SessionDetail'
import TopicTrendChart from '@/components/history/TopicTrendChart'
import { buildTrendChartModel } from '@/lib/historyMapping'
import { HISTORY_MAX_WEAK_AREAS, MAX_FOCUS_TOPICS, MIN_WEAK_AREA_SAMPLES, WEAK_AREA_SCORE_THRESHOLD } from '../../electron/ipc-types'
import type { HistorySessionSummary, TopicStat, TopicTrendPoint } from '../../electron/ipc-types'

const PAGE_SIZE = 50

interface HistoryProps {
  /** Starts a drill: App.tsx stores the topics and navigates to the Interview page. */
  onDrill: (topics: string[]) => void
}

/**
 * History & analytics: past sessions (click through to the full transcript and
 * per-answer feedback), per-topic score trends, the weak-areas ranking, and a
 * "Drill weak areas" shortcut. Everything is read main-process-side through
 * `window.api.*History*`; nothing is cached across visits -- the data is
 * re-fetched on every mount and after any delete/clear.
 *
 * Async hygiene: every fetch carries a request token (`loadIdRef`), and results
 * that arrive after unmount or after a newer refresh started are dropped.
 */
function History({ onDrill }: HistoryProps): JSX.Element {
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [topics, setTopics] = useState<TopicStat[]>([])
  const [trend, setTrend] = useState<TopicTrendPoint[]>([])
  const [weakAreas, setWeakAreas] = useState<TopicStat[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const mountedRef = useRef(true)
  const loadIdRef = useRef(0)

  const load = (): void => {
    const id = ++loadIdRef.current
    setLoading(true)
    setError(null)
    void Promise.all([
      window.api.listHistorySessions(PAGE_SIZE, 0),
      window.api.getHistoryTopicStats(),
      window.api.getHistoryWeakAreas(HISTORY_MAX_WEAK_AREAS)
    ])
      .then(([list, stats, weak]) => {
        if (!mountedRef.current || id !== loadIdRef.current) return
        setSessions(list.sessions)
        setHasMore(list.hasMore)
        setTopics(stats.topics)
        setTrend(stats.trend)
        setWeakAreas(weak.areas)
        const firstError = [list, stats, weak].find((r) => !r.ok)
        setError(firstError ? (firstError.error ?? 'Could not load history.') : null)
        setLoading(false)
      })
      .catch(() => {
        if (!mountedRef.current || id !== loadIdRef.current) return
        setError('Could not load history.')
        setLoading(false)
      })
  }

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => {
      mountedRef.current = false
      loadIdRef.current++
    }
  }, [])

  const handleLoadMore = (): void => {
    if (loadingMore) return
    const id = loadIdRef.current
    setLoadingMore(true)
    window.api
      .listHistorySessions(PAGE_SIZE, sessions.length)
      .then((result) => {
        if (!mountedRef.current) return
        // Always release the button when mounted, even if a newer refresh made this page stale.
        setLoadingMore(false)
        if (id !== loadIdRef.current) return
        if (!result.ok) {
          setActionError(result.error ?? 'Could not load more sessions.')
          return
        }
        // De-dup by id: a session that finished between pages could shift the offset window.
        setSessions((prev) => {
          const seen = new Set(prev.map((s) => s.id))
          return [...prev, ...result.sessions.filter((s) => !seen.has(s.id))]
        })
        setHasMore(result.hasMore)
      })
      .catch(() => {
        if (!mountedRef.current) return
        setLoadingMore(false)
        if (id !== loadIdRef.current) return
        setActionError('Could not load more sessions.')
      })
  }

  const runDestructive = (action: () => Promise<{ ok: boolean; error?: string }>, fallbackError: string): void => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    action()
      .then((result) => {
        if (!mountedRef.current) return
        setBusy(false)
        if (result.ok) {
          setSelectedId(null)
          load()
        } else {
          setActionError(result.error ?? fallbackError)
        }
      })
      .catch(() => {
        if (!mountedRef.current) return
        setBusy(false)
        setActionError(fallbackError)
      })
  }

  const handleDeleteSession = (sessionId: number): void =>
    runDestructive(() => window.api.deleteHistorySession(sessionId), 'Could not delete that session.')

  const handleClearAll = (): void => runDestructive(() => window.api.clearAllHistory(), 'Could not clear history.')

  const chartModel = useMemo(() => buildTrendChartModel(trend), [trend])
  const colorByTopic = useMemo(() => new Map(chartModel.series.map((s) => [s.topic, s.color])), [chartModel])
  const drillTopics = weakAreas.slice(0, MAX_FOCUS_TOPICS).map((a) => a.topic)

  if (selectedId !== null) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
        <SessionDetail
          sessionId={selectedId}
          onBack={() => setSelectedId(null)}
          onDeleted={() => {
            setSelectedId(null)
            load()
          }}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Past interviews, how your scores are trending by topic, and where to practice next.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Interview transcripts and feedback are stored locally on this machine only. You can delete any session, or clear everything, at any time.
          </p>
          {error && (
            <div role="status" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {actionError && (
            <div role="status" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Score trends by topic</CardTitle>
          <CardDescription>Average score (1-10) per topic by day, for your most-reviewed topics. Dashed line = 7, "would pass".</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : <TopicTrendChart model={chartModel} />}
          {!loading && topics.length > 0 && (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Average score per topic</caption>
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="py-1 font-medium">
                    Topic
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Answers
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Avg score
                  </th>
                </tr>
              </thead>
              <tbody>
                {topics.map((t) => (
                  <tr key={t.topic} className="border-t border-border">
                    <td className="py-1">
                      <span
                        aria-hidden="true"
                        className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                        style={{ background: colorByTopic.get(t.topic) ?? 'transparent', border: colorByTopic.has(t.topic) ? 'none' : '1px solid hsl(var(--border))' }}
                      />
                      {t.topic}
                    </td>
                    <td className="py-1 text-right">{t.count}</td>
                    <td className="py-1 text-right">{t.avgScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weak areas</CardTitle>
          <CardDescription>
            Ranked by lowest average score. A topic needs at least {MIN_WEAK_AREA_SAMPLES} scored answers (so one bad answer does not dominate) and an
            average below {WEAK_AREA_SCORE_THRESHOLD}/10.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!loading && weakAreas.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing to flag yet. Weak areas appear once a topic has enough scored answers.</p>
          )}
          {weakAreas.length > 0 && (
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              {weakAreas.map((area) => (
                <li key={area.topic}>
                  <span className="font-medium">{area.topic}</span>{' '}
                  <span className="text-muted-foreground">
                    -- avg {area.avgScore.toFixed(2)}/10 over {area.count} answers
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div>
            <Button type="button" disabled={drillTopics.length === 0 || busy} onClick={() => onDrill(drillTopics)}>
              Drill weak areas
            </Button>
            {drillTopics.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Starts an interview focused on: {drillTopics.join(', ')} (top {MAX_FOCUS_TOPICS} at most).
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <CardTitle className="text-base">Past sessions</CardTitle>
              <CardDescription>Select a session to read its transcript and feedback.</CardDescription>
            </div>
            {(error !== null || sessions.length > 0) && (
              <ConfirmButton
                label="Clear all history"
                prompt="Permanently delete ALL sessions, transcripts and feedback?"
                confirmLabel="Yes, delete everything"
                disabled={busy}
                onConfirm={handleClearAll}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <SessionList sessions={sessions} onOpen={setSelectedId} onDelete={handleDeleteSession} busy={busy} />
          )}
          {hasMore && !loading && (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default History
