import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface LevelMeterProps {
  label: string
  /** Called once per animation frame while `active` is true; expected to return 0 (silent) - 1 (full scale). */
  getLevel: () => number
  active: boolean
}

/**
 * A live amplitude bar. Runs its own `requestAnimationFrame` loop and writes
 * directly to the bar's `style.width` via a ref, rather than driving it
 * through React state -- re-rendering the component tree at animation-frame
 * rate for a value nothing else depends on would be wasteful.
 */
function LevelMeter({ label, getLevel, active }: LevelMeterProps): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) {
      if (barRef.current) barRef.current.style.width = '0%'
      return
    }

    let frameId: number
    const tick = (): void => {
      const level = Math.max(0, Math.min(1, getLevel()))
      if (barRef.current) {
        barRef.current.style.width = `${Math.round(level * 100)}%`
      }
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frameId)
  }, [active, getLevel])

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className={cn('h-3 w-full overflow-hidden rounded-full bg-secondary', !active && 'opacity-50')}>
        <div
          ref={barRef}
          className="h-full rounded-full bg-success transition-[width] duration-75 ease-out"
          style={{ width: '0%' }}
        />
      </div>
    </div>
  )
}

export default LevelMeter
