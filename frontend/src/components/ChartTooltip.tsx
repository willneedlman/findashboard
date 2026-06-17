interface TooltipPayloadItem {
  name?: string
  value?: number | string
  color?: string
  dataKey?: string
}

interface ChartTooltipProps {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
  formatter?: (value: number, name: string) => string
  labelFormatter?: (label: string) => string
}

export const TOOLTIP_STYLE = {
  background: 'var(--theme-surface, #0d1826)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  borderRadius: 0,
  fontFamily: 'var(--theme-mono)',
  fontSize: 11,
  padding: '8px 10px',
  boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
}

export const CROSSHAIR_CURSOR = {
  stroke: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 25%, transparent)',
  strokeWidth: 1,
  strokeDasharray: '4 3',
}

// Use for BarCharts — prevents the default white/light rectangle cursor
export const BAR_CURSOR = {
  fill: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
}

export default function ChartTooltip({ active, payload, label, formatter, labelFormatter }: ChartTooltipProps) {
  if (!active || !payload?.length) return null

  const displayLabel = labelFormatter ? labelFormatter(label ?? '') : label

  return (
    <div style={TOOLTIP_STYLE}>
      {displayLabel && (
        <div style={{ color: 'var(--theme-secondary, #99907e)', fontSize: 10, letterSpacing: '0.08em', marginBottom: 6, borderBottom: '1px solid rgba(46,57,77,0.8)', paddingBottom: 4 }}>
          {displayLabel}
        </div>
      )}
      {payload.map((entry, i) => {
        const raw = entry.value as number
        const name = entry.name ?? entry.dataKey ?? ''
        const display = formatter ? formatter(raw, name) : (typeof raw === 'number' ? raw.toFixed(2) : String(raw))
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 3 : 0 }}>
            <div style={{ width: 8, height: 2, background: entry.color ?? 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
            <span style={{ color: 'var(--theme-secondary, #99907e)', flex: 1 }}>{name}</span>
            <span style={{ color: 'var(--theme-text, #d7e3fc)', fontWeight: 600 }}>{display}</span>
          </div>
        )
      })}
    </div>
  )
}
