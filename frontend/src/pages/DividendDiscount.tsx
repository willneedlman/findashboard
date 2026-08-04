import { useState, useMemo } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import {
  INPUT, LABEL, SECTION, RailSection, PRIMARY_BTN, READOUT_ROW,
  PANEL, STACK, Field, ChartPanel, VerdictStrip, upsidePrimary,
  RangeTrack, heatColor,
} from './valuationShared'
import { T } from '../lib/theme'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'

type DDM = {
  ticker: string; pays_dividend: boolean; price?: number | null
  dps?: number; div_yield?: number | null; div_growth?: number | null; beta?: number | null
  suggested_r?: number; suggested_g?: number; low_yield?: boolean; note?: string
}

// Projected dividends drawn twice: nominal as a dashed gold outline, present
// value as a solid gold bar in front. The shrinking gap is the discount drag.
function DividendBars({ rows }: { rows: { year: number; dividend: number; pv: number }[] }) {
  const max = Math.max(...rows.map(r => r.dividend)) * 1.3 || 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '5%', padding: '0 4%' }}>
        {rows.map(r => (
          <div key={r.year} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: '68%', height: `${(r.dividend / max) * 100}%`, border: '1px dashed var(--theme-primary, #c9a84c)', borderBottom: 'none', boxSizing: 'border-box' }}>
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${(r.pv / r.dividend) * 100}%`, background: 'var(--theme-primary, #c9a84c)' }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '5%', padding: '5px 4% 0' }}>
        {rows.map(r => <div key={r.year} style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #99907e)' }}>Y{r.year}</div>)}
      </div>
      <div style={{ display: 'flex', gap: 18, justifyContent: 'center', marginTop: 8, fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary, #99907e)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, border: '1px dashed var(--theme-primary, #c9a84c)', boxSizing: 'border-box' }} />Nominal DPS</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: 'var(--theme-primary, #c9a84c)' }} />Present value</span>
      </div>
    </div>
  )
}

// The fair-value derivation as a mono key/value ledger.
function ModelLedger({ D0, g1, years, r, calc, price }:
  { D0: number; g1: number; years: number; r: number
    calc: { pvStage1: number; terminal: number; pvTerminal: number; value: number; upside: number | null }; price?: number | null }) {
  const sec = 'var(--theme-secondary, #99907e)', txt = 'var(--theme-text, #d7e3fc)'
  const Row = ({ k, v, vColor }: { k: string; v: string; vColor?: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>
      <span style={{ color: sec }}>{k}</span><span style={{ color: vColor ?? txt }}>{v}</span>
    </div>
  )
  return (
    <div style={{ padding: '4px 4px' }}>
      <Row k="DPS (TTM)" v={`$${D0.toFixed(2)}`} />
      <Row k="Stage-1 growth" v={`${g1.toFixed(1)}% × ${years}y`} />
      <Row k="Required return" v={`${r.toFixed(1)}%`} />
      <div style={{ borderTop: '1px dashed var(--theme-border, rgba(255,255,255,0.14))', margin: '5px 0' }} />
      <Row k="PV of stage-1 divs" v={`$${calc.pvStage1.toFixed(2)}`} />
      <Row k={`Terminal value (Y${years})`} v={`$${calc.terminal.toFixed(2)}`} />
      <Row k="PV of terminal" v={`$${calc.pvTerminal.toFixed(2)}`} />
      <div style={{ borderTop: '2px solid var(--theme-primary, #c9a84c)', margin: '6px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0' }}>
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700, color: txt }}>Intrinsic value</span>
        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 16, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)' }}>${calc.value.toFixed(2)}</span>
      </div>
      {price != null && calc.upside != null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
          <span style={{ color: sec }}>vs market ${price.toFixed(2)}</span>
          <span style={{ color: calc.upside >= 0 ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)' }}>{calc.upside >= 0 ? '+' : '−'}{Math.abs(calc.upside).toFixed(1)}%</span>
        </div>
      )}
    </div>
  )
}

// Required-return × terminal-growth sensitivity heatmap of intrinsic $/share.
function RGHeat({ grid, activeR, activeG }:
  { grid: { rSteps: number[]; gSteps: number[]; cells: number[][]; min: number; max: number }; activeR: number; activeG: number }) {
  const faint = 'var(--theme-text-faint, rgba(255,255,255,0.18))', gold = 'var(--theme-primary, #c9a84c)'
  return (
    <div style={{ padding: 16, overflowX: 'auto' }}>
      <table style={{ borderSpacing: 3, borderCollapse: 'separate', margin: '0 auto' }}>
        <thead>
          <tr>
            <th style={{ paddingRight: 12, paddingBottom: 8, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: faint, textAlign: 'right' }}>Return ↓ / Term g →</th>
            {grid.gSteps.map((gg, i) => (
              <th key={i} style={{ padding: '0 3px 8px', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textAlign: 'center', color: gg === activeG ? gold : faint }}>{gg.toFixed(1)}%</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rSteps.map((rr, ri) => (
            <tr key={ri}>
              <td style={{ paddingRight: 12, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textAlign: 'right', color: rr === activeR ? gold : faint }}>{rr.toFixed(1)}%</td>
              {grid.gSteps.map((_, ci) => {
                const v = grid.cells[ri][ci]
                const ok = isFinite(v)
                return (
                  <td key={ci} style={{ padding: 2 }}>
                    <div style={{
                      width: 62, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: ok ? heatColor(v, grid.min, grid.max) : 'var(--theme-bg, #0a1628)',
                      color: ok ? '#dce3ed' : faint, fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 600,
                      outline: (rr === activeR && grid.gSteps[ci] === activeG) ? `1px solid ${gold}` : 'none',
                    }}>{ok ? `$${v.toFixed(0)}` : '—'}</div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DividendDiscountContent() {
  const [ticker, setTicker] = useState('KO')
  const [inputsOpen, setInputsOpen] = useState(true)
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
    return { rows, value, terminal, pvStage1, pvTerminal, validTerminal, upside }
  }, [data, r, g1, g2, years])

  // Required-return × terminal-growth grid of intrinsic $/share (two-stage math),
  // centered on the active inputs; cells where r − g < ~1pt don't converge.
  const grid = useMemo(() => {
    if (!data?.pays_dividend || !data.dps) return null
    const D0 = data.dps, gd1 = g1 / 100
    const steps = [-3, -2, -1, 0, 1, 2, 3]
    const rSteps = steps.map(k => Math.round((r + k * 0.5) * 10) / 10)
    const gSteps = steps.map(k => Math.round((g2 + k * 0.5) * 10) / 10)
    const cells = rSteps.map(rr => gSteps.map(gg => {
      const rd = rr / 100, gd2 = gg / 100
      if (rd - gd2 < 0.01) return NaN
      let pv1 = 0
      for (let t = 1; t <= years; t++) pv1 += D0 * Math.pow(1 + gd1, t) / Math.pow(1 + rd, t)
      const Dn = D0 * Math.pow(1 + gd1, years)
      const term = Dn * (1 + gd2) / (rd - gd2)
      return pv1 + term / Math.pow(1 + rd, years)
    }))
    const vals = cells.flat().filter(v => isFinite(v))
    return { rSteps, gSteps, cells, min: vals.length ? Math.min(...vals) : 0, max: vals.length ? Math.max(...vals) : 0 }
  }, [data, r, g1, g2, years])

  useReportCapture(() => {
    if (!data?.pays_dividend || !calc?.validTerminal) return null
    const tkr = data.ticker ? ` · ${data.ticker}` : ''
    const pieces: ClipDraft[] = [
      kpiClip('Dividend Discount', `DDM Verdict${tkr}`, [
        { label: 'Intrinsic / Share', value: `$${calc.value.toFixed(2)}` },
        ...(data.price != null ? [{ label: 'Market Price', value: `$${data.price.toFixed(2)}` }] : []),
        ...(calc.upside != null ? [{ label: 'Upside', value: `${calc.upside >= 0 ? '+' : '−'}${Math.abs(calc.upside).toFixed(1)}%` }] : []),
        ...(data.div_yield != null ? [{ label: 'Div Yield', value: `${data.div_yield.toFixed(2)}%` }] : []),
      ]),
      kpiClip('Dividend Discount', `DDM Assumptions${tkr}`, [
        { label: 'Required Return', value: `${r}%` },
        { label: 'Stage-1 Growth', value: `${g1}%` },
        { label: 'Stage-1 Years', value: String(years) },
        { label: 'Terminal Growth', value: `${g2}%` },
      ]),
    ]
    if (calc.rows.length) {
      pieces.push(tableClip(
        'Dividend Discount',
        `Dividend Stream${tkr}`,
        ['Year', 'DPS', 'PV'],
        calc.rows.map(row => [`Y${row.year}`, `$${row.dividend.toFixed(2)}`, `$${row.pv.toFixed(2)}`]),
      ))
    }
    return pieces
  }, { disabled: !(data?.pays_dividend && calc?.validTerminal), sourceTab: 'Dividend Discount' })

  return (
    <SidebarLayout sidebarWidth={250} sidebarTitle="" sidebar={
      <RailSection title="DDM Inputs" open={inputsOpen} onToggle={() => setInputsOpen(o => !o)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={LABEL}>Ticker</label>
          <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && load()} placeholder="KO" />
          <button onClick={load} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'FETCHING…' : 'FETCH'}
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
      </RailSection>
    }>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Dividend Discount Model"
          hint="Value a dividend-paying stock as the present value of its future dividends. Enter a ticker and press FETCH."
          action="FETCH"
          keys={['Enter']} kpis={['Fair Value', 'Upside', 'Cost of Equity', 'Growth', 'Yield']}
          preview="chart" previewLabel="Discounted Dividend Stream" />
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

          <div style={PANEL}>
            {(() => {
              let range: React.ReactNode = undefined
              const price = data!.price
              if (calc.validTerminal && grid && price != null) {
                const bear = Math.min(grid.min, calc.value, price)
                const bull = Math.max(grid.max, calc.value, price)
                if (bull > bear) {
                  const clamp = (x: number) => Math.max(0, Math.min(100, x))
                  const at = (v: number) => clamp((v - bear) / (bull - bear) * 100)
                  range = <RangeTrack title="Valuation range"
                    gradient={`linear-gradient(90deg, ${T.negTint(35)}, color-mix(in srgb, var(--theme-secondary) 22%, transparent), ${T.posTint(35)})`}
                    ticks={[{ pct: at(calc.value), tone: 'gold' }, { pct: at(price), tone: 'text' }]}
                    labels={[
                      { text: `$${grid.min.toFixed(0)} bear`, pct: at(grid.min), tone: 'muted' },
                      { text: `price $${price.toFixed(2)}`, pct: at(price), tone: 'text' },
                      { text: `fair $${calc.value.toFixed(2)}`, pct: at(calc.value), tone: 'gold' },
                      { text: `$${grid.max.toFixed(0)} bull`, pct: at(grid.max), tone: 'muted' },
                    ]} />
                }
              }
              return (
                <VerdictStrip
                  primary={upsidePrimary(calc.upside ?? null, calc.validTerminal ? `$${calc.value.toFixed(2)}` : 'n/a', price ? `$${price.toFixed(2)}` : null)}
                  range={range}
                  cells={[
                    { label: 'Intrinsic', value: calc.validTerminal ? `$${calc.value.toFixed(2)}` : 'n/a' },
                    { label: 'Yield', value: data!.div_yield != null ? `${data!.div_yield.toFixed(2)}%` : 'n/a' },
                  ]}
                />
              )
            })()}
          </div>

          {!calc.validTerminal && (
            <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, lineHeight: 1.6 }}>
              Terminal growth must be below the required return for the model to converge. Lower terminal growth or raise the required return.
            </div>
          )}

          {calc.validTerminal && (
            <>
              {/* Row A: dividend stream (nominal vs PV) + model ledger */}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
                <div style={{ flex: '1 1 360px', minWidth: 0 }}>
                  <ChartPanel title="Dividend per share" height={220}>
                    <DividendBars rows={calc.rows} />
                  </ChartPanel>
                </div>
                <div style={{ ...PANEL, flex: '0 0 340px', position: 'relative', padding: '30px 14px 14px' }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.85))', padding: '4px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>Model ledger</div>
                  <ModelLedger D0={data!.dps!} g1={g1} years={years} r={r} calc={calc} price={data!.price} />
                </div>
              </div>

              {/* Row B: required-return × terminal-growth sensitivity */}
              {grid && (
                <div style={PANEL}>
                  <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>Sensitivity — Required Return × Terminal Growth</span>
                    <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.08em' }}>Intrinsic $/share</span>
                  </div>
                  <RGHeat grid={grid} activeR={grid.rSteps[3]} activeG={grid.gSteps[3]} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </SidebarLayout>
  )
}

export default function DividendDiscount() {
  return <PageWrapper title="Dividend Discount Model"><DividendDiscountContent /></PageWrapper>
}
