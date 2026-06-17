import type { WidgetConfig } from '../../../hooks/useDashboard'
import { loadActivePortfolio, useQuotes, priceHoldings } from './usePortfolio'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}
const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }

export default function ExposureMapWidget({ config: _c }: { config: WidgetConfig }) {
  const { holdings, cash } = loadActivePortfolio()
  const quotes = useQuotes(holdings.map(h => h.ticker))
  const priced = priceHoldings(holdings, quotes)

  if (priced.length === 0) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, background: T.bg, fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
        No holdings yet. Add positions in the Portfolio Manager to map your exposure.
      </div>
    )
  }

  const longVal = priced.filter(p => p.value >= 0).reduce((s, p) => s + p.value, 0)
  const shortVal = priced.filter(p => p.value < 0).reduce((s, p) => s + Math.abs(p.value), 0)
  const nav = longVal - shortVal + cash || 1
  const pct = (v: number) => (v / nav) * 100

  const gross = pct(longVal + shortVal)
  const net = pct(longVal - shortVal)
  const longP = pct(longVal), shortP = pct(shortVal), cashP = Math.max(0, pct(cash))

  const rows = [...priced].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  const maxAbs = Math.max(...rows.map(p => Math.abs(pct(p.value))), 1)

  const top = [
    { l: 'Gross', v: `${gross.toFixed(0)}%`, c: T.text },
    { l: 'Net', v: `${net >= 0 ? '+' : ''}${net.toFixed(0)}%`, c: net >= 0 ? T.pos : T.neg },
    { l: 'Long', v: `${longP.toFixed(0)}%`, c: T.pos },
    { l: 'Short', v: `${shortP.toFixed(0)}%`, c: T.neg },
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
        {rows.map(p => {
          const np = pct(p.value)
          const long = np >= 0
          return (
            <div key={p.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px' }}>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.text, width: 52, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.ticker}</span>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 10 }}>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                  {!long && <div style={{ width: `${(Math.abs(np) / maxAbs) * 100}%`, height: 8, background: 'rgba(239,68,68,0.55)' }} />}
                </div>
                <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.16)', flexShrink: 0 }} />
                <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}>
                  {long && <div style={{ width: `${(np / maxAbs) * 100}%`, height: 8, background: 'rgba(34,197,94,0.55)' }} />}
                </div>
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: long ? T.pos : T.neg, width: 38, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{long ? '' : '-'}{Math.abs(np).toFixed(1)}%</span>
            </div>
          )
        })}
      </div>

      <div style={{ flexShrink: 0, padding: '8px 10px', borderTop: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', height: 12, overflow: 'hidden', border: `1px solid ${T.border}` }}>
          <div style={{ width: `${longP}%`, background: 'rgba(34,197,94,0.7)' }} />
          <div style={{ width: `${shortP}%`, background: 'rgba(239,68,68,0.7)' }} />
          <div style={{ width: `${cashP}%`, background: 'rgba(255,255,255,0.12)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: T.mono, fontSize: 9 }}>
          <span style={{ color: T.pos }}>{longP.toFixed(0)}% Long</span>
          <span style={{ color: T.neg }}>{shortP.toFixed(0)}% Short</span>
          <span style={{ color: T.muted }}>{cashP.toFixed(0)}% Cash</span>
        </div>
      </div>
    </div>
  )
}
