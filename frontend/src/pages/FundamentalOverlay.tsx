import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import axios from 'axios'
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Brush,
  ReferenceArea,
} from 'recharts'
import { X, Save, ChevronRight, ChevronDown } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerBasket from '../components/TickerBasket'
import { useTickerParam } from '../hooks/useTickerParam'
import { T } from '../lib/theme'
import { MONO, SANS, mix, seg } from './cockpitKit'
import { compile, evaluate, lexicon, resultUnit, token } from '../lib/formula'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'

// Reported fundamentals over time, plus metrics you define yourself.
//
// The data is SEC companyfacts, not FMP: FMP's free tier is exhausted and its
// absolute fundamentals return nothing, while companyfacts is free, unmetered
// and carries ~17 years for a large filer.

interface Field { key: string; label: string; unit: string; group: string }
interface Period { fiscalYear: number; date: string; estimate?: boolean; analysts?: number;
  [k: string]: number | string | boolean | null | undefined }
interface Resp { ticker: string; source: string; fields: Field[]; periods: Period[] }

interface Custom { id: string; name: string; expr: string }

const STORE = 'ft_custom_metrics_v1'
// Which field groups are open. Closed by default: 42 line items is a rail you
// scroll past rather than read, and the point of the sidebar is the formula.
const OPEN_STORE = 'ft_fundamental_groups_v1'
const GROUPS = ['Income', 'Balance', 'Cash flow', 'Market', 'Multiples', 'Estimate']
const loadOpen = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(OPEN_STORE) || '{}') } catch { return {} }
}
const loadCustom = (): Custom[] => {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]') } catch { return [] }
}
const saveCustom = (m: Custom[]) => {
  try { localStorage.setItem(STORE, JSON.stringify(m)) } catch { /* private mode */ }
}

// Two encodings, because one company and several are different reading problems.
//
// One company: hue is the metric, every line solid — nothing else needs saying.
// Several: hue becomes the COMPANY and the dash pattern carries the metric, so
// three names by three metrics reads as three groups instead of nine unrelated
// lines. The company chips take the same hue, so the rail is the key.
const METRIC_COLORS = [T.gold, '#60a5fa', '#3fb37f', '#c084fc', '#e0864a', '#38bdf8', '#e5484d']
const TICKER_COLORS = [T.gold, '#60a5fa', '#3fb37f', '#c084fc', '#e0864a']
const METRIC_DASH: (string | undefined)[] = [undefined, '7 4', '2 3', '11 4 2 4', '1 3']

// Three ways to make series of different magnitude share one plot.
//
// Absolute gives each unit its own axis, which is enough when the numbers are
// within an order of magnitude of each other. Indexed rebases everything to 100
// at the left edge of the view, which is the only reading that survives revenue
// in hundreds of billions next to a multiple of 0.04. Log keeps real units but
// compresses the range, at the cost of dropping non-positive points.
type Scale = 'abs' | 'idx' | 'log'
const SCALES: { key: Scale; label: string; hint: string }[] = [
  { key: 'abs', label: 'Absolute', hint: 'Real units, one axis per unit' },
  { key: 'idx', label: 'Indexed', hint: 'Every series rebased to 100 at the left edge of the view' },
  { key: 'log', label: 'Log', hint: 'Real units on a log axis. Zero and negative points drop out' },
]

// What a desk calls these line items, on top of the labels the rail already
// shows. "share price / earnings" is how someone asks for a P/E; making them
// find out it is spelled netIncome is the interface's problem, not theirs.
const SHORTHAND: Record<string, string> = {
  earnings: 'netIncome', 'net earnings': 'netIncome', profit: 'netIncome', 'net profit': 'netIncome',
  'bottom line': 'netIncome',
  sales: 'revenue', turnover: 'revenue', 'top line': 'revenue',
  cogs: 'costOfRevenue', 'cost of goods sold': 'costOfRevenue', 'cost of sales': 'costOfRevenue',
  opex: 'operatingExpenses', expenses: 'operatingExpenses', 'operating expense': 'operatingExpenses',
  ebit: 'operatingIncome', 'operating profit': 'operatingIncome',
  'forward eps': 'epsEstimate', 'consensus eps': 'epsEstimate',
  'ev ebitda': 'evEbitda', 'ev sales': 'evSales', 'ev fcf': 'evFcf',
  'fcf yield': 'fcfYield', 'dividend yield': 'dividendYield', 'div yield': 'dividendYield',
  'fwd pe': 'peFwd', 'forward pe': 'peFwd', 'fwd ps': 'psFwd',
  'fwd ev sales': 'evSalesFwd', 'forward ev sales': 'evSalesFwd',
  'forward revenue': 'revenueEstimate', 'consensus revenue': 'revenueEstimate',
  'forward sales': 'revenueEstimate',
  ebt: 'incomeBeforeTax', 'pretax income': 'incomeBeforeTax', 'pre tax income': 'incomeBeforeTax',
  tax: 'incomeTaxExpense', taxes: 'incomeTaxExpense',
  eps: 'epsdiluted', 'earnings per share': 'epsdiluted',
  shares: 'weightedAverageShsOutDil', 'share count': 'weightedAverageShsOutDil',
  'shares outstanding': 'weightedAverageShsOutDil',
  price: 'sharePrice', 'stock price': 'sharePrice',
  ev: 'enterpriseValue', mcap: 'marketCap', 'market value': 'marketCap',
  capex: 'capitalExpenditure',
  da: 'depreciationAndAmortization', depreciation: 'depreciationAndAmortization',
  cash: 'cashAndCashEquivalents',
  debt: 'totalDebt', equity: 'totalStockholdersEquity', 'book value': 'totalStockholdersEquity',
}

// Axis order, so dollars always take the left axis no matter what you picked first.
const UNIT_ORDER = ['$', 'sh', '$/sh', '%', 'x']
const MIN_SPAN = 2

/** Dollar figures are read in billions; ratios are read as they are. */
function fmt(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (unit === '$') {
    const a = Math.abs(v)
    if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
    if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
    if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
    return `$${v.toFixed(0)}`
  }
  if (unit === 'sh') return `${(v / 1e9).toFixed(2)}B`
  if (unit === '$/sh') return `$${v.toFixed(2)}`
  // Yields arrive already carrying their percent, so 3.2 means 3.20%.
  if (unit === '%') return `${v.toFixed(2)}%`
  // A custom metric can land anywhere on the number line, and neither end may be
  // written in exponent form: big goes to M/B/T, small carries enough decimals to
  // stay readable. Two decimals alone turned 2.4e-9 into "0.00", which reads as a
  // reported zero.
  const a = Math.abs(v)
  if (v === 0) return '0'
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1) return v.toFixed(2)
  // Three significant digits, spelled out: 0.00000000242, never 2.42e-9.
  return v.toFixed(Math.min(12, 2 - Math.floor(Math.log10(a))))
}

export default function FundamentalOverlay() {
  const [tickers, setTickers] = useState<string[]>(['AAPL'])
  // A symbol handed over from another tool joins the basket rather than replacing it.
  useTickerParam(sym => setTickers(t => (t.includes(sym.toUpperCase()) ? t : [sym.toUpperCase(), ...t].slice(0, 5))))

  const [picked, setPicked] = useState<string[]>(['revenue', 'ebitda', 'netIncome'])
  const [custom, setCustom] = useState<Custom[]>(loadCustom)
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen)
  const toggleGroup = (g: string) => setOpen(o => {
    const next = { ...o, [g]: !o[g] }
    try { localStorage.setItem(OPEN_STORE, JSON.stringify(next)) } catch { /* private mode */ }
    return next
  })

  const results = useQueries({
    queries: tickers.map(tk => ({
      queryKey: ['fundamental-history', tk],
      queryFn: () => axios.get(`/api/corporate/fundamental-history?ticker=${encodeURIComponent(tk)}`).then(r => r.data as Resp),
      staleTime: 6 * 3600 * 1000,
      retry: 1,
    })),
  })
  const isLoading = results.some(r => r.isLoading)
  // useQueries hands back fresh wrapper objects every render, so memoise on what
  // actually changed. Without this the chart data is a new array on every
  // keystroke in the formula box and Recharts never settles.
  const sig = results.map((r, i) => `${tickers[i]}:${r.data ? 'y' : r.error ? 'e' : '-'}`).join('|')
  const ok = useMemo(
    () => results.map((r, i) => ({ tk: tickers[i], data: r.data })).filter(l => l.data) as { tk: string; data: Resp }[],
    [sig], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const failed = results.map((r, i) => (r.error && !r.data ? tickers[i] : null)).filter(Boolean) as string[]
  const error = !isLoading && ok.length === 0 && results.length > 0 ? (results[0].error ?? true) : null
  const data = ok[0]?.data

  const fields = useMemo(() => data?.fields ?? [], [data])
  const lex = useMemo(() => lexicon(fields, SHORTHAND), [fields])
  const check = useMemo(() => (expr.trim() ? compile(expr, fields.length ? lex : undefined) : null), [expr, lex, fields.length])

  // Per-share over whole-company is the trap this box invites: "share price /
  // earnings" parses, computes, and returns 2.4e-9 instead of a P/E. The formula
  // is not wrong, so this warns rather than blocks.
  const unitMix = useMemo(() => {
    if (!check?.ok) return null
    const units = new Set(check.vars.map(v => fields.find(f => f.key === v)?.unit))
    return units.has('$/sh') && (units.has('$') || units.has('sh'))
      ? 'Mixes per-share and whole-company figures. Price over net income is not a P/E; price over EPS is.'
      : null
  }, [check, fields])

  const addCustom = () => {
    if (!check?.ok || !name.trim()) return
    const next = [...custom, { id: `c${Date.now()}`, name: name.trim(), expr: expr.trim() }]
    setCustom(next); saveCustom(next)
    setPicked(p => [...p, next[next.length - 1].id])
    setName(''); setExpr('')
  }
  // Drag a field out of the rail and drop it into the formula box. Typing the
  // name is still fine, but nobody should have to learn a spelling to start.
  const exprRef = useRef<HTMLTextAreaElement>(null)
  const [dropping, setDropping] = useState(false)

  const insertAt = (text: string, at?: number) => {
    setExpr(cur => {
      const pos = at == null ? cur.length : Math.max(0, Math.min(at, cur.length))
      const before = cur.slice(0, pos).replace(/\s+$/, '')
      const after = cur.slice(pos).replace(/^\s+/, '')
      return `${before}${before ? ' ' : ''}${text}${after ? ` ${after}` : ''}`
    })
    requestAnimationFrame(() => exprRef.current?.focus())
  }

  /** Where in the text the pointer let go, so a drop lands where you aimed it. */
  const caretAt = (e: React.DragEvent): number | undefined => {
    const el = exprRef.current
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return undefined
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    }
    const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY)
    if (pos && (pos.offsetNode === el || el.contains(pos.offsetNode))) return pos.offset
    return el.selectionStart ?? undefined
  }

  const onDropField = (e: React.DragEvent) => {
    const text = e.dataTransfer.getData('application/x-ft-field') || e.dataTransfer.getData('text/plain')
    setDropping(false)
    if (!text) return
    e.preventDefault()
    insertAt(text, caretAt(e))
  }

  const dropCustom = (id: string) => {
    const next = custom.filter(c => c.id !== id)
    setCustom(next); saveCustom(next)
    setPicked(p => p.filter(k => k !== id))
  }

  // Each selected series carries its own unit so dollars and ratios never share
  // an axis: a P/E of 30 beside a revenue of 4e11 would flatten the ratio to zero.
  const selected = useMemo(() => picked.map(key => {
    const f = fields.find(x => x.key === key)
    if (f) return { key, label: f.label, unit: f.unit, expr: null as string | null }
    const c = custom.find(x => x.id === key)
    if (!c) return null
    // Dollars minus dollars is still dollars, and it belongs on the money axis.
    const unit = resultUnit(c.expr, k => fields.find(f => f.key === k)?.unit, lex) ?? 'x'
    return { key, label: c.name, unit, expr: c.expr }
  }).filter(Boolean) as { key: string; label: string; unit: string; expr: string | null }[], [picked, fields, custom, lex])

  const multi = tickers.length > 1

  // Keyed to the basket slot rather than the loaded slot: a ticker that fails in
  // the middle must not shift every colour below it, or the chips stop matching
  // the lines.
  const colorFor = (tk: string) => TICKER_COLORS[Math.max(0, tickers.indexOf(tk)) % TICKER_COLORS.length]
  const dashFor = (key: string) =>
    (multi ? METRIC_DASH[Math.max(0, selected.findIndex(s => s.key === key)) % METRIC_DASH.length] : undefined)

  // One plotted line per company per metric.
  const lines = useMemo(() => ok.flatMap(l => selected.map((m, mi) => ({
    id: `${l.tk}__${m.key}`,
    label: multi ? `${l.tk} ${m.label}` : m.label,
    unit: m.unit,
    color: multi ? colorFor(l.tk) : METRIC_COLORS[mi % METRIC_COLORS.length],
    dash: dashFor(m.key),
  }))), [ok, selected, tickers, multi]) // eslint-disable-line react-hooks/exhaustive-deps

  // A year is a forecast only when nobody on the chart has actually reported it.
  // With two companies on different fiscal calendars one can report a year the
  // other is still estimating, and that year is not a forecast column.
  const estYears = useMemo(() => {
    const reported = new Set<number>(); const est = new Set<number>()
    ok.forEach(l => l.data.periods.forEach(p => (p.estimate ? est : reported).add(p.fiscalYear)))
    reported.forEach(y => est.delete(y))
    return est
  }, [ok])
  const fyLabel = (fy: number) => (estYears.has(fy) ? `${fy}E` : String(fy))

  // Fiscal years rarely line up across filers, so the x axis is the union and a
  // company simply has no point in a year it did not report.
  const rows = useMemo(() => {
    const years = new Set<number>()
    ok.forEach(l => l.data.periods.forEach(p => years.add(p.fiscalYear)))
    return [...years].sort((a, b) => a - b).map(fy => {
      const row: Record<string, number | null | string> = { fy: fyLabel(fy) }
      for (const l of ok) {
        const p = l.data.periods.find(x => x.fiscalYear === fy)
        for (const m of selected) {
          row[`${l.tk}__${m.key}`] = !p ? null
            : m.expr ? evaluate(m.expr, p as never, lex)
            : ((p[m.key] as number) ?? null)
        }
      }
      return row
    })
  }, [ok, selected, lex, estYears])

  const [scale, setScale] = useState<Scale>('abs')
  // The visible slice of fiscal years. null is the whole history.
  const [win, setWin] = useState<[number, number] | null>(null)
  const [panning, setPanning] = useState(false)
  const plotRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; a: number; b: number } | null>(null)

  const last = Math.max(0, rows.length - 1)
  // Swapping tickers changes the year span underneath the window, so start over
  // rather than leaving the view pointed at years that no longer exist.
  useEffect(() => { setWin(null) }, [rows.length])

  const [lo, hi] = useMemo<[number, number]>(() => {
    if (!win || last < MIN_SPAN) return [0, last]
    const a = Math.max(0, Math.min(win[0], last - MIN_SPAN))
    return [a, Math.max(a + MIN_SPAN, Math.min(win[1], last))]
  }, [win, last])
  const zoomed = lo > 0 || hi < last

  const setSpan = useCallback((a: number, b: number) => {
    if (last < MIN_SPAN) return
    const span = Math.max(MIN_SPAN, Math.min(last, b - a))
    const start = Math.max(0, Math.min(last - span, a))
    setWin(start === 0 && start + span === last ? null : [start, start + span])
  }, [last])

  // Wheel has to be a real listener: React routes wheel through a passive root
  // handler, so preventDefault there is a no-op and the page scrolls instead.
  useEffect(() => {
    const el = plotRef.current
    if (!el || last < MIN_SPAN) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)))
      const span = hi - lo
      let next = Math.round(span * (e.deltaY > 0 ? 1.15 : 0.87))
      if (next === span) next = span + (e.deltaY > 0 ? 1 : -1)
      next = Math.max(MIN_SPAN, Math.min(last, next))
      // Anchor on the year under the cursor so zooming walks toward what you are
      // pointing at rather than recentring the view every notch.
      const start = Math.round(lo + frac * span - frac * next)
      setSpan(start, start + next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [lo, hi, last, setSpan])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // The brush lives inside this box and owns its own drag.
    if (!zoomed || (e.target as Element).closest?.('.recharts-brush')) return
    drag.current = { x: e.clientX, a: lo, b: hi }
    setPanning(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const w = e.currentTarget.getBoundingClientRect().width
    const shift = Math.round((-(e.clientX - d.x) / Math.max(1, w)) * (d.b - d.a))
    setSpan(d.a + shift, d.b + shift)
  }
  const endPan = () => { drag.current = null; setPanning(false) }

  // Indexed and log both rewrite the plotted values, so the table below keeps
  // reading the reported numbers no matter what the chart is showing.
  const plotRows = useMemo(() => {
    if (scale === 'abs') return rows
    if (scale === 'log') {
      return rows.map(r => {
        const out: Record<string, number | null | string> = { fy: r.fy }
        for (const l of lines) {
          const v = r[l.id]
          out[l.id] = typeof v === 'number' && v > 0 ? v : null
        }
        return out
      })
    }
    const base: Record<string, number | null> = {}
    for (const l of lines) {
      let b: number | null = null
      for (let i = lo; i <= hi; i++) {
        const v = rows[i]?.[l.id]
        if (typeof v === 'number' && v !== 0) { b = v; break }
      }
      base[l.id] = b
    }
    return rows.map(r => {
      const out: Record<string, number | null | string> = { fy: r.fy }
      for (const l of lines) {
        const v = r[l.id]; const b = base[l.id]
        out[l.id] = typeof v === 'number' && b ? (v / b) * 100 : null
      }
      return out
    })
  }, [rows, lines, scale, lo, hi])

  // Log silently eats zero and negative points, so say how many it ate.
  const dropped = useMemo(() => {
    if (scale !== 'log') return 0
    let n = 0
    for (let i = lo; i <= hi; i++) {
      for (const l of lines) { const v = rows[i]?.[l.id]; if (typeof v === 'number' && v <= 0) n++ }
    }
    return n
  }, [scale, rows, lines, lo, hi])

  // One axis per unit in play, dollars first. A unit drawn by a single line takes
  // that line's colour, so you can tell at a glance which axis reads which line.
  const units = useMemo(() => {
    const present = [...new Set(lines.map(l => l.unit))]
    return present.sort((a, b) => UNIT_ORDER.indexOf(a) - UNIT_ORDER.indexOf(b))
  }, [lines])
  const axisColor = (u: string) => {
    const own = lines.filter(l => l.unit === u)
    return own.length === 1 ? own[0].color : T.muted
  }
  const axisOf = (u: string) => (scale === 'idx' ? 'idx' : u)

  const metricColor = (key: string) => {
    if (multi) return T.gold
    const i = selected.findIndex(s => s.key === key)
    return i < 0 ? T.gold : METRIC_COLORS[i % METRIC_COLORS.length]
  }

  // The chart says which metric a line is by its dash pattern, so the rail has to
  // show the same pattern or the key only exists in the legend.
  const DashKey = ({ dash }: { dash?: string }) => (
    <svg width={18} height={7} style={{ flexShrink: 0 }} aria-hidden>
      <line x1={0} y1={3.5} x2={18} y2={3.5} stroke="currentColor" strokeWidth={1.8} strokeDasharray={dash} />
    </svg>
  )

  const label = (t: string) => (
    <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
      textTransform: 'uppercase', color: T.muted, margin: '14px 0 6px' }}>{t}</div>
  )

  const sidebar = (
    <div style={{ padding: 13 }}>
      <TickerBasket value={tickers} onChange={setTickers} cap={5} label="Companies" chipColor={multi ? colorFor : undefined} />
      {failed.length > 0 && (
        <div style={{ fontFamily: SANS, fontSize: 10, color: T.warn, marginTop: 5, lineHeight: 1.45 }}>
          No SEC history for {failed.join(', ')}. Foreign issuers filing 20-F and most funds are not covered.
        </div>
      )}

      {multi && (
        <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
          Colour is the company, the line pattern is the metric.
        </div>
      )}

      {GROUPS.map(group => {
        const inGroup = fields.filter(f => f.group === group)
        if (!inGroup.length) return null
        const chosen = inGroup.filter(f => picked.includes(f.key)).length
        const isOpen = !!open[group]
        return (
          <div key={group}>
            <button onClick={() => toggleGroup(group)} aria-expanded={isOpen}
              style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', margin: '14px 0 6px',
                padding: 0, background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', color: chosen ? T.text : T.muted }}>
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {group}
              {/* A closed group has to say whether anything inside it is on the chart. */}
              {chosen > 0 && <span style={{ color: T.gold, fontFamily: MONO, fontSize: 9 }}>{chosen}</span>}
              <span style={{ marginLeft: 'auto', color: mix(T.muted, 60), fontFamily: MONO, fontSize: 9 }}>
                {inGroup.length}
              </span>
            </button>
            <div style={{ display: isOpen ? 'flex' : 'none', flexWrap: 'wrap', gap: 4 }}>
              {inGroup.map(f => {
                const on = picked.includes(f.key)
                return (
                  <button key={f.key} onClick={() => setPicked(p => on ? p.filter(k => k !== f.key) : [...p, f.key])}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData('application/x-ft-field', token(f.label))
                      e.dataTransfer.setData('text/plain', token(f.label))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    title={`${f.label} · drag into a formula, or click to plot`}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: SANS, fontSize: 10.5,
                      padding: '4px 8px', cursor: 'pointer',
                      background: on ? mix(metricColor(f.key), 14) : 'transparent',
                      border: `1px solid ${on ? metricColor(f.key) : T.border}`,
                      color: on ? metricColor(f.key) : T.muted }}>
                    {on && multi && <DashKey dash={dashFor(f.key)} />}{f.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {estYears.size > 0 && (
        <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
          Estimate years carry today's price, so a multiple built on them is a forward multiple.
          Consensus is usually an adjusted basis and will not tie exactly to the reported line.
        </div>
      )}

      {label('Your metrics')}
      {custom.map(c => {
        const on = picked.includes(c.id)
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
            <button onClick={() => setPicked(p => on ? p.filter(k => k !== c.id) : [...p, c.id])}
              style={{ flex: 1, textAlign: 'left', fontFamily: SANS, fontSize: 10.5, padding: '4px 8px',
                cursor: 'pointer', background: on ? mix(metricColor(c.id), 14) : 'transparent',
                border: `1px solid ${on ? metricColor(c.id) : T.border}`,
                color: on ? metricColor(c.id) : T.text, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {on && multi && <DashKey dash={dashFor(c.id)} />}{c.name}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.expr}</div>
            </button>
            <button onClick={() => dropCustom(c.id)} aria-label={`Delete ${c.name}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, padding: 2, display: 'flex' }}>
              <X size={12} />
            </button>
          </div>
        )
      })}

      <div
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dropping) setDropping(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false) }}
        onDrop={onDropField}
        style={{ border: `1px solid ${dropping ? T.gold : T.border}`, padding: 9, marginTop: 6,
          background: dropping ? mix(T.gold, 7) : 'transparent' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Metric name"
          className="ft-control" style={{ width: '100%', marginBottom: 5 }} />
        <textarea ref={exprRef} value={expr} onChange={e => setExpr(e.target.value)}
          placeholder="drag a field in, or type: share price / earnings"
          rows={3} className="ft-control" style={{ width: '100%', resize: 'vertical', fontFamily: MONO, fontSize: 10.5 }} />
        {dropping && (
          <div style={{ fontFamily: SANS, fontSize: 10, color: T.gold, marginTop: 4 }}>
            Drop to put it in the formula
          </div>
        )}
        {!dropping && check && !check.ok && (
          <div style={{ fontFamily: SANS, fontSize: 10, color: T.neg, marginTop: 4 }}>{check.error}</div>
        )}
        {!dropping && check?.ok && (
          <div style={{ fontFamily: SANS, fontSize: 10, color: T.pos, marginTop: 4 }}>
            uses {check.vars.map(v => lex.label.get(v) ?? v).join(', ')}
          </div>
        )}
        {!dropping && unitMix && (
          <div style={{ fontFamily: SANS, fontSize: 10, color: T.warn, marginTop: 4, lineHeight: 1.45 }}>
            {unitMix}
          </div>
        )}
        <button onClick={addCustom} disabled={!check?.ok || !name.trim()}
          style={{ marginTop: 6, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 6, padding: '6px 0', cursor: check?.ok && name.trim() ? 'pointer' : 'default',
            background: check?.ok && name.trim() ? T.gold : 'transparent',
            border: `1px solid ${check?.ok && name.trim() ? T.gold : T.border}`,
            color: check?.ok && name.trim() ? T.bg : T.muted,
            fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          <Save size={12} /> Save metric
        </button>
        <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, marginTop: 7, lineHeight: 1.5 }}>
          Drag any field above into this box, or type its name. Desk shorthand works too:
          price, earnings, sales, cogs, capex, ev. Combine with + − * / ^ and parentheses.
          Saved to this browser.
        </div>
      </div>
    </div>
  )

  return (
    <PageWrapper>
      <PageHeader title="Fundamental Overlay"
        meta={ok.length ? `${ok.length} compan${ok.length === 1 ? 'y' : 'ies'} · ${rows.length} fiscal years · ${data?.source}` : undefined} />
      <SidebarLayout sidebar={sidebar} sidebarTitle="Series" sidebarWidth={244}>
        {isLoading && <EmptyState title="Fundamental Overlay" variant="loading" hint={`Reading ${tickers.join(", ")} from SEC companyfacts.`} />}
        {!isLoading && error && (
          <EmptyState title="No filings found" variant="unavailable"
            hint={`SEC companyfacts has no usable us-gaap history for ${tickers.join(", ")}. Foreign issuers filing 20-F and most funds are not covered.`} />
        )}
        {!isLoading && !error && data && (
          // The chart is the page. Sizing it off the viewport rather than a fixed
          // clamp means the table takes what it needs and the plot takes the rest.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 'calc(100vh - 100px)' }}>
            <div style={{ border: `1px solid ${T.border}`, background: T.bg,
              flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 420 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '8px 12px', borderBottom: `1px solid ${T.borderFaint}` }}>
                <div style={{ display: 'flex', width: 216 }}>
                  {SCALES.map(sc => (
                    <div key={sc.key} onClick={() => setScale(sc.key)} title={sc.hint} style={seg(scale === sc.key)}>
                      {sc.label}
                    </div>
                  ))}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>
                  {rows.length ? `${rows[lo]?.fy} – ${rows[hi]?.fy}` : '—'}
                  <span style={{ color: mix(T.muted, 70) }}> · {hi - lo + 1} yrs</span>
                </div>
                {zoomed && (
                  <button onClick={() => setWin(null)} style={{ background: 'transparent',
                    border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', fontFamily: SANS,
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                    padding: '4px 9px' }}>Reset zoom</button>
                )}
                <div style={{ marginLeft: 'auto', fontFamily: SANS, fontSize: 9.5, color: mix(T.muted, 75) }}>
                  Scroll to zoom · drag to pan · double-click to reset
                </div>
              </div>

              <div
                ref={plotRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onDoubleClick={() => setWin(null)}
                style={{ touchAction: 'none', flex: '1 1 auto', minHeight: 0,
                  cursor: panning ? 'grabbing' : zoomed ? 'grab' : 'default',
                  // A flexed box has a used height but a computed height of auto,
                  // so a percentage child resolves to zero. The inset child is
                  // what gives ResponsiveContainer something definite to measure.
                  position: 'relative' }}>
                <div style={{ position: 'absolute', top: 12, right: 12, bottom: 6, left: 12 }}>
                {lines.length === 0 ? (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontFamily: SANS,
                    fontSize: 12, color: T.muted }}>Add a company, then pick a field or a saved metric.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={plotRows} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
                      <CartesianGrid stroke={T.borderFaint} vertical={false} />
                      <XAxis dataKey="fy" tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }} />
                      {scale === 'idx' ? (
                        <YAxis yAxisId="idx" width={50} tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }}
                          tickFormatter={(v: number) => v.toFixed(0)} />
                      ) : units.map((u, i) => (
                        <YAxis key={u} yAxisId={u} orientation={i % 2 ? 'right' : 'left'}
                          scale={scale === 'log' ? 'log' : 'auto'}
                          domain={scale === 'log' ? ['auto', 'auto'] : undefined}
                          width={u === '$' ? 62 : 54}
                          tick={{ fill: axisColor(u), fontSize: 10, fontFamily: MONO }}
                          tickFormatter={(v: number) => fmt(v, u)} />
                      ))}
                      <Tooltip contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, n: string, p: { payload?: { fy?: string } }) => {
                          const l = lines.find(x => x.label === n)
                          if (scale !== 'idx') return [fmt(v, l?.unit ?? 'x'), n]
                          // An index with no underlying number is a figure you
                          // cannot check, so carry the reported value with it.
                          const raw = rows.find(r => r.fy === p?.payload?.fy)?.[l?.id ?? '']
                          return [`${v.toFixed(1)} · ${fmt(raw as number, l?.unit ?? 'x')}`, n]
                        }} />
                      {/* Recharts' own key draws a 14px stub, which is too short to
                          tell "7 4" from a solid line, so the dash that carries
                          the metric was invisible exactly where it is needed. */}
                      <Legend content={() => (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px',
                          justifyContent: 'center', paddingTop: 6 }}>
                          {lines.map(l => (
                            <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center',
                              gap: 7, fontFamily: SANS, fontSize: 11, color: T.text }}>
                              <svg width={28} height={8} style={{ flexShrink: 0 }} aria-hidden>
                                <line x1={0} y1={4} x2={28} y2={4} stroke={l.color} strokeWidth={2}
                                  strokeDasharray={l.dash} />
                              </svg>
                              {l.label}
                            </span>
                          ))}
                        </div>
                      )} />
                      {estYears.size > 0 && (
                        // Consensus has to look different from what was filed.
                        <ReferenceArea yAxisId={scale === 'idx' ? 'idx' : units[0]}
                          x1={fyLabel(Math.min(...estYears))} x2={fyLabel(Math.max(...estYears))}
                          fill={T.gold} fillOpacity={0.05} stroke={mix(T.gold, 25)} strokeOpacity={1}
                          label={{ value: 'consensus', position: 'insideTop', fontSize: 9,
                            fill: mix(T.gold, 70), fontFamily: SANS }} />
                      )}
                      {lines.map(l => (
                        <Line key={l.id} yAxisId={axisOf(l.unit)}
                          dataKey={l.id} name={l.label} stroke={l.color} strokeDasharray={l.dash}
                          strokeWidth={1.9} dot={false} isAnimationActive={false}
                          // A year SEC never tagged must stay a gap, not a joined line.
                          connectNulls={false} />
                      ))}
                      {last >= MIN_SPAN && (
                        <Brush dataKey="fy" height={18} travellerWidth={7} startIndex={lo} endIndex={hi}
                          stroke={T.goldTint(45)} fill={mix(T.surface, 60)}
                          onChange={(r: { startIndex?: number; endIndex?: number }) => {
                            if (typeof r?.startIndex === 'number' && typeof r?.endIndex === 'number') {
                              setSpan(r.startIndex, r.endIndex)
                            }
                          }} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
                </div>
              </div>
              {dropped > 0 && (
                <div style={{ padding: '0 12px 8px', fontFamily: SANS, fontSize: 9.5, color: T.warn }}>
                  {dropped} point{dropped === 1 ? '' : 's'} in view are zero or negative and cannot sit on a log axis.
                </div>
              )}
            </div>

            <div style={{ border: `1px solid ${T.border}`, background: T.bg, overflowX: 'auto', flex: '0 0 auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontFamily: SANS, fontSize: 8.5,
                      fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted,
                      borderBottom: `1px solid ${T.border}`, position: 'sticky', left: 0, background: T.bg }}>Metric</th>
                    {rows.map(r => (
                      <th key={r.fy as string} style={{ textAlign: 'right', padding: '7px 10px', fontFamily: MONO,
                        fontSize: 10, color: T.muted, borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{r.fy}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => (
                    <tr key={l.id}>
                      <td style={{ padding: '5px 10px', fontFamily: SANS, fontSize: 11.5,
                        color: l.color, borderBottom: `1px solid ${T.borderFaint}`,
                        position: 'sticky', left: 0, background: T.bg, whiteSpace: 'nowrap' }}>{l.label}</td>
                      {rows.map(r => (
                        <td key={r.fy as string} style={{ textAlign: 'right', padding: '5px 10px', fontFamily: MONO,
                          fontSize: 11, color: T.text, borderBottom: `1px solid ${T.borderFaint}`, whiteSpace: 'nowrap' }}>
                          {fmt(r[l.id] as number, l.unit)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}
