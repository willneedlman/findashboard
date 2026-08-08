import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, CircleAlert, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { useReportCapture } from '../hooks/useReportCapture'
import type { ClipDraft } from '../lib/reportCreator'
import { recordRecentTicker } from '../lib/recentTickers'
import { T } from '../lib/theme'
import { heatColor } from './valuationShared'

/*
THESIS: One valuation should read as a connected financial argument, never as five calculators stacked together.
OWN-WORLD: AlphaTape's navy research desk, sharp dividers, one gold decision path, and explicit uncertainty.
STORY: Load the business, move through five freely navigable decisions, see every driver's effect, then reconcile the methods.
FIRST VIEWPORT: Fetch and AI actions lead into a five-step spine, one focused work surface, and a persistent live value rail.
FORM: Guided spine from the supplied 1a handoff, preserving the established terminal system and its compact operating density.
*/

type AnnualAssumption = {
  year: number
  growth: number
  margin: number
  tax_rate: number
  da_pct: number
  capex_pct: number
  change_nwc_pct: number
  sbc_pct: number
  cash_adjustment_pct: number
  fcf_conversion_pct: number
  net_interest_pct: number
  dilution_pct: number
  payout_pct: number
}

type MetricKey = 'ev_revenue' | 'ev_ebitda'
type MultipleTarget = { metric: MetricKey; multiple: number; weight: number; year: number }
type SotpSegment = { name: string; revenue_share: number; price_to_sales_multiple: number }
type MethodKey = 'dcf' | 'multiples' | 'ddm' | 'sotp'
type DriverKey = keyof Pick<AnnualAssumption, 'growth' | 'margin' | 'tax_rate' | 'da_pct' | 'capex_pct' | 'change_nwc_pct' | 'sbc_pct' | 'cash_adjustment_pct' | 'fcf_conversion_pct' | 'net_interest_pct' | 'dilution_pct' | 'payout_pct'>
type DriverView = 'endpoints' | 'annual'
type StepKey = 1 | 2 | 3 | 4 | 5
type SensitivityKey = 'discount_rate' | 'operating_case' | 'growth_risk' | 'exit_framework'
type SensitivityTable = {
  title: string
  row_label: string
  column_label: string
  row_values: number[]
  column_values: number[]
  row_suffix: string
  column_suffix: string
  values: Array<Array<number | null>>
  base_row_index: number
  base_column_index: number
}

type Fundamentals = {
  ticker: string
  revenue: number
  shares: number
  net_debt: number
  market_price: number | null
  beta: number | null
  source: string | null
  schedule: AnnualAssumption[]
  current_multiples: Record<string, number | null>
  business_segments: SotpSegment[]
  business_segments_source: string | null
  business_segments_fiscal_year: number | string | null
  dividend_per_share: number | null
  dividend_yield: number | null
}

type ForecastRow = AnnualAssumption & {
  revenue: number
  ebit: number
  nopat: number
  interest_expense: number
  net_income: number
  da: number
  capex: number
  change_nwc: number
  sbc: number
  cash_adjustment: number
  fcf: number
  pv_fcf: number
  shares: number
  dividend: number
  dividend_per_share: number
}

type DriverEffect = { bump: number; value_per_share: number; change_per_share: number; change_per_point: number; rank: number }
type Analysis = {
  ticker: string
  market_price: number | null
  rows: ForecastRow[]
  dcf: {
    value_per_share: number
    enterprise_value: number
    equity_value: number
    pv_forecast_fcf: number
    pv_terminal: number
    terminal_pct: number | null
  }
  multiples: { value_per_share: number | null; lines: Array<MultipleTarget & { value_per_share: number; effective_weight: number }> }
  ddm: { value_per_share: number | null }
  sotp: { value_per_share: number | null }
  methods: Record<MethodKey, number | null>
  active_weights: Partial<Record<MethodKey, number>>
  composite: { value_per_share: number; range_low: number; range_high: number }
  reverse: {
    implied_revenue_cagr?: number | null
    implied_growth_schedule?: number[] | null
    implied_terminal_margin?: number | null
    implied_margin_schedule?: number[] | null
    implied_wacc?: number | null
    implied_exit_multiple?: number | null
    implied_exit_year?: number | null
  }
  driver_effects: Partial<Record<DriverKey, DriverEffect>>
  sensitivity_tables: Record<SensitivityKey, SensitivityTable>
  warnings: string[]
}

type AiSuggestion = {
  growth: [number, number, number]
  margin: number
  tax: number
  wacc: number
  terminalGrowth: number
  thesis?: { stance?: string; summary?: string; evidence?: string[]; risks?: string[]; watch_items?: string[] }
  cached?: boolean
}

const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}` }
const LABEL: React.CSSProperties = { display: 'block', marginBottom: 5, fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: T.muted }
const INPUT: React.CSSProperties = { width: '100%', height: 34, boxSizing: 'border-box', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 0, color: T.text, fontFamily: T.mono, fontSize: 11, padding: '0 10px', outline: 'none' }
const BUTTON: React.CSSProperties = { minHeight: 31, padding: '0 12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 0, color: T.muted, fontFamily: T.label, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', cursor: 'pointer' }
const PRIMARY_BUTTON: React.CSSProperties = { ...BUTTON, background: T.gold, borderColor: T.gold, color: T.bg }
const METHOD_LABEL: Record<MethodKey, string> = { dcf: 'Intrinsic DCF', multiples: 'Market multiples', ddm: 'Dividend value', sotp: 'Parts value' }
const METRIC_LABEL: Record<MetricKey, string> = { ev_revenue: 'EV / Revenue', ev_ebitda: 'EV / EBITDA' }
const DRIVER_LABEL: Record<DriverKey, string> = {
  growth: 'Revenue growth', margin: 'Operating margin', tax_rate: 'Tax rate', da_pct: 'D&A / revenue', capex_pct: 'CapEx / revenue',
  change_nwc_pct: 'Working capital / growth', sbc_pct: 'SBC add-back / revenue', cash_adjustment_pct: 'Other cash adjustment',
  fcf_conversion_pct: 'FCF conversion', net_interest_pct: 'Net interest / revenue', dilution_pct: 'Annual dilution', payout_pct: 'Dividend payout',
}
const DRIVER_LIMITS: Record<DriverKey, [number, number]> = {
  growth: [-75, 200], margin: [-100, 100], tax_rate: [0, 60], da_pct: [0, 50], capex_pct: [-25, 100],
  change_nwc_pct: [-50, 50], sbc_pct: [0, 50], cash_adjustment_pct: [-50, 50], fcf_conversion_pct: [0, 300],
  net_interest_pct: [-25, 50], dilution_pct: [-25, 50], payout_pct: [0, 100],
}

const fmtMoney = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '-' : `$${value.toFixed(digits)}`
const fmtM = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '-' : `$${Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}B` : `${value.toFixed(0)}M`}`
const signedPct = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const apiErrorMessage = (reason: unknown, fallback: string) => {
  if (!axios.isAxiosError(reason)) return fallback
  const detail = reason.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(item => {
    const path = Array.isArray(item?.loc) ? item.loc.filter((part: unknown) => part !== 'body').join('.') : ''
    return `${path ? `${path}: ` : ''}${item?.msg || 'Invalid model input'}`
  }).join(' · ') || fallback
  if (detail && typeof detail === 'object') return JSON.stringify(detail)
  return reason.message || fallback
}

function Field({ label, value, onChange, step = 0.5, suffix, disabled }: { label: string; value: number; onChange: (value: number) => void; step?: number; suffix?: string; disabled?: boolean }) {
  return (
    <label>
      <span style={LABEL}>{label}</span>
      <div style={{ position: 'relative' }}>
        <input disabled={disabled} type="number" step={step} value={Number(value.toFixed(3))} onChange={event => onChange(+event.target.value)} style={{ ...INPUT, paddingRight: suffix ? 30 : 10, opacity: disabled ? .45 : 1 }} />
        {suffix && <span style={{ position: 'absolute', right: 9, top: 10, fontFamily: T.mono, fontSize: 9, color: T.muted }}>{suffix}</span>}
      </div>
    </label>
  )
}

function Disclosure({ label, detail, open, onToggle, children }: { label: string; detail?: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: `1px solid ${T.border}` }}>
      <button type="button" onClick={onToggle} style={{ width: '100%', minHeight: 45, padding: '0 15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'transparent', border: 0, color: T.text, cursor: 'pointer', textAlign: 'left' }}>
        <span><span style={{ display: 'block', fontFamily: T.label, fontSize: 10, fontWeight: 760 }}>{label}</span>{detail && <span style={{ display: 'block', marginTop: 2, fontFamily: T.label, fontSize: 8.5, color: T.muted }}>{detail}</span>}</span>
        {open ? <ChevronDown size={14} color={T.muted} /> : <ChevronRight size={14} color={T.muted} />}
      </button>
      {open && children}
    </div>
  )
}

function StepHeader({ step, title, detail }: { step: StepKey; title: string; detail: string }) {
  return (
    <div style={{ padding: '18px 19px 15px', borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.gold }}>STEP {step}</span>
        <h2 style={{ margin: 0, fontFamily: T.label, fontSize: 18, fontWeight: 780, letterSpacing: '-0.02em', color: T.text }}>{title}</h2>
      </div>
      <p style={{ maxWidth: 680, margin: '6px 0 0', fontFamily: T.label, fontSize: 10, lineHeight: 1.55, color: T.muted }}>{detail}</p>
    </div>
  )
}

function DriverChart({ values, onPointChange }: { values: number[]; onPointChange: (index: number, value: number) => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const domainRef = useRef({ low: 0, high: 1 })
  const width = 420
  const height = 68
  if (!values.length) return null
  const rawLow = Math.min(...values)
  const rawHigh = Math.max(...values)
  const padding = Math.max((rawHigh - rawLow) * .25, Math.max(Math.abs(rawLow), Math.abs(rawHigh)) * .12, 2)
  const freshDomain = { low: rawLow - padding, high: rawHigh + padding }
  if (dragIndex == null) domainRef.current = freshDomain
  const { low, high } = dragIndex == null ? freshDomain : domainRef.current
  const point = (value: number, index: number) => {
    const x = 5 + index * (width - 10) / Math.max(values.length - 1, 1)
    const y = 6 + (high - value) * (height - 14) / Math.max(high - low, 1)
    return [x, y]
  }
  const path = values.map((value, index) => `${index ? 'L' : 'M'}${point(value, index).join(',')}`).join(' ')
  const updateFromPointer = (clientY: number, index: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const chartY = (clientY - rect.top) / Math.max(rect.height, 1) * height
    const ratio = clamp((chartY - 6) / (height - 14), 0, 1)
    const value = domainRef.current.high - ratio * (domainRef.current.high - domainRef.current.low)
    onPointChange(index, Number(value.toFixed(2)))
  }
  const startDrag = (event: React.PointerEvent<SVGCircleElement>, index: number) => {
    event.preventDefault()
    domainRef.current = freshDomain
    svgRef.current?.setPointerCapture(event.pointerId)
    setDragIndex(index)
    updateFromPointer(event.clientY, index)
  }
  const moveDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragIndex != null) updateFromPointer(event.clientY, dragIndex)
  }
  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
    setDragIndex(null)
  }
  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Editable annual forecast curve" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} style={{ display: 'block', width: '100%', height: 68, touchAction: 'none', userSelect: 'none' }}>
      <line x1="5" y1={height - 6} x2={width - 5} y2={height - 6} stroke={T.border} />
      <path d={path} fill="none" stroke={T.gold} strokeWidth="2" />
      {dragIndex != null && (() => { const [cx] = point(values[dragIndex], dragIndex); return <line x1={cx} x2={cx} y1="4" y2={height - 5} stroke={T.goldTint(45)} strokeWidth="1" /> })()}
      {values.map((value, index) => {
        const [cx, cy] = point(value, index)
        return <g key={index}>
          <circle cx={cx} cy={cy} r={dragIndex === index ? 4.2 : 2.8} fill={T.surface} stroke={T.gold} strokeWidth={dragIndex === index ? 2 : 1.5} pointerEvents="none" />
          <circle cx={cx} cy={cy} r="10" fill="transparent" role="slider" aria-label={`Year ${index + 1}: ${value.toFixed(1)} percent`} aria-valuenow={value} tabIndex={0} onPointerDown={event => startDrag(event, index)} onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            onPointChange(index, Number((value + (event.key === 'ArrowUp' ? .5 : -.5)).toFixed(2)))
          }} style={{ cursor: 'ns-resize' }} />
        </g>
      })}
    </svg>
  )
}

function DriverRow({ driverKey, schedule, view, effect, onCurve, onYear }: {
  driverKey: DriverKey
  schedule: AnnualAssumption[]
  view: DriverView
  effect?: DriverEffect
  onCurve: (key: DriverKey, start: number, end: number) => void
  onYear: (index: number, key: DriverKey, value: number) => void
}) {
  const first = schedule[0]?.[driverKey] ?? 0
  const last = schedule[schedule.length - 1]?.[driverKey] ?? 0
  const effectTone = (effect?.change_per_share ?? 0) >= 0 ? T.pos : T.neg
  return (
    <div className="mv-driver-row" style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr) 130px', gap: 16, padding: '15px 17px', alignItems: 'center', borderBottom: `1px solid ${T.borderFaint}` }}>
      <div>
        <div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 770, color: T.text }}>{DRIVER_LABEL[driverKey]}</div>
        <div style={{ marginTop: 4, fontFamily: T.label, fontSize: 8.5, lineHeight: 1.4, color: T.muted }}>Shape the full forecast from one connected assumption.</div>
      </div>
      {view === 'endpoints' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(100px, 1fr) 78px', gap: 10, alignItems: 'end' }}>
          <Field label="Start" value={first} onChange={value => onCurve(driverKey, value, last)} suffix="%" />
          <DriverChart values={schedule.map(row => row[driverKey])} onPointChange={(index, value) => onYear(index, driverKey, clamp(value, ...DRIVER_LIMITS[driverKey]))} />
          <Field label="End" value={last} onChange={value => onCurve(driverKey, first, value)} suffix="%" />
        </div>
      ) : (
        <div className="mv-year-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${schedule.length}, minmax(51px, 1fr))`, gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
          {schedule.map((row, index) => (
            <label key={row.year} style={{ minWidth: 51 }}>
              <span style={{ ...LABEL, marginBottom: 4, textAlign: 'center', fontSize: 7.5 }}>Y{row.year}</span>
              <input type="number" step={0.5} value={Number(row[driverKey].toFixed(2))} onChange={event => onYear(index, driverKey, +event.target.value)} style={{ ...INPUT, height: 30, padding: '0 3px', textAlign: 'center', fontSize: 9 }} />
            </label>
          ))}
        </div>
      )}
      <div style={{ paddingLeft: 14, borderLeft: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 780, color: effect ? effectTone : T.muted }}>{effect ? `${effect.change_per_share >= 0 ? '+' : '-'}$${Math.abs(effect.change_per_share).toFixed(2)}` : '-'}</div>
        <div style={{ marginTop: 3, fontFamily: T.label, fontSize: 8, lineHeight: 1.4, color: T.muted }}>per share for +{effect?.bump ?? (driverKey === 'growth' || driverKey === 'margin' || driverKey === 'tax_rate' ? 5 : 1)}pp</div>
        {effect && <div style={{ marginTop: 5, fontFamily: T.mono, fontSize: 7.5, color: effect.rank <= 3 ? T.gold : T.muted }}>IMPACT RANK {effect.rank} PER 1PP</div>}
      </div>
    </div>
  )
}

function DriverViewToggle({ value, onChange }: { value: DriverView; onChange: (value: DriverView) => void }) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${T.border}` }}>
      {([['endpoints', 'Endpoints'], ['annual', 'Every year']] as const).map(([key, label]) => <button key={key} type="button" onClick={() => onChange(key)} style={{ ...BUTTON, minHeight: 28, border: 0, borderRight: key === 'endpoints' ? `1px solid ${T.border}` : 0, background: value === key ? T.goldTint(10) : 'transparent', color: value === key ? T.gold : T.muted }}>{label}</button>)}
    </div>
  )
}

export function MasterValuationContent() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [ticker, setTicker] = useState(searchParams.get('ticker') || '')
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null)
  const [revenue, setRevenue] = useState(0)
  const [shares, setShares] = useState(0)
  const [netDebt, setNetDebt] = useState(0)
  const [marketPrice, setMarketPrice] = useState<number | null>(null)
  const [schedule, setSchedule] = useState<AnnualAssumption[]>([])
  const [step, setStep] = useState<StepKey>(1)
  const [driverView, setDriverView] = useState<DriverView>(() => localStorage.getItem('mv-driver-view') === 'annual' ? 'annual' : 'endpoints')
  const [wacc, setWacc] = useState(9.5)
  const [costOfEquity, setCostOfEquity] = useState(10)
  const [terminalGrowth, setTerminalGrowth] = useState(3)
  const [dividendGrowth, setDividendGrowth] = useState(3)
  const [targets, setTargets] = useState<MultipleTarget[]>([])
  const [segments, setSegments] = useState<SotpSegment[]>([])
  const [weights, setWeights] = useState<Record<MethodKey, number>>({ dcf: 65, multiples: 35, ddm: 0, sotp: 0 })
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [error, setError] = useState('')
  const [moreCashOpen, setMoreCashOpen] = useState(false)
  const [additionalMethodsOpen, setAdditionalMethodsOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [sensitivityId, setSensitivityId] = useState<SensitivityKey>('discount_rate')
  const [aiSuggestion, setAiSuggestion] = useState<AiSuggestion | null>(null)
  const [aiThesisOpen, setAiThesisOpen] = useState(false)
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [aiRegenerating, setAiRegenerating] = useState(false)
  const [aiPreview, setAiPreview] = useState<number | null>(null)
  const requestVersion = useRef(0)
  const loadVersion = useRef(0)

  const buildRequest = () => ({
    ticker,
    revenue,
    shares,
    net_debt: netDebt,
    market_price: marketPrice,
    wacc,
    cost_of_equity: costOfEquity,
    schedule,
    terminal: { perpetual_growth: terminalGrowth },
    multiple_targets: targets,
    sotp_segments: segments,
    weights,
    dividend_terminal_growth: dividendGrowth,
  })

  const runModel = async () => {
    if (!fundamentals) return
    const invalidMessage = schedule.length < 3
      ? 'The forecast requires at least three annual periods.'
      : revenue <= 0
        ? 'Base revenue must be greater than zero.'
        : shares <= 0
          ? 'Share count must be greater than zero.'
          : wacc <= terminalGrowth
            ? 'WACC must be greater than perpetual growth.'
            : schedule.some(row => row.payout_pct > 0) && costOfEquity <= dividendGrowth
              ? 'Cost of equity must be greater than dividend terminal growth.'
              : ''
    if (invalidMessage) {
      requestVersion.current += 1
      setCalculating(false)
      setAnalysis(null)
      setError(invalidMessage)
      return
    }
    const version = ++requestVersion.current
    setCalculating(true)
    try {
      const { data } = await axios.post<Analysis>('/api/master-valuation/analyze', buildRequest())
      if (version === requestVersion.current) { setAnalysis(data); setError('') }
    } catch (reason) {
      if (version === requestVersion.current) {
        setAnalysis(null)
        setError(apiErrorMessage(reason, 'Unable to run the valuation model.'))
      }
    } finally {
      if (version === requestVersion.current) setCalculating(false)
    }
  }

  const loadTicker = async (symbol?: string) => {
    const nextTicker = (symbol || ticker).trim().toUpperCase()
    if (!nextTicker) return
    const version = ++loadVersion.current
    setLoading(true)
    setError('')
    setAnalysis(null)
    setAiSuggestion(null)
    try {
      const { data } = await axios.get<Fundamentals>('/api/master-valuation/fundamentals', { params: { ticker: nextTicker } })
      if (version !== loadVersion.current) return
      setTicker(nextTicker)
      setFundamentals(data)
      setStep(1)
      setRevenue(data.revenue)
      setShares(data.shares)
      setNetDebt(data.net_debt)
      setMarketPrice(data.market_price)
      const normalizedSchedule = data.schedule.map(row => ({ ...row, fcf_conversion_pct: row.fcf_conversion_pct ?? 100, net_interest_pct: row.net_interest_pct ?? 0 }))
      const seededTargets: MultipleTarget[] = []
      if ((data.current_multiples.ev_revenue || 0) > 0) seededTargets.push({ metric: 'ev_revenue', multiple: clamp(data.current_multiples.ev_revenue!, .01, 200), weight: 50, year: 3 })
      if ((data.current_multiples.ev_ebitda || 0) > 0) seededTargets.push({ metric: 'ev_ebitda', multiple: clamp(data.current_multiples.ev_ebitda!, .01, 200), weight: 50, year: 3 })
      const paysDividend = Boolean(data.dividend_per_share && data.dividend_per_share > 0)
      if (paysDividend) {
        const payout = clamp(((data.dividend_per_share || 0) * data.shares) / Math.max(data.revenue * Math.max(normalizedSchedule[0]?.margin || 10, 1) / 100 * .79, 1) * 100, 0, 80)
        normalizedSchedule.forEach(row => { row.payout_pct = Number(payout.toFixed(1)) })
      }
      setSchedule(normalizedSchedule)
      setTargets(seededTargets)
      setSegments((data.business_segments || []).map(segment => ({ ...segment })))
      setWacc(9.5)
      setCostOfEquity(10)
      setTerminalGrowth(3)
      setDividendGrowth(3)
      const multiplesWeight = seededTargets.length ? 35 : 0
      setWeights({ dcf: 100 - multiplesWeight, multiples: multiplesWeight, ddm: 0, sotp: 0 })
      recordRecentTicker(nextTicker)
      setSearchParams({ ticker: nextTicker }, { replace: true })
    } catch (reason) {
      if (version === loadVersion.current) setError(apiErrorMessage(reason, 'Unable to load company fundamentals.'))
    } finally {
      if (version === loadVersion.current) setLoading(false)
    }
  }

  const suggestedSchedule = (suggestion: AiSuggestion) => schedule.map((row, index) => {
    const growth = index < 3 ? suggestion.growth[0] : index < 7 ? suggestion.growth[1] : suggestion.growth[2]
    const margin = schedule.length <= 1 ? suggestion.margin : schedule[0].margin + (suggestion.margin - schedule[0].margin) * index / (schedule.length - 1)
    return { ...row, growth, margin: Number(margin.toFixed(2)), tax_rate: suggestion.tax }
  })

  const suggestAdjustments = async (regenerate = false) => {
    if (!fundamentals) return
    setAiSuggesting(true)
    setAiRegenerating(regenerate)
    setAiPreview(null)
    setAiThesisOpen(false)
    try {
      const { data: context } = await axios.get('/api/dcf/fundamentals', { params: { ticker } })
      const { data } = await axios.post('/api/ai/dcf-assumptions', {
        ticker,
        revenue,
        op_margin: schedule[0]?.margin ?? context.op_margin,
        rev_growth: schedule[0]?.growth ?? context.rev_growth,
        beta: fundamentals.beta ?? context.beta ?? 1,
        sector: context.sector ?? '',
        wacc,
        tax_rate: schedule[0]?.tax_rate ?? 21,
        regenerate,
      })
      const suggestedWacc = clamp(Number(data.wacc ?? wacc), 1, 50)
      const suggestion: AiSuggestion = {
        growth: [data.rev_growth_1 ?? 15, data.rev_growth_2 ?? 10, data.rev_growth_3 ?? 5].map(value => clamp(Number(value), -75, 200)) as [number, number, number],
        margin: clamp(Number(data.target_margin ?? schedule[schedule.length - 1]?.margin ?? 15), -100, 100),
        tax: clamp(Number(data.tax_rate ?? schedule[0]?.tax_rate ?? 21), 0, 60),
        wacc: suggestedWacc,
        terminalGrowth: clamp(Number(data.terminal_growth ?? terminalGrowth), -10, Math.min(15, suggestedWacc - .25)),
        thesis: data.thesis,
        cached: data.cache_meta?.cached,
      }
      setAiSuggestion(suggestion)
      const previewRequest = buildRequest()
      previewRequest.schedule = suggestedSchedule(suggestion)
      previewRequest.wacc = suggestion.wacc
      previewRequest.terminal.perpetual_growth = suggestion.terminalGrowth
      if (previewRequest.wacc > previewRequest.terminal.perpetual_growth) {
        const { data: preview } = await axios.post<Analysis>('/api/master-valuation/analyze', previewRequest)
        setAiPreview(preview.composite.value_per_share)
      }
    } catch (reason) {
      setError(apiErrorMessage(reason, 'AI filing analysis failed. Try again.'))
    } finally {
      setAiSuggesting(false)
      setAiRegenerating(false)
    }
  }

  const applyAiSuggestion = () => {
    if (!aiSuggestion) return
    setSchedule(suggestedSchedule(aiSuggestion))
    setWacc(aiSuggestion.wacc)
    setTerminalGrowth(aiSuggestion.terminalGrowth)
    setAiSuggestion(null)
    setAiPreview(null)
  }

  useEffect(() => {
    if (!fundamentals || loading || schedule.length < 3) return
    const timer = window.setTimeout(() => { void runModel() }, 320)
    return () => window.clearTimeout(timer)
  }, [fundamentals, revenue, shares, netDebt, marketPrice, schedule, wacc, costOfEquity, terminalGrowth, dividendGrowth, targets, segments, weights])

  useEffect(() => {
    const symbol = searchParams.get('ticker')
    if (symbol && !fundamentals) void loadTicker(symbol)
  }, [])

  useEffect(() => { localStorage.setItem('mv-driver-view', driverView) }, [driverView])

  const updateYear = (index: number, key: DriverKey, value: number) => setSchedule(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row))
  const applyCurve = (key: DriverKey, start: number, end: number) => setSchedule(rows => rows.map((row, index) => ({ ...row, [key]: Number((start + (end - start) * index / Math.max(rows.length - 1, 1)).toFixed(2)) })))
  const resizeSchedule = (years: number) => setSchedule(rows => {
    if (years <= rows.length) return rows.slice(0, years).map((row, index) => ({ ...row, year: index + 1 }))
    const last = rows[rows.length - 1]
    if (!last) return rows
    return [...rows, ...Array.from({ length: years - rows.length }, (_, index) => ({ ...last, year: rows.length + index + 1, growth: Math.max(terminalGrowth, last.growth - (index + 1) * .5) }))]
  })
  const adoptSchedule = (key: 'growth' | 'margin', values: number[] | null | undefined) => {
    if (values) setSchedule(rows => rows.map((row, index) => ({ ...row, [key]: Number(values[index].toFixed(2)) })))
  }
  const updateMethodWeight = (key: MethodKey, value: number) => setWeights(current => {
    const next = { ...current, [key]: clamp(value, 0, 100) }
    if (Object.values(next).reduce((sum, weight) => sum + weight, 0) <= 0) next[key] = 1
    return next
  })
  const addMultipleTarget = () => {
    const seededMultiple = targets.find(target => target.metric === 'ev_ebitda')?.multiple
      ?? fundamentals?.current_multiples.ev_ebitda
      ?? 16
    setTargets(rows => [...rows, {
      metric: 'ev_ebitda',
      multiple: clamp(seededMultiple, .01, 200),
      weight: rows.length ? 25 : 100,
      year: Math.min(3, schedule.length),
    }])
    setWeights(current => {
      if (current.multiples > 0) return current
      const coreTotal = current.dcf + current.multiples || 100
      const multiplesWeight = Math.min(35, coreTotal)
      return { ...current, dcf: coreTotal - multiplesWeight, multiples: multiplesWeight }
    })
  }
  const removeMultipleTarget = (index: number) => {
    setTargets(rows => rows.filter((_, rowIndex) => rowIndex !== index))
    if (targets.length === 1) setWeights(current => ({ ...current, dcf: Math.min(100, current.dcf + current.multiples), multiples: 0 }))
  }
  const updateMultipleWeight = (index: number, value: number) => setTargets(rows => {
    const next = rows.map((row, rowIndex) => rowIndex === index ? { ...row, weight: clamp(value, 0, 100) } : row)
    if (next.every(row => row.weight <= 0)) next[index].weight = 1
    return next
  })
  const updateCoreBlend = (dcfShare: number) => setWeights(current => {
    const coreTotal = current.dcf + current.multiples || 100
    return {
      ...current,
      dcf: Number((coreTotal * clamp(dcfShare, 0, 100) / 100).toFixed(2)),
      multiples: Number((coreTotal * (100 - clamp(dcfShare, 0, 100)) / 100).toFixed(2)),
    }
  })
  const adoptImpliedMultiple = () => {
    const implied = analysis?.reverse.implied_exit_multiple
    if (implied == null) return
    const year = clamp(analysis?.reverse.implied_exit_year || Math.min(3, schedule.length), 1, schedule.length)
    const existingIndex = targets.findIndex(target => target.metric === 'ev_ebitda')
    if (existingIndex >= 0) {
      setTargets(rows => rows.map((row, index) => index === existingIndex ? { ...row, multiple: Number(implied.toFixed(2)), year } : row))
    } else {
      setTargets(rows => [...rows, { metric: 'ev_ebitda', multiple: Number(clamp(implied, .01, 200).toFixed(2)), weight: 100, year }])
      setWeights(current => current.multiples > 0 ? current : { ...current, dcf: 65, multiples: 35 })
    }
    setStep(5)
  }

  const capture = (): ClipDraft[] | null => !analysis ? null : [
    { sourceTab: 'Master Valuation', dataType: 'kpi', payload: { kind: 'kpi', title: `${ticker} Master Valuation`, cells: [
      { label: 'Blended Value', value: fmtMoney(analysis.composite.value_per_share) }, { label: 'Market Price', value: fmtMoney(marketPrice) },
      { label: 'DCF', value: fmtMoney(analysis.dcf.value_per_share) }, { label: 'Multiples', value: fmtMoney(analysis.multiples.value_per_share) },
      { label: 'Dividend', value: fmtMoney(analysis.ddm.value_per_share) }, { label: 'SOTP', value: fmtMoney(analysis.sotp.value_per_share) },
    ] } },
    { sourceTab: 'Master Valuation', dataType: 'table', payload: { kind: 'table', title: `${ticker} Connected Cash Flow Schedule`, columns: ['Year', 'Growth', 'Margin', 'Revenue', 'FCF', 'Shares'], rows: analysis.rows.map(row => [row.year, `${row.growth.toFixed(1)}%`, `${row.margin.toFixed(1)}%`, fmtM(row.revenue), fmtM(row.fcf), `${row.shares.toFixed(1)}M`]) } },
  ]
  useReportCapture(capture, { disabled: !analysis, sourceTab: 'Master Valuation' })

  const selectedCagr = useMemo(() => schedule.length ? (Math.pow(schedule.reduce((product, row) => product * (1 + row.growth / 100), 1), 1 / schedule.length) - 1) * 100 : 0, [schedule])
  const connectedValue = analysis?.composite.value_per_share ?? null
  const upside = connectedValue != null && marketPrice ? (connectedValue / marketPrice - 1) * 100 : null
  const rangeLow = analysis?.composite.range_low ?? 0
  const rangeHigh = analysis?.composite.range_high ?? 0
  const rangeSpan = Math.max(rangeHigh - rangeLow, 1)
  const pricePct = marketPrice == null ? null : clamp((marketPrice - rangeLow) / rangeSpan * 100, 0, 100)
  const valuePct = connectedValue == null ? null : clamp((connectedValue - rangeLow) / rangeSpan * 100, 0, 100)
  const methodValues = analysis ? (Object.keys(analysis.methods) as MethodKey[]).map(key => analysis.active_weights[key] ? analysis.methods[key] : null).filter((value): value is number => value != null && Number.isFinite(value)) : []
  const methodSpread = methodValues.length > 1 ? Math.max(...methodValues) - Math.min(...methodValues) : 0
  const spreadWarning = connectedValue != null && methodSpread > connectedValue * .4
  const marketCap = marketPrice == null ? null : marketPrice * shares
  const enterpriseValue = marketCap == null ? null : marketCap + netDebt
  const lastSchedule = schedule[schedule.length - 1]
  const lastRow = analysis?.rows[analysis.rows.length - 1]
  const status = calculating ? 'RECONCILING' : analysis ? 'MODEL LIVE' : error ? 'CHECK INPUTS' : fundamentals ? 'MODEL READY' : 'LOAD A COMPANY'
  const statusColor = calculating ? T.gold : analysis ? T.pos : error ? T.neg : T.muted
  const coreWeightTotal = weights.dcf + weights.multiples
  const dcfBlend = coreWeightTotal > 0 ? weights.dcf / coreWeightTotal * 100 : 100

  const steps: Array<{ key: StepKey; label: string; sub: string }> = [
    { key: 1, label: 'Business today', sub: fundamentals ? `${fmtM(revenue)} revenue` : 'Load the baseline' },
    { key: 2, label: 'Growth & profit', sub: schedule.length ? `${selectedCagr.toFixed(1)}% CAGR to ${lastSchedule?.margin.toFixed(1)}% margin` : 'Shape the forecast' },
    { key: 3, label: 'Cash from profit', sub: analysis ? `${fmtM(lastRow?.fcf)} year ${schedule.length} FCF` : 'Build the cash bridge' },
    { key: 4, label: 'Intrinsic DCF', sub: analysis ? `${fmtMoney(analysis.dcf.value_per_share)} standalone value` : `${wacc.toFixed(1)}% WACC, ${terminalGrowth.toFixed(1)}% terminal growth` },
    { key: 5, label: 'Multiples & blend', sub: connectedValue == null ? 'Build the market method' : `${fmtMoney(connectedValue)} blended value` },
  ]

  const stepDrivers = (drivers: DriverKey[]) => drivers.map(key => <DriverRow key={key} driverKey={key} schedule={schedule} view={driverView} effect={analysis?.driver_effects[key]} onCurve={applyCurve} onYear={updateYear} />)

  const renderMultiplesBuilder = () => (
    <div style={{ padding: '16px 18px 18px', borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
        <div><div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 780, color: T.text }}>Standalone market valuation</div><div style={{ maxWidth: 650, marginTop: 4, fontFamily: T.label, fontSize: 9, lineHeight: 1.5, color: T.muted }}>Choose the multiples you trust. Each target produces a complete present value. Their internal weights create one market-method value.</div></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><div style={{ textAlign: 'right' }}><div style={LABEL}>Multiples value</div><div style={{ fontFamily: T.mono, fontSize: 19, fontWeight: 790, color: T.blue }}>{fmtMoney(analysis?.multiples.value_per_share)}</div></div><button type="button" onClick={addMultipleTarget} style={{ ...BUTTON, borderColor: T.blue, color: T.blue }}><Plus size={11} /> Add multiple</button></div>
      </div>
      <div style={{ marginTop: 13, overflowX: 'auto' }}>
        {targets.length > 0 && <div className="mv-target-row" style={{ minWidth: 650, display: 'grid', gridTemplateColumns: '1.35fr .68fr .58fr .68fr .8fr 28px', gap: 5, padding: '0 0 5px' }}>{['Metric', 'Target', 'Year', 'Weight', 'Value / share', ''].map(label => <div key={label} style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 780, letterSpacing: '.08em', textTransform: 'uppercase', color: T.muted }}>{label}</div>)}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {targets.map((target, index) => {
            const line = analysis?.multiples.lines[index]
            return <div key={`${target.metric}-${index}`} className="mv-target-row" style={{ minWidth: 650, display: 'grid', gridTemplateColumns: '1.35fr .68fr .58fr .68fr .8fr 28px', gap: 5, alignItems: 'center' }}>
              <select aria-label={`Multiple metric ${index + 1}`} value={target.metric} onChange={event => setTargets(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, metric: event.target.value as MetricKey } : row))} style={{ ...INPUT, height: 31 }}>{Object.entries(METRIC_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
              <input aria-label={`Target multiple ${index + 1}`} type="number" min={.01} max={200} step={.5} value={target.multiple} onChange={event => setTargets(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, multiple: +event.target.value } : row))} style={{ ...INPUT, height: 31, padding: '0 6px' }} />
              <input aria-label={`Forecast year ${index + 1}`} type="number" min={1} max={schedule.length} value={target.year} onChange={event => setTargets(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, year: clamp(+event.target.value, 1, schedule.length) } : row))} style={{ ...INPUT, height: 31, padding: '0 6px' }} />
              <input aria-label={`Within-method weight ${index + 1}`} type="number" min={0} max={100} value={target.weight} onChange={event => updateMultipleWeight(index, +event.target.value)} style={{ ...INPUT, height: 31, padding: '0 6px' }} />
              <div style={{ padding: '0 8px', fontFamily: T.mono, fontSize: 11, fontWeight: 770, color: T.text }}>{fmtMoney(line?.value_per_share)}<span style={{ display: 'block', marginTop: 2, fontSize: 7, fontWeight: 500, color: T.muted }}>{line ? `${line.effective_weight.toFixed(0)}% OF METHOD` : 'CALCULATING'}</span></div>
              <button type="button" aria-label={`Remove multiple ${index + 1}`} onClick={() => removeMultipleTarget(index)} style={{ ...BUTTON, minHeight: 31, padding: 0 }}><Trash2 size={11} /></button>
            </div>
          })}
          {!targets.length && <button type="button" onClick={addMultipleTarget} style={{ minHeight: 68, width: '100%', background: 'color-mix(in srgb, var(--theme-tertiary) 3%, transparent)', border: '1px dashed color-mix(in srgb, var(--theme-tertiary) 30%, transparent)', color: T.muted, fontFamily: T.label, fontSize: 9, cursor: 'pointer' }}>Add EV / Revenue or EV / EBITDA to build the standalone market method.</button>}
        </div>
      </div>
    </div>
  )

  const renderAdditionalMethods = () => (
    <div className="mv-crosschecks" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: `1px solid ${T.border}` }}>
      <div style={{ padding: 15, borderRight: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 770 }}>Dividend method</div><div style={{ marginTop: 3, fontFamily: T.label, fontSize: 8.5, lineHeight: 1.5, color: T.muted }}>Available when the forecast includes a payout. This remains separate from both DCF and market multiples.</div>
        <div style={{ marginTop: 12, fontFamily: T.mono, fontSize: 18, fontWeight: 780, color: T.text }}>{fmtMoney(analysis?.ddm.value_per_share)}</div>
        <div className="mv-two-fields" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}><Field label="Cost of equity" value={costOfEquity} onChange={setCostOfEquity} step={.25} suffix="%" /><Field label="Dividend growth" value={dividendGrowth} onChange={setDividendGrowth} step={.25} suffix="%" /></div>
        <input aria-label="Dividend value weight" type="range" min={0} max={100} step={5} value={weights.ddm} disabled={analysis?.ddm.value_per_share == null} onChange={event => updateMethodWeight('ddm', +event.target.value)} style={{ width: '100%', marginTop: 13, accentColor: T.gold }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.label, fontSize: 8, color: T.muted }}><span>Final blend weight</span><span style={{ fontFamily: T.mono }}>{(analysis?.active_weights.ddm || 0).toFixed(0)}% effective</span></div>
      </div>
      <div style={{ padding: 15 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><div><div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 770 }}>Parts method</div><div style={{ marginTop: 3, fontFamily: T.label, fontSize: 8.5, color: T.muted }}>{fundamentals?.business_segments?.length ? `${fundamentals.business_segments.length} reported segments auto-loaded${fundamentals.business_segments_fiscal_year ? ` · FY${fundamentals.business_segments_fiscal_year}` : ''}${fundamentals.business_segments_source ? ` · ${fundamentals.business_segments_source}` : ''}. Edit the shares or P/S assumptions before adding this method to the blend.` : 'Use when distinct businesses deserve separate revenue multiples.'}</div></div><div style={{ display: 'flex', gap: 6 }}>{fundamentals?.business_segments?.length ? <button type="button" onClick={() => setSegments(fundamentals.business_segments.map(segment => ({ ...segment })))} style={BUTTON}><RefreshCw size={10} /> Reset</button> : null}<button type="button" onClick={() => { setSegments(rows => [...rows, { name: `Segment ${rows.length + 1}`, revenue_share: rows.length ? 25 : 100, price_to_sales_multiple: 5 }]); setWeights(current => ({ ...current, sotp: current.sotp || 10 })) }} style={BUTTON}><Plus size={11} /> Add part</button></div></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 11 }}>
          {segments.length > 0 && <div className="mv-segment-row" style={{ display: 'grid', gridTemplateColumns: '1fr .55fr .62fr 28px', gap: 5 }}>{['Segment', 'Revenue %', 'P / S', ''].map(label => <div key={label} style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 780, letterSpacing: '.08em', textTransform: 'uppercase', color: T.muted }}>{label}</div>)}</div>}
          {segments.map((segment, index) => <div key={index} className="mv-segment-row" style={{ display: 'grid', gridTemplateColumns: '1fr .55fr .62fr 28px', gap: 5 }}><input aria-label="Segment name" value={segment.name} onChange={event => setSegments(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} style={{ ...INPUT, height: 29 }} /><input aria-label="Revenue share" type="number" value={segment.revenue_share} onChange={event => setSegments(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, revenue_share: +event.target.value } : row))} style={{ ...INPUT, height: 29 }} /><input aria-label="Price to sales multiple" type="number" step={.5} value={segment.price_to_sales_multiple} onChange={event => setSegments(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, price_to_sales_multiple: +event.target.value } : row))} style={{ ...INPUT, height: 29 }} /><button type="button" aria-label="Remove segment" onClick={() => setSegments(rows => rows.filter((_, rowIndex) => rowIndex !== index))} style={{ ...BUTTON, minHeight: 29, padding: 0 }}><Trash2 size={11} /></button></div>)}
          {!segments.length && <div style={{ padding: 12, border: `1px dashed ${T.border}`, fontFamily: T.label, fontSize: 9, lineHeight: 1.5, color: T.muted }}>No parts valuation is active.</div>}
          {segments.length > 0 && <><div style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>Revenue shares normalize to 100%. Current input total {segments.reduce((sum, segment) => sum + segment.revenue_share, 0).toFixed(0)}%.</div><input aria-label="Parts value weight" type="range" min={0} max={100} step={5} value={weights.sotp} onChange={event => updateMethodWeight('sotp', +event.target.value)} style={{ width: '100%', marginTop: 5, accentColor: T.gold }} /><div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.label, fontSize: 8, color: T.muted }}><span>{fmtMoney(analysis?.sotp.value_per_share)} parts value</span><span style={{ fontFamily: T.mono }}>{(analysis?.active_weights.sotp || 0).toFixed(0)}% effective</span></div></>}
        </div>
      </div>
    </div>
  )

  return (
    <div className="mv-page" style={{ padding: '0 14px 38px', color: T.text }}>
      <div className="mv-toolbar" style={{ ...PANEL, minHeight: 58, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', marginBottom: 8 }}>
        <TickerInput value={ticker} onChange={setTicker} onEnter={() => void loadTicker()} placeholder="Ticker" style={{ ...INPUT, width: 130, height: 32, fontWeight: 800 }} />
        <button type="button" onClick={() => void loadTicker()} disabled={loading || !ticker.trim()} style={{ ...PRIMARY_BUTTON, opacity: loading || !ticker.trim() ? .45 : 1 }}>{loading ? 'Fetching...' : 'Fetch financials'}</button>
        <button type="button" onClick={() => void suggestAdjustments(false)} disabled={!fundamentals || aiSuggesting} style={{ ...BUTTON, borderColor: fundamentals ? T.gold : T.border, color: fundamentals ? T.gold : T.muted, opacity: !fundamentals || aiSuggesting ? .45 : 1 }}><Sparkles size={12} />{aiSuggesting && !aiRegenerating ? 'Reading filing...' : 'AI suggest adjustments'}</button>
        <div className="mv-toolbar-source" style={{ minWidth: 0, marginLeft: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: T.label, fontSize: 8.5, color: T.muted }}>{fundamentals?.source || 'Load the latest financial statements to begin'}</div>
        <div className="mv-toolbar-status" style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 7, fontFamily: T.mono, fontSize: 9.5, color: statusColor }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />{status}</div>
      </div>

      {aiSuggestion && <section style={{ ...PANEL, marginBottom: 8, borderColor: T.goldTint(42) }}>
        <div className="mv-ai-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, padding: '14px 16px 12px', borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.label, fontSize: 10.5, fontWeight: 780, color: T.gold }}><Sparkles size={13} /> Filing-based adjustments</div>
            <div style={{ maxWidth: 800, marginTop: 5, fontFamily: T.label, fontSize: 9.5, lineHeight: 1.55, color: T.muted }}>{aiSuggestion.thesis?.summary || 'Review the filing-based assumptions before writing them into your model.'}</div>
            <div style={{ marginTop: 5, fontFamily: T.mono, fontSize: 7.5, color: T.muted }}>{aiSuggestion.cached ? 'CACHED FROM THE LATEST STATEMENT' : 'NEW ANALYSIS OF THE LATEST STATEMENT'}</div>
          </div>
          <button type="button" aria-label="Dismiss AI suggestions" onClick={() => { setAiSuggestion(null); setAiPreview(null) }} style={{ ...BUTTON, minWidth: 31, padding: 0 }}><X size={13} /></button>
        </div>
        <div className="mv-ai-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', borderBottom: `1px solid ${T.border}` }}>
          {[
            ['Revenue growth path', `${schedule[0]?.growth.toFixed(1) ?? '-'}%`, `${aiSuggestion.growth.map(value => value.toFixed(1)).join(' / ')}%`],
            [`Year ${schedule.length} margin`, `${lastSchedule?.margin.toFixed(1) ?? '-'}%`, `${aiSuggestion.margin.toFixed(1)}%`],
            ['Normalized tax', `${schedule[0]?.tax_rate.toFixed(1) ?? '-'}%`, `${aiSuggestion.tax.toFixed(1)}%`],
            ['WACC', `${wacc.toFixed(1)}%`, `${aiSuggestion.wacc.toFixed(1)}%`],
            ['Terminal growth', `${terminalGrowth.toFixed(1)}%`, `${aiSuggestion.terminalGrowth.toFixed(1)}%`],
          ].map(([label, before, after], index) => <div key={label} style={{ padding: '12px 15px', borderRight: index < 4 ? `1px solid ${T.border}` : undefined }}><div style={LABEL}>{label}</div><div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>{before}</span><span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>-&gt;</span><span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 770, color: T.gold }}>{after}</span></div></div>)}
        </div>
        {aiSuggestion.thesis && <Disclosure label="Filing evidence, risks, and watch items" detail="The statement evidence behind the proposed assumption changes." open={aiThesisOpen} onToggle={() => setAiThesisOpen(open => !open)}>
          <div className="mv-ai-thesis" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', borderTop: `1px solid ${T.border}` }}>
            {[
              ['Evidence', aiSuggestion.thesis.evidence || [], T.pos],
              ['Risks', aiSuggestion.thesis.risks || [], T.neg],
              ['Watch next', aiSuggestion.thesis.watch_items || [], T.gold],
            ].map(([label, items, tone], column) => <div key={String(label)} style={{ padding: '12px 15px 14px', borderRight: column < 2 ? `1px solid ${T.border}` : 0 }}><div style={{ ...LABEL, color: tone as string }}>{label as string}</div>{(items as string[]).map((item, index) => <div key={index} style={{ marginTop: index ? 7 : 0, fontFamily: T.label, fontSize: 9, lineHeight: 1.5, color: T.muted }}>- {item}</div>)}</div>)}
          </div>
        </Disclosure>}
        <div className="mv-ai-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 15px' }}>
          {aiPreview != null && <div style={{ marginRight: 'auto', fontFamily: T.label, fontSize: 9.5, color: T.muted }}>Preview connected value <strong style={{ marginLeft: 5, fontFamily: T.mono, fontSize: 13, color: T.text }}>{fmtMoney(aiPreview)}</strong></div>}
          <button type="button" onClick={() => void suggestAdjustments(true)} disabled={aiSuggesting} style={BUTTON}><RefreshCw size={11} />{aiRegenerating ? 'Regenerating...' : 'Regenerate'}</button>
          <button type="button" onClick={() => { setAiSuggestion(null); setAiPreview(null) }} style={BUTTON}>Dismiss</button>
          <button type="button" onClick={applyAiSuggestion} style={PRIMARY_BUTTON}><Check size={11} /> Apply all</button>
        </div>
      </section>}

      {fundamentals && <nav className="mv-step-nav" aria-label="Valuation model steps" style={{ ...PANEL, display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', marginBottom: 8, overflowX: 'auto' }}>
        {steps.map((item, index) => {
          const active = item.key === step
          return <button key={item.key} type="button" onClick={() => setStep(item.key)} style={{ minWidth: 150, padding: '11px 13px 10px', textAlign: 'left', background: active ? T.goldTint(9) : 'transparent', border: 0, borderRight: index < 4 ? `1px solid ${T.border}` : 0, borderBottom: active ? `2px solid ${T.gold}` : '2px solid transparent', color: T.text, cursor: 'pointer' }}>
            <span style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}><span style={{ fontFamily: T.mono, fontSize: 8, color: active ? T.gold : T.muted }}>{item.key}</span><span style={{ fontFamily: T.label, fontSize: 9.5, fontWeight: 770, color: active ? T.gold : T.text }}>{item.label}</span></span>
            <span style={{ display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: T.label, fontSize: 8, color: T.muted }}>{item.sub}</span>
          </button>
        })}
      </nav>}

      {!fundamentals ? loading
        ? <EmptyState title={`${ticker} Model`} hint="Fetching financials and assembling the connected valuation." variant="loading" />
        : error
          ? <EmptyState title="Master Valuation" hint={error} variant="unavailable" onRetry={() => void loadTicker()} />
          : <EmptyState title="Master Valuation" hint="Enter a ticker above, then load its latest financials to build the connected model." action="Fetch Financials" />
        : <div className="mv-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 400px', gap: 8, alignItems: 'start' }}>
        <main style={PANEL}>
          {step === 1 && <>
            <StepHeader step={1} title="Start with the business today" detail="Set the four facts every valuation method shares. The derived market anchors update immediately." />
            <div className="mv-four-fields" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, padding: 18 }}>
              <Field label="Base revenue" value={revenue} onChange={setRevenue} step={100} suffix="$M" />
              <Field label="Diluted shares" value={shares} onChange={setShares} step={1} suffix="M" />
              <Field label="Net debt" value={netDebt} onChange={setNetDebt} step={100} suffix="$M" />
              <Field label="Market price" value={marketPrice || 0} onChange={value => setMarketPrice(value || null)} step={.5} suffix="$" />
            </div>
            <div className="mv-three-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', borderTop: `1px solid ${T.border}` }}>
              {[
                ['Market capitalization', fmtM(marketCap), 'Price multiplied by diluted shares'],
                ['Enterprise value', fmtM(enterpriseValue), 'Market capitalization plus net debt'],
                ['Current EV / revenue', enterpriseValue == null || revenue <= 0 ? '-' : `${(enterpriseValue / revenue).toFixed(1)}x`, 'Current market anchor'],
              ].map(([label, value, detail], index) => <div key={label} style={{ padding: '16px 18px', borderRight: index < 2 ? `1px solid ${T.border}` : 0 }}><div style={LABEL}>{label}</div><div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 780, color: T.text }}>{value}</div><div style={{ marginTop: 5, fontFamily: T.label, fontSize: 8.5, color: T.muted }}>{detail}</div></div>)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 15, borderTop: `1px solid ${T.border}` }}><button type="button" onClick={() => setStep(2)} style={PRIMARY_BUTTON}>Shape growth and profit <ChevronRight size={12} /></button></div>
          </>}

          {step === 2 && <>
            <StepHeader step={2} title="Shape growth and profit" detail="Start with endpoints for a readable operating story. Open every year only when the path needs precision." />
            <div className="mv-step-tools" style={{ minHeight: 48, padding: '8px 15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><label><span style={{ ...LABEL, display: 'inline', margin: 0 }}>Forecast horizon</span><select value={schedule.length} onChange={event => resizeSchedule(+event.target.value)} style={{ ...INPUT, width: 72, height: 28, marginLeft: 8 }}>{[3, 5, 7, 10, 12, 15, 20].map(years => <option key={years} value={years}>{years}Y</option>)}</select></label></div>
              <DriverViewToggle value={driverView} onChange={setDriverView} />
            </div>
            {stepDrivers(['growth', 'margin', 'tax_rate'])}
            {analysis && <div className="mv-four-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', borderTop: `1px solid ${T.border}` }}>
              {[
                ['Year 1 revenue', fmtM(analysis.rows[0]?.revenue)], [`Year ${schedule.length} revenue`, fmtM(lastRow?.revenue)],
                [`Year ${schedule.length} FCF`, fmtM(lastRow?.fcf)], ['Forecast CAGR', `${selectedCagr.toFixed(1)}%`],
              ].map(([label, value], index) => <div key={label} style={{ padding: '13px 15px', borderRight: index < 3 ? `1px solid ${T.border}` : 0 }}><div style={LABEL}>{label}</div><div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 770, color: index === 3 ? T.gold : T.text }}>{value}</div></div>)}
            </div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 13, borderTop: `1px solid ${T.border}` }}><button type="button" onClick={() => setStep(3)} style={PRIMARY_BUTTON}>Build the cash bridge <ChevronRight size={12} /></button></div>
          </>}

          {step === 3 && <>
            <StepHeader step={3} title="Turn profit into cash" detail="Reinvestment and accounting bridges explain how operating profit becomes free cash flow." />
            <div className="mv-step-tools" style={{ minHeight: 48, padding: '8px 15px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', borderBottom: `1px solid ${T.border}` }}><DriverViewToggle value={driverView} onChange={setDriverView} /></div>
            {stepDrivers(['capex_pct', 'da_pct', 'change_nwc_pct', 'fcf_conversion_pct'])}
            {analysis && <div style={{ padding: '15px 17px', borderTop: `1px solid ${T.border}` }}>
              <div style={{ ...LABEL, marginBottom: 10 }}>Year {schedule.length} profit-to-cash bridge</div>
              <div className="mv-cash-bridge" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(78px, 1fr))', border: `1px solid ${T.border}` }}>
                {[
                  ['NOPAT', lastRow?.nopat], ['+ D&A', lastRow?.da], ['+ SBC', lastRow?.sbc], ['+ Other', lastRow?.cash_adjustment], ['- CapEx', -(lastRow?.capex || 0)], ['- NWC', -(lastRow?.change_nwc || 0)], ['Free cash flow', lastRow?.fcf],
                ].map(([label, value], index) => <div key={String(label)} style={{ padding: '11px 10px', borderRight: index < 6 ? `1px solid ${T.border}` : 0, background: index === 6 ? T.goldTint(8) : 'transparent' }}><div style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>{label}</div><div style={{ marginTop: 5, fontFamily: T.mono, fontSize: 12, fontWeight: 760, color: index === 6 ? T.gold : T.text }}>{fmtM(value as number)}</div></div>)}
              </div>
            </div>}
            <Disclosure label="Remaining ownership and cash drivers" detail="Stock compensation, other cash items, interest, dilution, and payout." open={moreCashOpen} onToggle={() => setMoreCashOpen(open => !open)}><div>{stepDrivers(['sbc_pct', 'cash_adjustment_pct', 'net_interest_pct', 'dilution_pct', 'payout_pct'])}</div></Disclosure>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 13, borderTop: `1px solid ${T.border}` }}><button type="button" onClick={() => setStep(4)} style={PRIMARY_BUTTON}>Complete the intrinsic DCF <ChevronRight size={12} /></button></div>
          </>}

          {step === 4 && <>
            <StepHeader step={4} title="Complete the intrinsic DCF" detail="Discount forecast cash flow and a perpetual-growth terminal value. Market multiples do not enter this method." />
            <div className="mv-two-fields" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, padding: 18 }}>
              <Field label="WACC" value={wacc} onChange={setWacc} step={.25} suffix="%" />
              <Field label="Terminal growth" value={terminalGrowth} onChange={setTerminalGrowth} step={.25} suffix="%" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'center', padding: '18px 19px', borderTop: `1px solid ${T.border}`, background: T.goldTint(4) }}>
              <div><div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 780, color: T.text }}>Standalone intrinsic value</div><div style={{ maxWidth: 610, marginTop: 5, fontFamily: T.label, fontSize: 9, lineHeight: 1.55, color: T.muted }}>This is the completed DCF: present value of forecast free cash flow plus a perpetual-growth terminal value, less net debt, divided by diluted shares.</div></div>
              <div style={{ textAlign: 'right' }}><div style={LABEL}>DCF value / share</div><div style={{ fontFamily: T.mono, fontSize: 27, fontWeight: 810, letterSpacing: '-.03em', color: T.gold }}>{fmtMoney(analysis?.dcf.value_per_share)}</div></div>
            </div>
            <div className="mv-three-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', borderTop: `1px solid ${T.border}` }}>
              {[
                ['Forecast cash flow value', fmtM(analysis?.dcf.pv_forecast_fcf)], ['Terminal value today', fmtM(analysis?.dcf.pv_terminal)], ['Terminal share of EV', analysis?.dcf.terminal_pct == null ? '-' : `${analysis.dcf.terminal_pct.toFixed(0)}%`],
              ].map(([label, value], index) => <div key={label} style={{ padding: '14px 16px', borderRight: index < 2 ? `1px solid ${T.border}` : 0 }}><div style={LABEL}>{label}</div><div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 770, color: index === 2 && (analysis?.dcf.terminal_pct || 0) > 85 ? T.neg : T.text }}>{value}</div></div>)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 13, borderTop: `1px solid ${T.border}` }}><button type="button" onClick={() => setStep(5)} style={PRIMARY_BUTTON}>Build market multiples <ChevronRight size={12} /></button></div>
          </>}

          {step === 5 && <>
            <StepHeader step={5} title="Build the market method, then blend" detail="Choose one or more multiples to produce a complete market valuation. Only then blend it with the completed intrinsic DCF." />
            {renderMultiplesBuilder()}
            <div style={{ padding: '17px 18px 19px', borderBottom: `1px solid ${T.border}` }}>
              <div><div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 780, color: T.text }}>Core DCF / multiples split</div><div style={{ marginTop: 4, fontFamily: T.label, fontSize: 9, color: T.muted }}>Set the split inside the core valuation sleeve. The cards show final effective weights after optional dividend or parts methods dilute both proportionally.</div></div>
              <div className="mv-method-cards" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', marginTop: 13, border: `1px solid ${T.border}` }}>
                {[{ key: 'dcf' as const, label: 'Intrinsic DCF', detail: 'Forecast FCF + perpetuity', color: T.gold }, { key: 'multiples' as const, label: 'Market multiples', detail: `${targets.length} target${targets.length === 1 ? '' : 's'} blended internally`, color: T.blue }].map((method, index) => <div key={method.key} style={{ minHeight: 104, padding: '14px 16px', borderRight: index === 0 ? `1px solid ${T.border}` : 0, opacity: method.key === 'multiples' && analysis?.multiples.value_per_share == null ? .45 : 1 }}><div style={{ fontFamily: T.label, fontSize: 9.5, fontWeight: 780, color: T.text }}>{method.label}</div><div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 21, fontWeight: 800, color: method.color }}>{fmtMoney(analysis?.methods[method.key])}</div><div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: T.label, fontSize: 8, color: T.muted }}><span>{method.detail}</span><span style={{ fontFamily: T.mono }}>{(analysis?.active_weights[method.key] || 0).toFixed(0)}% EFFECTIVE</span></div></div>)}
              </div>
              <input aria-label="Core DCF and multiples split" type="range" min={0} max={100} step={5} value={dcfBlend} disabled={analysis?.multiples.value_per_share == null} onChange={event => updateCoreBlend(+event.target.value)} style={{ width: '100%', marginTop: 15, accentColor: T.gold }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.label, fontSize: 8.5, color: T.muted }}><span>Core multiples share <strong style={{ marginLeft: 5, fontFamily: T.mono, color: T.blue }}>{(100 - dcfBlend).toFixed(0)}%</strong></span><span><strong style={{ marginRight: 5, fontFamily: T.mono, color: T.gold }}>{dcfBlend.toFixed(0)}%</strong> Core DCF share</span></div>
            </div>
            {analysis?.sensitivity_tables && (() => {
              const table = analysis.sensitivity_tables[sensitivityId] || analysis.sensitivity_tables.discount_rate
              const upsets = table.values.flat().filter((value): value is number => value != null).map(value => marketPrice ? (value / marketPrice - 1) * 100 : value)
              const min = Math.min(...upsets)
              const max = Math.max(...upsets)
              return <div style={{ padding: '17px 18px 19px' }}>
                <div className="mv-sensitivity-head" style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12, marginBottom: 11 }}><div><div style={{ fontFamily: T.label, fontSize: 10.5, fontWeight: 770 }}>{table.title} sensitivity</div><div style={{ marginTop: 3, fontFamily: T.label, fontSize: 8.5, color: T.muted }}>Blended value per share. The outlined cell is the current model.</div></div><label style={{ minWidth: 205 }}><span style={LABEL}>Sensitivity view</span><select value={sensitivityId} onChange={event => setSensitivityId(event.target.value as SensitivityKey)} style={{ ...INPUT, height: 30 }}><option value="discount_rate">DCF: discount rate</option><option value="operating_case">CAGR and margin</option><option value="growth_risk">Growth and risk</option><option value="exit_framework">Multiples: margin and EV / EBITDA</option></select></label></div>
                <div style={{ marginBottom: 5, textAlign: 'right', fontFamily: T.mono, fontSize: 8, color: T.muted }}>{table.column_label.toUpperCase()} -&gt;</div>
                <div className="mv-sensitivity" style={{ display: 'grid', gridTemplateColumns: `92px repeat(${table.column_values.length}, minmax(72px, 1fr))`, gap: 3, overflowX: 'auto' }}>
                  <div style={{ padding: 9, fontFamily: T.mono, fontSize: 8, color: T.muted }}>{table.row_label.toUpperCase()}</div>
                  {table.column_values.map((column, columnIndex) => <div key={`${column}-${columnIndex}`} style={{ padding: 9, textAlign: 'center', fontFamily: T.mono, fontSize: 8, color: T.muted }}>{column.toFixed(1)}{table.column_suffix}</div>)}
                  {table.row_values.map((rowValue, rowIndex) => <div key={`${rowValue}-${rowIndex}`} style={{ display: 'contents' }}><div style={{ padding: 10, fontFamily: T.mono, fontSize: 9, color: T.muted }}>{rowValue.toFixed(1)}{table.row_suffix}</div>{table.values[rowIndex].map((value, columnIndex) => {
                    const isBase = rowIndex === table.base_row_index && columnIndex === table.base_column_index
                    const scaleValue = value == null ? 0 : marketPrice ? (value / marketPrice - 1) * 100 : value
                    return <div key={columnIndex} style={{ minHeight: 48, padding: '8px 6px', display: 'grid', placeItems: 'center', background: value == null ? T.surface : heatColor(scaleValue, min, max), outline: isBase ? `1px solid ${T.gold}` : 'none', outlineOffset: -1 }}><div style={{ textAlign: 'center' }}><div style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 770, color: T.text }}>{fmtMoney(value)}</div>{value != null && marketPrice && <div style={{ marginTop: 2, fontFamily: T.mono, fontSize: 7.5, color: T.text }}>{signedPct(scaleValue)}</div>}</div></div>
                  })}</div>)}
                </div>
              </div>
            })()}
            <Disclosure label="Additional valuation methods" detail="Optionally add a dividend or sum-of-the-parts value to the final blend." open={additionalMethodsOpen} onToggle={() => setAdditionalMethodsOpen(open => !open)}>{renderAdditionalMethods()}</Disclosure>
            <Disclosure label="Full annual audit" detail="Inspect every operating and per-share bridge behind the model." open={auditOpen} onToggle={() => setAuditOpen(open => !open)}>{analysis && <div style={{ overflowX: 'auto', borderTop: `1px solid ${T.border}` }}><table style={{ width: '100%', minWidth: 1120, borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 9 }}><thead><tr>{['Year', 'Growth', 'Margin', 'Revenue', 'NOPAT', 'Interest', 'Net income', 'D&A', 'CapEx', 'NWC', 'SBC', 'Other', 'Conversion', 'FCF', 'DPS', 'Shares'].map(label => <th key={label} style={{ padding: '8px 9px', textAlign: label === 'Year' ? 'left' : 'right', borderBottom: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase' }}>{label}</th>)}</tr></thead><tbody>{analysis.rows.map(row => <tr key={row.year}>{[String(row.year), `${row.growth.toFixed(1)}%`, `${row.margin.toFixed(1)}%`, fmtM(row.revenue), fmtM(row.nopat), fmtM(row.interest_expense), fmtM(row.net_income), fmtM(row.da), fmtM(row.capex), fmtM(row.change_nwc), fmtM(row.sbc), fmtM(row.cash_adjustment), `${row.fcf_conversion_pct.toFixed(0)}%`, fmtM(row.fcf), fmtMoney(row.dividend_per_share), `${row.shares.toFixed(1)}M`].map((value, index) => <td key={index} style={{ padding: '7px 9px', textAlign: index === 0 ? 'left' : 'right', borderBottom: `1px solid ${T.borderFaint}`, color: index === 13 ? T.gold : T.text }}>{value}</td>)}</tr>)}</tbody></table></div>}</Disclosure>
          </>}
        </main>

        <aside className="mv-rail" style={{ ...PANEL, position: 'sticky', top: 8 }}>
          <div style={{ padding: '18px 18px 15px', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 760, color: T.muted }}>Your final blended value is</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}><span style={{ fontFamily: T.mono, fontSize: 33, fontWeight: 820, letterSpacing: '-.035em', color: T.gold }}>{fmtMoney(connectedValue)}</span><span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 770, color: (upside ?? 0) >= 0 ? T.pos : T.neg }}>{signedPct(upside)}</span></div>
            <div style={{ marginTop: 5, fontFamily: T.label, fontSize: 9.5, lineHeight: 1.45, color: T.muted }}>{marketPrice == null ? 'Load a market price to compare value and price.' : `${fmtMoney(marketPrice)} market price. ${upside == null ? '' : upside >= 0 ? 'The model sits above the market.' : 'The model sits below the market.'}`}</div>
            {analysis && <div style={{ marginTop: 15 }}>
              <div style={{ position: 'relative', height: 23 }}><div style={{ position: 'absolute', left: 0, right: 0, top: 10, height: 3, background: T.border }} />{pricePct != null && <><div style={{ position: 'absolute', left: `${pricePct}%`, top: 4, width: 2, height: 15, background: T.text }} /><div style={{ position: 'absolute', left: `${pricePct}%`, top: -7, transform: 'translateX(-50%)', fontFamily: T.mono, fontSize: 7, color: T.text }}>MARKET</div></>}{valuePct != null && <><div style={{ position: 'absolute', left: `${valuePct}%`, top: 1, width: 2, height: 20, background: T.gold }} /><div style={{ position: 'absolute', left: `${valuePct}%`, top: 22, transform: 'translateX(-50%)', fontFamily: T.mono, fontSize: 7, color: T.gold }}>MODEL</div></>}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9, fontFamily: T.mono, fontSize: 8, color: T.muted }}><span>{fmtMoney(rangeLow)}</span><span>{fmtMoney(rangeHigh)}</span></div>
            </div>}
          </div>

          <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ ...LABEL, marginBottom: 10 }}>How the number is made</div>
            {(Object.keys(METHOD_LABEL) as MethodKey[]).map(key => {
              const value = analysis?.methods[key]
              const activeWeight = analysis?.active_weights[key] || 0
              return <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, padding: '6px 0', opacity: value != null && Number.isFinite(value) ? 1 : .42 }}><div><div style={{ fontFamily: T.label, fontSize: 9.5, color: T.text }}>{METHOD_LABEL[key]}</div><div style={{ marginTop: 2, fontFamily: T.mono, fontSize: 7.5, color: T.muted }}>{activeWeight ? `${activeWeight.toFixed(0)}% effective weight` : 'Not active'}</div></div><div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 770, color: key === 'dcf' ? T.gold : T.text }}>{fmtMoney(value)}</div></div>
            })}
            {analysis && <div style={{ display: 'flex', height: 5, marginTop: 8, background: T.border }}>{(Object.keys(METHOD_LABEL) as MethodKey[]).map((key, index) => { const weight = analysis.active_weights[key] || 0; const total = Object.values(analysis.active_weights).reduce((sum, value) => sum + (value || 0), 0); return weight ? <div key={key} title={METHOD_LABEL[key]} style={{ width: `${weight / Math.max(total, 1) * 100}%`, background: [T.gold, T.blue, T.pos, T.muted][index] }} /> : null })}</div>}
            {spreadWarning && <div style={{ marginTop: 12, padding: '10px 11px', background: T.negTint(5), border: `1px solid ${T.negTint(22)}`, fontFamily: T.label, fontSize: 9, lineHeight: 1.5, color: T.text }}>The methods are {fmtMoney(methodSpread)} apart. That spread, not the {fmtMoney(connectedValue)}, is the real uncertainty here.</div>}
          </div>

          <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ ...LABEL, marginBottom: 8 }}>What the market price assumes</div>
            {[
              { label: 'Revenue CAGR', value: analysis?.reverse.implied_revenue_cagr, suffix: '%', action: () => adoptSchedule('growth', analysis?.reverse.implied_growth_schedule), enabled: Boolean(analysis?.reverse.implied_growth_schedule) },
              { label: 'Terminal margin', value: analysis?.reverse.implied_terminal_margin, suffix: '%', action: () => adoptSchedule('margin', analysis?.reverse.implied_margin_schedule), enabled: Boolean(analysis?.reverse.implied_margin_schedule) },
              { label: 'WACC', value: analysis?.reverse.implied_wacc, suffix: '%', action: () => analysis?.reverse.implied_wacc != null && setWacc(Number(analysis.reverse.implied_wacc.toFixed(2))), enabled: analysis?.reverse.implied_wacc != null },
              { label: `EV / EBITDA in Y${analysis?.reverse.implied_exit_year || schedule.length}`, value: analysis?.reverse.implied_exit_multiple, suffix: 'x', action: adoptImpliedMultiple, enabled: analysis?.reverse.implied_exit_multiple != null },
            ].map(item => <div key={item.label} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'center', padding: '6px 0' }}><span style={{ fontFamily: T.label, fontSize: 9, color: T.muted }}>{item.label}</span><span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text }}>{item.value == null ? 'No solve' : `${item.value.toFixed(1)}${item.suffix}`}</span><button type="button" onClick={item.action} disabled={!item.enabled} title={`Use implied ${item.label.toLowerCase()}`} style={{ ...BUTTON, minWidth: 39, minHeight: 23, padding: '0 5px', color: item.enabled ? T.gold : T.muted, opacity: item.enabled ? 1 : .35 }}><ArrowDownToLine size={10} /> Use</button></div>)}
          </div>

          <div style={{ padding: 14 }}><button type="button" onClick={() => void runModel()} disabled={calculating} style={{ ...BUTTON, width: '100%', borderColor: T.gold, color: T.gold }}><RefreshCw size={11} />{calculating ? 'Reconciling...' : 'Reconcile now'}</button></div>
          {(error || analysis?.warnings.length) ? <div style={{ padding: '10px 12px', borderTop: `1px solid ${T.border}`, background: T.negTint(4) }}>{[error, ...(analysis?.warnings || [])].filter(Boolean).map((warning, index) => <div key={index} style={{ display: 'flex', gap: 7, marginTop: index ? 6 : 0, fontFamily: T.label, fontSize: 8.5, lineHeight: 1.45, color: error && index === 0 ? T.neg : T.muted }}><CircleAlert size={11} style={{ flex: 'none', marginTop: 1 }} />{warning}</div>)}</div> : null}
        </aside>
      </div>}
    </div>
  )
}

export default function MasterValuation() {
  return <PageWrapper title="Master Valuation"><MasterValuationContent /></PageWrapper>
}
