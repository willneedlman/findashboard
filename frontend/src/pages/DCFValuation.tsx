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
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { T } from '../lib/theme'
import {
  INPUT, LABEL, HINT, TICK, RailSection, RangeTrack, VerdictStrip, PANEL, ChartPanel, TH, TD,
  fmtM, upsidePrimary, Tornado, type VerdictTone, type TornadoRow,
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
  enterprise_value: number; equity_value: number; intrinsic_per_share: number
  wacc_build: WaccBuild; tornado: TornadoRow[]; tornado_base: number
  sensitivity_tables: SensitivityTable[]
  modeled_revenue_cagr: number
  fcf_conversion_pct: number
  market_implied?: {
    market_price: number; implied_revenue_cagr: number | null; modeled_revenue_cagr: number
    cagr_gap: number | null; implied_target_margin: number | null
    implied_terminal_revenue: number | null; valuation_gap_pct: number
  }
  market_price?: number
}

type SensitivityDriver = { key: string; label: string; values: number[]; base: number }
type SensitivityTable = {
  id: string; label: string; row_driver: SensitivityDriver; column_driver: SensitivityDriver
  values: (number | null)[][]
}

type AiThesis = {
  stance: 'constructive' | 'balanced' | 'cautious' | string
  summary: string
  evidence: string[]
  risks: string[]
  watch_items: string[]
}

type StatementContext = { source: string; period: string; comparison_period?: string; annual_period?: string }
type AiCacheMeta = { cached: boolean; generated_at?: string; statement_fingerprint?: string }

const MAX_HORIZON = 20
const DEFAULT_STAGES: Stage[] = [{ years: 3, growth: 15 }, { years: 4, growth: 10 }, { years: 3, growth: 5 }]

function CurveRow({ label, curve, onChange, focus, blur }: {
  label: string; curve: Curve; onChange: (c: Curve) => void
  focus: (e: React.FocusEvent<HTMLInputElement>) => void; blur: (e: React.FocusEvent<HTMLInputElement>) => void
}) {
  return (
    <div>
      <label style={LABEL}>{label} · Start % → End %</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="number" step={0.25} style={INPUT} value={curve.start_pct} onFocus={focus} onBlur={blur}
          onChange={e => onChange({ ...curve, start_pct: +e.target.value })} />
        <input type="number" step={0.25} style={INPUT} value={curve.end_pct} onFocus={focus} onBlur={blur}
          onChange={e => onChange({ ...curve, end_pct: +e.target.value })} />
      </div>
    </div>
  )
}

type AiSuggested = { stages: Stage[]; target_margin: number; wacc: number; terminal_growth: number }

function SensitivityMatrix({ table, baseValue }: { table: SensitivityTable; baseValue: number }) {
  const near = (value: number, base: number) => Math.abs(value - base) < 0.011
  const baseOnGrid = table.row_driver.values.some(value => near(value, table.row_driver.base))
    && table.column_driver.values.some(value => near(value, table.column_driver.base))
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 590, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 122, lineHeight: 1.35 }}>
              {table.row_driver.label}<br />↓ · {table.column_driver.label} →
            </th>
            {table.column_driver.values.map(value => (
              <th key={value} style={{ ...TH, color: near(value, table.column_driver.base) ? 'var(--theme-primary, #c9a84c)' : undefined }}>
                {value.toFixed(1)}%
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.row_driver.values.map((rowValue, rowIndex) => (
            <tr key={rowValue}>
              <th style={{ ...TH, color: near(rowValue, table.row_driver.base) ? 'var(--theme-primary, #c9a84c)' : undefined }}>
                {rowValue.toFixed(1)}%
              </th>
              {table.values[rowIndex].map((value, columnIndex) => {
                const isBase = near(rowValue, table.row_driver.base) && near(table.column_driver.values[columnIndex], table.column_driver.base)
                const delta = value == null || baseValue === 0 ? 0 : (value / baseValue - 1) * 100
                const tone = delta > 1 ? 'var(--theme-positive, #22c55e)' : delta < -1 ? 'var(--theme-negative, #ef4444)' : 'var(--theme-primary, #c9a84c)'
                return (
                  <td key={columnIndex} style={{
                    ...TD, height: 48, textAlign: 'center', fontSize: 12, fontWeight: isBase ? 800 : 650,
                    color: value == null ? 'var(--theme-text-faint, rgba(255,255,255,0.2))' : tone,
                    background: value == null ? 'transparent' : `color-mix(in srgb, ${tone} ${isBase ? 16 : 7}%, transparent)`,
                    boxShadow: isBase ? 'inset 0 0 0 1px var(--theme-primary, #c9a84c)' : undefined,
                  }}>
                    {value == null ? '—' : `$${value.toFixed(2)}`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      {!baseOnGrid && <div style={{ padding: '7px 10px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 8.5, color: 'var(--theme-secondary, #8099b0)' }}>The current model falls outside this custom range, so no base cell is highlighted.</div>}
    </>
  )
}

function ThesisList({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  if (!items?.length) return null
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: tone, marginBottom: 7 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item, index) => <div key={index} style={{ fontSize: 10, lineHeight: '15px', color: 'var(--theme-secondary, #8099b0)' }}>— {item}</div>)}
      </div>
    </div>
  )
}

export function DCFValuationContent() {
  const cc = useChartColors()
  const [searchParams, setSearchParams] = useSearchParams()
  const [ticker, setTickerRaw] = useState(searchParams.get('ticker') || 'AAPL')
  const setTicker = (value: string) => {
    setTickerRaw(value)
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      next.set('ticker', value)
      return next
    }, { replace: true })
  }
  const [fetching, setFetching] = useState(false)
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [aiRegenerating, setAiRegenerating] = useState(false)
  const [betaInfo, setBetaInfo] = useState<{ beta: number; source: string } | null>(null)
  const [marketPrice, setMarketPrice] = useState<number | null>(null)
  const [aiRationale, setAiRationale] = useState<{ growth: string; margin: string; wacc: string } | null>(null)
  const [aiSuggested, setAiSuggested] = useState<AiSuggested | null>(null)
  const [aiThesis, setAiThesis] = useState<AiThesis | null>(null)
  const [aiStatement, setAiStatement] = useState<StatementContext | null>(null)
  const [aiCacheMeta, setAiCacheMeta] = useState<AiCacheMeta | null>(null)
  const [sensitivityId, setSensitivityId] = useState('growth_margin')

  const [revenue, setRevenue] = useState(0)
  const [opMargin, setOpMargin] = useState(15)
  const [targetMargin, setTargetMargin] = useState(15)
  const [shares, setShares] = useState(100)
  const [netDebt, setNetDebt] = useState(0)
  const [taxRate, setTaxRate] = useState(21)
  const [terminalGrowth, setTerminalGrowth] = useState(2.5)
  const [fcfConversion, setFcfConversion] = useState(100)
  const [scenario, setScenario] = useState('custom')
  const [sensitivityGrowthLow, setSensitivityGrowthLow] = useState<number | ''>('')
  const [sensitivityGrowthHigh, setSensitivityGrowthHigh] = useState<number | ''>('')
  const [sensitivityMarginLow, setSensitivityMarginLow] = useState<number | ''>('')
  const [sensitivityMarginHigh, setSensitivityMarginHigh] = useState<number | ''>('')

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
  const [scenarioOpen, setScenarioOpen] = useState(false)

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')

  const totalYears = stages.reduce((s, st) => s + (st.years || 0), 0)
  const horizonOk = totalYears > 0 && totalYears <= MAX_HORIZON

  const addStage = () => { setStages(s => [...s, { years: 2, growth: 5 }]); setScenario('custom') }
  const removeStage = (i: number) => { setStages(s => s.length > 1 ? s.filter((_, j) => j !== i) : s); setScenario('custom') }
  const updateStage = (i: number, patch: Partial<Stage>) => { setStages(s => s.map((st, j) => j === i ? { ...st, ...patch } : st)); setScenario('custom') }

  const applyScenario = (next: 'standard' | 'growth' | 'aggressive') => {
    setScenario(next)
    setWaccMode('manual')
    if (next === 'standard') {
      setStages([{ years: 3, growth: 20 }, { years: 4, growth: 15 }, { years: 3, growth: 10 }])
      setTargetMargin(25)
      setWaccManual(10)
      setTerminalGrowth(3)
      setFcfConversion(100)
    } else if (next === 'growth') {
      setStages([{ years: 10, growth: 30 }])
      setTargetMargin(35)
      setWaccManual(9.5)
      setTerminalGrowth(3.5)
      setFcfConversion(110)
    } else {
      setStages([{ years: 10, growth: 40 }])
      setTargetMargin(45)
      setWaccManual(9)
      setTerminalGrowth(4)
      setFcfConversion(120)
    }
    setSensitivityGrowthLow(20)
    setSensitivityGrowthHigh(50)
    setSensitivityMarginLow(25)
    setSensitivityMarginHigh(45)
  }

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
      setScenario('custom')
      setFcfConversion(100)
      setBetaInfo(f.beta != null ? { beta: f.beta, source: f.assumptions_source ?? 'unknown' } : null)
      setMarketPrice(f.market_price ?? null)
    } catch (e) { console.error('Fetch failed:', e) }
    setFetching(false)
  }

  const { mutate: calculate, data, isPending, isError } = useMutation<DCFResult>({
    mutationFn: async () => {
      const body = {
        ticker, revenue, op_margin: opMargin, target_margin: targetMargin, shares,
        net_debt: netDebt, tax_rate: taxRate, stages, capex, da, wc,
        fcf_conversion_pct: fcfConversion, terminal_growth: terminalGrowth,
        market_price: marketPrice ?? undefined,
        sensitivity_growth_low: sensitivityGrowthLow === '' ? undefined : sensitivityGrowthLow,
        sensitivity_growth_high: sensitivityGrowthHigh === '' ? undefined : sensitivityGrowthHigh,
        sensitivity_margin_low: sensitivityMarginLow === '' ? undefined : sensitivityMarginLow,
        sensitivity_margin_high: sensitivityMarginHigh === '' ? undefined : sensitivityMarginHigh,
        wacc: waccMode === 'manual' ? waccManual : undefined,
        equity_risk_premium: erp, cost_of_debt_spread: debtSpread,
      }
      const { data } = await axios.post('/api/dcf/value', body)
      return { ...data, market_price: marketPrice ?? undefined }
    },
  })

  // AI Suggest Assumptions — reuses the same endpoint the classic model used;
  // its 3-tier growth suggestion (Yr1-3/4-7/8-10) maps directly onto a fresh
  // 3-stage schedule here, and the suggested WACC is applied as a manual
  // override (the AI gave an explicit number, so it should take effect
  // exactly rather than being recomputed by the auto CAPM build).
  const aiSuggest = async (regenerate = false) => {
    setAiSuggesting(true)
    setAiRegenerating(regenerate)
    if (!regenerate) {
      setAiRationale(null)
      setAiSuggested(null)
      setAiThesis(null)
      setAiStatement(null)
      setAiCacheMeta(null)
    }
    try {
      const { data: f } = await axios.get(`/api/dcf/fundamentals?ticker=${ticker}`)
      const { data: r } = await axios.post('/api/ai/dcf-assumptions', {
        ticker, revenue: revenue || f.revenue, op_margin: opMargin || f.op_margin,
        rev_growth: stages[0]?.growth || f.rev_growth, beta: f.beta ?? 1, sector: f.sector ?? '',
        wacc: data?.wacc_build.wacc ?? (waccMode === 'manual' ? waccManual : 10),
        tax_rate: taxRate,
        regenerate,
      })
      setAiSuggested({
        stages: [
          { years: 3, growth: r.rev_growth_1 ?? stages[0]?.growth ?? 15 },
          { years: 4, growth: r.rev_growth_2 ?? stages[1]?.growth ?? 10 },
          { years: 3, growth: r.rev_growth_3 ?? stages[2]?.growth ?? 5 },
        ],
        target_margin: r.target_margin ?? targetMargin,
        wacc: r.wacc ?? waccManual,
        terminal_growth: r.terminal_growth ?? terminalGrowth,
      })
      if (r.rationale) setAiRationale(r.rationale)
      if (r.thesis) setAiThesis(r.thesis)
      if (r.statement_context) setAiStatement(r.statement_context)
      if (r.cache_meta) setAiCacheMeta(r.cache_meta)
    } catch (e) { console.error('AI suggest failed:', e) }
    setAiSuggesting(false)
    setAiRegenerating(false)
  }

  const applyAiSuggestions = () => {
    if (!aiSuggested) return
    setStages(aiSuggested.stages)
    setTargetMargin(aiSuggested.target_margin)
    setTerminalGrowth(aiSuggested.terminal_growth)
    setWaccMode('manual')
    setWaccManual(aiSuggested.wacc)
    setScenario('custom')
    setAiSuggested(null)
    setAiRationale(null)
  }

  const rangePairOk = (low: number | '', high: number | '') =>
    (low === '' && high === '') || (low !== '' && high !== '' && low < high)
  const canRun = revenue > 0 && shares > 0 && horizonOk
    && rangePairOk(sensitivityGrowthLow, sensitivityGrowthHigh)
    && rangePairOk(sensitivityMarginLow, sensitivityMarginHigh)

  const captureDcf = (): ClipDraft[] => {
    if (!data || data.intrinsic_per_share == null) return []
    const tkr = ticker ? ` · ${ticker.toUpperCase()}` : ''
    const pieces: ClipDraft[] = []
    const price = data.market_price
    const upside = price != null && price > 0 ? (data.intrinsic_per_share / price - 1) * 100 : null
    const verdictLabel = upside == null ? undefined
      : upside > 10 ? 'Undervalued' : upside > 2 ? 'Modestly undervalued'
      : upside >= -2 ? 'Fairly valued' : upside >= -10 ? 'Modestly overvalued' : 'Overvalued'
    pieces.push({ sourceTab: 'DCF Valuation', dataType: 'kpi', payload: { kind: 'kpi', title: `DCF Verdict${tkr}`, cells: [
      { label: 'Intrinsic / Share', value: `$${data.intrinsic_per_share.toFixed(2)}` },
      ...(price != null ? [{ label: 'Market Price', value: `$${price.toFixed(2)}` }] : []),
      ...(upside != null ? [{ label: 'Upside', value: `${upside >= 0 ? '+' : '−'}${Math.abs(upside).toFixed(1)}%`, sub: verdictLabel }] : []),
    ] } })
    const termPct = data.enterprise_value > 0 ? (data.terminal_value / data.enterprise_value) * 100 : null
    pieces.push({ sourceTab: 'DCF Valuation', dataType: 'kpi', payload: { kind: 'kpi', title: `Enterprise Value Bridge${tkr}`, cells: [
      { label: 'Enterprise Value', value: fmtM(data.enterprise_value) },
      { label: 'PV of Explicit FCFs', value: fmtM(data.pv_fcfs) },
      { label: 'Terminal Value', value: fmtM(data.terminal_value) },
      ...(termPct != null ? [{ label: 'Terminal % of EV', value: `${termPct.toFixed(0)}%` }] : []),
    ] } })
    pieces.push({ sourceTab: 'DCF Valuation', dataType: 'chart', payload: {
      kind: 'chart', title: `Revenue Projection${tkr}`, chartType: 'bar', xKey: 'year',
      data: data.fcfs.map(d => ({ year: `Y${d.year}`, revenue: d.revenue })),
      series: [{ key: 'revenue', label: 'Revenue ($M)' }],
    } })
    pieces.push({ sourceTab: 'DCF Valuation', dataType: 'chart', payload: {
      kind: 'chart', title: `Free Cash Flow Projection${tkr}`, chartType: 'line', xKey: 'year',
      data: data.fcfs.map(d => ({ year: `Y${d.year}`, fcf: d.fcf, pv_fcf: d.pv_fcf })),
      series: [{ key: 'fcf', label: 'Free Cash Flow' }, { key: 'pv_fcf', label: 'PV of FCF' }],
    } })
    if (data.tornado?.length) {
      pieces.push({ sourceTab: 'DCF Valuation', dataType: 'table', payload: {
        kind: 'table', title: `Value Drivers — one-way sensitivity${tkr}`,
        columns: ['Driver', 'Range', 'Low $/sh', 'High $/sh', 'Swing $/sh'],
        rows: data.tornado.map(t => [t.label, t.range, `$${t.lo.toFixed(2)}`, `$${t.hi.toFixed(2)}`, `$${(t.hi - t.lo).toFixed(2)}`]),
      } })
    }
    const sensitivity = data.sensitivity_tables?.find(table => table.id === sensitivityId) ?? data.sensitivity_tables?.[0]
    if (sensitivity) {
      pieces.push({ sourceTab: 'DCF Valuation', dataType: 'table', payload: {
        kind: 'table', title: `${sensitivity.label} sensitivity${tkr}`,
        columns: [sensitivity.row_driver.label, ...sensitivity.column_driver.values.map(value => `${sensitivity.column_driver.label} ${value.toFixed(1)}%`)],
        rows: sensitivity.row_driver.values.map((rowValue, rowIndex) => [
          `${rowValue.toFixed(1)}%`, ...sensitivity.values[rowIndex].map(value => value == null ? '—' : `$${value.toFixed(2)}`),
        ]),
      } })
    }
    pieces.push({ sourceTab: 'DCF Valuation', dataType: 'kpi', payload: { kind: 'kpi', title: `Key Assumptions${tkr}`, cells: [
      { label: 'WACC', value: `${data.wacc_build.wacc}%` },
      { label: 'Terminal Growth', value: `${terminalGrowth}%` },
      { label: 'Target Margin', value: `${targetMargin}%` },
      { label: 'Yr 1 Growth', value: `${stages[0]?.growth ?? 0}%` },
      { label: 'Tax Rate', value: `${taxRate}%` },
      { label: 'CapEx % Rev', value: `${capex.start_pct}% → ${capex.end_pct}%` },
      { label: 'FCF Conversion', value: `${fcfConversion}%` },
    ] } })
    return pieces
  }

  useReportCapture(captureDcf, {
    disabled: !data?.intrinsic_per_share,
    sourceTab: 'DCF Valuation',
  })

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
              color: 'var(--theme-secondary, #8099b0)', fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', padding: '5px 0', cursor: fetching ? 'default' : 'pointer', opacity: fetching ? 0.6 : 1,
            }}>
              {fetching ? 'FETCHING…' : 'FETCH'}
            </button>
            <button onClick={() => aiSuggest(false)} disabled={aiSuggesting || fetching} style={{
              marginTop: 4, width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
              color: 'var(--theme-primary, #c9a84c)', fontFamily: 'inherit', fontSize: 10,
              fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
              padding: '5px 0', cursor: aiSuggesting ? 'default' : 'pointer', opacity: aiSuggesting ? 0.6 : 1,
            }}>
              {aiSuggesting ? (aiRegenerating ? 'Regenerating Analysis…' : 'Loading Filing Analysis…') : 'AI Analyze Latest Filing'}
            </button>
            {aiSuggested && (
              <div style={{ marginTop: 6, background: 'color-mix(in srgb, var(--theme-primary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', padding: '8px' }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)', marginBottom: 6 }}>
                  AI Suggestions
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, fontSize: 9, fontFamily: 'var(--theme-mono)' }}>
                  {[
                    ['Yr 1–3 / 4–7 / 8–10 Growth %', `${stages[0]?.growth ?? 0} / ${stages[1]?.growth ?? 0} / ${stages[2]?.growth ?? 0}`,
                      `${aiSuggested.stages[0].growth} / ${aiSuggested.stages[1].growth} / ${aiSuggested.stages[2].growth}`],
                    ['Target Margin %', targetMargin, aiSuggested.target_margin],
                    ['WACC %', waccMode === 'manual' ? waccManual : (data?.wacc_build.wacc ?? '—'), aiSuggested.wacc],
                    ['Terminal Growth %', terminalGrowth, aiSuggested.terminal_growth],
                  ].map(([label, was, now]) => (
                    <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--theme-secondary, #8099b0)' }}>{label}</span>
                      <span>
                        <span style={{ color: 'var(--theme-text-dim, rgba(255,255,255,0.3))', textDecoration: 'line-through', marginRight: 6 }}>{was}</span>
                        <span style={{ color: 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>{now}</span>
                      </span>
                    </div>
                  ))}
                </div>
                {aiRationale && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8, paddingTop: 6, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                    {Object.entries(aiRationale).map(([k, v]) => (
                      <div key={k} style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', lineHeight: '12px' }}>
                        <span style={{ color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}: </span>{v as string}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={applyAiSuggestions} style={{
                    flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', fontFamily: 'inherit', cursor: 'pointer',
                    background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
                    border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
                  }}>
                    Apply Changes
                  </button>
                  <button onClick={() => { setAiSuggested(null); setAiRationale(null); setAiThesis(null); setAiStatement(null) }} style={{
                    flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', fontFamily: 'inherit', cursor: 'pointer',
                    background: 'transparent', border: '1px solid var(--theme-text-subtle, rgba(255,255,255,0.12))', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
                  }}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
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
                  onChange={e => { set(+e.target.value); setScenario('custom') }} />
              </div>
            ))}
          </div>
        </div>
      </RailSection>

      <RailSection title="Scenario Lab" badge={scenario === 'growth' ? 'High Growth' : scenario === 'aggressive' ? 'Aggressive' : scenario === 'standard' ? 'Standard' : 'Custom'} open={scenarioOpen} onToggle={() => setScenarioOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={LABEL}>Starting Template</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
              {([
                ['standard', 'Standard'],
                ['growth', 'High Growth'],
                ['aggressive', 'Aggressive'],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => applyScenario(key)} style={{
                  padding: '6px 3px', fontFamily: 'var(--theme-mono)', fontSize: 8.5, fontWeight: 750,
                  background: scenario === key ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                  border: `1px solid ${scenario === key ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                  color: scenario === key ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                  cursor: 'pointer',
                }}>{label}</button>
              ))}
            </div>
            <div style={{ ...HINT, marginTop: 6 }}>Editable starting points. High Growth assumes 30% sustained CAGR. Aggressive assumes 40% sustained CAGR, 45% target margin, 9% WACC, 4% terminal growth, and 120% cash conversion.</div>
          </div>

          <div>
            <label style={LABEL}>FCF / Base FCFF Conversion %</label>
            <input type="number" min={0} max={300} step={2.5} style={INPUT} value={fcfConversion} onFocus={focus} onBlur={blur}
              onChange={e => { setFcfConversion(+e.target.value); setScenario('custom') }} />
            <div style={{ ...HINT, marginTop: 4 }}>100% uses NOPAT + D&A - CapEx - working capital. Higher values model recurring-billing and other cash-conversion tailwinds.</div>
          </div>

          <div style={{ paddingTop: 8, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <label style={LABEL}>Revenue CAGR Sensitivity %</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="number" step={2.5} placeholder="Auto low" style={INPUT} value={sensitivityGrowthLow} onFocus={focus} onBlur={blur}
                onChange={e => setSensitivityGrowthLow(e.target.value === '' ? '' : +e.target.value)} />
              <input type="number" step={2.5} placeholder="Auto high" style={INPUT} value={sensitivityGrowthHigh} onFocus={focus} onBlur={blur}
                onChange={e => setSensitivityGrowthHigh(e.target.value === '' ? '' : +e.target.value)} />
            </div>
          </div>

          <div>
            <label style={LABEL}>Target Margin Sensitivity %</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="number" step={2.5} placeholder="Auto low" style={INPUT} value={sensitivityMarginLow} onFocus={focus} onBlur={blur}
                onChange={e => setSensitivityMarginLow(e.target.value === '' ? '' : +e.target.value)} />
              <input type="number" step={2.5} placeholder="Auto high" style={INPUT} value={sensitivityMarginHigh} onFocus={focus} onBlur={blur}
                onChange={e => setSensitivityMarginHigh(e.target.value === '' ? '' : +e.target.value)} />
            </div>
            {!rangePairOk(sensitivityGrowthLow, sensitivityGrowthHigh) || !rangePairOk(sensitivityMarginLow, sensitivityMarginHigh) ? (
              <div style={{ ...HINT, marginTop: 5, color: 'var(--theme-negative, #ef4444)' }}>Enter both bounds and keep low below high.</div>
            ) : (
              <div style={{ ...HINT, marginTop: 5 }}>Leave both fields blank for a range centered on the current model.</div>
            )}
          </div>
        </div>
      </RailSection>

      <RailSection title="Growth Stages" badge={`${totalYears}y`} open={stagesOpen} onToggle={() => setStagesOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>
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
                color: stages.length <= 1 ? 'var(--theme-text-faint, rgba(255,255,255,0.2))' : 'var(--theme-secondary, #8099b0)',
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
          <CurveRow label="CapEx % Rev" curve={capex} onChange={value => { setCapex(value); setScenario('custom') }} focus={focus} blur={blur} />
          <CurveRow label="D&A % Rev" curve={da} onChange={value => { setDa(value); setScenario('custom') }} focus={focus} blur={blur} />
          <CurveRow label="Working Capital % Rev" curve={wc} onChange={value => { setWc(value); setScenario('custom') }} focus={focus} blur={blur} />
          <div style={HINT}>Each glides linearly from Start % (year 1) to End % (final projection year). CapEx, for example, starts high during the growth phase and fading toward a steady state.</div>
        </div>
      </RailSection>

      <RailSection title="Discount Rate" open={waccOpen} onToggle={() => setWaccOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['auto', 'manual'] as const).map(m => (
              <button key={m} onClick={() => { setWaccMode(m); setScenario('custom') }} style={{
                flex: 1, padding: '5px 0', fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', cursor: 'pointer',
                background: waccMode === m ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                border: `1px solid ${waccMode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                color: waccMode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
              }}>{m === 'auto' ? 'Auto (CAPM)' : 'Manual'}</button>
            ))}
          </div>
          {waccMode === 'manual' ? (
            <div>
              <label style={LABEL}>WACC %</label>
              <input type="number" step={0.25} style={INPUT} value={waccManual} onFocus={focus} onBlur={blur}
                onChange={e => { setWaccManual(+e.target.value); setScenario('custom') }} />
            </div>
          ) : (
            <>
              <div>
                <label style={LABEL}>Equity Risk Premium %</label>
                <input type="number" step={0.25} style={INPUT} value={erp} onFocus={focus} onBlur={blur}
                  onChange={e => { setErp(+e.target.value); setScenario('custom') }} />
              </div>
              <div>
                <label style={LABEL}>Cost-of-Debt Spread % (over risk-free)</label>
                <input type="number" step={0.25} style={INPUT} value={debtSpread} onFocus={focus} onBlur={blur}
                  onChange={e => { setDebtSpread(+e.target.value); setScenario('custom') }} />
              </div>
              {betaInfo && (
                <div style={HINT}>β {betaInfo.beta.toFixed(2)} · {betaInfo.source} · risk-free rate and D/E resolved live from the Treasury curve and fundamentals.</div>
              )}
              {data?.wacc_build && (
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, color: 'var(--theme-secondary, #8099b0)', lineHeight: 1.8, paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
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

      {aiThesis && (
        <div style={{ ...PANEL, padding: 0, overflow: 'hidden', borderLeft: '4px solid var(--theme-primary, #c9a84c)' }}>
          <div style={{ padding: '11px 15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>AI Filing-Grounded Thesis</div>
              {aiStatement && (
                <div style={{ marginTop: 3, fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>
                  Income: {aiStatement.source} · {aiStatement.period}
                  {aiStatement.annual_period ? ` · Balance / cash flow: annual filing ${aiStatement.annual_period}` : ''}
                  {aiCacheMeta?.generated_at ? ` · ${aiCacheMeta.cached ? 'Cached' : 'Generated'} ${new Date(aiCacheMeta.generated_at).toLocaleString()}` : ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => aiSuggest(true)} disabled={aiSuggesting} style={{
                padding: '4px 8px', background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                color: 'var(--theme-secondary, #8099b0)', fontSize: 9, fontWeight: 750, letterSpacing: '0.08em',
                textTransform: 'uppercase', cursor: aiSuggesting ? 'default' : 'pointer', opacity: aiSuggesting ? 0.55 : 1,
              }}>{aiRegenerating ? 'Regenerating…' : 'Regenerate'}</button>
              <span style={{ padding: '4px 8px', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{aiThesis.stance}</span>
              <button aria-label="Dismiss filing thesis" onClick={() => { setAiThesis(null); setAiStatement(null) }} style={{ background: 'transparent', border: 0, color: 'var(--theme-secondary, #8099b0)', fontSize: 17, lineHeight: 1, cursor: 'pointer', padding: 4 }}>×</button>
            </div>
          </div>
          <div style={{ padding: '14px 15px' }}>
            <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--theme-text, #d7e3fc)', marginBottom: 14 }}>{aiThesis.summary}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 18, paddingTop: 12, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <ThesisList label="Statement evidence" items={aiThesis.evidence} tone="var(--theme-positive, #22c55e)" />
              <ThesisList label="Thesis risks" items={aiThesis.risks} tone="var(--theme-negative, #ef4444)" />
              <ThesisList label="Next filing watch" items={aiThesis.watch_items} tone="var(--theme-primary, #c9a84c)" />
            </div>
          </div>
        </div>
      )}

      {!data && (
        <EmptyState title="DCF Valuation Engine" hint="Enter a ticker and press FETCH, adjust stages, curves, and the discount rate, then RUN."
          keys={['Enter']} action="Run DCF Model" />
      )}

      {data && (() => {
        const intrinsic = data.intrinsic_per_share
        const price = data.market_price ?? null
        const upside = price != null && price > 0 ? (intrinsic - price) / price * 100 : null
        const termPct = data.enterprise_value > 0 ? data.terminal_value / data.enterprise_value * 100 : null
        const cells = [
          { label: 'Enterprise Value', value: fmtM(data.enterprise_value) },
          { label: 'Equity Value', value: fmtM(data.equity_value) },
          { label: 'Terminal % EV', value: termPct == null ? '—' : `${termPct.toFixed(0)}%`, tone: (termPct ?? 0) > 85 ? 'neg' : 'text' as VerdictTone },
          { label: 'WACC', value: `${data.wacc_build.wacc}%` },
        ]

        // Valuation range: bear/bull bounds from the tornado's own low/high
        // extremes across every driver, rather than a separate sensitivity
        // sweep — the tornado already captures "how far could this move."
        const tornadoVals = data.tornado.flatMap(t => [t.lo, t.hi])
        const sensiMin = tornadoVals.length ? Math.min(...tornadoVals) : intrinsic
        const sensiMax = tornadoVals.length ? Math.max(...tornadoVals) : intrinsic
        let range: React.ReactNode = undefined
        if (price != null) {
          const bear = Math.min(sensiMin, intrinsic, price)
          const bull = Math.max(sensiMax, intrinsic, price)
          if (bull > bear) {
            const clamp = (x: number) => Math.max(0, Math.min(100, x))
            range = <RangeTrack title="Valuation range"
              gradient={`linear-gradient(90deg, ${T.posTint(35)}, color-mix(in srgb, var(--theme-secondary) 22%, transparent), ${T.negTint(35)})`}
              ticks={[{ pct: clamp((intrinsic - bear) / (bull - bear) * 100), tone: 'gold' }, { pct: clamp((price - bear) / (bull - bear) * 100), tone: 'text' }]}
              labels={[
                { text: `$${sensiMin.toFixed(0)} bear`, pct: clamp((sensiMin - bear) / (bull - bear) * 100), tone: 'muted' },
                { text: `fair $${intrinsic.toFixed(2)}`, pct: clamp((intrinsic - bear) / (bull - bear) * 100), tone: 'gold' },
                { text: `price $${price.toFixed(2)}`, pct: clamp((price - bear) / (bull - bear) * 100), tone: 'text' },
                { text: `$${sensiMax.toFixed(0)} bull`, pct: clamp((sensiMax - bear) / (bull - bear) * 100), tone: 'muted' },
              ]} />
          }
        }
        const primary = price != null
          ? upsidePrimary(upside, `$${intrinsic.toFixed(2)}`, `$${price.toFixed(2)}`)
          : { label: 'Intrinsic / Share', value: `$${intrinsic.toFixed(2)}`, tone: 'gold' as VerdictTone }

        return (
          <>
            <div style={PANEL}>
              <VerdictStrip primary={primary} range={range} cells={cells} />
            </div>

            {data.market_implied && (
              <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>Market-Implied Expectations</div>
                    <div style={{ marginTop: 3, fontSize: 9.5, color: 'var(--theme-secondary, #8099b0)' }}>What the live price requires while every other assumption stays fixed.</div>
                  </div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-primary, #c9a84c)', whiteSpace: 'nowrap' }}>Price ${data.market_implied.market_price.toFixed(2)}</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                  {[
                    ['Modeled Revenue CAGR', `${data.market_implied.modeled_revenue_cagr.toFixed(1)}%`, 'Current stage schedule'],
                    ['Price-Implied CAGR', data.market_implied.implied_revenue_cagr == null ? 'Outside range' : `${data.market_implied.implied_revenue_cagr.toFixed(1)}%`, data.market_implied.cagr_gap == null ? 'No finite solve' : `${data.market_implied.cagr_gap >= 0 ? '+' : ''}${data.market_implied.cagr_gap.toFixed(1)} pts vs model`],
                    ['Price-Implied Margin', data.market_implied.implied_target_margin == null ? 'Outside range' : `${data.market_implied.implied_target_margin.toFixed(1)}%`, 'At modeled growth'],
                    ['Implied Final Revenue', data.market_implied.implied_terminal_revenue == null ? 'Outside range' : fmtM(data.market_implied.implied_terminal_revenue), `Year ${data.total_years}`],
                    ['FCF Conversion', `${data.fcf_conversion_pct.toFixed(1)}%`, 'Applied to base FCFF'],
                    ['Growth + Margin', `${(data.modeled_revenue_cagr + targetMargin).toFixed(1)}%`, 'Modeled CAGR + target margin'],
                  ].map(([label, value, sub], index) => (
                    <div key={label} style={{ padding: '12px 14px', minHeight: 76, borderRight: index < 5 ? '1px solid var(--theme-border, rgba(255,255,255,0.08))' : undefined }}>
                      <div style={{ fontSize: 8.5, fontWeight: 750, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>{label}</div>
                      <div style={{ marginTop: 6, fontFamily: 'var(--theme-mono)', fontSize: 16, fontWeight: 750, color: label === 'Price-Implied CAGR' ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)' }}>{value}</div>
                      <div style={{ marginTop: 3, fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.4))' }}>{sub}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(data.pv_fcfs < 0 || data.enterprise_value <= 0 || (data.enterprise_value > 0 && termPct != null && termPct > 85)) && (
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-negative) 35%, transparent)', borderLeft: '4px solid var(--theme-negative)', padding: '8px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-negative)', marginBottom: 3 }}>Terminal-Dominated Result: Treat With Caution</div>
                <div style={{ fontSize: 10, color: 'var(--theme-secondary, #8099b0)', lineHeight: '14px' }}>
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
                  <XAxis dataKey="year" tick={TICK} tickFormatter={(y: number | string) => y === 'TV' ? 'TV' : `Y${y}`} />
                  <YAxis yAxisId="rev" orientation="left" tick={TICK} tickFormatter={v => `$${(v / 1000).toFixed(0)}B`} width={44} />
                  <YAxis yAxisId="fcf" orientation="right" tick={TICK} tickFormatter={v => fmtM(v)} width={56} />
                  <Tooltip formatter={(v: number, name: string) => [fmtM(v), name]} contentStyle={cc.tooltipStyle} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} payload={[
                    { value: 'Revenue', type: 'rect', id: 'rev', color: cc.c2 },
                    { value: 'Terminal Value', type: 'rect', id: 'tv', color: cc.primary },
                    { value: 'Free Cash Flow', type: 'line', id: 'fcf', color: cc.gain },
                    { value: 'PV of FCF', type: 'line', id: 'pv', color: cc.primary },
                  ]} />
                  <ReferenceLine yAxisId="fcf" y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.15))" />
                  <Bar isAnimationActive={false} yAxisId="rev" dataKey="revenue" name="Revenue / Terminal Value" fill={cc.c2}>
                    {[...data.fcfs, { year: 'TV' }].map((d: { year: number | string }, i: number) => (
                      <Cell key={i} fill={d.year === 'TV' ? cc.primary : cc.c2} fillOpacity={d.year === 'TV' ? 0.85 : 0.55} />
                    ))}
                  </Bar>
                  <Line isAnimationActive={false} yAxisId="fcf" type="monotone" dataKey="fcf" name="Free Cash Flow" stroke={cc.gain} strokeWidth={2} dot={{ r: 3, fill: cc.gain }} activeDot={{ r: 5 }} />
                  <Line isAnimationActive={false} yAxisId="fcf" type="monotone" dataKey="pv_fcf" name="PV of FCF" stroke={cc.primary} strokeWidth={2} dot={{ r: 3, fill: cc.primary }} activeDot={{ r: 5 }} strokeDasharray="4 2" />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartPanel>

            {/* Value-driver tornado — one-way sensitivity of intrinsic $/share */}
            {data.tornado.length > 0 && (
              <ChartPanel title="Value Drivers, one-way sensitivity" height={252}>
                <Tornado rows={data.tornado} base={data.tornado_base} />
              </ChartPanel>
            )}

            {data.sensitivity_tables?.length > 0 && (() => {
              const activeTable = data.sensitivity_tables.find(table => table.id === sensitivityId) ?? data.sensitivity_tables[0]
              return (
                <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>Two-Way Sensitivity · Intrinsic $/Share</div>
                      <div style={{ marginTop: 3, fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>Switch the paired drivers. The current model is highlighted when its assumptions land on the grid.</div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {data.sensitivity_tables.map(table => (
                        <button key={table.id} onClick={() => setSensitivityId(table.id)} style={{
                          padding: '5px 8px', fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 750,
                          background: activeTable.id === table.id ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                          border: `1px solid ${activeTable.id === table.id ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                          color: activeTable.id === table.id ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)', cursor: 'pointer',
                        }}>{table.label}</button>
                      ))}
                    </div>
                  </div>
                  <SensitivityMatrix table={activeTable} baseValue={data.intrinsic_per_share} />
                </div>
              )
            })()}

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
