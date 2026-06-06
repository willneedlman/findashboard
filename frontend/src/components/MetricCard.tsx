import clsx from 'clsx'
import { useState } from 'react'

interface MetricCardProps {
  label: string
  value: string | number
  delta?: string
  deltaPositive?: boolean
  className?: string
  help?: string
}

export default function MetricCard({ label, value, delta, deltaPositive, className, help }: MetricCardProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className={clsx('metric-card relative', className)}>
      <div className="flex items-center gap-1 mb-1">
        <p className="label-sm">{label}</p>
        {help && (
          <div className="relative"
            onMouseEnter={() => setVisible(true)}
            onMouseLeave={() => setVisible(false)}>
            <span className="text-slate-terminal hover:text-gold cursor-help text-[10px] leading-none select-none"
              style={{ lineHeight: 1 }}>
              ⓘ
            </span>
            {visible && (
              <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded
                bg-navy-800 border border-white/10 shadow-xl p-2.5 text-xs text-slate-bright leading-snug pointer-events-none"
                style={{ background: 'var(--theme-bg, #0f1d31)' }}>
                {help}
                <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent"
                  style={{ borderTopColor: 'var(--theme-bg, #0f1d31)' }} />
              </div>
            )}
          </div>
        )}
      </div>
      <p className="text-slate-bright text-xl font-semibold tabular-nums">{value}</p>
      {delta !== undefined && (
        <p className={clsx('text-xs mt-0.5 tabular-nums', deltaPositive ? 'text-positive' : 'text-negative')}>
          {delta}
        </p>
      )}
    </div>
  )
}
