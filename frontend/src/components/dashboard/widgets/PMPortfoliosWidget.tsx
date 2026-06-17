import { T } from '../../../lib/theme'
import { useMemo, useState } from 'react'
import { useQueries, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { normalizeTicker } from '../../../lib/pmImport'
import TickerLogo from '../../TickerLogo'
import { useTheme } from '../../../contexts/ThemeContext'
import { fmtMarketCap } from '../../../lib/format'


interface Holding { ticker: string; shares: number; avgCost: number }
interface Portfolio { id: string; name: string; holdings: Holding[] }
interface HubData { current_price: number | null; pct_change_1d: number | null; market_cap: number | null }
interface PaperPos { symbol: string; quantity: number; avg_cost: number; price: number; market_value: number; unrealized_pnl: number }
interface PaperOpt { option_symbol: string; underlying: string; type: string; strike: number; quantity: number; avg_cost: number; price: number; market_value: number; unrealized_pnl: number }
interface PaperAccount { equity: number; cash: number; realized_pnl: number; positions: PaperPos[]; option_positions: PaperOpt[] }

interface Row {
  key: string; ticker: string; label: string; sub: string; isOption: boolean
  avgCost: number; price: number | null; pct1d: number | null; mktCap: number | null; value: number | null; pnl: number | null; pnlPct: number | null
}

const PAPER = '__paper__'

const money = (v: number, d = 0) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d })

export default function PMPortfoliosWidget({ config: _config }: { config: WidgetConfig }) {
  const { user } = useTheme()
  const token = typeof window !== 'undefined' ? (localStorage.getItem('ft-session-token') || '') : ''
  const authed = !!user?.id && !!token
  const authHeaders = { Authorization: `Bearer ${token}`, 'x-session-token': token }
  const qc = useQueryClient()

  // The Portfolio Manager persists here; read it once on mount.
  const pm = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('pm-portfolios-v2') || 'null') } catch { return null }
  }, [])
  const books: Portfolio[] = pm?.portfolios ?? []
  const sources = [...books.map(b => ({ id: b.id, name: b.name })), ...(authed ? [{ id: PAPER, name: 'Paper Account' }] : [])]

  const [selId, setSelId] = useState<string>(pm?.activeId ?? books[0]?.id ?? (authed ? PAPER : ''))
  const isPaper = selId === PAPER
  const book = books.find(b => b.id === selId) ?? (isPaper ? undefined : books[0])
  const holdings = book?.holdings ?? []

  const account = useQuery<PaperAccount>({
    queryKey: ['paper-account', user?.id],
    queryFn: () => axios.get(`/api/paper/account?user_id=${user!.id}`, { headers: authHeaders }).then(r => r.data),
    enabled: authed && isPaper,
    staleTime: 15_000,
    retry: 1,
  })

  // Symbols needing a live quote (market cap + day change): PM holdings, or the
  // paper account's equity legs. Options carry their own price from the engine.
  const paperEq = account.data?.positions ?? []
  const paperOpt = account.data?.option_positions ?? []
  const equitySymbols = isPaper ? paperEq.map(p => p.symbol) : holdings.map(h => normalizeTicker(h.ticker))
  const quotes = useQueries({
    queries: equitySymbols.map(sym => ({
      queryKey: ['pm-widget-hub', sym],
      queryFn: () => axios.get(`/api/corporate/hub?ticker=${encodeURIComponent(sym)}`).then(r => r.data as HubData),
      staleTime: 300_000,
      retry: 1,
    })),
  })
  const quoteBySym: Record<string, HubData | undefined> = {}
  equitySymbols.forEach((s, i) => { quoteBySym[s] = quotes[i]?.data })

  const [seedConfirm, setSeedConfirm] = useState(false)
  const seed = useMutation({
    mutationFn: () => axios.post('/api/paper/seed', {
      user_id: user!.id,
      holdings: holdings.map(h => ({ ticker: normalizeTicker(h.ticker), shares: h.shares, avg_cost: h.avgCost })),
    }, { headers: authHeaders }).then(r => r.data),
    onSuccess: () => { setSeedConfirm(false); setSelId(PAPER); qc.invalidateQueries({ queryKey: ['paper-account', user?.id] }) },
    onError: () => setSeedConfirm(false),
  })

  // ── Build rows + totals for whichever source is selected ──
  let rows: Row[]
  let totalValue: number, totalCost: number
  if (isPaper) {
    const eqRows: Row[] = paperEq.map(p => {
      const q = quoteBySym[p.symbol]
      const cost = p.avg_cost * p.quantity
      return {
        key: p.symbol, ticker: p.symbol, label: p.symbol, sub: `${p.quantity} sh`, isOption: false,
        avgCost: p.avg_cost, price: p.price, pct1d: q?.pct_change_1d ?? null, mktCap: q?.market_cap ?? null,
        value: p.market_value, pnl: p.unrealized_pnl, pnlPct: cost > 0 ? (p.unrealized_pnl / cost) * 100 : null,
      }
    })
    const optRows: Row[] = paperOpt.map(p => {
      const cost = p.avg_cost * p.quantity
      return {
        key: p.option_symbol, ticker: p.underlying, label: `${p.underlying} ${p.strike}${p.type === 'call' ? 'C' : 'P'}`, sub: `${p.quantity} ct`, isOption: true,
        avgCost: p.avg_cost, price: p.price * 100, pct1d: null, mktCap: null,
        value: p.market_value, pnl: p.unrealized_pnl, pnlPct: cost > 0 ? (p.unrealized_pnl / cost) * 100 : null,
      }
    })
    rows = [...eqRows, ...optRows]
    totalValue = account.data?.equity ?? 0
    totalCost = [...paperEq, ...paperOpt].reduce((s, p) => s + p.avg_cost * p.quantity, 0)
  } else {
    rows = holdings.map((h, i) => {
      const d = quotes[i]?.data
      const price = d?.current_price ?? null
      const cost = h.avgCost * h.shares
      const value = price != null ? price * h.shares : null
      const pnl = value != null ? value - cost : null
      return {
        key: h.ticker, ticker: h.ticker, label: h.ticker, sub: `${h.shares} sh`, isOption: false,
        avgCost: h.avgCost, price, pct1d: d?.pct_change_1d ?? null, mktCap: d?.market_cap ?? null,
        value, pnl, pnlPct: pnl != null && cost > 0 ? (pnl / cost) * 100 : null,
      }
    })
    totalValue = rows.reduce((s, r) => s + (r.value ?? 0), 0)
    totalCost = holdings.reduce((s, h) => s + h.avgCost * h.shares, 0)
  }
  const totalPnl = isPaper ? rows.reduce((s, r) => s + (r.pnl ?? 0), 0) : totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0
  const loading = isPaper ? account.isLoading : false

  if (!sources.length) return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 14, textAlign: 'center' }}>
      <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11, lineHeight: 1.5 }}>No portfolios yet.<br />Create one in the Portfolio Manager, or sign in to paper-trade.</span>
    </div>
  )

  const TH: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.muted, padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10.5, padding: '5px 8px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
  const subPct = (v: number | null, suffix = '%') => v == null ? null : (
    <span style={{ display: 'block', fontSize: 8.5, color: v >= 0 ? T.pos : T.neg, lineHeight: 1.4 }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}{suffix}</span>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>Source</span>
        <select value={selId} onChange={e => { setSelId(e.target.value); setSeedConfirm(false) }} style={{
          background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: isPaper ? T.gold : T.text,
          fontFamily: T.mono, fontSize: 10.5, padding: '2px 4px', outline: 'none', cursor: 'pointer', flex: 1,
        }}>
          {books.length > 0 && <optgroup label="Portfolio Manager">{books.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
          {authed && <optgroup label="Simulated"><option value={PAPER}>Paper Account</option></optgroup>}
        </select>
        {!isPaper && authed && holdings.length > 0 && (
          <button onClick={() => { if (seedConfirm) seed.mutate(); else { setSeedConfirm(true); setTimeout(() => setSeedConfirm(false), 4000) } }}
            disabled={seed.isPending}
            title="Replace your paper account with this book's holdings at cost, then trade it"
            style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
              border: `1px solid ${seedConfirm ? T.gold : T.border}`, background: seedConfirm ? 'color-mix(in srgb, var(--theme-primary) 14%, transparent)' : 'transparent',
              color: seedConfirm ? T.gold : T.muted, padding: '3px 7px', cursor: 'pointer' }}>
            {seed.isPending ? '…' : seedConfirm ? 'Confirm' : 'Trade on paper'}
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ padding: '7px 10px', borderRight: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>{isPaper ? 'Account Value' : 'Value'}</div>
          <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1 }}>{money(totalValue)}</div>
          {isPaper && account.data && <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, marginTop: 2 }}>{money(account.data.cash)} cash</div>}
        </div>
        <div style={{ padding: '7px 10px' }}>
          <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>Unrealized P&L</div>
          <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: totalPnl >= 0 ? T.pos : T.neg, lineHeight: 1 }}>
            {totalPnl >= 0 ? '+' : ''}{money(totalPnl)} <span style={{ fontSize: 10 }}>({totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(1)}%)</span>
          </div>
          {isPaper && account.data && <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, marginTop: 2 }}>{account.data.realized_pnl >= 0 ? '+' : ''}{money(account.data.realized_pnl)} realized</div>}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>{loading ? 'Loading…' : isPaper ? 'No open positions. Trade them on the chart.' : 'No holdings in this portfolio.'}</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: T.surface, zIndex: 1 }}>
                <th style={{ ...TH, textAlign: 'left' }}>{isPaper ? 'Position' : 'Ticker'}</th>
                <th style={TH}>Avg Cost</th>
                <th style={TH}>Last</th>
                <th style={TH}>Mkt Cap</th>
                <th style={TH}>Value</th>
                <th style={TH}>P&L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ ...TD, textAlign: 'left' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
                      <TickerLogo ticker={r.ticker} size={16} />
                      <span>
                        <span style={{ color: T.gold, fontWeight: 700 }}>{r.label}</span>
                        <span style={{ display: 'block', color: T.muted, fontSize: 8.5, lineHeight: 1.4 }}>{r.sub}</span>
                      </span>
                    </span>
                  </td>
                  <td style={TD}>{money(r.avgCost, 2)}</td>
                  <td style={TD}>
                    {r.price != null ? money(r.price, 2) : '—'}
                    {subPct(r.pct1d)}
                  </td>
                  <td style={{ ...TD, color: T.muted }}>{fmtMarketCap(r.mktCap)}</td>
                  <td style={TD}>{r.value != null ? money(r.value) : '—'}</td>
                  <td style={{ ...TD, color: r.pnl == null ? T.muted : r.pnl >= 0 ? T.pos : T.neg }}>
                    {r.pnl == null ? '—' : `${r.pnl >= 0 ? '+' : ''}${money(r.pnl)}`}
                    {subPct(r.pnlPct)}
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
