import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { useChartColors } from '../hooks/useChartColors'
import {
  INPUT, LABEL, HINT, RailSection, VerdictStrip, PANEL, ChartPanel, TH, TD,
  fmtM, upsidePrimary, type VerdictTone,
} from './valuationShared'

type Stage = { years: number; growth: number }
type Curve = { start_pct: number; end_pct: number }

type WaccBuild = {
  wacc: number; mode: 'auto' | 'manual'; risk_free: number | null; cost_of_equity: number | null
  cost_of_debt: number | null; beta: number | null; equity_weight: number | null; debt_weight: number | null
}

type YearRow = {
  year: number; revenue: number; growth: number; margin: number
  capex_pct: number; da_pct: number; wc_pct: number; ebit: number; fcf: number; pv_fcf: number
}

type DCFResult = {
  fcfs: YearRow[]; total_years: number; pv_fcfs: number; terminal_value: number
  enterprise_value: number; equity_value: number; intrinsic_per_share: number; wacc_build: WaccBuild
}

const MAX_HORIZON = 20
const DEFAULT_STAGES: Stage[] = [{ years: 3, growth: 15 }, { years: 4, growth: 10 }, { years: 3, growth: 5 }]

function CurveRow({ label, curve, onChange, focus, blur }: {
  label: string; curve: Curve; onChange: (c: Curve) => void
  focus: (e: React.FocusEvent<HTMLInputElement>) => void; blur: (e: React.FocusEvent<HTMLInputElement>) => void
}) {
  return (
    <div>
      <label style={LABEL}>{label} — Start % → End %</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="number" step={0.25} style={INPUT} value={curve.start_pct} onFocus={focus} onBlur={blur}
          onChange={e => onChange({ ...curve, start_pct: +e.target.value })} />
        <input type="number" step={0.25} style={INPUT} value={curve.end_pct} onFocus={focus} onBlur={blur}
          onChange={e => onChange({ ...curve, end_pct: +e.target.value })} />
      </div>
    </div>
  )
}

export function DCFValuationContent() {
  const cc = useChartColors()
  const [searchParams, setSearchParams] = useSearchParams()
  const [ticker, setTickerRaw] = useState(searchParams.get('ticker') || 'AAPL')
  const setTicker = (v: string) => { setTickerRaw(v); setSearchParams(p => { p.set('ticker', v); return p }) }
  const [fetching, setFetching] = useState(false)
  const [betaInfo, setBetaInfo] = useState<{ beta: number; source: string } | null>(null)
  const [marketPrice, setMarketPrice] = useState<number | null>(null)

  const [revenue, setRevenue] = useState(0)
  const [opMargin, setOpMargin] = useState(15)
  const [targetMargin, setTargetMargin] = useState(15)
  const [shares, setShares] = useState(100)
  const [netDebt, setNetDebt] = useState(0)
  const [taxRate, setTaxRate] = useState(21)
  const [terminalGrowth, setTerminalGrowth] = useState(2.5)

  const [stages, setStages] = useState<Stage[]>(DEFAULT_STAGES)
  const [capex, setCapex] = useState<Curve>({ start_pct: 5, end_pct: 5 })
  const [da, setDa] = useState<Curve>({ start_pct: 4, end_pct: 4 })
  const [wc, setWc] = useState<Curve>({ start_pct: 0.5, end_pct: 0.5 })

  const [waccMode, setWaccMode] = useState<'auto' | 'manual'>('auto')
  const [waccManual, setWaccManual] = useState(10)
  const [erp, setErp] = useState(5.5)
  const [debtSpread, setDebtSpread] = useState(2.0)

  const [paramsOpen, setParamsOpen] = useState(true)
  const [stagesOpen, setStagesOpen] = useState(true)
  const [capitalOpen, setCapitalOpen] = useState(true)
  const [waccOpen, setWaccOpen] = useState(true)

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')

  const totalYears = stages.reduce((s, st) => s + (st.years || 0), 0)
  const horizonOk = totalYears > 0 && totalYears <= MAX_HORIZON

  const addStage = () => setStages(s => [...s, { years: 2, growth: 5 }])
  const removeStage = (i: number) => setStages(s => s.length > 1 ? s.filter((_, j) => j !== i) : s)
  const updateStage = (i: number, patch: Partial<Stage>) => setStages(s => s.map((st, j) => j === i ? { ...st, ...patch } : st))

  const autoFill = async () => {
    setFetching(true)
    try {
      const { data: f } = await axios.get(`/api/dcf/fundamentals?ticker=${ticker}`)
      setRevenue(f.revenue)
      setOpMargin(f.op_margin)
      setTargetMargin(f.op_margin >= 0 ? f.op_margin : 15)
      setShares(f.shares)
      setNetDebt(f.net_debt)
      setTaxRate(f.tax_rate)
      setCapex({ start_pct: f.capex_pct, end_pct: f.capex_pct })
      setDa({ start_pct: f.da_pct, end_pct: f.da_pct })
      setWc({ start_pct: f.wc_pct ?? 0.5, end_pct: (f.wc_pct ?? 0.5) * 0.5 })
      const g = Math.min(f.rev_growth ?? 10, 35)
      setStages([
        { years: 3, growth: Math.round(g * 10) / 10 },
        { years: 4, growth: Math.round(g * 0.6 * 10) / 10 },
        { years: 3, growth: Math.round(g * 0.3 * 10) / 10 },
      ])
      setBetaInfo(f.beta != null ? { beta: f.beta, source: f.assumptions_source ?? 'unknown' } : null)
      setMarketPrice(f.market_price ?? null)
    } catch (e) { console.error('Fetch failed:', e) }
    setFetching(false)
  }

  const { mutate: calculate, data, isPending, isError } = useMutation<DCFResult>({
    mutationFn: async () => {
      const body = {
        ticker, revenue, op_margin: opMargin, target_margin: targetMargin, shares,
        net_debt: netDebt, tax_rate: taxRate, stages, capex, da, wc, terminal_growth: terminalGrowth,
        wacc: waccMode === 'manual' ? waccManual : undefined,
        equity_risk_premium: erp, cost_of_debt_spread: debtSpread,
      }
      const { data } = await axios.post('/api/dcf/value', body)
      return data
    },
  })

  const canRun = revenue > 0 && shares > 0 && horizonOk

  return (
    <SidebarLayout sidebarWidth={230} sidebarTitle="" sidebar={<>
      <RailSection title="Ticker & Fundamentals" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={LABEL}>Ticker</label>
            <TickerInput style={INPUT} value={ticker} onChange={setTicker} onEnter={autoFill}
              onFocus={focus} onBlur={blur} placeholder="Ticker or company" />
            <button onClick={autoFill} disabled={fetching} style={{
              marginTop: 6, width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
              color: 'var(--theme-secondary, #99907e)', fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', padding: '5px 0', cursor: fetching ? 'default' : 'pointer', opacity: fetching ? 0.6 : 1,
            }}>
              {fetching ? 'Loading…' : 'Fetch Fundamentals'}
            </button>
          </div>

          <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {([
              ['Base Revenue ($M)', revenue, setRevenue, 1000],
              ['Op. Margin % (Current)', opMargin, setOpMargin, 0.5],
              ['Target Margin % (Final Yr)', targetMargin, setTargetMargin, 0.5],
              ['Shares (M)', shares, setShares, 10],
              ['Net Debt ($M)', netDebt, setNetDebt, 100],
              ['Tax Rate %', taxRate, setTaxRate, 0.5],
              ['Terminal Growth %', terminalGrowth, setTerminalGrowth, 0.25],
            ] as [string, number, (v: number) => void, number][]).map(([label, val, set, step]) => (
              <div key={label}>
                <label style={LABEL}>{label}</label>
                <input type="number" style={INPUT} value={val} step={step} onFocus={focus} onBlur={blur}
                  onChange={e => set(+e.target.value)} />
              </div>
            ))}
          </div>
        </div>
      </RailSection>

      <RailSection title="Growth Stages" badge={`${totalYears}y`} open={stagesOpen} onToggle={() => setStagesOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>
            <span style={{ width: 50 }}>Years</span><span style={{ flex: 1 }}>Growth %</span><span style={{ width: 16 }} />
          </div>
          {stages.map((st, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="number" min={1} max={MAX_HORIZON} style={{ ...INPUT, width: 50 }} value={st.years} onFocus={focus} onBlur={blur}
                onChange={e => updateStage(i, { years: Math.max(1, Math.round(+e.target.value)) })} />
              <input type="number" step={0.5} style={{ ...INPUT, flex: 1 }} value={st.growth} onFocus={focus} onBlur={blur}
                onChange={e => updateStage(i, { growth: +e.target.value })} />
              <button onClick={() => removeStage(i)} disabled={stages.length <= 1} style={{
                width: 16, background: 'none', border: 'none', fontSize: 14, cursor: stages.length <= 1 ? 'default' : 'pointer',
                color: stages.length <= 1 ? 'var(--theme-text-faint, rgba(255,255,255,0.2))' : 'var(--theme-secondary, #99907e)',
              }}>×</button>
            </div>
          ))}
          <button onClick={addStage} disabled={totalYears >= MAX_HORIZON} style={{
            marginTop: 2, background: 'none', border: 'none', color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)',
            fontSize: 10, padding: '4px 0', textAlign: 'left', cursor: totalYears >= MAX_HORIZON ? 'default' : 'pointer',
            opacity: totalYears >= MAX_HORIZON ? 0.5 : 1,
          }}>
            + add stage
          </button>
          {!horizonOk && (
            <div style={{ ...HINT, color: 'var(--theme-negative, #ef4444)' }}>
              {totalYears === 0 ? 'At least one stage is required.' : `Total horizon (${totalYears}y) exceeds the ${MAX_HORIZON}-year cap.`}
            </div>
          )}
        </div>
      </RailSection>

      <RailSection title="Capital Assumptions" open={capitalOpen} onToggle={() => setCapitalOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CurveRow label="CapEx % Rev" curve={capex} onChange={setCapex} focus={focus} blur={blur} />
          <CurveRow label="D&A % Rev" curve={da} onChange={setDa} focus={focus} blur={blur} />
          <CurveRow label="Working Capital % Rev" curve={wc} onChange={setWc} focus={focus} blur={blur} />
          <div style={HINT}>Each glides linearly from Start % (year 1) to End % (final projection year) — e.g. CapEx starting high during the growth phase and fading toward a steady state.</div>
        </div>
      </RailSection>

      <RailSection title="Discount Rate" open={waccOpen} onToggle={() => setWaccOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['auto', 'manual'] as const).map(m => (
              <button key={m} onClick={() => setWaccMode(m)} style={{
                flex: 1, padding: '5px 0', fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', cursor: 'pointer',
                background: waccMode === m ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                border: `1px solid ${waccMode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                color: waccMode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #99907e)',
              }}>{m === 'auto' ? 'Auto (CAPM)' : 'Manual'}</button>
            ))}
          </div>
          {waccMode === 'manual' ? (
            <div>
              <label style={LABEL}>WACC %</label>
              <input type="number" step={0.25} style={INPUT} value={waccManual} onFocus={focus} onBlur={blur}
                onChange={e => setWaccManual(+e.target.value)} />
            </div>
          ) : (
            <>
              <div>
                <label style={LABEL}>Equity Risk Premium %</label>
                <input type="number" step={0.25} style={INPUT} value={erp} onFocus={focus} onBlur={blur}
                  onChange={e => setErp(+e.target.value)} />
              </div>
              <div>
                <label style={LABEL}>Cost-of-Debt Spread % (over risk-free)</label>
                <input type="number" step={0.25} style={INPUT} value={debtSpread} onFocus={focus} onBlur={blur}
                  onChange={e => setDebtSpread(+e.target.value)} />
              </div>
              {betaInfo && (
                <div style={HINT}>β {betaInfo.beta.toFixed(2)} · {betaInfo.source} · risk-free rate and D/E resolved live from the Treasury curve and fundamentals.</div>
              )}
              {data?.wacc_build && (
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, color: 'var(--theme-secondary, #99907e)', lineHeight: 1.8, paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                  <div>Risk-free {data.wacc_build.risk_free}% · Ke {data.wacc_build.cost_of_equity}% · Kd {data.wacc_build.cost_of_debt}%</div>
                  <div>Weights E {((data.wacc_build.equity_weight ?? 1) * 100).toFixed(0)}% / D {((data.wacc_build.debt_weight ?? 0) * 100).toFixed(0)}% → <span style={{ color: 'var(--theme-primary, #c9a84c)' }}>WACC {data.wacc_build.wacc}%</span></div>
                </div>
              )}
            </>
          )}
        </div>
      </RailSection>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button onClick={() => calculate()} disabled={isPending || !canRun} style={{
          width: '100%', background: isPending ? 'var(--theme-hover, rgba(255,255,255,0.04))' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
          border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
          fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', padding: '8px 0', cursor: (isPending || !canRun) ? 'default' : 'pointer',
          opacity: (isPending || !canRun) ? 0.6 : 1, transition: 'opacity 0.15s',
        }}>
          {isPending ? 'Running…' : 'Run DCF Model'}
        </button>
        {isError && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', textAlign: 'center', fontFamily: 'var(--theme-sans)' }}>Server unavailable, or check your stage/curve inputs.</div>}
      </div>

    {/* Right panel */}
    </>}>

      {!data && (
        <EmptyState title="DCF Valuation Engine" hint="Enter a ticker and press Fetch Fundamentals, adjust stages/curves/discount rate, then Run."
          keys={['Enter']} action="Run DCF Model" />
      )}

      {data && (() => {
        const intrinsic = data.intrinsic_per_share
        const price = marketPrice
        const upside = price != null && price > 0 ? (intrinsic - price) / price * 100 : null
        const primary = upsidePrimary(upside, `$${intrinsic.toFixed(2)}`, price != null ? `$${price.toFixed(2)}` : null)
        const termPct = data.enterprise_value > 0 ? data.terminal_value / data.enterprise_value * 100 : null
        const cells = [
          { label: 'Enterprise Value', value: fmtM(data.enterprise_value) },
          { label: 'Equity Value', value: fmtM(data.equity_value) },
          { label: 'Terminal % EV', value: termPct == null ? '—' : `${termPct.toFixed(0)}%`, tone: (termPct ?? 0) > 85 ? 'neg' : 'text' as VerdictTone },
          { label: 'WACC', value: `${data.wacc_build.wacc}%` },
        ]
        return (
          <>
            <div style={PANEL}>
              <VerdictStrip primary={primary} cells={cells} />
            </div>

            {(data.pv_fcfs < 0 || data.enterprise_value <= 0 || (data.enterprise_value > 0 && termPct != null && termPct > 85)) && (
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-negative) 35%, transparent)', borderLeft: '4px solid var(--theme-negative)', padding: '8px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-negative)', marginBottom: 3 }}>Terminal-Dominated Result: Treat With Caution</div>
                <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', lineHeight: '14px' }}>
                  {data.pv_fcfs < 0
                    ? 'The projected cash flows are negative across the explicit window, so all value (and more) comes from the terminal year. '
                    : 'Over 85% of enterprise value sits in the terminal value. '}
                  The intrinsic figure depends almost entirely on the Target Margin and terminal-growth assumptions, not near-term fundamentals.
                </div>
              </div>
            )}

            <ChartPanel title={`${data.total_years}-Year Free Cash Flow Projections ($M)`} height={268}>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={[...data.fcfs, { year: 'TV', revenue: data.terminal_value }]}>
                  <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                  <XAxis dataKey="year" tick={{ fontSize: 9, fill: 'var(--theme-secondary, #99907e)' }} tickFormatter={(y: number | string) => y === 'TV' ? 'TV' : `Y${y}`} />
                  <YAxis yAxisId="rev" orientation="left" tick={{ fontSize: 9, fill: 'var(--theme-secondary, #99907e)' }} tickFormatter={v => `$${(v / 1000).toFixed(0)}B`} width={44} />
                  <YAxis yAxisId="fcf" orientation="right" tick={{ fontSize: 9, fill: 'var(--theme-secondary, #99907e)' }} tickFormatter={v => fmtM(v)} width={56} />
                  <Tooltip formatter={(v: number, name: string) => [fmtM(v), name]} contentStyle={cc.tooltipStyle} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} payload={[
                    { value: 'Revenue', type: 'rect', id: 'rev', color: cc.c2 },
                    { value: 'Terminal Value', type: 'rect', id: 'tv', color: cc.primary },
                    { value: 'Free Cash Flow', type: 'line', id: 'fcf', color: cc.gain },
                    { value: 'PV of FCF', type: 'line', id: 'pv', color: cc.primary },
                  ]} />
                  <ReferenceLine yAxisId="fcf" y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.15))" />
                  <Bar yAxisId="rev" dataKey="revenue" name="Revenue / Terminal Value" fill={cc.c2}>
                    {[...data.fcfs, { year: 'TV' }].map((d: { year: number | string }, i: number) => (
                      <Cell key={i} fill={d.year === 'TV' ? cc.primary : cc.c2} fillOpacity={d.year === 'TV' ? 0.85 : 0.55} />
                    ))}
                  </Bar>
                  <Line yAxisId="fcf" type="monotone" dataKey="fcf" name="Free Cash Flow" stroke={cc.gain} strokeWidth={2} dot={{ r: 3, fill: cc.gain }} activeDot={{ r: 5 }} />
                  <Line yAxisId="fcf" type="monotone" dataKey="pv_fcf" name="PV of FCF" stroke={cc.primary} strokeWidth={2} dot={{ r: 3, fill: cc.primary }} activeDot={{ r: 5 }} strokeDasharray="4 2" />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartPanel>

            <div style={{ ...PANEL, position: 'relative', padding: '30px 0 0' }}>
              <div style={{
                position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.85))',
                padding: '4px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--theme-text, #d7e3fc)', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
              }}>
                Assumptions by Year
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Year', 'Growth %', 'Margin %', 'CapEx %', 'D&A %', 'WC %', 'EBIT', 'FCF', 'PV FCF'].map(h => (
                        <th key={h} style={TH}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.fcfs.map(row => (
                      <tr key={row.year}>
                        <td style={TD}>Y{row.year}</td>
                        <td style={TD}>{row.growth.toFixed(1)}%</td>
                        <td style={TD}>{row.margin.toFixed(1)}%</td>
                        <td style={TD}>{row.capex_pct.toFixed(1)}%</td>
                        <td style={TD}>{row.da_pct.toFixed(1)}%</td>
                        <td style={TD}>{row.wc_pct.toFixed(1)}%</td>
                        <td style={TD}>{fmtM(row.ebit)}</td>
                        <td style={TD}>{fmtM(row.fcf)}</td>
                        <td style={TD}>{fmtM(row.pv_fcf)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      })()}

    </SidebarLayout>
  )
}

export default function DCFValuation() {
  return <PageWrapper title="DCF Valuation"><DCFValuationContent /></PageWrapper>
}
