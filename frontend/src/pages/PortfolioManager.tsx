import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'rgba(255,255,255,0.08)',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    '#d7e3fc',
  mono:    'JetBrains Mono, monospace',
  label:   'IBM Plex Sans, sans-serif',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

const STORAGE_KEY = 'ft-portfolio-manager'

interface Holding {
  ticker:   string
  shares:   number
  avgCost:  number
}

interface QuoteData {
  current_price:    number
  pct_change_1d:    number | null
  market_cap:       number | null
}

function loadHoldings(): Holding[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}
function saveHoldings(h: Holding[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(h))
}

function fmt(v: number, pre = '', suf = '', d = 2) {
  return `${pre}${v.toFixed(d)}${suf}`
}
function fmtMoney(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

const inp: React.CSSProperties = {
  background: T.surface, border: `1px solid ${T.border}`,
  color: T.text, fontFamily: T.mono, fontSize: 11,
  padding: '5px 8px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

export default function PortfolioManager() {
  const [holdings, setHoldings] = useState<Holding[]>(loadHoldings)
  const [newTicker,  setNewTicker]  = useState('')
  const [newShares,  setNewShares]  = useState('')
  const [newCost,    setNewCost]    = useState('')
  const [editIdx,    setEditIdx]    = useState<number | null>(null)

  useEffect(() => { saveHoldings(holdings) }, [holdings])

  // Fetch live prices for all tickers
  const priceResults = useQueries({
    queries: holdings.map(h => ({
      queryKey: ['pm-quote', h.ticker],
      queryFn:  () => axios.get(`/api/market/quote/${h.ticker}`).then(r => r.data as QuoteData),
      staleTime: 60_000,
      retry: 1,
    })),
  })

  const addHolding = useCallback(() => {
    const ticker  = newTicker.trim().toUpperCase()
    const shares  = parseFloat(newShares)
    const avgCost = parseFloat(newCost)
    if (!ticker || isNaN(shares) || shares <= 0 || isNaN(avgCost) || avgCost <= 0) return
    setHoldings(prev => {
      const existing = prev.findIndex(h => h.ticker === ticker)
      if (existing >= 0) {
        return prev.map((h, i) => i === existing ? { ...h, shares, avgCost } : h)
      }
      return [...prev, { ticker, shares, avgCost }]
    })
    setNewTicker(''); setNewShares(''); setNewCost('')
  }, [newTicker, newShares, newCost])

  const removeHolding = (i: number) => setHoldings(prev => prev.filter((_, j) => j !== i))

  // Import from PortfolioIO
  const handleImport = useCallback((assets: PortfolioAsset[]) => {
    // assets have ticker + weight (0-1 or 0-100); map to holding with weight as placeholder shares
    const imported: Holding[] = assets.map(a => ({
      ticker:  a.ticker,
      shares:  a.weight > 1 ? a.weight : a.weight * 100, // treat weight as share count if imported from CSV
      avgCost: 0,
    }))
    setHoldings(imported)
  }, [])

  // Compute portfolio stats
  let totalValue = 0
  let totalCost  = 0
  const rows = holdings.map((h, i) => {
    const q        = priceResults[i]?.data as QuoteData | undefined
    const price    = q?.current_price ?? 0
    // Auto-fill avg cost from current price when user didn't enter one
    const avgCost  = h.avgCost > 0 ? h.avgCost : price
    const costIsAuto = h.avgCost <= 0 && price > 0
    const value    = h.shares * price
    const cost     = h.shares * avgCost
    const pnl      = costIsAuto ? 0 : value - cost
    const pnlPct   = costIsAuto ? 0 : (cost > 0 ? (pnl / cost) * 100 : null)
    if (price > 0) totalValue += value
    if (cost > 0) totalCost += cost
    return { ...h, avgCost, costIsAuto, price, value, cost, pnl, pnlPct, loading: priceResults[i]?.isLoading, pct1d: q?.pct_change_1d }
  })
  const totalPnl    = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null

  const lbl: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }

  return (
    <PageWrapper>
      <div style={{ maxWidth: 1050, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.gold, letterSpacing: '0.08em', margin: 0 }}>
            PORTFOLIO MANAGER
          </h1>
          <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, marginTop: 6 }}>
            Track holdings by shares and cost basis. Import from CSV or JSON.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 24, alignItems: 'start' }}>

          {/* ── Left panel ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Add holding */}
            <div>
              <div style={{ ...lbl, marginBottom: 10 }}>Add / Update Holding</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())}
                  placeholder="Ticker (e.g. AAPL)" style={inp}
                  onKeyDown={e => e.key === 'Enter' && addHolding()} />
                <input value={newShares} onChange={e => setNewShares(e.target.value)}
                  placeholder="Shares" type="number" min="0" style={inp}
                  onKeyDown={e => e.key === 'Enter' && addHolding()} />
                <input value={newCost} onChange={e => setNewCost(e.target.value)}
                  placeholder="Avg Cost ($)" type="number" min="0" style={inp}
                  onKeyDown={e => e.key === 'Enter' && addHolding()} />
                <button onClick={addHolding} style={{
                  background: T.gold, border: 'none', color: '#0a1220',
                  fontFamily: T.label, fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  padding: '7px 0', cursor: 'pointer',
                }}>
                  Add
                </button>
              </div>
            </div>

            {/* Import / Export */}
            <div>
              <div style={{ ...lbl, marginBottom: 10 }}>Import / Export</div>
              <PortfolioIO
                mode="portfolio"
                assets={holdings.map(h => ({ ticker: h.ticker, weight: h.shares, strategy: String(h.avgCost) }))}
                onImportAssets={handleImport}
                name="portfolio"
              />
              <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                CSV format: <span style={{ fontFamily: T.mono }}>TICKER,SHARES,AVG_COST</span><br />
                JSON: array of <span style={{ fontFamily: T.mono }}>{`{ticker, weight, strategy}`}</span>
              </p>
            </div>

            {/* Summary card */}
            {holdings.length > 0 && (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
                <div style={{ ...lbl, marginBottom: 12 }}>Summary</div>
                {[
                  ['Total Value',    fmtMoney(totalValue)],
                  ['Total Cost',     fmtMoney(totalCost)],
                  ['Total P&L',      fmtMoney(totalPnl)],
                  ['Return',         totalPnlPct != null ? `${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%` : '—'],
                  ['Positions',      String(holdings.length)],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontFamily: T.label, fontSize: 10, color: T.muted }}>{k}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: k === 'Total P&L' || k === 'Return' ? (totalPnl >= 0 ? T.pos : T.neg) : T.text }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Holdings table ── */}
          <div>
            {holdings.length === 0 ? (
              <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11 }}>
                Add a holding or import a portfolio file
              </div>
            ) : (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                      {['Ticker', 'Shares', 'Avg Cost', 'Price', '1D %', 'Value', 'P&L', 'Return', 'Weight', ''].map(h => (
                        <th key={h} style={{ padding: '7px 12px', textAlign: h === 'Ticker' ? 'left' : 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const weight = totalValue > 0 ? (r.value / totalValue) * 100 : 0
                      return (
                        <tr key={r.ticker} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                          <td style={{ padding: '8px 12px', color: T.gold, fontFamily: T.mono, fontWeight: 700, fontSize: 10, letterSpacing: '0.08em' }}>{r.ticker}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{r.shares.toLocaleString()}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : T.text }}>
                            {r.loading ? '…' : r.avgCost > 0 ? `$${r.avgCost.toFixed(2)}${r.costIsAuto ? '*' : ''}` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{r.loading ? '…' : r.price > 0 ? `$${r.price.toFixed(2)}` : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.pct1d == null ? T.muted : r.pct1d >= 0 ? T.pos : T.neg }}>
                            {r.loading ? '…' : r.pct1d != null ? `${r.pct1d >= 0 ? '+' : ''}${r.pct1d.toFixed(2)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text, fontWeight: 600 }}>{r.loading ? '…' : r.price > 0 ? fmtMoney(r.value) : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : r.price > 0 ? (r.pnl >= 0 ? T.pos : T.neg) : T.muted, fontWeight: 600 }}>
                            {r.loading ? '…' : r.costIsAuto ? '—' : r.price > 0 ? `${r.pnl >= 0 ? '+' : ''}${fmtMoney(r.pnl)}` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : r.pnlPct == null ? T.muted : r.pnlPct >= 0 ? T.pos : T.neg }}>
                            {r.loading ? '…' : r.costIsAuto ? '—' : r.pnlPct != null ? `${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>
                            {r.loading ? '…' : totalValue > 0 && r.price > 0 ? `${weight.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                            <button onClick={() => removeHolding(i)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {/* Auto-cost footnote */}
                {rows.some(r => r.costIsAuto) && (
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    * avg cost auto-filled from current price — enter your actual cost basis to see P&L
                  </div>
                )}

                {/* Weight bar */}
                {totalValue > 0 && (
                  <div style={{ display: 'flex', height: 4, overflow: 'hidden' }}>
                    {rows.map((r, i) => {
                      const w = (r.value / totalValue) * 100
                      const colors = ['#c9a84c','#60a5fa','#22c55e','#ef4444','#a78bfa','#f97316','#38bdf8','#fb923c','#4ade80','#f472b6','#facc15']
                      return <div key={r.ticker} style={{ width: `${w}%`, background: colors[i % colors.length], transition: 'width 0.3s' }} />
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Allocation visual */}
            {rows.length > 0 && totalValue > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {rows.map((r, i) => {
                  const w = (r.value / totalValue) * 100
                  const colors = ['#c9a84c','#60a5fa','#22c55e','#ef4444','#a78bfa','#f97316','#38bdf8','#fb923c','#4ade80','#f472b6','#facc15']
                  return (
                    <div key={r.ticker} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: colors[i % colors.length], flexShrink: 0 }} />
                      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>{r.ticker} {w.toFixed(1)}%</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}
