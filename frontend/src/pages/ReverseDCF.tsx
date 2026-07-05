import { useState, useRef, useLayoutEffect } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, HINT, SIDEBAR, SECTION, RailSection, PRIMARY_BTN, GHOST_BTN, READOUT_ROW, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TOOLTIP_CURSOR, TICK, PANEL, STACK, fmtM, ChartPanel, LabeledPanel, VerdictStrip, type VerdictTone } from './valuationShared'

const MONO = 'var(--theme-mono)', SANS = 'var(--theme-sans)'
const TXT = 'var(--theme-text, #d7e3fc)', SEC = 'var(--theme-secondary, #99907e)', GOLD = 'var(--theme-primary, #c9a84c)'
const NEG = 'var(--theme-negative, #ef4444)', TER = 'var(--theme-tertiary, #60a5fa)'
const HAIR = '1px solid var(--theme-border, rgba(255,255,255,0.08))'

// Element width via ResizeObserver, so the hand-built SVG stays crisp (no
// viewBox scaling of strokes/text).
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el); return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

// Horizontal 0→scale demand track split into undemanding / reasonable /
// demanding zones, with current-growth and implied-growth markers.
function DemandGauge({ current, implied, verdict }: { current: number | null; implied: number; verdict?: string | null }) {
  const scale = Math.max(35, Math.ceil((Math.max(implied, current ?? 0) + 3) / 5) * 5)
  const pct = (v: number) => Math.max(0, Math.min(100, (v / scale) * 100))
  const b10 = pct(10), b20 = pct(20)
  const implColor = verdict === 'demanding' ? NEG : verdict === 'undemanding' ? 'var(--theme-positive, #22c55e)' : GOLD
  return (
    <div style={{ paddingTop: 16 }}>
      <div style={{ position: 'relative', height: 0 }}>
        {current != null && <span style={{ position: 'absolute', top: -14, left: `${pct(current)}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 9, color: TXT }}>current {current.toFixed(1)}%</span>}
        <span style={{ position: 'absolute', top: -14, left: `${pct(implied)}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 9, color: implColor }}>implied {implied.toFixed(1)}%</span>
      </div>
      <div style={{ position: 'relative', height: 22, display: 'flex', border: HAIR }}>
        <div style={{ width: `${b10}%`, background: 'rgba(47,107,75,0.45)' }} />
        <div style={{ width: `${b20 - b10}%`, background: 'rgba(201,168,76,0.40)' }} />
        <div style={{ flex: 1, background: 'rgba(140,46,54,0.45)' }} />
        {current != null && <div style={{ position: 'absolute', top: -3, bottom: -3, left: `${pct(current)}%`, width: 2, marginLeft: -1, background: TXT }} />}
        <div style={{ position: 'absolute', top: -3, bottom: -3, left: `${pct(implied)}%`, width: 2, marginLeft: -1, background: implColor }} />
      </div>
      <div style={{ position: 'relative', height: 12, marginTop: 6, fontFamily: SANS, fontSize: 9, letterSpacing: '0.04em', color: SEC }}>
        <span style={{ position: 'absolute', left: `${b10 / 2}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>Undemanding · &lt;10%</span>
        <span style={{ position: 'absolute', left: `${(b10 + b20) / 2}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>Reasonable · 10–20%</span>
        <span style={{ position: 'absolute', left: `${(b20 + 100) / 2}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>Demanding · &gt;20%</span>
      </div>
    </div>
  )
}

// Two revenue trajectories from the same TTM revenue: what the price implies vs
// the current run-rate, with the gap between them shaded.
function ExpectationGap({ rev0, impliedG, currentG, years }: { rev0: number; impliedG: number; currentG: number; years: number }) {
  const [ref, w] = useWidth()
  const H = 172, PADL = 6, PADR = 52, PADT = 20, PADB = 8
  const impl = Array.from({ length: years + 1 }, (_, t) => rev0 * Math.pow(1 + impliedG / 100, t))
  const curr = Array.from({ length: years + 1 }, (_, t) => rev0 * Math.pow(1 + currentG / 100, t))
  const yMax = Math.max(...impl, ...curr), yMin = Math.min(...impl, ...curr, rev0), spanY = (yMax - yMin) || 1
  const innerW = Math.max(0, w - PADL - PADR), innerH = H - PADT - PADB
  const X = (t: number) => PADL + (years === 0 ? 0 : t / years) * innerW
  const Y = (v: number) => PADT + (1 - (v - yMin) / spanY) * innerH
  const implPts = impl.map((v, t) => [X(t), Y(v)])
  const currPts = curr.map((v, t) => [X(t), Y(v)])
  const line = (pts: number[][]) => pts.map(p => p.join(',')).join(' ')
  const gap = `M ${implPts.map(p => p.join(' ')).join(' L ')} L ${[...currPts].reverse().map(p => p.join(' ')).join(' L ')} Z`
  return (
    <div style={{ height: '100%' }}>
      <div ref={ref} style={{ width: '100%' }}>
        {w > 0 && (
          <svg width={w} height={H} style={{ display: 'block' }}>
            <path d={gap} fill={NEG} fillOpacity={0.1} />
            <polyline points={line(currPts)} fill="none" stroke={TER} strokeWidth={2} />
            <polyline points={line(implPts)} fill="none" stroke={NEG} strokeWidth={2} />
            {currPts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={2.5} fill={TER} />)}
            {implPts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={2.5} fill={NEG} />)}
            <text x={implPts[years][0] + 5} y={implPts[years][1] - 4} fontFamily={MONO} fontSize={9} fill={NEG}>{fmtM(impl[years])}</text>
            <text x={currPts[years][0] + 5} y={currPts[years][1] + 11} fontFamily={MONO} fontSize={9} fill={TER}>{fmtM(curr[years])}</text>
          </svg>
        )}
      </div>
      <div style={{ display: 'flex', gap: 18, justifyContent: 'center', marginTop: 2, fontFamily: SANS, fontSize: 9, color: SEC }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 12, height: 2, background: NEG }} />Price demands · {impliedG.toFixed(1)}%</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 12, height: 2, background: TER }} />Current run-rate · {currentG.toFixed(1)}%</span>
      </div>
    </div>
  )
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
  pre_profit?: boolean
  assumed_target_margin?: number | null
}

export function ReverseDCFContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [inputsOpen, setInputsOpen] = useState(true)
  const [marketPrice, setMarketPrice] = useState<number | ''>('')
  const [opMargin, setOpMargin] = useState(20)
  const [targetMargin, setTargetMargin] = useState(12)
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
      const effMargin = useLoaded ? opMargin : (f.op_margin ?? opMargin)
      const body = {
        ticker: ticker.trim().toUpperCase(),
        revenue: f.revenue, op_margin: effMargin,
        target_margin: effMargin < 0 ? targetMargin : null,
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

  return (
    <SidebarLayout sidebarWidth={232} sidebarTitle="" sidebar={
      <RailSection title="Reverse DCF Inputs" open={inputsOpen} onToggle={() => setInputsOpen(o => !o)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={LABEL}>Ticker</label>
          <TickerInput style={INPUT} value={ticker} onChange={setTicker} onEnter={() => loadAndSolve(false)} placeholder="Ticker or company" />
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
            {opMargin < 0 && (
              <div>
                <label style={LABEL}>Maturity margin (%)</label>
                <input style={INPUT} type="number" value={targetMargin} onChange={e => setTargetMargin(Number(e.target.value))} />
                <div style={HINT}>This company runs at a loss. Margin is ramped from {opMargin.toFixed(1)}% to this target over the projection so cash flow can turn positive.</div>
              </div>
            )}
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
      </RailSection>
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
          {data.pre_profit && data.note && (
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: 'var(--theme-text-dim, #8aa0c2)', lineHeight: 1.6, padding: '10px 12px', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderRadius: 6, background: 'var(--theme-bg, #101c2e)' }}>
              {data.note}
            </div>
          )}
          {(() => {
            const vlabel = data.verdict === 'demanding' ? 'Demanding' : data.verdict === 'undemanding' ? 'Undemanding' : data.verdict === 'in-line' ? 'In-line' : 'Implied growth'
            const vtone: VerdictTone = data.verdict === 'demanding' ? 'neg' : data.verdict === 'undemanding' ? 'pos' : 'gold'
            return (
              <div style={PANEL}>
                <VerdictStrip
                  primary={{ label: vlabel, value: `${implied.toFixed(1)}%`, tone: vtone, context: `Revenue growth the price implies · solved at $${data.market_price.toFixed(2)}`, contextTone: 'muted' }}
                  cells={[
                    { label: 'Current Growth', value: data.current_growth != null ? `${data.current_growth.toFixed(1)}%` : 'n/a' },
                    { label: 'Growth Gap', value: data.growth_gap != null ? `${data.growth_gap > 0 ? '+' : ''}${data.growth_gap.toFixed(1)} pts` : 'n/a', tone: (data.growth_gap ?? 0) <= 0 ? 'pos' : 'neg' },
                    { label: 'Price Solved', value: `$${data.market_price.toFixed(2)}` },
                  ]}
                />
              </div>
            )
          })()}

          {/* Demand gauge */}
          <LabeledPanel title="Demand gauge">
            <DemandGauge current={data.current_growth} implied={implied} verdict={data.verdict} />
          </LabeledPanel>

          {/* Two-up: the expectation gap + the implied FCF path */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <ChartPanel title="The expectation gap" height={200}>
                {funda?.revenue && data.current_growth != null
                  ? <ExpectationGap rev0={funda.revenue} impliedG={implied} currentG={data.current_growth} years={years} />
                  : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 11, color: SEC }}>Current growth unavailable</div>}
              </ChartPanel>
            </div>
            {data.fcfs && data.fcfs.length > 0 && (
              <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                <ChartPanel title="Implied free cash flow path" height={200}>
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
              </div>
            )}
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function ReverseDCF() {
  return <PageWrapper title="Reverse DCF"><ReverseDCFContent /></PageWrapper>
}
