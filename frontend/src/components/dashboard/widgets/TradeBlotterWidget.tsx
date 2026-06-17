import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444', blue: '#60a5fa',
}

type Status = 'FILLED' | 'PARTIAL' | 'WORKING' | 'CANCELED' | 'REJECTED'
interface Order { time: string; sym: string; side: 'BUY' | 'SELL'; qty: number; type: 'MKT' | 'LMT'; avg: number | null; status: Status; fillPct?: number }
const ORDERS: Order[] = [
  { time: '15:59:02', sym: 'NVDA', side: 'BUY', qty: 200, type: 'LMT', avg: 207.38, status: 'FILLED' },
  { time: '15:57:41', sym: 'AAPL', side: 'SELL', qty: 500, type: 'MKT', avg: 299.21, status: 'FILLED' },
  { time: '15:55:10', sym: 'TSLA', side: 'BUY', qty: 300, type: 'LMT', avg: 404.10, status: 'PARTIAL', fillPct: 60 },
  { time: '15:52:33', sym: 'SPY', side: 'BUY', qty: 1000, type: 'LMT', avg: null, status: 'WORKING', fillPct: 0 },
  { time: '15:49:58', sym: 'META', side: 'SELL', qty: 150, type: 'LMT', avg: null, status: 'WORKING', fillPct: 0 },
  { time: '15:46:20', sym: 'AMD', side: 'BUY', qty: 400, type: 'MKT', avg: 179.84, status: 'FILLED' },
  { time: '15:43:05', sym: 'QQQ', side: 'SELL', qty: 250, type: 'LMT', avg: null, status: 'CANCELED' },
  { time: '15:40:11', sym: 'AMZN', side: 'BUY', qty: 120, type: 'LMT', avg: null, status: 'REJECTED' },
]
const STATUS_C: Record<Status, string> = { FILLED: T.pos, PARTIAL: T.gold, WORKING: T.blue, CANCELED: T.muted, REJECTED: T.neg }

export default function TradeBlotterWidget({ config: _c }: { config: WidgetConfig }) {
  const [filter, setFilter] = useState<'all' | 'filled' | 'working'>('all')
  const rows = ORDERS.filter(o =>
    filter === 'all' ? true : filter === 'filled' ? o.status === 'FILLED' : (o.status === 'WORKING' || o.status === 'PARTIAL'))

  const chip = (active: boolean): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 8px', cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase',
    border: active ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`, background: active ? 'rgba(201,168,76,0.12)' : 'transparent', color: active ? T.gold : 'rgba(255,255,255,0.4)',
  })
  const TH: React.CSSProperties = { fontFamily: T.label, fontSize: 7.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10, color: T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '5px 10px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>{rows.length} orders</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(['all', 'filled', 'working'] as const).map(f => <button key={f} onClick={() => setFilter(f)} style={chip(filter === f)}>{f}</button>)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '4px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ ...TH, flex: '0 0 56px' }}>Time</span>
        <span style={{ ...TH, flex: 1 }}>Symbol</span>
        <span style={{ ...TH, flex: '0 0 36px', textAlign: 'right' }}>Qty</span>
        <span style={{ ...TH, flex: '0 0 56px', textAlign: 'right' }}>Avg</span>
        <span style={{ ...TH, flex: '0 0 76px', textAlign: 'right' }}>Status</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.map((o, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
            <span style={{ ...TD, fontSize: 8.5, color: T.muted, flex: '0 0 56px' }}>{o.time}</span>
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <TickerLogo ticker={o.sym} size={15} />
              <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: T.gold }}>{o.sym}</span>
              <span style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 700, color: o.side === 'BUY' ? T.pos : T.neg, border: `1px solid ${o.side === 'BUY' ? T.pos : T.neg}`, padding: '0 4px', flexShrink: 0 }}>{o.side}</span>
              <span style={{ fontFamily: T.mono, fontSize: 7.5, color: T.muted, flexShrink: 0 }}>{o.type}</span>
            </span>
            <span style={{ ...TD, flex: '0 0 36px', textAlign: 'right' }}>{o.qty}</span>
            <span style={{ ...TD, flex: '0 0 56px', textAlign: 'right' }}>{o.avg != null ? o.avg.toFixed(2) : '—'}</span>
            <span style={{ flex: '0 0 76px', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: STATUS_C[o.status], flexShrink: 0 }} />
              <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, color: STATUS_C[o.status] }}>{o.status}{o.fillPct != null && o.status === 'PARTIAL' ? ` ${o.fillPct}%` : ''}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
