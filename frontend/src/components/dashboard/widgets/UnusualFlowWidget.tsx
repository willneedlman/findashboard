import { T } from '../../../lib/theme'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'
import TickerLink from '../../TickerLink'


interface Flow {
  ticker: string; type: 'call' | 'put'; strike: number; expiry: string; dte: number
  volume: number; openInterest: number; volOiRatio: number; iv: number; moneyness: number | null; premium: number
}
const fmtPrem = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`
const fmtExp = (iso: string) => {
  const d = new Date(iso + 'T00:00:00')
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
}

export default function UnusualFlowWidget({ config }: { config: WidgetConfig }) {
  const [filter, setFilter] = useState<'all' | 'call' | 'put'>('all')
  const scope = config.ticker ? `?tickers=${encodeURIComponent(config.ticker.toUpperCase())}` : ''

  const { data, isLoading, isError } = useQuery<{ rows: Flow[] }>({
    queryKey: ['unusual-flow', scope],
    queryFn: () => axios.get(`/api/options/unusual${scope}`).then(r => r.data),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })

  const all = data?.rows ?? []
  const rows = all.filter(f => filter === 'all' || f.type === filter)
  const callPrem = all.filter(f => f.type === 'call').reduce((s, f) => s + f.premium, 0)
  const putPrem = all.filter(f => f.type === 'put').reduce((s, f) => s + f.premium, 0)
  const callPct = callPrem + putPrem > 0 ? (callPrem / (callPrem + putPrem)) * 100 : 50

  const chip = (active: boolean, color: string): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 8px', cursor: 'pointer', letterSpacing: '0.06em',
    border: active ? `1px solid ${color}` : `1px solid ${T.border}`, background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent', color: active ? color : 'rgba(255,255,255,0.4)',
  })
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10, color: T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ flex: 1, display: 'flex', height: 8, overflow: 'hidden', border: `1px solid ${T.border}` }}>
          <div style={{ width: `${callPct}%`, background: 'color-mix(in srgb, var(--theme-positive) 60%, transparent)' }} />
          <div style={{ width: `${100 - callPct}%`, background: 'color-mix(in srgb, var(--theme-negative) 60%, transparent)' }} />
        </div>
        <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, whiteSpace: 'nowrap' }}>{callPct.toFixed(0)}% calls</span>
        <div style={{ display: 'flex', gap: 3 }}>
          <button onClick={() => setFilter('all')} style={chip(filter === 'all', T.gold)}>ALL</button>
          <button onClick={() => setFilter('call')} style={chip(filter === 'call', T.pos)}>C</button>
          <button onClick={() => setFilter('put')} style={chip(filter === 'put', T.neg)}>P</button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', fontFamily: T.label, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            {isLoading ? 'Scanning option chains…' : isError ? 'Flow scan unavailable.' : 'No unusual activity found.'}
          </div>
        ) : rows.map((f, i) => {
          const isCall = f.type === 'call'
          const c = isCall ? T.pos : T.neg
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px 6px 8px', borderBottom: `1px solid rgba(255,255,255,0.04)`, borderLeft: `2px solid ${c}` }}>
              <TickerLogo ticker={f.ticker} size={16} />
              <TickerLink ticker={f.ticker} caret={false} style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold, width: 44, flexShrink: 0 }} />
              <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, color: c, border: `1px solid ${c}`, padding: '0 4px', flexShrink: 0 }}>{isCall ? 'C' : 'P'}</span>
              <span style={{ ...TD, width: 42, textAlign: 'right' }}>{f.strike}</span>
              <span style={{ ...TD, fontSize: 8.5, color: T.muted, width: 42, textAlign: 'right' }}>{fmtExp(f.expiry)}</span>
              <span style={{ ...TD, fontSize: 9, color: T.muted, flex: 1, textAlign: 'right' }}>{f.volume.toLocaleString()}×</span>
              <span style={{ fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, color: f.volOiRatio >= 3 ? T.gold : T.muted, width: 38, textAlign: 'right', flexShrink: 0 }} title="Volume / Open Interest">{f.volOiRatio.toFixed(1)}x</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, width: 60, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtPrem(f.premium)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
