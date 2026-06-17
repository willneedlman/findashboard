import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { loadActivePortfolio, useQuotes, priceHoldings } from './usePortfolio'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`

export default function PnLAttributionWidget({ config: _c }: { config: WidgetConfig }) {
  const [mode, setMode] = useState<'day' | 'open'>('day')
  const { holdings } = loadActivePortfolio()
  const quotes = useQuotes(holdings.map(h => h.ticker))
  const priced = priceHoldings(holdings, quotes)

  const rows = priced
    .map(p => ({ ticker: p.ticker, pnl: mode === 'day' ? p.dayPnl : p.pnl }))
    .sort((a, b) => b.pnl - a.pnl)
  const net = rows.reduce((s, r) => s + r.pnl, 0)

  const btn = (active: boolean): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 7px', cursor: 'pointer', letterSpacing: '0.04em',
    border: active ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
    background: active ? 'rgba(201,168,76,0.12)' : 'transparent', color: active ? T.gold : 'rgba(255,255,255,0.4)',
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

  // Cumulative waterfall bars + a final Net bar.
  let run = 0
  const bars = rows.map(r => { const from = run; run += r.pnl; return { ticker: r.ticker, from, to: run, pnl: r.pnl } })
  const cum = [0, ...bars.map(b => b.to)]
  const lo = Math.min(0, ...cum, net), hi = Math.max(0, ...cum, net)
  const yPct = (v: number) => (1 - (v - lo) / (hi - lo || 1)) * 100
  const cols = bars.length + 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, padding: '10px 10px 20px' }}>
        <div style={{ position: 'relative', height: '100%' }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: `${yPct(0)}%`, height: 1, background: 'rgba(255,255,255,0.14)' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {bars.map(b => {
              const top = Math.min(yPct(b.from), yPct(b.to))
              const h = Math.abs(yPct(b.from) - yPct(b.to))
              const up = b.pnl >= 0
              return (
                <div key={b.ticker} style={{ position: 'relative' }}>
                  <div style={{ position: 'absolute', left: '22%', right: '22%', top: `${top}%`, height: `${Math.max(h, 0.6)}%`, background: up ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)' }} title={`${b.ticker} ${up ? '+' : ''}${money(b.pnl)}`} />
                  <div style={{ position: 'absolute', bottom: -16, left: 0, right: 0, textAlign: 'center', fontFamily: T.mono, fontSize: 8, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.ticker}</div>
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
