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
    <div className={clsx('ft-metric relative', className)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <p style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--theme-secondary, #8099b0)',
          fontFamily: 'var(--theme-sans, Sora, sans-serif)',
          margin: 0,
        }}>{label}</p>
        {help && (
          <div style={{ position: 'relative' }}
            onMouseEnter={() => setVisible(true)}
            onMouseLeave={() => setVisible(false)}>
            <span style={{
              color: 'var(--theme-secondary, #8099b0)',
              cursor: 'help',
              fontSize: 10,
              lineHeight: 1,
              userSelect: 'none',
            }}>ⓘ</span>
            {visible && (
              <div style={{
                position: 'absolute',
                zIndex: 50,
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: 8,
                width: 224,
                borderRadius: 2,
                background: 'var(--theme-bg, #0f1d31)',
                border: '1px solid rgba(255,255,255,0.10)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                padding: '8px 10px',
                fontSize: 11,
                color: 'var(--theme-text, #d7e3fc)',
                lineHeight: 1.5,
                pointerEvents: 'none',
              }}>
                {help}
              </div>
            )}
          </div>
        )}
      </div>
      <p style={{
        color: 'var(--theme-text, #d7e3fc)',
        fontSize: 20,
        fontWeight: 700,
        fontFamily: 'var(--theme-mono, ui-monospace, monospace)',
        fontVariantNumeric: 'tabular-nums',
        margin: 0,
        lineHeight: 1.1,
      }}>{value}</p>
      {delta !== undefined && (
        <p style={{
          fontSize: 11,
          marginTop: 2,
          fontVariantNumeric: 'tabular-nums',
          color: deltaPositive ? 'var(--theme-positive)' : 'var(--theme-negative)',
          margin: '2px 0 0 0',
        }}>
          {delta}
        </p>
      )}
    </div>
  )
}
