import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TrendChartModel } from '@/lib/historyMapping'
import { WEAK_AREA_SCORE_THRESHOLD } from '../../../electron/ipc-types'

interface TopicTrendChartProps {
  model: TrendChartModel
}

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 12 } as const

/**
 * Average score per topic over time (one line per topic, one point per local
 * day with reviews), with the "would pass" line at 7. Recharts renders plain
 * SVG, so it needs nothing from the app's `script-src 'self'` CSP (no eval, no
 * inline scripts; its inline style attributes are covered by `style-src
 * 'unsafe-inline'`). Only the handful of Recharts pieces used are imported.
 *
 * Accessibility: the chart is `role="img"` with a text summary (its SVG
 * internals are hidden from assistive tech under that role), and the
 * swatched topic table rendered next to it carries the same numbers as text.
 */
function TopicTrendChart({ model }: TopicTrendChartProps): JSX.Element {
  if (model.series.length === 0 || model.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No scored answers yet. Finish an interview and your per-topic score trends will show up here.
      </p>
    )
  }

  const label = `Line chart of average answer score (1 to 10) per topic over time. Topics: ${model.series.map((s) => s.topic).join(', ')}. Values are listed in the table below.`

  return (
    <div role="img" aria-label={label} className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={model.rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="day" tick={AXIS_TICK} stroke="hsl(var(--border))" />
          <YAxis domain={[1, 10]} ticks={[1, 4, 7, 10]} tick={AXIS_TICK} stroke="hsl(var(--border))" width={32} />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              color: 'hsl(var(--card-foreground))',
              fontSize: 12
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={WEAK_AREA_SCORE_THRESHOLD} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
          {model.series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.topic}
              stroke={s.color}
              strokeWidth={2}
              dot={{ r: 3, fill: s.color }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default TopicTrendChart
