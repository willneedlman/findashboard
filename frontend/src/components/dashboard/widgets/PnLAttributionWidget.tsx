import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}

const BASE: { ticker: string; pnl: number }[] = [
  { ticker: 'NVDA', pnl: 3200 }, { ticker: 'AAPL', pnl: 1850 }, { ticker: 'MSFT', pnl: 920 },
  { ticker: 'AMZN', pnl: 540 }, { ticker: 'GOOGL', pnl: -310 }, { ticker: 'META', pnl: -640 },
  { ticker: 'TSLA', pnl: -1280 },
]
const SCALE: Record<string, number> = { Day: 1, Week: 3.4, Month: 11.2 }
const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`

export default function PnLAttributionWidget({ config }: { config: WidgetConfig }) {
  const [range, setRange] = useState<'Day' | 'Week' | 'Month'>('Day')
  const tickers = config.tickers?.length ? config.tickers : null
  const rows = (tickers ? BASE.map((b, i) => ({ ...b, ticker: tickers[i] ?? b.ticker })) : BASE).map(r => ({ ...r, pnl: r.pnl * SCALE[range] }))
  const net = rows.reduce((s, r) => s + r.pnl, 0)

  // Cumulative waterfall bars + a final Net bar.
  let run = 0
  const bars = rows.map(r => { const from = run; run += r.pnl; return { ticker: r.ticker, from, to: run, pnl: r.pnl } })
  const cum = [0, ...bars.map(b => b.to)]
  const lo = Math.min(0, ...cum, net), hi = Math.max(0, ...cum, net)
  const yPct = (v: number) => (1 - (v - lo) / (hi - lo || 1)) * 100
  const cols = bars.length + 1

  const btn = (active: boolean): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 7px', cursor: 'pointer', letterSpacing: '0.04em',
    border: active ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
    background: active ? 'rgba(201,168,76,0.12)' : 'transparent', color: active ? T.gold : 'rgba(255,255,255,0.4)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '5px 10px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>Net {range} P/L <span style={{ color: net >= 0 ? T.pos : T.neg, fontWeight: 700 }}>{net >= 0 ? '+' : ''}{money(net)}</span></span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(['Day', 'Week', 'Month'] as const).map(r => <button key={r} onClick={() => setRange(r)} style={btn(range === r)}>{r}</button>)}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: '10px 10px 20px' }}>
        <div style={{ position: 'relative', height: '100%' }}>
          {/* zero baseline */}
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
