import { T } from '../../../lib/theme'
import { useState, useMemo } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { loadActivePortfolio, useQuotes, priceHoldings, money } from './usePortfolio'
import { useWidgetContentState } from '../widgetContentState'



export default function PnLAttributionWidget({ config }: { config: WidgetConfig }) {
  const [mode, setMode] = useState<'day' | 'open'>('day')
  const { holdings } = useMemo(() => loadActivePortfolio(config.portfolioId), [config.portfolioId])
  const quotes = useQuotes(holdings.map(h => h.ticker))
  const priced = priceHoldings(holdings, quotes)

  const rows = priced
    .map(p => ({ ticker: p.ticker, pnl: mode === 'day' ? p.dayPnl : p.pnl }))
    .sort((a, b) => b.pnl - a.pnl)
  const net = rows.reduce((s, r) => s + r.pnl, 0)
  useWidgetContentState(config.id, rows.length ? 'ready' : 'empty')

  const btn = (active: boolean): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 7px', cursor: 'pointer', letterSpacing: '0.04em',
    border: active ? '1px solid color-mix(in srgb, var(--theme-primary) 55%, transparent)' : `1px solid ${T.border}`,
    background: active ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent', color: active ? T.gold : 'rgba(255,255,255,0.4)',
  })

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '5px 10px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
        {mode === 'day' ? 'Day' : 'Open'} P/L <span style={{ color: net >= 0 ? T.pos : T.neg, fontWeight: 700 }}>{net >= 0 ? '+' : ''}{money(net)}</span>
      </span>
      <div style={{ display: 'flex', gap: 3 }}>
        <button onClick={() => setMode('day')} style={btn(mode === 'day')}>Day</button>
        <button onClick={() => setMode('open')} style={btn(mode === 'open')}>Open</button>
      </div>
    </div>
  )

  if (rows.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
        {header}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
          No holdings yet. Add positions in the Portfolio Manager to see live P/L attribution.
        </div>
      </div>
    )
  }

  // Per-position bars anchored at a centered zero line: gains rise above 0,
  // losses drop below it (no cumulative waterfall).
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.pnl)), Math.abs(net), 1)
  const yPct = (v: number) => (1 - (v + maxAbs) / (2 * maxAbs)) * 100
  const cols = rows.length + 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, padding: '10px 10px 20px' }}>
        <div style={{ position: 'relative', height: '100%' }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: `${yPct(0)}%`, height: 1, background: 'rgba(255,255,255,0.14)' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {rows.map(r => {
              const top = Math.min(yPct(0), yPct(r.pnl))
              const h = Math.abs(yPct(0) - yPct(r.pnl))
              const up = r.pnl >= 0
              return (
                <div key={r.ticker} style={{ position: 'relative' }}>
                  <div style={{ position: 'absolute', left: '22%', right: '22%', top: `${top}%`, height: `${Math.max(h, 0.6)}%`, background: up ? 'color-mix(in srgb, var(--theme-positive) 70%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 70%, transparent)' }} title={`${r.ticker} ${up ? '+' : ''}${money(r.pnl)}`} />
                  <div style={{ position: 'absolute', bottom: -16, left: 0, right: 0, textAlign: 'center', fontFamily: T.mono, fontSize: 8, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.ticker}</div>
                </div>
              )
            })}
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', left: '18%', right: '18%', top: `${Math.min(yPct(0), yPct(net))}%`, height: `${Math.max(Math.abs(yPct(0) - yPct(net)), 0.6)}%`, background: T.gold }} />
              <div style={{ position: 'absolute', bottom: -16, left: 0, right: 0, textAlign: 'center', fontFamily: T.label, fontSize: 8, fontWeight: 700, color: T.gold, letterSpacing: '0.06em' }}>NET</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
