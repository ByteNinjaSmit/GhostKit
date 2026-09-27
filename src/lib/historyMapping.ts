import type { GeminiLiveAnswerReviewEvent, HistoryReview, TopicTrendPoint } from '../../electron/ipc-types'

/**
 * A persisted review (`HistoryReview`) differs from the live push event: it is
 * always successful, carries a turn link and timestamp, and stores the
 * follow-up under `followUpQuestion`. FeedbackCard renders the live shape, so
 * this maps rather than forcing the two types together. `answerIndex` is kept
 * so the card header ("Answer N") matches what the candidate saw live.
 */
export function historyReviewToFeedbackEvent(review: HistoryReview): GeminiLiveAnswerReviewEvent {
  return {
    answerIndex: review.answerIndex,
    ok: true,
    score: review.score,
    star: review.star,
    missingPoints: review.missingPoints,
    technicalErrors: review.technicalErrors,
    improvedAnswer: review.improvedAnswer,
    followUpQuestion: review.followUpQuestion,
    topic: review.topic,
    metrics: review.metrics
  }
}

/**
 * Small fixed categorical palette for the topic trend chart. Mid-tone hues
 * chosen to keep contrast against both the light (white) and dark (near-black
 * navy) card backgrounds defined in src/index.css; series are also told apart
 * by the legend and the swatched table under the chart, never by colour alone.
 */
export const TOPIC_CHART_COLORS: readonly string[] = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4']

export interface TrendChartModel {
  /** Topics that have a series, in palette order (most-reviewed in the recent window first). */
  series: Array<{ key: string; topic: string; color: string }>
  /** One row per local day, oldest first: `{ day, t0: 4.5, t1: 7 ... }`. A missing value means no reviews for that topic that day. */
  rows: Array<Record<string, string | number>>
}

/**
 * Pivots the flat per-topic-per-day trend into chart rows. Series keys are
 * positional (`t0`, `t1`, ...) rather than the topic text: Recharts treats a
 * dataKey string containing "." as a nested path lookup, and topic labels may
 * legitimately contain one.
 */
export function buildTrendChartModel(trend: readonly TopicTrendPoint[]): TrendChartModel {
  // The series come from the trend data itself (main already chose the most-reviewed
  // topics of the RECENT window) -- never from the all-time topic list, which can
  // rank a different set and would silently drop a recently active topic.
  const countByTopic = new Map<string, number>()
  for (const point of trend) countByTopic.set(point.topic, (countByTopic.get(point.topic) ?? 0) + point.count)
  const ordered = [...countByTopic.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOPIC_CHART_COLORS.length)
    .map(([topic]) => topic)
  const series = ordered.map((topic, i) => ({ key: `t${i}`, topic, color: TOPIC_CHART_COLORS[i] ?? '#888888' }))
  const keyByTopic = new Map(series.map((s) => [s.topic, s.key]))

  const rowsByDay = new Map<string, Record<string, string | number>>()
  for (const point of trend) {
    const key = keyByTopic.get(point.topic)
    if (key === undefined) continue
    const row = rowsByDay.get(point.day) ?? { day: point.day }
    row[key] = point.avgScore
    rowsByDay.set(point.day, row)
  }
  const rows = [...rowsByDay.values()].sort((a, b) => String(a['day']).localeCompare(String(b['day'])))
  return { series, rows }
}

export function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
