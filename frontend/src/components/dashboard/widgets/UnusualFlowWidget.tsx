import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}

interface Flow { time: string; ticker: string; cp: 'C' | 'P'; strike: number; expiry: string; size: number; premium: number; type: 'SWEEP' | 'BLOCK' | 'SPLIT'; bull: boolean }
const FLOWS: Flow[] = [
  { time: '15:58', ticker: 'NVDA', cp: 'C', strike: 215, expiry: 'Jul 18', size: 4200, premium: 6_120_000, type: 'SWEEP', bull: true },
  { time: '15:54', ticker: 'SPY', cp: 'P', strike: 540, expiry: 'Jun 27', size: 9800, premium: 4_410_000, type: 'BLOCK', bull: false },
  { time: '15:51', ticker: 'TSLA', cp: 'C', strike: 420, expiry: 'Aug 15', size: 3100, premium: 3_280_000, type: 'SWEEP', bull: true },
  { time: '15:47', ticker: 'AAPL', cp: 'C', strike: 305, expiry: 'Jul 03', size: 5600, premium: 2_740_000, type: 'SPLIT', bull: true },
  { time: '15:43', ticker: 'META', cp: 'P', strike: 580, expiry: 'Jul 18', size: 2200, premium: 2_120_000, type: 'BLOCK', bull: false },
  { time: '15:39', ticker: 'AMD', cp: 'C', strike: 180, expiry: 'Jun 27', size: 7400, premium: 1_880_000, type: 'SWEEP', bull: true },
  { time: '15:34', ticker: 'QQQ', cp: 'P', strike: 470, expiry: 'Jul 11', size: 3300, premium: 1_540_000, type: 'BLOCK', bull: false },
  { time: '15:30', ticker: 'AMZN', cp: 'C', strike: 250, expiry: 'Aug 15', size: 2900, premium: 1_210_000, type: 'SPLIT', bull: true },
  { time: '15:25', ticker: 'GOOGL', cp: 'P', strike: 360, expiry: 'Jul 03', size: 1800, premium: 940_000, type: 'SWEEP', bull: false },
]
const fmtPrem = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(0)}K`

export default function UnusualFlowWidget({ config: _c }: { config: WidgetConfig }) {
  const [filter, setFilter] = useState<'all' | 'C' | 'P'>('all')
  const rows = FLOWS.filter(f => filter === 'all' || f.cp === filter).sort((a, b) => b.premium - a.premium)
  const callPrem = FLOWS.filter(f => f.cp === 'C').reduce((s, f) => s + f.premium, 0)
  const putPrem = FLOWS.filter(f => f.cp === 'P').reduce((s, f) => s + f.premium, 0)
  const callPct = (callPrem / (callPrem + putPrem)) * 100

  const chip = (active: boolean, color: string): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 8px', cursor: 'pointer', letterSpacing: '0.06em',
    border: active ? `1px solid ${color}` : `1px solid ${T.border}`, background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent', color: active ? color : 'rgba(255,255,255,0.4)',
  })
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10, color: T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ flex: 1, display: 'flex', height: 8, overflow: 'hidden', border: `1px solid ${T.border}` }}>
          <div style={{ width: `${callPct}%`, background: 'rgba(34,197,94,0.6)' }} />
          <div style={{ width: `${100 - callPct}%`, background: 'rgba(239,68,68,0.6)' }} />
        </div>
        <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, whiteSpace: 'nowrap' }}>{callPct.toFixed(0)}% calls</span>
        <div style={{ display: 'flex', gap: 3 }}>
          <button onClick={() => setFilter('all')} style={chip(filter === 'all', T.gold)}>ALL</button>
          <button onClick={() => setFilter('C')} style={chip(filter === 'C', T.pos)}>C</button>
          <button onClick={() => setFilter('P')} style={chip(filter === 'P', T.neg)}>P</button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.map((f, i) => {
          const c = f.bull ? T.pos : T.neg
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 6px 8px', borderBottom: `1px solid rgba(255,255,255,0.04)`, borderLeft: `3px solid ${c}` }}>
              <span style={{ ...TD, fontSize: 8.5, color: T.muted, width: 34, flexShrink: 0 }}>{f.time}</span>
              <TickerLogo ticker={f.ticker} size={16} />
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold, width: 46, flexShrink: 0 }}>{f.ticker}</span>
              <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, color: c, border: `1px solid ${c}`, padding: '0 4px', flexShrink: 0 }}>{f.cp}</span>
              <span style={{ ...TD, width: 44, textAlign: 'right' }}>{f.strike}</span>
              <span style={{ ...TD, fontSize: 8.5, color: T.muted, width: 44, textAlign: 'right' }}>{f.expiry}</span>
              <span style={{ ...TD, fontSize: 9, color: T.muted, flex: 1, textAlign: 'right' }}>{f.size.toLocaleString()}×</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, width: 62, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtPrem(f.premium)}</span>
              <span style={{ fontFamily: T.label, fontSize: 7, fontWeight: 700, letterSpacing: '0.06em', color: T.muted, border: `1px solid ${T.border}`, padding: '0 4px', flexShrink: 0, width: 44, textAlign: 'center' }}>{f.type}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
