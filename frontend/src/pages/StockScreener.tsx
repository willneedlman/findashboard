import { useState, useEffect, useMemo, useRef } from 'react'
import { todayLocal } from '../lib/time'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadingState from '../components/LoadingState'
import ErrorState from '../components/ErrorState'
import Tooltip from '../components/Tooltip'
import { setLinkedTicker } from '../lib/tickerLink'
import useIsMobile from '../hooks/useIsMobile'
import { ArrowRight, ChevronDown } from 'lucide-react'
import { readPMPortfolios, addHoldingsToPortfolio, normalizeTicker, type PMPortfolio } from '../lib/pmImport'
import { useToolState } from '../hooks/useToolState'
import { formatScreenerFilterDisplay, screenerAsOfLabel, screenerFilterPlaceholder, screenerFilterToApi } from '../lib/format'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, textClip } from '../lib/reportCaptureRegistry'
import ShellActions from '../components/ShellActions'

const C = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', surface: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #7e93ab)',
  dim: 'color-mix(in srgb, var(--theme-secondary, #6b7d93) 85%, transparent)',
  emph: 'var(--theme-text, #e7eefc)',
  chipVal: 'color-mix(in srgb, var(--theme-text, #cdd8ee) 92%, transparent)',
  mutedNum: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 78%, var(--theme-bg))',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)', warn: 'var(--theme-warn, #f59e0b)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

const OPERATORS = [
  { value: 'gt',      label: '>'  },
  { value: 'gte',     label: '>=' },
  { value: 'lt',      label: '<'  },
  { value: 'lte',     label: '<=' },
  { value: 'between', label: '↔' },
]

const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: C.text,
  fontFamily: C.mono, fontSize: 11, padding: '5px 7px', outline: 'none', width: '100%', boxSizing: 'border-box',
}
const SELECT: React.CSSProperties = { ...INPUT, cursor: 'pointer' }

// Sector → data-viz color. Sectors with a theme token track color presets; the
// rest stay distinct categorical hexes (like the app's other chart series).
const SECTOR_COLORS: Record<string, string> = {
  'Technology': 'var(--theme-tertiary, #60a5fa)', 'Communication Services': 'var(--theme-accent-violet, #a78bfa)',
  'Financial Services': 'var(--theme-chart-neutral, #4a7fa5)', 'Consumer Cyclical': 'var(--theme-accent-orange, #f59e0b)',
  'Healthcare': '#2dd4bf', 'Consumer Defensive': 'var(--theme-secondary, #8099b0)',
  'Industrials': '#e07a5f', 'Energy': '#d4a72c', 'Utilities': '#6ee7b7', 'Real Estate': '#c084fc',
  'Basic Materials': '#94a3b8',
}
const sectorColor = (s?: string) => (s && SECTOR_COLORS[s]) || 'var(--theme-text-dim, #56657b)'

interface FieldMeta { id: string; label: string; group: string }
interface FilterRow { id: number; field: string; operator: string; value: string; value2: string; param?: string }

const PRICE_PERIODS = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y']

interface ScreenResult {
  ticker: string; companyName: string; price: number | null; marketCap: number | null
  beta: number | null; volume: number | null; sector: string; exchange: string
  peRatio: number | null; pegRatio: number | null
  pbRatio: number | null; psRatio: number | null; evEbitda: number | null
  grossMargin: number | null; operatingMargin: number | null; netMargin: number | null
  roe: number | null; debtEquity: number | null; currentRatio: number | null
  revenueGrowth: number | null; epsGrowth: number | null; dividendYield: number | null
  change52wHiPct: number | null; avgVolume: number | null
  rsi14: number | null; smaDist50: number | null; smaDist200: number | null; vol30: number | null
  priceChange: number | null; region: string | null; country: string | null
  // Provenance. A row's price is either live, a cached vendor snapshot, or the
  // bundled July seed, and its fundamentals are sourced independently of that.
  priceSource: string | null; priceAsOf: string | null; fundamentalsSource: string | null
}

// Handoff to the Algo Strategy Builder: "Send to Algo Builder" writes the
// current result set's tickers here, then hard-navigates to /algo-strategy,
// which reads + clears this key on mount and appends one position per ticker.
export const SCREENER_ALGO_HANDOFF_KEY = 'fdb_screener_algo_universe_handoff'
export type ScreenerAlgoHandoff = {
  version: 1
  createdAt: string
  tickers: string[]
}

// Column registry. `w` is the grid width when shown (Company is rendered specially).
const TABLE_COLS: { key: keyof ScreenResult; label: string; w: string; align: 'left' | 'right'; fmt: (v: unknown) => string; colorFn?: (v: number) => string }[] = [
  { key: 'sector',          label: 'Sector',     w: '150px', align: 'left',  fmt: v => String(v ?? '—') },
  { key: 'region',          label: 'Region',     w: '130px', align: 'left',  fmt: v => String(v ?? '—') },
  { key: 'price',           label: 'Price',      w: '92px',  align: 'right', fmt: v => v != null ? `$${Number(v).toFixed(2)}` : '—' },
  { key: 'priceChange',     label: 'Chg %',      w: '88px',  align: 'right', fmt: v => v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '—', colorFn: v => v >= 0 ? C.pos : C.neg },
  { key: 'marketCap',       label: 'Mkt Cap',    w: '104px', align: 'right', fmt: v => v != null ? `$${Number(v).toFixed(1)}B` : '—' },
  { key: 'volume',          label: 'Volume',     w: '88px',  align: 'right', fmt: v => v != null ? Intl.NumberFormat('en', { notation: 'compact' }).format(Number(v)) : '—' },
  { key: 'beta',            label: 'Beta',       w: '70px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v > 1.5 ? C.warn : v < 0 ? C.neg : C.text },
  { key: 'peRatio',         label: 'P/E',        w: '70px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(1) : '—' },
  { key: 'pegRatio',        label: 'PEG',        w: '70px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v > 0 && v < 1 ? C.pos : v < 2 ? C.text : C.neg },
  { key: 'pbRatio',         label: 'P/B',        w: '70px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(2) : '—' },
  { key: 'psRatio',         label: 'P/S',        w: '70px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(2) : '—' },
  { key: 'evEbitda',        label: 'EV/EBITDA',  w: '92px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(1) : '—' },
  { key: 'grossMargin',     label: 'Gross %',    w: '84px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 60 ? C.pos : v > 30 ? C.text : C.neg },
  { key: 'operatingMargin', label: 'Op %',       w: '78px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 20 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'netMargin',       label: 'Net %',      w: '78px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 15 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'roe',             label: 'ROE %',      w: '78px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 15 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'debtEquity',      label: 'D/E',        w: '70px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v < 0.5 ? C.pos : v < 1.5 ? C.warn : C.neg },
  { key: 'currentRatio',    label: 'Curr Ratio', w: '92px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v > 1.5 ? C.pos : v > 1 ? C.warn : C.neg },
  { key: 'revenueGrowth',   label: 'Rev Growth', w: '104px', align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 15 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'epsGrowth',       label: 'EPS Growth', w: '104px', align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 10 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'dividendYield',   label: 'Div Yield',  w: '92px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(2)}%` : '—' },
  { key: 'change52wHiPct',  label: '52W Hi%',    w: '88px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > -5 ? C.pos : v > -20 ? C.warn : C.neg },
  { key: 'rsi14',           label: 'RSI',        w: '64px',  align: 'right', fmt: v => v != null ? Number(v).toFixed(0) : '—', colorFn: v => v >= 70 ? C.neg : v <= 30 ? C.pos : C.text },
  { key: 'smaDist50',       label: 'vs 50D MA',  w: '96px',  align: 'right', fmt: v => v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%` : '—', colorFn: v => v >= 0 ? C.pos : C.neg },
  { key: 'smaDist200',      label: 'vs 200D MA', w: '100px', align: 'right', fmt: v => v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%` : '—', colorFn: v => v >= 0 ? C.pos : C.neg },
  { key: 'vol30',           label: '30D Vol',    w: '84px',  align: 'right', fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 50 ? C.neg : v > 30 ? C.warn : C.text },
]

// Client-side seeded screens (presets). Selecting one loads its filters + sort.
export interface Preset { id: string; name: string; desc: string; universes?: string[]; sortBy: string; sortDir: 'asc' | 'desc'; sortParam?: string; filters: { field: string; operator: string; value: string; param?: string }[] }
const PRESETS: Preset[] = [
  { id: 'liquid-large-caps', name: 'Liquid Large Caps', desc: 'Big, liquid names, loads instantly', sortBy: 'marketCap', sortDir: 'desc',
    filters: [{ field: 'marketCap', operator: 'gt', value: '10' }] },
  { id: 'mega-cap-quality', name: 'Mega-Cap Quality', desc: 'Large, profitable compounders', sortBy: 'marketCap', sortDir: 'desc',
    filters: [{ field: 'marketCap', operator: 'gt', value: '100' }, { field: 'operatingMargin', operator: 'gt', value: '20' }, { field: 'roe', operator: 'gt', value: '15' }] },
  { id: 'deep-value', name: 'Deep Value', desc: 'Low P/E, low price-to-book', sortBy: 'peRatio', sortDir: 'asc',
    filters: [{ field: 'peRatio', operator: 'gt', value: '0' }, { field: 'peRatio', operator: 'lt', value: '15' }, { field: 'pbRatio', operator: 'lt', value: '3' }] },
  { id: 'high-growth', name: 'High Growth', desc: 'Revenue growth over 25%', sortBy: 'revenueGrowth', sortDir: 'desc',
    filters: [{ field: 'revenueGrowth', operator: 'gt', value: '25' }] },
  { id: 'dividend-growers', name: 'Dividend Growers', desc: 'Yield over 2%, profitable', sortBy: 'dividendYield', sortDir: 'desc',
    filters: [{ field: 'dividendYield', operator: 'gt', value: '2' }, { field: 'netMargin', operator: 'gt', value: '5' }] },
  { id: 'momentum-leaders', name: 'Momentum Leaders', desc: 'Near 52-week highs', sortBy: 'priceChange', sortDir: 'desc', sortParam: '3M',
    filters: [{ field: 'change52wHiPct', operator: 'gt', value: '-5' }, { field: 'priceChange', operator: 'gt', value: '10', param: '3M' }] },
  { id: 'quality-at-a-price', name: 'Quality at a Price', desc: 'High ROE, fair multiple', sortBy: 'roe', sortDir: 'desc',
    filters: [{ field: 'roe', operator: 'gt', value: '15' }, { field: 'peRatio', operator: 'lt', value: '25' }] },
]
const DEFAULT_PRESET = PRESETS[0]
let _fid = 1

// The Screen Library is user-editable (create/rename/delete/reorder) but
// starts seeded from the built-in PRESETS above on first-ever visit — from
// that point on the persisted, mutable copy in localStorage is the source of
// truth, so a rename/delete of a "built-in" screen behaves exactly like one
// on a screen the user made themselves.
export const SAVED_SCREENS_KEY = 'fdb_screener_saved_screens_v1'
export function loadScreens(): Preset[] {
  try {
    const raw = localStorage.getItem(SAVED_SCREENS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) return parsed
    }
  } catch { /* fall through to seed */ }
  return PRESETS
}
const toRows = (p: Preset): FilterRow[] => p.filters.map(f => ({ id: _fid++, field: f.field, operator: f.operator, value: f.value, value2: '', param: f.param }))

const EB: React.CSSProperties = { fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase', color: C.muted }

function FieldSelect({ value, fields, onChange }: { value: string; fields: FieldMeta[]; onChange: (v: string) => void }) {
  const groups = [...new Set(fields.map(f => f.group))]
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...SELECT, flex: 1, minWidth: 0 }}>
      {groups.map(g => (
        <optgroup key={g} label={g}>
          {fields.filter(f => f.group === g).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

const fmtMc = (b: number) => b >= 1000 ? `$${(b / 1000).toFixed(1)}T` : `$${Math.round(b)}B`
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

// Deep links from a screened name into the rest of the terminal.
// Overview has no route: it fires the same 'ft:ticker-drawer' window event the
// command palette and <TickerLink> use, opening the slide-over in place.
const ROW_LINKS: { label: string; base?: string; overview?: boolean }[] = [
  { label: 'Profile',  base: '/company-profile' },
  { label: 'Peers',    base: '/peer-comparison' },
  { label: 'Overview', overview: true },
  { label: 'DCF',      base: '/dcf' },
  { label: 'Alert',    base: '/alerts' },
]

// Checkbox dropdown so several universes can screen together (e.g. S&P 500 +
// Nasdaq 100 + a Sector SPDR) — a native <select multiple> can't do a
// click-to-toggle dropdown with grouped headers the way a single-select
// <select>+<optgroup> can. Empty selection = "Bundled Universes" (all three
// core indexes) and is exclusive with any other pick, matching the single-
// select default's meaning.
function UniverseMultiSelect({ options, groups, selected, onChange, triggerStyle }: {
  options: { value: string; label: string; group: string }[]
  groups: string[]
  selected: string[]
  onChange: (values: string[]) => void
  triggerStyle: React.CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  const toggle = (value: string) => {
    if (!value) { onChange([]); return }
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value])
  }
  const bundledLabel = options.find(o => !o.value)?.label ?? 'All'
  const label = selected.length === 0 ? bundledLabel
    : selected.length === 1 ? (options.find(o => o.value === selected[0])?.label ?? selected[0])
    : `${selected.length} universes`
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <span onClick={() => setOpen(v => !v)} title="Universe (select one or more)"
        style={{ ...triggerStyle, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
        {label}<ChevronDown size={11} />
      </span>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 210, maxHeight: 340, overflowY: 'auto', background: C.surface, border: `1px solid ${C.border}`, padding: 6, zIndex: 40, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
          {groups.map(g => (
            <div key={g}>
              <div style={{ fontFamily: C.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.dim, padding: '6px 8px 3px' }}>{g}</div>
              {options.filter(o => o.group === g).map(o => {
                const checked = o.value ? selected.includes(o.value) : selected.length === 0
                return (
                  <label key={o.value || 'all'} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 8px', fontFamily: C.sans, fontSize: 11, color: checked ? C.gold : C.chipVal, cursor: 'pointer' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} style={{ margin: 0, accentColor: C.gold }} />
                    {o.label}
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StockScreener() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  // The working screen survives navigating away. This reset to DEFAULT_PRESET on
  // every mount, so a 25-filter screen you had not explicitly saved was gone the
  // moment you opened another tool and came back.
  const [filters, setFilters]   = useToolState<FilterRow[]>('screener.filters', toRows(DEFAULT_PRESET))
  const [sector,   setSector]   = useToolState('screener.sector', '')
  const [exchange, setExchange] = useToolState('screener.exchange', '')
  const [region,   setRegion]   = useToolState('screener.region', '')
  const [selectedUniverses, setSelectedUniverses] = useToolState<string[]>('screener.universes', DEFAULT_PRESET.universes ?? [])
  const [sortBy,   setSortBy]   = useToolState('screener.sortBy', DEFAULT_PRESET.sortBy)
  const [sortDir,  setSortDir]  = useToolState<'desc' | 'asc'>('screener.sortDir', DEFAULT_PRESET.sortDir)
  const [sortParam, setSortParam] = useToolState('screener.sortParam', DEFAULT_PRESET.sortParam ?? '1M')
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(['sector', 'price', 'priceChange', 'marketCap', 'peRatio', 'pegRatio', 'operatingMargin', 'revenueGrowth'])
  )
  const [colPanelOpen, setColPanelOpen] = useState(false)
  const [localSort, setLocalSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: DEFAULT_PRESET.sortBy, dir: DEFAULT_PRESET.sortDir })
  const [textFilter, setTextFilter] = useState('')
  const [activeScreenId, setActiveScreenId] = useState<string>(DEFAULT_PRESET.id)
  const [screens, setScreens] = useState<Preset[]>(loadScreens)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem('screenerRailCollapsed') === '1')
  const [editingFilterId, setEditingFilterId] = useState<number | null>(null)
  const [density, setDensity] = useState<'roomy' | 'compact'>('roomy')
  const [zebra, setZebra] = useState(true)
  const [dots, setDots] = useState(true)

  useEffect(() => { localStorage.setItem('screenerRailCollapsed', railCollapsed ? '1' : '0') }, [railCollapsed])

  const { data: meta } = useQuery({
    queryKey: ['screener-fields'],
    queryFn: () => axios.get('/api/screener/fields').then(r => r.data),
    staleTime: Infinity,
  })
  // Industry-median benchmarks (WIFR methodology) — static bundled computation,
  // fetch once. Powers the sector-median tooltip on ratio cells; no new columns
  // or badges, so the table stays exactly as dense as before.
  const { data: sectorMedians } = useQuery({
    queryKey: ['screener-sector-medians'],
    queryFn: () => axios.get('/api/screener/sector-medians').then(r => r.data),
    staleTime: Infinity,
  })
  const medianFields: Set<string> = new Set(sectorMedians?.fields ?? [])
  // Quartile marker (↑ top quartile, ↓ bottom quartile) alongside the value —
  // visible without hovering, no new column. Deliberately neutral-colored
  // rather than green/red: which quartile is "good" depends on the ratio
  // (top-quartile margin is good, top-quartile debt/equity usually isn't),
  // so this shows WHERE a value sits, not a judgment on it.
  const medianBadge = (sector: string, field: string, value: number | null): { symbol: string; tip: string } | null => {
    if (value == null || !sector || !medianFields.has(field)) return null
    const entry = sectorMedians?.sectors?.[sector]?.[field]
    if (!entry) return null
    const delta = value - entry.median
    const tip = `${sector} median: ${entry.median.toFixed(2)} (n=${entry.n}) · this name is ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ${delta >= 0 ? 'above' : 'below'}`
    if (entry.p75 != null && value > entry.p75) return { symbol: '↑', tip: `${tip} · top quartile` }
    if (entry.p25 != null && value < entry.p25) return { symbol: '↓', tip: `${tip} · bottom quartile` }
    return { symbol: '', tip }
  }
  const fields: FieldMeta[] = meta?.fields ?? []
  const sectors: string[]   = meta?.sectors ?? []
  const exchanges: string[] = meta?.exchanges ?? []
  const regions: string[]   = meta?.regions ?? []
  const universes: { value: string; label: string; group: string }[] = meta?.universes ?? [
    { value: '', label: 'Bundled Universes', group: 'Indexes' },
    { value: 'sp500', label: 'S&P 500', group: 'Indexes' },
  ]
  const universeGroups = [...new Set(universes.map(u => u.group))]

  // Several universes screen together as N parallel single-universe requests,
  // merged and deduped by ticker client-side — mirrors the AI assistant's own
  // multi-universe screen (backend/routers/ai.py's _screen_candidates loop),
  // rather than teaching the screener endpoint's already-large universe-
  // resolution logic a second, union-of-sets code path.
  const { mutate, data, isPending, error, reset } = useMutation({
    mutationFn: async () => {
      const body = {
        filters: filters.filter(f => f.value !== '').map(f => ({
          field: f.field, operator: f.operator,
          value: screenerFilterToApi(f.field, f.value) ?? parseFloat(f.value),
          value2: f.value2 ? (screenerFilterToApi(f.field, f.value2) ?? parseFloat(f.value2)) : null,
          param: f.field === 'priceChange' ? (f.param || '1M') : null,
        })),
        sector: sector || null, exchange: exchange || null, region: region || null,
        sort_by: sortBy, sort_dir: sortDir, sort_param: sortBy === 'priceChange' ? sortParam : null,
        limit: 200,
      }
      const targets = selectedUniverses.length ? selectedUniverses : [null]
      const responses = await Promise.all(targets.map(u =>
        axios.post('/api/screener/run', { ...body, universe: u }).then(r => r.data)
      ))
      if (responses.length === 1) return responses[0]
      const seen = new Set<string>()
      const results: ScreenResult[] = []
      for (const r of responses) {
        for (const row of r.results ?? []) {
          const t = row.ticker?.toUpperCase()
          if (t && !seen.has(t)) { seen.add(t); results.push(row) }
        }
      }
      // Provenance is recomputed over the merged set rather than taken from the
      // first response, or a union of a live board and a bundled one would
      // report whichever universe happened to be screened first.
      const priceSources: Record<string, number> = {}
      const fundamentalsSources: Record<string, number> = {}
      for (const row of results) {
        const p = row.priceSource ?? 'unknown'
        priceSources[p] = (priceSources[p] ?? 0) + 1
        const f = row.fundamentalsSource ?? 'none'
        fundamentalsSources[f] = (fundamentalsSources[f] ?? 0) + 1
      }
      const stamps = results.map(row => row.priceAsOf).filter((s): s is string => !!s)
      return {
        results, total: results.length, changePeriod: responses[0]?.changePeriod,
        priceAsOf: stamps.length ? stamps.reduce((a, b) => a < b ? a : b) : null,
        priceSources, fundamentalsSources, bundledAsOf: responses[0]?.bundledAsOf ?? null,
      }
    },
  })

  const runScreen = () => mutate()

  useEffect(() => { if (data) { setLocalSort({ key: sortBy, dir: sortDir }); setTextFilter('') } }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyPreset = (p: Preset) => {
    setFilters(toRows(p))
    setSelectedUniverses(p.universes ?? [])
    setSector(''); setExchange(''); setRegion('')
    setSortBy(p.sortBy); setSortDir(p.sortDir); setSortParam(p.sortParam ?? '1M')
    setEditingFilterId(null)
    setActiveScreenId(p.id)
    reset()
  }

  // "+ New Screen": start a blank custom screen with one filter ready to edit.
  const newScreen = () => {
    const id = _fid++
    setFilters([{ id, field: 'marketCap', operator: 'gt', value: '', value2: '' }])
    setSelectedUniverses([]); setSector(''); setExchange(''); setRegion('')
    setSortBy('marketCap'); setSortDir('desc')
    setActiveScreenId('custom-' + id)
    setEditingFilterId(id)
    reset()
  }

  useEffect(() => { localStorage.setItem(SAVED_SCREENS_KEY, JSON.stringify(screens)) }, [screens])

  // Save: updates the active screen in place if it's already in the library
  // (e.g. filters were tweaked after picking it), otherwise files the current
  // live config as a brand-new library entry and opens its name for editing.
  const saveScreen = () => {
    const config = {
      universes: selectedUniverses.length ? selectedUniverses : undefined,
      sortBy, sortDir, sortParam: sortBy === 'priceChange' ? sortParam : undefined,
      filters: filters.filter(f => f.value !== '').map(f => ({ field: f.field, operator: f.operator, value: f.value, param: f.param })),
    }
    const existing = screens.find(s => s.id === activeScreenId)
    if (existing) {
      setScreens(prev => prev.map(s => s.id === activeScreenId ? { ...s, ...config } : s))
      return
    }
    const names = new Set(screens.map(s => s.name))
    let name = 'New Screen'
    let n = 2
    while (names.has(name)) name = `New Screen ${n++}`
    const id = 'screen-' + Date.now().toString(36)
    setScreens(prev => [...prev, { id, name, desc: '', ...config }])
    setActiveScreenId(id)
    setRenamingId(id)
    setRenameText(name)
  }
  const startRename = (s: Preset) => { setRenamingId(s.id); setRenameText(s.name) }
  const commitRename = () => {
    if (renamingId) setScreens(prev => prev.map(s => s.id === renamingId ? { ...s, name: renameText.trim() || s.name } : s))
    setRenamingId(null)
  }
  const deleteScreen = (id: string) => {
    setScreens(prev => {
      const next = prev.filter(s => s.id !== id)
      if (activeScreenId === id && next.length) applyPreset(next[0])
      return next
    })
  }
  const moveScreen = (id: string, dir: -1 | 1) => {
    setScreens(prev => {
      const i = prev.findIndex(s => s.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const addFilter = () => {
    const id = _fid++
    setFilters(p => [...p, { id, field: 'marketCap', operator: 'gt', value: '', value2: '' }])
    setEditingFilterId(id)
  }
  const removeFilter = (id: number) => { setFilters(p => p.filter(f => f.id !== id)); if (editingFilterId === id) setEditingFilterId(null) }
  const patchFilter = (id: number, patch: Partial<FilterRow>) => setFilters(p => p.map(f => f.id === id ? { ...f, ...patch } : f))

  const handleSort = (col: string) => setLocalSort(prev => ({ key: col, dir: prev.key === col && prev.dir === 'desc' ? 'asc' : 'desc' }))

  const STRING_KEYS = useMemo(() => new Set(['ticker', 'companyName', 'sector', 'exchange', 'region']), [])
  const displayRows = useMemo(() => {
    if (!data?.results) return []
    let rows = [...data.results] as ScreenResult[]
    if (textFilter.trim()) {
      const q = textFilter.trim().toLowerCase()
      rows = rows.filter(r => r.ticker.toLowerCase().includes(q) || (r.companyName ?? '').toLowerCase().includes(q) || (r.sector ?? '').toLowerCase().includes(q))
    }
    rows.sort((a, b) => {
      const av = a[localSort.key as keyof ScreenResult], bv = b[localSort.key as keyof ScreenResult]
      let cmp: number
      if (STRING_KEYS.has(localSort.key)) cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      else if (av == null && bv == null) cmp = 0
      else if (av == null) cmp = 1
      else if (bv == null) cmp = -1
      else cmp = Number(av) - Number(bv)
      return localSort.dir === 'desc' ? -cmp : cmp
    })
    return rows
  }, [data, localSort, textFilter, STRING_KEYS])

  // Send/save actions act on the currently visible rows (displayRows) — same
  // "what's on screen" semantics exportCsv already uses, so filtering the
  // table first is how the user scopes what gets sent, no separate
  // row-selection UI needed.
  const [pmPickerOpen, setPmPickerOpen] = useState(false)
  const [pmTarget, setPmTarget] = useState('new')
  const [pmNewName, setPmNewName] = useState('')
  const [pmResult, setPmResult] = useState<{ name: string; added: number; skipped: number; notFound?: false } | { notFound: true } | null>(null)
  const pmBooks = useMemo(() => readPMPortfolios(), [pmPickerOpen])

  const sendToAlgoBuilder = () => {
    const tickers = [...new Set(displayRows.map(r => normalizeTicker(r.ticker)).filter(Boolean))]
    if (!tickers.length) return
    const handoff: ScreenerAlgoHandoff = { version: 1, createdAt: new Date().toISOString(), tickers }
    localStorage.setItem(SCREENER_ALGO_HANDOFF_KEY, JSON.stringify(handoff))
    window.location.assign('/algo-strategy')
  }

  const confirmAddToPortfolio = () => {
    const holdings = displayRows.map(r => ({ ticker: r.ticker, shares: 1, avgCost: r.price ?? 0 }))
    if (!holdings.length) return
    const target = pmTarget === 'new' ? { newName: pmNewName || 'Screener picks' } : { portfolioId: pmTarget }
    const result = addHoldingsToPortfolio(target, holdings)
    setPmResult(result)
  }

  // Summary stats over the full result set.
  const stats = useMemo(() => {
    const rows = (data?.results ?? []) as ScreenResult[]
    const col = (k: keyof ScreenResult) => rows.map(r => r[k]).filter(v => v != null && !isNaN(Number(v))).map(Number)
    const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
    const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
    const counts: Record<string, number> = {}
    rows.forEach(r => { const s = r.sector || 'Other'; counts[s] = (counts[s] || 0) + 1 })
    const total = rows.length || 1
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    const mix = sorted.slice(0, 6).map(([name, c]) => ({ name, pct: (c / total) * 100, color: sectorColor(name) }))
    const other = sorted.slice(6).reduce((a, [, c]) => a + c, 0)
    if (other > 0) mix.push({ name: 'Other', pct: (other / total) * 100, color: 'var(--theme-text-dim, #56657b)' })
    return { matches: data?.total ?? rows.length, avgPE: mean(col('peRatio').filter(v => v > 0)), medRev: median(col('revenueGrowth')), avgOp: mean(col('operatingMargin')), medMc: median(col('marketCap')), mix }
  }, [data])

  const activePreset = screens.find(p => p.id === activeScreenId)

  useReportCapture(() => {
    if (!data?.results?.length) return null
    const pieces: ClipDraft[] = []
    const screenName = activePreset?.name ?? 'Custom'
    const n = displayRows.length
    const total = data.total ?? data.results.length
    const sectorsHit = new Set(displayRows.map(r => r.sector).filter(Boolean)).size
    pieces.push(kpiClip('Stock Screener', `Screen Results · ${screenName}`, [
      { label: 'Matches', value: String(n), sub: n !== total ? `${total} before table filter` : undefined },
      { label: 'Sectors', value: String(sectorsHit) },
      { label: 'Sort', value: `${localSort.key} ${localSort.dir}` },
      ...(selectedUniverses.length ? [{ label: 'Universe', value: selectedUniverses.join(', ') }] : []),
    ]))
    const activeFilters = filters.filter(f => f.value !== '')
    if (activeFilters.length) {
      pieces.push(textClip(
        'Stock Screener',
        'Active Filters',
        activeFilters.map(f => {
          const op = OPERATORS.find(o => o.value === f.operator)?.label ?? f.operator
          const range = f.operator === 'between' && f.value2 ? `${f.value}–${f.value2}` : f.value
          return `${f.field} ${op} ${range}${f.param ? ` (${f.param})` : ''}`
        }).join('\n'),
      ))
    }
    const colKeys = (['ticker', 'companyName', ...[...visibleCols]] as (keyof ScreenResult)[])
      .filter((k, i, a) => a.indexOf(k) === i)
      .slice(0, 10)
    const colMeta = colKeys.map(k => {
      if (k === 'ticker') return { key: k, label: 'Ticker', fmt: (v: unknown) => String(v ?? '—') }
      if (k === 'companyName') return { key: k, label: 'Company', fmt: (v: unknown) => String(v ?? '—') }
      const meta = TABLE_COLS.find(c => c.key === k)
      return { key: k, label: meta?.label ?? String(k), fmt: meta?.fmt ?? ((v: unknown) => v == null ? '—' : String(v)) }
    })
    pieces.push(tableClip(
      'Stock Screener',
      `Top Matches · ${screenName}`,
      colMeta.map(c => c.label),
      displayRows.slice(0, 20).map(r => colMeta.map(c => c.fmt(r[c.key]))),
    ))
    return pieces
  }, { disabled: !data?.results?.length, sourceTab: 'Stock Screener' })

  const sortColLabel = sortBy === 'priceChange' ? `${sortParam} price change` : (TABLE_COLS.find(c => c.key === sortBy)?.label ?? sortBy)
  // The 1D move exists only when the snapshot or the live overlay supplied it.
  // A column of dashes should not hold a slot in a dense table.
  const hasPriceChange = useMemo(() => displayRows.some(r => r.priceChange != null), [displayRows])
  const renderCols = TABLE_COLS.filter(c => visibleCols.has(c.key as string) && (c.key !== 'priceChange' || hasPriceChange))
  const gridTemplate = `minmax(190px,1.5fr) ${renderCols.map(c => c.w).join(' ')}`
  // Natural width of the table; the scroll container falls back to horizontal
  // scroll below this so columns stay readable instead of being clipped when the
  // results pane is narrow (e.g. the app nav rail is expanded).
  const tableMinWidth = 48 + 190 + renderCols.reduce((s, c) => s + parseInt(c.w, 10), 0)
  const rowPad = density === 'compact' ? 7 : 11
  const universeLabel = selectedUniverses.length === 0 ? (universes.find(u => !u.value)?.label ?? 'All')
    : selectedUniverses.length === 1 ? (universes.find(u => u.value === selectedUniverses[0])?.label ?? selectedUniverses[0])
    : `${selectedUniverses.length} universes`

  const focus = (e: React.FocusEvent<HTMLElement>) => ((e.target as HTMLElement).style.borderColor = C.gold)
  const blur  = (e: React.FocusEvent<HTMLElement>) => ((e.target as HTMLElement).style.borderColor = 'var(--theme-border, rgba(255,255,255,0.13))')

  const railBtn: React.CSSProperties = { cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, background: 'none' }
  const scopeSelect: React.CSSProperties = { ...SELECT, fontSize: 10.5, padding: '5px 6px', width: 'auto', border: '1px solid var(--theme-border, rgba(255,255,255,0.13))', background: C.surface, color: C.chipVal }

  // ── Filter chip (the editor is a separate bar below the row) ──
  const chip = (f: FilterRow) => {
    const fieldLabel = (fields.find(x => x.id === f.field)?.label ?? f.field).replace(' (%)', '').replace(' ($B)', '').replace(' ($)', '')
    const opSym = OPERATORS.find(o => o.value === f.operator)?.label ?? f.operator
    const periodSuffix = f.field === 'priceChange' ? ` ${f.param || '1M'}` : ''
    const expr = `${opSym} ${formatScreenerFilterDisplay(f.field, f.value)}${f.operator === 'between' && f.value2 ? `–${formatScreenerFilterDisplay(f.field, f.value2)}` : ''}`
    const editing = editingFilterId === f.id
    return (
      <span key={f.id} onClick={() => setEditingFilterId(editing ? null : f.id)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none', whiteSpace: 'nowrap', border: `1px solid ${editing ? C.gold : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 42%, transparent)'}`, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', fontFamily: C.mono, fontSize: 11, padding: '6px 10px', cursor: 'pointer' }}>
        <span style={{ color: C.gold }}>{fieldLabel}{periodSuffix}</span>
        <span style={{ color: C.chipVal }}>{expr}</span>
        <span onClick={e => { e.stopPropagation(); removeFilter(f.id) }} style={{ color: C.dim, fontSize: 13, lineHeight: 1 }} title="Remove filter">×</span>
      </span>
    )
  }

  const editingFilter = filters.find(f => f.id === editingFilterId)

  return (
    <PageWrapper>
      <div style={{ height: isMobile ? 'auto' : 'calc(100dvh - 36px)', minHeight: isMobile ? 'calc(100dvh - 96px)' : undefined, display: 'flex', flexDirection: 'column', background: C.bg, border: `1px solid ${C.border}` }}>

        {/* title bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: isMobile ? '12px' : '15px 24px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)', flex: 'none' }}>
          <span style={{ fontFamily: C.sans, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.gold }}>Stock Screener</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: '0.04em', color: C.dim }}>
              {universeLabel.toUpperCase()} · {data ? `${data.total} MATCHES · ${screenerAsOfLabel(data.priceAsOf, data.priceSources)}` : 'READY'}
            </span>
            <ShellActions />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minHeight: 0 }}>

          {/* ── Screen Library rail ── */}
          {!isMobile && <div className="ft-rail" style={{ width: railCollapsed ? 54 : 272, flex: 'none', borderRight: `1px solid ${C.border}`, background: C.surface, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {railCollapsed ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 0', gap: 14, height: '100%' }}>
                <span onClick={() => setRailCollapsed(false)} title="Expand library" style={{ ...railBtn, width: 30, height: 30, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)', color: C.gold, fontSize: 14 }}>»</span>
                <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.gold }}>{screens.length}</span>
                <span style={{ fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>Saved</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 13px 18px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  <span style={{ ...EB, fontSize: 9, letterSpacing: '0.16em' }}>Screen Library</span>
                  <span onClick={() => setRailCollapsed(true)} title="Collapse library" style={{ ...railBtn, width: 24, height: 24, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', color: C.muted, fontSize: 14 }}>«</span>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {screens.map((p, screenIdx) => {
                    const on = p.id === activeScreenId
                    const renaming = renamingId === p.id
                    const actionBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontFamily: C.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.04em', color: C.dim, padding: 0 }
                    return (
                      <div key={p.id} className="ft-screen-row" onClick={() => applyPreset(p)}
                        style={{ position: 'relative', padding: '11px 16px 11px 18px', background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, transparent)' : 'transparent', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.045))', cursor: 'pointer' }}>
                        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: on ? C.gold : 'transparent' }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {renaming ? (
                            <input autoFocus value={renameText} onClick={e => e.stopPropagation()}
                              onChange={e => setRenameText(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null) }}
                              style={{ ...INPUT, fontSize: 12.5, fontWeight: 600, padding: '2px 5px' }} />
                          ) : (
                            <span style={{ fontFamily: C.sans, fontSize: 12.5, fontWeight: 600, color: on ? C.emph : C.text }}>{p.name}</span>
                          )}
                          <span style={{ marginLeft: 'auto', fontFamily: C.mono, fontSize: 11, color: on ? C.gold : C.dim }}>{on && data ? data.total : ''}</span>
                        </div>
                        <div style={{ fontFamily: C.sans, fontSize: 9.5, color: C.dim, marginTop: 2 }}>{p.desc}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 5 }}>
                          <span onClick={e => { e.stopPropagation(); moveScreen(p.id, -1) }} title="Move up"
                            style={{ ...actionBtn, opacity: screenIdx === 0 ? 0.3 : 1, cursor: screenIdx === 0 ? 'default' : 'pointer' }}>↑</span>
                          <span onClick={e => { e.stopPropagation(); moveScreen(p.id, 1) }} title="Move down"
                            style={{ ...actionBtn, opacity: screenIdx === screens.length - 1 ? 0.3 : 1, cursor: screenIdx === screens.length - 1 ? 'default' : 'pointer' }}>↓</span>
                          <span onClick={e => { e.stopPropagation(); startRename(p) }} style={actionBtn}>RENAME</span>
                          <span onClick={e => { e.stopPropagation(); deleteScreen(p.id) }} style={{ ...actionBtn, color: 'var(--theme-negative)' }}>DEL</span>
                        </div>
                      </div>
                    )
                  })}
                  <div style={{ padding: '13px 18px', display: 'flex', gap: 8 }}>
                    <span onClick={newScreen} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: C.sans, fontSize: 11, padding: '7px 12px', border: '1px dashed var(--theme-border, rgba(255,255,255,0.16))', color: 'var(--theme-text-muted, #9fb0c7)', cursor: 'pointer' }}>+ New Screen</span>
                    <span onClick={saveScreen} title="Save the current filters/sort/universe as a screen"
                      style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: C.sans, fontSize: 11, fontWeight: 600, padding: '7px 12px', border: `1px solid ${C.gold}`, color: C.gold, cursor: 'pointer' }}>Save</span>
                  </div>
                </div>
                <div style={{ padding: '13px 18px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', flex: 'none' }}>
                  <span style={{ fontFamily: C.sans, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>Pick a screen to run it, then refine filters inline. Edits re-run on Apply.</span>
                </div>
              </div>
            )}
          </div>}

          {/* ── Results pane ── */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>

            {/* screen header + scope + filters */}
            <div style={{ padding: isMobile ? 12 : '16px 24px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
              {isMobile && <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <select value={activeScreenId} onChange={e => { const preset = screens.find(item => item.id === e.target.value); if (preset) applyPreset(preset) }} style={{ ...SELECT, flex: 1, minWidth: 0 }} aria-label="Saved screen">
                  {screens.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
                <button onClick={newScreen} style={{ flex: 'none', padding: '7px 11px', background: 'none', border: `1px solid ${C.border}`, color: C.gold, fontFamily: C.sans, fontSize: 10, cursor: 'pointer' }}>New</button>
                <button onClick={saveScreen} style={{ flex: 'none', padding: '7px 11px', background: 'none', border: `1px solid ${C.gold}`, color: C.gold, fontFamily: C.sans, fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>Save</button>
              </div>}
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'flex-start', justifyContent: 'space-between', gap: isMobile ? 10 : 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  {!isMobile && railCollapsed && <span onClick={() => setRailCollapsed(false)} title="Show library" style={{ ...railBtn, width: 28, height: 28, border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-text-muted, #9fb0c7)', fontSize: 13, flex: 'none' }}>☰</span>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: C.sans, fontSize: 16, fontWeight: 600, color: C.emph }}>{activePreset?.name ?? 'Custom Screen'}</div>
                    <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {activePreset?.desc ?? 'Ad-hoc filters'}{data ? ` · ${data.total} matches · sorted by ${sortColLabel}` : ''}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none', width: isMobile ? '100%' : undefined, minWidth: 0 }}>
                  <input value={textFilter} onChange={e => setTextFilter(e.target.value)} placeholder="Filter by ticker / name / sector..."
                    style={{ background: C.surface, border: '1px solid var(--theme-border, rgba(255,255,255,0.13))', color: C.text, fontFamily: C.sans, fontSize: 11, padding: '7px 12px', minWidth: isMobile ? 0 : 230, flex: isMobile ? 1 : undefined, outline: 'none' }} onFocus={focus} onBlur={blur} />
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => setColPanelOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-text-muted, #9fb0c7)', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', padding: '7px 12px', cursor: 'pointer' }}>
                      Columns <span style={{ color: C.dim, fontSize: 9 }}>▾</span>
                    </button>
                    {colPanelOpen && (
                      <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30, background: C.surface, border: `1px solid ${C.border}`, padding: 12, width: 280, boxShadow: '0 6px 20px rgba(0,0,0,0.4)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 12px', maxHeight: 280, overflowY: 'auto' }}>
                          {TABLE_COLS.map(col => {
                            const onCol = visibleCols.has(col.key as string)
                            return (
                              <label key={col.key as string} onClick={() => setVisibleCols(prev => { const n = new Set(prev); onCol ? n.delete(col.key as string) : n.add(col.key as string); return n })}
                                style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                                <div style={{ width: 10, height: 10, flexShrink: 0, border: `1px solid ${onCol ? C.gold : C.dim}`, background: onCol ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent' }} />
                                <span style={{ fontFamily: C.sans, fontSize: 9.5, color: onCol ? C.text : C.dim, whiteSpace: 'nowrap' }}>{col.label}</span>
                              </label>
                            )
                          })}
                        </div>
                        <div style={{ display: 'flex', gap: 12, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontFamily: C.sans, fontSize: 9.5, color: C.muted }} onClick={() => setDensity(d => d === 'roomy' ? 'compact' : 'roomy')}>
                            <span style={{ color: C.gold, fontFamily: C.mono }}>{density === 'roomy' ? '▣' : '▢'}</span> Roomy rows
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontFamily: C.sans, fontSize: 9.5, color: C.muted }} onClick={() => setZebra(z => !z)}>
                            <span style={{ color: C.gold, fontFamily: C.mono }}>{zebra ? '▣' : '▢'}</span> Zebra
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontFamily: C.sans, fontSize: 9.5, color: C.muted }} onClick={() => setDots(d => !d)}>
                            <span style={{ color: C.gold, fontFamily: C.mono }}>{dots ? '▣' : '▢'}</span> Sector dots
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* scope selectors */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <span style={{ ...EB, marginRight: 2 }}>Scope</span>
                <UniverseMultiSelect options={universes} groups={universeGroups} selected={selectedUniverses} onChange={setSelectedUniverses} triggerStyle={scopeSelect} />
                <select value={sector} onChange={e => setSector(e.target.value)} style={scopeSelect} title="Sector">
                  <option value="">All Sectors</option>{sectors.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select value={region} onChange={e => setRegion(e.target.value)} style={scopeSelect} title="Region">
                  <option value="">All Regions</option>{regions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={exchange} onChange={e => setExchange(e.target.value)} style={scopeSelect} title="Exchange">
                  <option value="">All Exchanges</option>{exchanges.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={runScreen} disabled={isPending}
                  style={{ marginLeft: 'auto', fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.gold, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)', border: `1px solid ${C.gold}`, padding: '7px 16px', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1 }}>
                  {isPending ? 'SCANNING…' : 'SCAN'}
                </button>
              </div>
              {/* filter chips — scroll horizontally instead of wrapping off-screen */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, minWidth: 0 }}>
                <span style={{ ...EB, flex: 'none' }}>Filters</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto', flex: 1, paddingBottom: 2 }}>
                  {filters.map(chip)}
                  <span onClick={addFilter} style={{ fontFamily: C.sans, fontSize: 11, color: C.dim, padding: '0 4px', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}>+ Add filter</span>
                </div>
              </div>

              {/* filter editor — a non-clipped bar so the horizontal-scroll chips don't hide it */}
              {editingFilter && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, padding: 8, background: C.surface, border: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
                  <span style={{ ...EB, flex: 'none' }}>Edit</span>
                  <div style={{ flex: '0 0 200px' }}>
                    <FieldSelect value={editingFilter.field} fields={fields} onChange={v => patchFilter(editingFilter.id, { field: v, param: v === 'priceChange' ? (editingFilter.param || '1M') : undefined })} />
                  </div>
                  {editingFilter.field === 'priceChange' && (
                    <select value={editingFilter.param || '1M'} onChange={e => patchFilter(editingFilter.id, { param: e.target.value })} style={{ ...SELECT, width: 64, flex: 'none', padding: '4px 4px' }}>
                      {PRICE_PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  )}
                  <select value={editingFilter.operator} onChange={e => patchFilter(editingFilter.id, { operator: e.target.value })} style={{ ...SELECT, width: 60, flex: 'none', padding: '4px 4px' }}>
                    {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input value={editingFilter.value} placeholder={screenerFilterPlaceholder(editingFilter.field)} autoFocus style={{ ...INPUT, width: 100, flex: 'none' }}
                    onChange={e => patchFilter(editingFilter.id, { value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { setEditingFilterId(null); runScreen() } }} />
                  {editingFilter.operator === 'between' && (
                    <input value={editingFilter.value2} placeholder={screenerFilterPlaceholder(editingFilter.field)} style={{ ...INPUT, width: 100, flex: 'none' }} onChange={e => patchFilter(editingFilter.id, { value2: e.target.value })} />
                  )}
                  <button onClick={() => { setEditingFilterId(null); runScreen() }}
                    style={{ flex: 'none', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)', border: `1px solid ${C.gold}`, color: C.gold, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
                    Apply
                  </button>
                  {(['marketCap', 'volume', 'avgVolume'] as const).includes(editingFilter.field as 'marketCap' | 'volume' | 'avgVolume') && (
                    <span style={{ fontFamily: C.sans, fontSize: 9, color: C.dim, flex: '1 1 140px', minWidth: 140 }}>
                      K/M/B/T suffixes · bare market cap = $B
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* states / results */}
            {error ? (
              <div style={{ padding: 24 }}>
                <ErrorState
                  title="Screen failed"
                  message={(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Screen failed. Check FMP_API_KEY is configured.'}
                  onRetry={runScreen}
                />
              </div>
            ) : !data && isPending ? (
              <div style={{ padding: 24 }}><LoadingState label="Screening" /></div>
            ) : !data ? (
              <div style={{ padding: 24 }}><EmptyState title="Stock Screener" hint="Pick a screen from the library or set filters, then scan the universe."
                action="SCAN" onAction={runScreen} /></div>
            ) : (
              <>
                {/* summary stats band */}
                <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${C.border}`, background: 'var(--theme-surface, #0d1826)', flex: 'none' }}>
                  {[
                    { label: 'Matches', value: String(stats.matches), color: C.gold, weight: 700 },
                    { label: 'Avg P/E', value: stats.avgPE != null ? stats.avgPE.toFixed(1) : '—', color: C.text, weight: 500 },
                    { label: 'Median Rev Growth', value: stats.medRev != null ? fmtPct(stats.medRev) : '—', color: stats.medRev != null && stats.medRev >= 0 ? C.pos : C.text, weight: 500 },
                    { label: 'Avg Op Margin', value: stats.avgOp != null ? `${stats.avgOp.toFixed(1)}%` : '—', color: C.text, weight: 500 },
                    { label: 'Median Mkt Cap', value: stats.medMc != null ? fmtMc(stats.medMc) : '—', color: C.text, weight: 500 },
                  ].map(s => (
                    <div key={s.label} style={{ flex: '1 1 0', minWidth: 0, padding: '13px 22px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ ...EB, whiteSpace: 'nowrap' }}>{s.label}</span>
                      <span style={{ fontFamily: C.mono, fontSize: 17, fontWeight: s.weight, color: s.color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{s.value}</span>
                    </div>
                  ))}
                  <div style={{ flex: '1.6 1 0', minWidth: 0, padding: '13px 22px', display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}>
                    <div style={{ display: 'flex', height: 8, gap: 1.5, width: '100%' }}>
                      {stats.mix.map(m => <span key={m.name} style={{ width: `${m.pct}%`, background: m.color }} />)}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px' }}>
                      {stats.mix.map(m => (
                        <span key={m.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: C.sans, fontSize: 9.5, color: 'var(--theme-text-muted, #9fb0c7)' }}>
                          <span style={{ width: 7, height: 7, background: m.color, flex: 'none' }} />{m.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* table: header + rows scroll together (h + v); header stays sticky */}
                <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                  <div style={{ minWidth: tableMinWidth }}>
                    {/* table header */}
                    <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, alignItems: 'center', padding: '11px 24px', background: 'var(--theme-surface, #0d1826)', position: 'sticky', top: 0, zIndex: 2, borderBottom: `1px solid ${C.border}` }}>
                      <div onClick={() => handleSort('ticker')} style={{ ...EB, fontSize: 9, letterSpacing: '0.11em', cursor: 'pointer', color: localSort.key === 'ticker' ? C.gold : C.muted }}>
                        Company{localSort.key === 'ticker' ? (localSort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </div>
                      {renderCols.map(col => (
                        <div key={col.key as string} onClick={() => handleSort(col.key as string)}
                          style={{ ...EB, fontSize: 9, letterSpacing: '0.11em', cursor: 'pointer', textAlign: col.align, color: localSort.key === col.key ? C.gold : C.muted, whiteSpace: 'nowrap' }}>
                          {col.key === 'priceChange' && data.changePeriod ? `${data.changePeriod} Chg` : col.label}{localSort.key === col.key ? (localSort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                        </div>
                      ))}
                    </div>

                    {/* rows */}
                    {displayRows.map((r, i) => (
                    <div key={`${r.ticker}-${i}`} className="ft-screen-row"
                      style={{ position: 'relative', display: 'grid', gridTemplateColumns: gridTemplate, alignItems: 'center', padding: `${rowPad}px 24px`, background: zebra && i % 2 === 1 ? 'var(--theme-hover, rgba(255,255,255,0.03))' : 'transparent', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.045))' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
                        <span style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 12.5, color: C.gold }}>{r.ticker}</span>
                        <span style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.companyName}</span>
                        {/* Rows in one table can come from different vintages: a
                            name with live vendor fundamentals sits beside one
                            running on the bundled file. Unmarked, two share
                            classes of the same company differed by six P/E
                            points with nothing on screen to explain it. */}
                        {r.fundamentalsSource === 'bundled' && (
                          <Tooltip label={`Fundamentals from the bundled snapshot${data.bundledAsOf ? ` built ${new Date(data.bundledAsOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}. Price is current, the ratios are not.`}>
                            <span style={{ fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: C.warn, border: `1px solid ${C.warn}`, padding: '1px 4px', flex: 'none', cursor: 'default' }}>SEED</span>
                          </Tooltip>
                        )}
                      </div>
                      {/* Actions float over the row's LEFT edge (the ticker) on hover, so
                          they stay on-screen even when the table scrolls horizontally and
                          never steal width from the company name. Opaque backdrop, fading right. */}
                      <span className="ft-row-actions" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 11, padding: '0 36px 0 24px', background: 'linear-gradient(90deg, var(--theme-surface, #0d1826), var(--theme-surface, #0d1826) calc(100% - 28px), transparent)' }}>
                        {ROW_LINKS.map(l => (
                          <Tooltip key={l.label} label={l.overview ? `${r.ticker} overview` : `Open ${r.ticker} in ${l.label}`}>
                            <span
                              onClick={() => {
                                setLinkedTicker(r.ticker)
                                if (l.overview) window.dispatchEvent(new CustomEvent('ft:ticker-drawer', { detail: r.ticker }))
                                else navigate(`${l.base}?ticker=${encodeURIComponent(r.ticker)}`)
                              }}
                              onMouseEnter={e => (e.currentTarget.style.color = C.gold)}
                              onMouseLeave={e => (e.currentTarget.style.color = C.dim)}
                              style={{ fontFamily: C.sans, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: C.dim, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                              {l.label}
                            </span>
                          </Tooltip>
                        ))}
                      </span>
                      {renderCols.map(col => {
                        const raw = r[col.key]
                        if (col.key === 'sector') {
                          return (
                            <div key="sector" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: C.sans, fontSize: 11, color: 'var(--theme-text-muted, #9fb0c7)', minWidth: 0 }}>
                              {dots && <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: sectorColor(r.sector) }} />}
                              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.fmt(raw)}</span>
                            </div>
                          )
                        }
                        const color = col.colorFn && raw != null ? col.colorFn(Number(raw)) : col.key === 'marketCap' ? C.emph : ['peRatio', 'pegRatio', 'pbRatio', 'psRatio', 'evEbitda'].includes(col.key as string) ? C.mutedNum : col.align === 'left' ? 'var(--theme-text-muted, #9fb0c7)' : C.text
                        const badge = medianBadge(r.sector, col.key as string, raw as number | null)
                        return (
                          <div key={col.key as string} title={badge?.tip} style={{ fontFamily: col.align === 'right' ? C.mono : C.sans, fontSize: col.align === 'right' ? 12 : 11, color, textAlign: col.align, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...(badge ? { textDecoration: 'underline dotted', textUnderlineOffset: 2, textDecorationColor: 'color-mix(in srgb, currentColor 30%, transparent)', cursor: 'help' } : {}) }}>
                            {col.fmt(raw)}{badge?.symbol && <span style={{ marginLeft: 3, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>{badge.symbol}</span>}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                    {displayRows.length === 0 && (
                      <div style={{ padding: 40, color: C.muted, fontFamily: C.sans, fontSize: 12 }}>No matches. Loosen the filters or pick a different screen.</div>
                    )}
                  </div>
                </div>

                {/* footer */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', flex: 'none' }}>
                  <span style={{ fontFamily: C.sans, fontSize: 10, color: C.dim }}>Showing {displayRows.length} of {data.total} matches</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <span onClick={() => exportCsv(displayRows, renderCols)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: C.sans, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--theme-text-muted, #9fb0c7)', cursor: 'pointer' }}>Export CSV <ArrowRight size={11} /></span>
                    <span onClick={sendToAlgoBuilder} title={`Send ${displayRows.length} ticker${displayRows.length === 1 ? '' : 's'} to the Algo Strategy Builder as a portfolio universe`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: C.sans, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--theme-text-muted, #9fb0c7)', cursor: displayRows.length ? 'pointer' : 'default', opacity: displayRows.length ? 1 : 0.4 }}>
                      Send to Algo Builder <ArrowRight size={11} />
                    </span>
                    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                      <span onClick={() => { setPmResult(null); setPmPickerOpen(v => !v) }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: C.sans, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: pmPickerOpen ? C.gold : 'var(--theme-text-muted, #9fb0c7)', cursor: displayRows.length ? 'pointer' : 'default', opacity: displayRows.length ? 1 : 0.4 }}>
                        Add to Portfolio <ChevronDown size={11} />
                      </span>
                      {pmPickerOpen && (
                        <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 8, width: 220, background: C.surface, border: `1px solid ${C.border}`, padding: 10, zIndex: 30, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontFamily: C.mono, fontSize: 9, color: C.muted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                            Add {displayRows.length} ticker{displayRows.length === 1 ? '' : 's'} to
                          </div>
                          <select value={pmTarget} onChange={e => setPmTarget(e.target.value)} style={SELECT}>
                            <option value="new">New portfolio…</option>
                            {pmBooks.map((b: PMPortfolio) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                          {pmTarget === 'new' && (
                            <input value={pmNewName} onChange={e => setPmNewName(e.target.value)} placeholder="Portfolio name"
                              style={INPUT} />
                          )}
                          <span style={{ fontFamily: C.sans, fontSize: 9, color: C.dim, lineHeight: 1.4 }}>
                            Adds each ticker at 1 share, cost basis = current screener price. Tickers already held are left untouched.
                          </span>
                          <button onClick={confirmAddToPortfolio} style={{ background: C.gold, border: 'none', color: C.bg, fontFamily: C.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 0', cursor: 'pointer' }}>
                            Add
                          </button>
                          {pmResult && (pmResult.notFound ? (
                            <span style={{ fontFamily: C.sans, fontSize: 9, color: C.neg }}>
                              Target portfolio no longer exists. It may have been deleted elsewhere. Refresh and pick another.
                            </span>
                          ) : (
                            <span style={{ fontFamily: C.sans, fontSize: 9, color: C.pos }}>
                              Added {pmResult.added} to "{pmResult.name}"{pmResult.skipped ? ` · ${pmResult.skipped} already held` : ''}.
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}

// Export the currently visible rows + columns to CSV.
function exportCsv(rows: ScreenResult[], cols: { key: keyof ScreenResult; label: string; fmt: (v: unknown) => string }[]) {
  // Quote + escape, and disarm spreadsheet formula injection on leading = + - @.
  const cell = (s: string) => `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
  const header = ['Ticker', 'Company', ...cols.map(c => c.label)]
  const lines = rows.map(r => [cell(r.ticker), cell(r.companyName ?? ''), ...cols.map(c => {
    const v = r[c.key]
    return v == null ? '' : typeof v === 'number' ? String(v) : cell(String(v))
  })].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `screener-${todayLocal()}.csv`; a.click()
  URL.revokeObjectURL(url)
}
