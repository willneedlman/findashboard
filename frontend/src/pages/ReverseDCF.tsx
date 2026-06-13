import { useState } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'

const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}
const TOOLTIP_STYLE = { background: 'var(--theme-surface, #142032)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderRadius: 0 }
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

function fmtM(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}T`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(1)}B`
  return `$${v.toFixed(0)}M`
}

type Reverse = {
  implied_growth: number | null
  market_price: number
  intrinsic_per_share?: number
  current_growth: number | null
  growth_gap?: number | null
  verdict?: 'demanding' | 'undemanding' | 'in-line' | null
  enterprise_value?: number
  equity_value?: number
  fcfs?: { year: number; revenue: number; fcf: number; pv_fcf: number }[]
  note?: string
}

const VERDICT_COPY: Record<string, { label: string; color: string; blurb: string }> = {
  demanding:   { label: 'Demanding',   color: '#f85149', blurb: 'The price bakes in materially faster growth than the company is currently delivering. Expectations are high.' },
  'in-line':   { label: 'In line',     color: '#c9a84c', blurb: 'The price implies roughly the growth the company is already running. Expectations look reasonable.' },
  undemanding: { label: 'Undemanding', color: '#3fb950', blurb: 'The price implies slower growth than the company is currently delivering. Expectations are conservative.' },
}

export function ReverseDCFContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [marketPrice, setMarketPrice] = useState<number | ''>('')
  const [opMargin, setOpMargin] = useState(20)
  const [wacc, setWacc] = useState(9)
  const [termGrowth, setTermGrowth] = useState(2.5)
  const [years, setYears] = useState(5)
  // fixed fundamentals carried from the load, not user-tuned here
  const [funda, setFunda] = useState<any>(null)
  const [data, setData] = useState<Reverse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadAndSolve(useLoaded = false) {
    setLoading(true); setError(null)
    try {
      let f = funda
      if (!useLoaded || !f) {
        const res = await axios.get(`/api/dcf/fundamentals?ticker=${ticker.trim().toUpperCase()}`)
        f = res.data
        setFunda(f)
        if (f.op_margin != null) setOpMargin(Math.round(f.op_margin * 10) / 10)
        if (f.market_price) setMarketPrice(Math.round(f.market_price * 100) / 100)
      }
      const price = (useLoaded && marketPrice !== '') ? Number(marketPrice) : (f.market_price ?? Number(marketPrice))
      if (!price || price <= 0) { setError('No market price available. Enter one manually.'); setLoading(false); return }
      const body = {
        ticker: ticker.trim().toUpperCase(),
        revenue: f.revenue, op_margin: useLoaded ? opMargin : (f.op_margin ?? opMargin),
        wacc, terminal_growth: termGrowth, years,
        shares: f.shares, net_debt: f.net_debt, tax_rate: f.tax_rate ?? 21,
        capex_pct: f.capex_pct ?? 5, da_pct: f.da_pct ?? 4,
        market_price: price, current_growth: f.rev_growth ?? null,
      }
      const res = await axios.post('/api/dcf/reverse', body)
      setData(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not run the reverse DCF.')
    } finally {
      setLoading(false)
    }
  }

  const implied = data?.implied_growth
  const verdict = data?.verdict ? VERDICT_COPY[data.verdict] : null

  return (
    <SidebarLayout sidebarWidth={220} sidebarTitle="Reverse DCF Inputs" sidebar={<>
      <div style={{ marginBottom: 12 }}>
        <label style={LABEL}>Ticker</label>
        <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadAndSolve(false)} placeholder="AAPL" />
      </div>
      <button onClick={() => loadAndSolve(false)} disabled={loading}
        style={{ ...INPUT, width: '100%', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--theme-primary, #c9a84c)', borderColor: 'var(--theme-primary, #c9a84c)', marginBottom: 16 }}>
        {loading ? 'Solving…' : 'Load & Solve'}
      </button>

      {funda && <>
        <div style={{ marginBottom: 10 }}>
          <label style={LABEL}>Market price ($)</label>
          <input style={INPUT} type="number" value={marketPrice}
            onChange={e => setMarketPrice(e.target.value === '' ? '' : Number(e.target.value))} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={LABEL}>Operating margin (%)</label>
          <input style={INPUT} type="number" value={opMargin} onChange={e => setOpMargin(Number(e.target.value))} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={LABEL}>WACC (%)</label>
          <input style={INPUT} type="number" value={wacc} onChange={e => setWacc(Number(e.target.value))} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={LABEL}>Terminal growth (%)</label>
          <input style={INPUT} type="number" value={termGrowth} onChange={e => setTermGrowth(Number(e.target.value))} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={LABEL}>Projection years</label>
          <input style={INPUT} type="number" min={3} max={10} value={years} onChange={e => setYears(Number(e.target.value))} />
        </div>
        <button onClick={() => loadAndSolve(true)} disabled={loading}
          style={{ ...INPUT, width: '100%', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Re-solve
        </button>
        <div style={{ marginTop: 14, fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #99907e)', lineHeight: 1.7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Revenue (TTM)</span><span>{fmtM(funda.revenue)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Shares</span><span>{funda.shares?.toFixed(0)}M</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Net debt</span><span>{fmtM(funda.net_debt)}</span></div>
          {funda.rev_growth != null && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Current growth</span><span>{funda.rev_growth.toFixed(1)}%</span></div>}
        </div>
      </>}
    </>}>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Reverse DCF" hint="Enter a ticker and Load & Solve to back out the revenue growth the market price is pricing in." />
      )}

      {data && implied == null && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7 }}>
          {data.note || 'No solution found in a plausible growth range. Try adjusting the margin, WACC, or terminal-growth assumptions.'}
        </div>
      )}

      {data && implied != null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <MetricCard label="Market-implied growth" value={`${implied.toFixed(1)}%`} />
            <MetricCard label="Current growth" value={data.current_growth != null ? `${data.current_growth.toFixed(1)}%` : 'n/a'} />
            <MetricCard label="Growth gap" value={data.growth_gap != null ? `${data.growth_gap > 0 ? '+' : ''}${data.growth_gap.toFixed(1)} pts` : 'n/a'} />
            <MetricCard label="Market price" value={`$${data.market_price.toFixed(2)}`} />
          </div>

          {verdict && (
            <div style={{ border: `1px solid ${verdict.color}55`, background: `${verdict.color}11`, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: verdict.color }}>
                  Expectations: {verdict.label}
                </span>
              </div>
              <p style={{ margin: 0, fontFamily: 'var(--theme-mono)', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-text, #d7e3fc)' }}>
                At ${data.market_price.toFixed(2)}, the market is pricing in {implied.toFixed(1)}% annual revenue growth over the next {years} years. {verdict.blurb}
              </p>
            </div>
          )}

          {data.fcfs && data.fcfs.length > 0 && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '28px 8px 8px', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
                Implied free cash flow path
              </div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data.fcfs}>
                    <CartesianGrid strokeDasharray="2 4" stroke="var(--theme-border, rgba(255,255,255,0.08))" />
                    <XAxis dataKey="year" tick={TICK} tickFormatter={(y) => `Y${y}`} />
                    <YAxis tick={TICK} tickFormatter={(v) => fmtM(v)} width={56} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => fmtM(v)} labelFormatter={(y) => `Year ${y}`} />
                    <Bar dataKey="fcf" name="FCF" radius={[2, 2, 0, 0]}>
                      {data.fcfs.map((_, i) => <Cell key={i} fill={cc.c1} />)}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}
    </SidebarLayout>
  )
}

export default function ReverseDCF() {
  return <PageWrapper title="Reverse DCF"><ReverseDCFContent /></PageWrapper>
}
