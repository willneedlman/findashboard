import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { normalizeTicker } from '../../../lib/pmImport'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

interface Holding { ticker: string; shares: number; avgCost: number }
interface Portfolio { id: string; name: string; holdings: Holding[] }
interface QuoteData { current_price: number; pct_change_1d: number | null }

const money = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export default function PMPortfoliosWidget({ config: _config }: { config: WidgetConfig }) {
  // The Portfolio Manager persists here; read it once on mount.
  const pm = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('pm-portfolios-v2') || 'null') } catch { return null }
  }, [])
  const portfolios: Portfolio[] = pm?.portfolios ?? []
  const [selId, setSelId] = useState<string>(pm?.activeId ?? portfolios[0]?.id ?? '')
  const sel = portfolios.find(p => p.id === selId) ?? portfolios[0]
  const holdings = sel?.holdings ?? []

  const quotes = useQueries({
    queries: holdings.map(h => {
      const sym = normalizeTicker(h.ticker)
      return {
        queryKey: ['pm-widget-quote', sym],
        queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(sym)}`).then(r => r.data as QuoteData),
        staleTime: 60_000,
        retry: 1,
      }
    }),
  })

  const rows = holdings.map((h, i) => {
    const price = quotes[i]?.data?.current_price ?? null
    const cost = h.avgCost * h.shares
    const value = price != null ? price * h.shares : null
    const pnl = value != null ? value - cost : null
    const pnlPct = pnl != null && cost > 0 ? (pnl / cost) * 100 : null
    return { ticker: h.ticker, shares: h.shares, price, value, pnlPct }
  })
  const totalValue = rows.reduce((s, r) => s + (r.value ?? 0), 0)
  const totalCost = holdings.reduce((s, h) => s + h.avgCost * h.shares, 0)
  const totalPnl = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

  if (!portfolios.length) return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 14, textAlign: 'center' }}>
      <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11, lineHeight: 1.5 }}>No portfolios yet.<br />Create one in the Portfolio Manager.</span>
    </div>
  )

  const TH: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10.5, padding: '4px 8px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {portfolios.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>Book</span>
          <select value={sel?.id ?? ''} onChange={e => setSelId(e.target.value)} style={{
            background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.text,
            fontFamily: T.mono, fontSize: 10.5, padding: '2px 4px', outline: 'none', cursor: 'pointer', width: '100%',
          }}>
            {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ padding: '7px 10px', borderRight: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>Value</div>
          <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1 }}>{money(totalValue)}</div>
        </div>
        <div style={{ padding: '7px 10px' }}>
          <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>Unrealized P&L</div>
          <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: totalPnl >= 0 ? T.pos : T.neg, lineHeight: 1 }}>
            {totalPnl >= 0 ? '+' : ''}{money(totalPnl)} <span style={{ fontSize: 10 }}>({totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(1)}%)</span>
          </div>
        </div>
      </div>

      {holdings.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>No holdings in this portfolio.</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: T.surface }}>
                <th style={{ ...TH, textAlign: 'left' }}>Ticker</th>
                <th style={TH}>Value</th>
                <th style={TH}>P&L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.ticker} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ ...TD, textAlign: 'left' }}>
                    <span style={{ color: T.gold, fontWeight: 700 }}>{r.ticker}</span>
                    <span style={{ color: T.muted, fontSize: 8.5, marginLeft: 6 }}>{r.shares} sh</span>
                  </td>
                  <td style={TD}>{r.value != null ? money(r.value) : '—'}</td>
                  <td style={{ ...TD, color: r.pnlPct == null ? T.muted : r.pnlPct >= 0 ? T.pos : T.neg }}>
                    {r.pnlPct == null ? '—' : `${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
