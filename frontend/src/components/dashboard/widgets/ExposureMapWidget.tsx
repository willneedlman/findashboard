import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}

// % of NAV, long positive / short negative.
const SECTORS = [
  { name: 'Technology', long: 38, short: 6 },
  { name: 'Financials', long: 18, short: 2 },
  { name: 'Healthcare', long: 14, short: 9 },
  { name: 'Energy', long: 4, short: 12 },
  { name: 'Consumer', long: 16, short: 5 },
  { name: 'Industrials', long: 11, short: 3 },
  { name: 'Utilities', long: 2, short: 7 },
]
const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }

export default function ExposureMapWidget({ config: _c }: { config: WidgetConfig }) {
  const long = SECTORS.reduce((s, x) => s + x.long, 0)
  const short = SECTORS.reduce((s, x) => s + x.short, 0)
  const gross = long + short
  const net = long - short
  const cash = Math.max(0, 100 - long - short)
  const maxAbs = Math.max(...SECTORS.map(s => Math.max(s.long, s.short)), 1)

  const top = [
    { l: 'Gross', v: `${gross}%`, c: T.text },
    { l: 'Net', v: `${net >= 0 ? '+' : ''}${net}%`, c: net >= 0 ? T.pos : T.neg },
    { l: 'Long', v: `${long}%`, c: T.pos },
    { l: 'Short', v: `${short}%`, c: T.neg },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {top.map((s, i) => (
          <div key={s.l} style={{ padding: '7px 8px', borderRight: i < 3 ? `1px solid ${T.border}` : 'none' }}>
            <div style={cap}>{s.l}</div>
            <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: s.c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
        {SECTORS.map(s => {
          const net = s.long - s.short
          return (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px' }}>
              <span style={{ fontFamily: T.label, fontSize: 9.5, color: T.text, width: 76, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 10 }}>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{ width: `${(s.short / maxAbs) * 100}%`, height: 8, background: 'rgba(239,68,68,0.55)' }} />
                </div>
                <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.16)', flexShrink: 0 }} />
                <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}>
                  <div style={{ width: `${(s.long / maxAbs) * 100}%`, height: 8, background: 'rgba(34,197,94,0.55)' }} />
                </div>
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: net >= 0 ? T.pos : T.neg, width: 34, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{net >= 0 ? '+' : ''}{net}%</span>
            </div>
          )
        })}
      </div>

      <div style={{ flexShrink: 0, padding: '8px 10px', borderTop: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', height: 12, overflow: 'hidden', border: `1px solid ${T.border}` }}>
          <div style={{ width: `${long}%`, background: 'rgba(34,197,94,0.7)' }} />
          <div style={{ width: `${short}%`, background: 'rgba(239,68,68,0.7)' }} />
          <div style={{ width: `${cash}%`, background: 'rgba(255,255,255,0.12)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: T.mono, fontSize: 9 }}>
          <span style={{ color: T.pos }}>{long}% Long</span>
          <span style={{ color: T.neg }}>{short}% Short</span>
          <span style={{ color: T.muted }}>{cash}% Cash</span>
        </div>
      </div>
    </div>
  )
}
