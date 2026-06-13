import { useState } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, HINT, SIDEBAR, SECTION, PRIMARY_BTN, GHOST_BTN, READOUT_ROW, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TOOLTIP_CURSOR, TICK, METRIC_GRID, STACK, fmtM, ChartPanel } from './valuationShared'

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
  demanding:   { label: 'Demanding',   color: '#f85149', blurb: 'That is materially faster than the company is currently growing, so the price leaves little room for error.' },
  'in-line':   { label: 'In line',     color: '#c9a84c', blurb: 'That is roughly the pace the company is already running, so expectations look reasonable.' },
  undemanding: { label: 'Undemanding', color: '#3fb950', blurb: 'That is slower than the company is currently growing, so expectations look conservative.' },
}

export function ReverseDCFContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [marketPrice, setMarketPrice] = useState<number | ''>('')
  const [opMargin, setOpMargin] = useState(20)
  const [wacc, setWacc] = useState(9)
  const [termGrowth, setTermGrowth] = useState(2.5)
  const [years, setYears] = useState(5)
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
    <SidebarLayout sidebarWidth={232} sidebarTitle="Reverse DCF Inputs" sidebar={
      <div style={SIDEBAR}>
        <div>
          <label style={LABEL}>Ticker</label>
          <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && loadAndSolve(false)} placeholder="AAPL" />
          <button onClick={() => loadAndSolve(false)} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'Solving…' : 'Load & Solve'}
          </button>
        </div>

        {funda && <>
          <div>
            <label style={LABEL}>Price to solve against</label>
            <input style={INPUT} type="number" value={marketPrice}
              onChange={e => setMarketPrice(e.target.value === '' ? '' : Number(e.target.value))} />
            <div style={HINT}>Auto-filled with the live price. Change it to test a different entry point.</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={SECTION}>Assumptions</div>
            <div>
              <label style={LABEL}>Operating margin (%)</label>
              <input style={INPUT} type="number" value={opMargin} onChange={e => setOpMargin(Number(e.target.value))} />
            </div>
            <div>
              <label style={LABEL}>Discount rate / WACC (%)</label>
              <input style={INPUT} type="number" value={wacc} onChange={e => setWacc(Number(e.target.value))} />
            </div>
            <div>
              <label style={LABEL}>Terminal growth (%)</label>
              <input style={INPUT} type="number" value={termGrowth} onChange={e => setTermGrowth(Number(e.target.value))} />
            </div>
            <div>
              <label style={LABEL}>Projection years</label>
              <input style={INPUT} type="number" min={3} max={10} value={years} onChange={e => setYears(Number(e.target.value))} />
            </div>
          </div>

          <button onClick={() => loadAndSolve(true)} disabled={loading} style={GHOST_BTN}>Re-solve</button>

          <div style={{ paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={READOUT_ROW}><span>Revenue (TTM)</span><span>{fmtM(funda.revenue)}</span></div>
            <div style={READOUT_ROW}><span>Shares</span><span>{funda.shares?.toFixed(0)}M</span></div>
            <div style={READOUT_ROW}><span>Net debt</span><span>{fmtM(funda.net_debt)}</span></div>
            {funda.rev_growth != null && <div style={READOUT_ROW}><span>Current growth</span><span>{funda.rev_growth.toFixed(1)}%</span></div>}
          </div>
        </>}
      </div>
    }>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Reverse DCF"
          hint="A reverse DCF flips a normal DCF around. Instead of guessing growth to get a value, it solves for the revenue growth rate the current price already implies, holding margins fixed. Enter a ticker and Load & Solve." />
      )}

      {data && implied == null && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7 }}>
          {data.note || 'No solution found in a plausible growth range. Try adjusting the margin, WACC, or terminal-growth assumptions.'}
        </div>
      )}

      {data && implied != null && (
        <div style={STACK}>
          <p style={{ margin: 0, fontFamily: 'var(--theme-mono)', fontSize: 13.5, lineHeight: 1.6, color: 'var(--theme-text, #d7e3fc)' }}>
            To justify today's <b style={{ color: 'var(--theme-primary, #c9a84c)' }}>${data.market_price.toFixed(2)}</b> price at a {opMargin.toFixed(1)}% operating margin and {wacc}% discount rate,
            revenue must grow <b style={{ color: 'var(--theme-primary, #c9a84c)' }}>{implied.toFixed(1)}% a year</b> for {years} years.
          </p>

          <div style={METRIC_GRID}>
            <MetricCard label="Implied revenue growth" value={`${implied.toFixed(1)}%`} help="Annual revenue growth the price implies, with margins held constant" />
            <MetricCard label="Current growth" value={data.current_growth != null ? `${data.current_growth.toFixed(1)}%` : 'n/a'} />
            <MetricCard label="Growth gap" value={data.growth_gap != null ? `${data.growth_gap > 0 ? '+' : ''}${data.growth_gap.toFixed(1)} pts` : 'n/a'} deltaPositive={(data.growth_gap ?? 0) <= 0} />
            <MetricCard label="Price solved against" value={`$${data.market_price.toFixed(2)}`} />
          </div>

          {verdict && (
            <div style={{ border: `1px solid ${verdict.color}55`, background: `${verdict.color}11`, padding: '12px 14px' }}>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: verdict.color, marginBottom: 6 }}>
                Expectations: {verdict.label}
              </div>
              <p style={{ margin: 0, fontFamily: 'var(--theme-mono)', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-text, #d7e3fc)' }}>
                The market implies {implied.toFixed(1)}% growth versus the {data.current_growth != null ? `${data.current_growth.toFixed(1)}%` : 'rate'} the company is currently running. {verdict.blurb}
              </p>
            </div>
          )}

          {data.fcfs && data.fcfs.length > 0 && (
            <ChartPanel title="Implied free cash flow path">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data.fcfs}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--theme-border, rgba(255,255,255,0.08))" />
                  <XAxis dataKey="year" tick={TICK} tickFormatter={(y) => `Y${y}`} />
                  <YAxis tick={TICK} tickFormatter={(v) => fmtM(v)} width={56} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR} formatter={(v: number) => fmtM(v)} labelFormatter={(y) => `Year ${y}`} />
                  <Bar dataKey="fcf" name="FCF" radius={[2, 2, 0, 0]}>
                    {data.fcfs.map((_, i) => <Cell key={i} fill={cc.c1} />)}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </ChartPanel>
          )}
        </div>
      )}
    </SidebarLayout>
  )
}

export default function ReverseDCF() {
  return <PageWrapper title="Reverse DCF"><ReverseDCFContent /></PageWrapper>
}
