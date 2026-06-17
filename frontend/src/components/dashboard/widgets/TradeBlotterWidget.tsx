import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'
import { usePaperAccount, hhmmss } from './usePortfolio'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444', blue: '#60a5fa',
}

const STATUS_C: Record<string, string> = { filled: T.pos, partial: T.gold, working: T.blue, pending: T.blue, open: T.blue, canceled: T.muted, cancelled: T.muted, rejected: T.neg }
const isWorking = (s: string) => ['working', 'pending', 'open', 'partial'].includes(s)

export default function TradeBlotterWidget({ config: _c }: { config: WidgetConfig }) {
  const [filter, setFilter] = useState<'all' | 'filled' | 'working'>('all')
  const { data, isLoading, user } = usePaperAccount()

  const orders = (data?.orders ?? []).slice().sort((a, b) => (b.filled_at ?? b.created_at ?? 0) - (a.filled_at ?? a.created_at ?? 0))
  const rows = orders.filter(o => {
    const s = (o.status || '').toLowerCase()
    return filter === 'all' ? true : filter === 'filled' ? s === 'filled' : isWorking(s)
  })

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
        <span style={{ ...TH, flex: '0 0 56px', textAlign: 'right' }}>Fill</span>
        <span style={{ ...TH, flex: '0 0 76px', textAlign: 'right' }}>Status</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', fontFamily: T.label, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            {!user?.id ? 'Sign in and paper-trade to populate the blotter.' : isLoading ? 'Loading orders…' : 'No orders yet. Place a paper trade to see fills here.'}
          </div>
        ) : rows.map((o, i) => {
          const s = (o.status || '').toLowerCase()
          const sc = STATUS_C[s] ?? T.muted
          const sym = o.symbol || o.option_symbol || '—'
          const side = (o.side || '').split('_')[0].toUpperCase()
          const buy = side === 'BUY'
          return (
            <div key={o.id || i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
              <span style={{ ...TD, fontSize: 8.5, color: T.muted, flex: '0 0 56px' }}>{hhmmss(o.filled_at ?? o.created_at)}</span>
              <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <TickerLogo ticker={sym} size={15} />
                <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: T.gold }}>{sym}</span>
                {side && <span style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 700, color: buy ? T.pos : T.neg, border: `1px solid ${buy ? T.pos : T.neg}`, padding: '0 4px', flexShrink: 0 }}>{side}</span>}
                {o.order_type && <span style={{ fontFamily: T.mono, fontSize: 7.5, color: T.muted, flexShrink: 0, textTransform: 'uppercase' }}>{o.order_type.slice(0, 3)}</span>}
              </span>
              <span style={{ ...TD, flex: '0 0 36px', textAlign: 'right' }}>{o.quantity ?? '—'}</span>
              <span style={{ ...TD, flex: '0 0 56px', textAlign: 'right' }}>{o.fill_price != null ? o.fill_price.toFixed(2) : '—'}</span>
              <span style={{ flex: '0 0 76px', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: sc, flexShrink: 0 }} />
                <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, color: sc, textTransform: 'uppercase' }}>{s || 'unknown'}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
