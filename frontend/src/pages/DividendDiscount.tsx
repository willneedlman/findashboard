import { useState, useMemo } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'
import {
  INPUT, LABEL, HINT, SIDEBAR, SECTION, PRIMARY_BTN, READOUT_ROW, TOOLTIP_STYLE, TOOLTIP_LABEL,
  TOOLTIP_ITEM, TOOLTIP_CURSOR, TICK, METRIC_GRID, STACK, Field, ChartPanel,
} from './valuationShared'

type DDM = {
  ticker: string; pays_dividend: boolean; price?: number | null
  dps?: number; div_yield?: number | null; div_growth?: number | null; beta?: number | null
  suggested_r?: number; suggested_g?: number; low_yield?: boolean; note?: string
}

export function DividendDiscountContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('KO')
  const [data, setData] = useState<DDM | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [r, setR] = useState(8)      // cost of equity %
  const [g1, setG1] = useState(6)    // stage-1 growth %
  const [years, setYears] = useState(5)
  const [g2, setG2] = useState(3)    // terminal growth %

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await axios.get(`/api/valuation/ddm?ticker=${ticker.trim().toUpperCase()}`)
      const d: DDM = res.data
      setData(d)
      if (d.suggested_r) setR(d.suggested_r)
      if (d.suggested_g != null) { setG1(d.suggested_g); setG2(Math.min(d.suggested_g, (d.suggested_r ?? 8) - 2)) }
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not load dividend data.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const calc = useMemo(() => {
    if (!data?.pays_dividend || !data.dps) return null
    const D0 = data.dps, rd = r / 100, gd1 = g1 / 100, gd2 = g2 / 100
    const rows: { year: number; dividend: number; pv: number }[] = []
    let pvStage1 = 0
    for (let t = 1; t <= years; t++) {
      const div = D0 * Math.pow(1 + gd1, t)
      const pv = div / Math.pow(1 + rd, t)
      pvStage1 += pv
      rows.push({ year: t, dividend: div, pv })
    }
    const Dn = D0 * Math.pow(1 + gd1, years)
    const validTerminal = rd > gd2
    const terminal = validTerminal ? (Dn * (1 + gd2)) / (rd - gd2) : NaN
    const pvTerminal = validTerminal ? terminal / Math.pow(1 + rd, years) : NaN
    const value = validTerminal ? pvStage1 + pvTerminal : NaN
    const upside = (validTerminal && data.price) ? (value / data.price - 1) * 100 : null
    return { rows, value, pvStage1, pvTerminal, validTerminal, upside }
  }, [data, r, g1, g2, years])

  return (
    <SidebarLayout sidebarWidth={250} sidebarTitle="DDM Inputs" sidebar={
      <div style={SIDEBAR}>
        <div>
          <label style={LABEL}>Ticker</label>
          <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && load()} placeholder="KO" />
          <button onClick={load} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'Loading…' : 'Load dividend'}
          </button>
        </div>

        {data?.pays_dividend && <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={SECTION}>Discount rate & growth</div>
            <Field label="Required return (cost of equity, %)" hint="The return equity holders demand, not WACC. CAPM seed: risk-free + beta x equity risk premium.">
              <input style={INPUT} type="number" step={0.1} value={r} onChange={e => setR(Number(e.target.value))} />
            </Field>
            <Field label="Stage-1 growth (%)" hint="Near-term dividend growth, applied for the years below.">
              <input style={INPUT} type="number" step={0.1} value={g1} onChange={e => setG1(Number(e.target.value))} />
            </Field>
            <Field label="Stage-1 years">
              <input style={INPUT} type="number" min={0} max={20} value={years} onChange={e => setYears(Number(e.target.value))} />
            </Field>
            <Field label="Terminal growth (%)" hint="Perpetual growth after stage 1. Must stay below the required return.">
              <input style={INPUT} type="number" step={0.1} value={g2} onChange={e => setG2(Number(e.target.value))} />
            </Field>
          </div>
          <div style={{ paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={READOUT_ROW}><span>DPS (TTM)</span><span>${data.dps?.toFixed(2)}</span></div>
            <div style={READOUT_ROW}><span>Yield</span><span>{data.div_yield?.toFixed(2)}%</span></div>
            {data.div_growth != null && <div style={READOUT_ROW}><span>5y div CAGR</span><span>{data.div_growth.toFixed(1)}%</span></div>}
            {data.beta != null && <div style={READOUT_ROW}><span>Beta</span><span>{data.beta.toFixed(2)}</span></div>}
          </div>
        </>}
      </div>
    }>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Dividend Discount Model"
          hint="Value a dividend-paying stock as the present value of its future dividends. Enter a ticker and Load dividend." />
      )}

      {data && !data.pays_dividend && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7, maxWidth: 620 }}>
          {data.note || 'This company does not pay a dividend, so a DDM does not apply.'}
        </div>
      )}

      {calc && (
        <div style={STACK}>
          {data!.low_yield && data!.note && (
            <div style={{ border: '1px solid #d9863355', background: '#d9863311', padding: '12px 14px', fontFamily: 'var(--theme-mono)', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-text, #d7e3fc)' }}>
              {data!.note}
            </div>
          )}

          <p style={{ margin: 0, fontFamily: 'var(--theme-mono)', fontSize: 13.5, lineHeight: 1.6, color: 'var(--theme-text, #d7e3fc)' }}>
            Discounting the ${data!.dps?.toFixed(2)} dividend at a {r}% cost of equity, growing {g1}% for {years} years then {g2}% forever,
            values the stock at <b style={{ color: 'var(--theme-primary, #c9a84c)' }}>{calc.validTerminal ? `$${calc.value.toFixed(2)}` : 'n/a'}</b>.
          </p>

          <div style={METRIC_GRID}>
            <MetricCard label="Intrinsic value" value={calc.validTerminal ? `$${calc.value.toFixed(2)}` : 'n/a'} />
            <MetricCard label="Market price" value={data!.price ? `$${data!.price.toFixed(2)}` : 'n/a'} />
            <MetricCard label="Upside" value={calc.upside != null ? `${calc.upside > 0 ? '+' : ''}${calc.upside.toFixed(1)}%` : 'n/a'} deltaPositive={(calc.upside ?? 0) >= 0} />
            <MetricCard label="Dividend yield" value={data!.div_yield != null ? `${data!.div_yield.toFixed(2)}%` : 'n/a'} />
          </div>

          {!calc.validTerminal && (
            <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, lineHeight: 1.6 }}>
              Terminal growth must be below the required return for the model to converge. Lower terminal growth or raise the required return.
            </div>
          )}

          {calc.validTerminal && (
            <ChartPanel title="Projected dividend per share">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={calc.rows}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--theme-border, rgba(255,255,255,0.08))" />
                  <XAxis dataKey="year" tick={TICK} tickFormatter={(y) => `Y${y}`} />
                  <YAxis tick={TICK} tickFormatter={(v) => `$${v.toFixed(2)}`} width={56} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR} formatter={(v: number) => `$${v.toFixed(2)}`} labelFormatter={(y) => `Year ${y}`} />
                  <Bar dataKey="dividend" name="Dividend" radius={[2, 2, 0, 0]}>
                    {calc.rows.map((_, i) => <Cell key={i} fill={cc.c1} />)}
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

export default function DividendDiscount() {
  return <PageWrapper title="Dividend Discount Model"><DividendDiscountContent /></PageWrapper>
}
