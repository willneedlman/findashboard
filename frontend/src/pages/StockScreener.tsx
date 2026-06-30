import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadingState from '../components/LoadingState'
import ErrorState from '../components/ErrorState'
import Tooltip from '../components/Tooltip'

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
interface Preset { id: string; name: string; desc: string; universe?: string; sortBy: string; sortDir: 'asc' | 'desc'; sortParam?: string; filters: { field: string; operator: string; value: string; param?: string }[] }
const PRESETS: Preset[] = [
  { id: 'liquid-large-caps', name: 'Liquid Large Caps', desc: 'Big, liquid names — loads instantly', sortBy: 'marketCap', sortDir: 'desc',
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
const ROW_LINKS: { label: string; base: string }[] = [
  { label: 'Profile', base: '/supply-chain' },
  { label: 'Peers',   base: '/relative-valuation' },
  { label: 'DCF',     base: '/dcf' },
  { label: 'Alert',   base: '/alerts' },
]

export default function StockScreener() {
  const navigate = useNavigate()
  const [filters, setFilters]   = useState<FilterRow[]>(() => toRows(DEFAULT_PRESET))
  const [sector,   setSector]   = useState('')
  const [exchange, setExchange] = useState('')
  const [region,   setRegion]   = useState('')
  const [universe, setUniverse] = useState(DEFAULT_PRESET.universe ?? '')
  const [sortBy,   setSortBy]   = useState(DEFAULT_PRESET.sortBy)
  const [sortDir,  setSortDir]  = useState<'desc' | 'asc'>(DEFAULT_PRESET.sortDir)
  const [sortParam, setSortParam] = useState(DEFAULT_PRESET.sortParam ?? '1M')
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(['sector', 'price', 'priceChange', 'marketCap', 'peRatio', 'pegRatio', 'operatingMargin', 'revenueGrowth'])
  )
  const [colPanelOpen, setColPanelOpen] = useState(false)
  const [localSort, setLocalSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: DEFAULT_PRESET.sortBy, dir: DEFAULT_PRESET.sortDir })
  const [textFilter, setTextFilter] = useState('')
  const [activeScreenId, setActiveScreenId] = useState<string>(DEFAULT_PRESET.id)
  const [runNonce, setRunNonce] = useState(0)   // bumped to (re-)run a screen, even the active one
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
  const fields: FieldMeta[] = meta?.fields ?? []
  const sectors: string[]   = meta?.sectors ?? []
  const exchanges: string[] = meta?.exchanges ?? []
  const regions: string[]   = meta?.regions ?? []
  const universes: { value: string; label: string; group: string }[] = meta?.universes ?? [
    { value: '', label: 'All', group: 'Indexes' },
    { value: 'sp500', label: 'S&P 500', group: 'Indexes' },
  ]
  const universeGroups = [...new Set(universes.map(u => u.group))]

  const { mutate, data, isPending, error } = useMutation({
    mutationFn: () => axios.post('/api/screener/run', {
      filters: filters.filter(f => f.value !== '').map(f => ({
        field: f.field, operator: f.operator,
        value: parseFloat(f.value),
        value2: f.value2 ? parseFloat(f.value2) : null,
        param: f.field === 'priceChange' ? (f.param || '1M') : null,
      })),
      sector: sector || null, exchange: exchange || null, region: region || null, universe: universe || null,
      sort_by: sortBy, sort_dir: sortDir, sort_param: sortBy === 'priceChange' ? sortParam : null,
      limit: 200,
    }).then(r => r.data),
  })

  // Run on mount and whenever a screen is (re-)selected — the nonce bumps even when
  // the same preset is re-clicked, so a reset re-runs instead of showing stale rows.
  useEffect(() => { mutate() }, [runNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (data) { setLocalSort({ key: sortBy, dir: sortDir }); setTextFilter('') } }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyPreset = (p: Preset) => {
    setFilters(toRows(p))
    setUniverse(p.universe ?? '')
    setSector(''); setExchange(''); setRegion('')
    setSortBy(p.sortBy); setSortDir(p.sortDir); setSortParam(p.sortParam ?? '1M')
    setEditingFilterId(null)
    setActiveScreenId(p.id)
    setRunNonce(n => n + 1)   // run, even if this preset was already active
  }

  // "+ New Screen": start a blank custom screen with one filter ready to edit.
  const newScreen = () => {
    const id = _fid++
    setFilters([{ id, field: 'marketCap', operator: 'gt', value: '', value2: '' }])
    setUniverse(''); setSector(''); setExchange(''); setRegion('')
    setSortBy('marketCap'); setSortDir('desc')
    setActiveScreenId('custom-' + id)
    setEditingFilterId(id)
    setRunNonce(n => n + 1)
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

  const activePreset = PRESETS.find(p => p.id === activeScreenId)
  const sortColLabel = sortBy === 'priceChange' ? `${sortParam} price change` : (TABLE_COLS.find(c => c.key === sortBy)?.label ?? sortBy)
  const renderCols = TABLE_COLS.filter(c => visibleCols.has(c.key as string))
  const gridTemplate = `minmax(190px,1.5fr) ${renderCols.map(c => c.w).join(' ')}`
  // Natural width of the table; the scroll container falls back to horizontal
  // scroll below this so columns stay readable instead of being clipped when the
  // results pane is narrow (e.g. the app nav rail is expanded).
  const tableMinWidth = 48 + 190 + renderCols.reduce((s, c) => s + parseInt(c.w, 10), 0)
  const rowPad = density === 'compact' ? 7 : 11
  const universeLabel = universes.find(u => u.value === universe)?.label ?? 'All'

  const focus = (e: React.FocusEvent<HTMLElement>) => ((e.target as HTMLElement).style.borderColor = C.gold)
  const blur  = (e: React.FocusEvent<HTMLElement>) => ((e.target as HTMLElement).style.borderColor = 'var(--theme-border, rgba(255,255,255,0.13))')

  const railBtn: React.CSSProperties = { cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, background: 'none' }
  const scopeSelect: React.CSSProperties = { ...SELECT, fontSize: 10.5, padding: '5px 6px', width: 'auto', border: '1px solid var(--theme-border, rgba(255,255,255,0.13))', background: C.surface, color: C.chipVal }

  // ── Filter chip (the editor is a separate bar below the row) ──
  const chip = (f: FilterRow) => {
    const fieldLabel = (fields.find(x => x.id === f.field)?.label ?? f.field).replace(' (%)', '').replace(' ($B)', '').replace(' ($)', '')
    const opSym = OPERATORS.find(o => o.value === f.operator)?.label ?? f.operator
    const periodSuffix = f.field === 'priceChange' ? ` ${f.param || '1M'}` : ''
    const expr = `${opSym} ${f.value || '·'}${f.operator === 'between' && f.value2 ? `–${f.value2}` : ''}`
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
      <div style={{ height: 'calc(100dvh - 36px)', display: 'flex', flexDirection: 'column', background: C.bg, border: `1px solid ${C.border}` }}>

        {/* title bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 24px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)', flex: 'none' }}>
          <span style={{ fontFamily: C.sans, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.gold }}>Stock Screener</span>
          <span style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: '0.04em', color: C.dim }}>
            {universeLabel.toUpperCase()} · {data ? `${data.total} MATCHES` : 'READY'} · {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minHeight: 0 }}>

          {/* ── Screen Library rail ── */}
          <div className="ft-rail" style={{ width: railCollapsed ? 54 : 272, flex: 'none', borderRight: `1px solid ${C.border}`, background: C.surface, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {railCollapsed ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 0', gap: 14, height: '100%' }}>
                <span onClick={() => setRailCollapsed(false)} title="Expand library" style={{ ...railBtn, width: 30, height: 30, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)', color: C.gold, fontSize: 14 }}>»</span>
                <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.gold }}>{PRESETS.length}</span>
                <span style={{ fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>Saved</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 13px 18px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  <span style={{ ...EB, fontSize: 9, letterSpacing: '0.16em' }}>Screen Library</span>
                  <span onClick={() => setRailCollapsed(true)} title="Collapse library" style={{ ...railBtn, width: 24, height: 24, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', color: C.muted, fontSize: 14 }}>«</span>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {PRESETS.map(p => {
                    const on = p.id === activeScreenId
                    return (
                      <div key={p.id} className="ft-screen-row" onClick={() => applyPreset(p)}
                        style={{ position: 'relative', padding: '11px 16px 11px 18px', background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, transparent)' : 'transparent', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.045))', cursor: 'pointer' }}>
                        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: on ? C.gold : 'transparent' }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontFamily: C.sans, fontSize: 12.5, fontWeight: 600, color: on ? C.emph : 'var(--theme-text-muted, #aebdd4)' }}>{p.name}</span>
                          <span style={{ marginLeft: 'auto', fontFamily: C.mono, fontSize: 11, color: on ? C.gold : C.dim }}>{on && data ? data.total : ''}</span>
                        </div>
                        <div style={{ fontFamily: C.sans, fontSize: 9.5, color: C.dim, marginTop: 2 }}>{p.desc}</div>
                      </div>
                    )
                  })}
                  <div style={{ padding: '13px 18px' }}>
                    <span onClick={newScreen} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: C.sans, fontSize: 11, padding: '7px 12px', border: '1px dashed var(--theme-border, rgba(255,255,255,0.16))', color: 'var(--theme-text-muted, #9fb0c7)', cursor: 'pointer' }}>+ New Screen</span>
                  </div>
                </div>
                <div style={{ padding: '13px 18px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', flex: 'none' }}>
                  <span style={{ fontFamily: C.sans, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>Pick a screen to run it, then refine filters inline. Edits re-run on Apply.</span>
                </div>
              </div>
            )}
          </div>

          {/* ── Results pane ── */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>

            {/* screen header + scope + filters */}
            <div style={{ padding: '16px 24px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  {railCollapsed && <span onClick={() => setRailCollapsed(false)} title="Show library" style={{ ...railBtn, width: 28, height: 28, border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-text-muted, #9fb0c7)', fontSize: 13, flex: 'none' }}>☰</span>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: C.sans, fontSize: 16, fontWeight: 600, color: C.emph }}>{activePreset?.name ?? 'Custom Screen'}</div>
                    <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {activePreset?.desc ?? 'Ad-hoc filters'}{data ? ` · ${data.total} matches · sorted by ${sortColLabel}` : ''}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none' }}>
                  <input value={textFilter} onChange={e => setTextFilter(e.target.value)} placeholder="Filter by ticker / name / sector…"
                    style={{ background: C.surface, border: '1px solid var(--theme-border, rgba(255,255,255,0.13))', color: C.text, fontFamily: C.sans, fontSize: 11, padding: '7px 12px', minWidth: 230, outline: 'none' }} onFocus={focus} onBlur={blur} />
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
                <select value={universe} onChange={e => setUniverse(e.target.value)} style={scopeSelect} title="Universe">
                  {universeGroups.map(g => <optgroup key={g} label={g}>{universes.filter(u => u.group === g).map(u => <option key={u.value || 'all'} value={u.value}>{u.label}</option>)}</optgroup>)}
                </select>
                <select value={sector} onChange={e => setSector(e.target.value)} style={scopeSelect} title="Sector">
                  <option value="">All Sectors</option>{sectors.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select value={region} onChange={e => setRegion(e.target.value)} style={scopeSelect} title="Region">
                  <option value="">All Regions</option>{regions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={exchange} onChange={e => setExchange(e.target.value)} style={scopeSelect} title="Exchange">
                  <option value="">All Exchanges</option>{exchanges.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => mutate()} disabled={isPending}
                  style={{ marginLeft: 'auto', fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.gold, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)', border: `1px solid ${C.gold}`, padding: '7px 16px', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1 }}>
                  {isPending ? 'Screening…' : 'Run'}
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
                  <input type="number" value={editingFilter.value} placeholder="Value" autoFocus style={{ ...INPUT, width: 90, flex: 'none' }}
                    onChange={e => patchFilter(editingFilter.id, { value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { setEditingFilterId(null); mutate() } }} />
                  {editingFilter.operator === 'between' && (
                    <input type="number" value={editingFilter.value2} placeholder="To" style={{ ...INPUT, width: 90, flex: 'none' }} onChange={e => patchFilter(editingFilter.id, { value2: e.target.value })} />
                  )}
                  <button onClick={() => { setEditingFilterId(null); mutate() }}
                    style={{ flex: 'none', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)', border: `1px solid ${C.gold}`, color: C.gold, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
                    Apply
                  </button>
                </div>
              )}
            </div>

            {/* states / results */}
            {error ? (
              <div style={{ padding: 24 }}>
                <ErrorState
                  title="Screen failed"
                  message={(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Screen failed. Check FMP_API_KEY is configured.'}
                  onRetry={() => mutate()}
                />
              </div>
            ) : !data && isPending ? (
              <div style={{ padding: 24 }}><LoadingState label="Screening" /></div>
            ) : !data ? (
              <div style={{ padding: 24 }}><EmptyState title="Stock Screener" hint="Pick a screen from the library or set filters, then Run." /></div>
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
                      </div>
                      {/* Actions float over the row's right edge on hover so they never
                          steal width from the company name. Opaque backdrop keeps them legible. */}
                      <span className="ft-row-actions" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 11, padding: '0 24px 0 36px', background: 'linear-gradient(90deg, transparent, var(--theme-surface, #0d1826) 28px)' }}>
                        {ROW_LINKS.map(l => (
                          <Tooltip key={l.label} label={`Open ${r.ticker} in ${l.label}`}>
                            <span
                              onClick={() => navigate(`${l.base}?ticker=${encodeURIComponent(r.ticker)}`)}
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
                        return (
                          <div key={col.key as string} style={{ fontFamily: col.align === 'right' ? C.mono : C.sans, fontSize: col.align === 'right' ? 12 : 11, color, textAlign: col.align, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {col.fmt(raw)}
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
                  <span onClick={() => exportCsv(displayRows, renderCols)} style={{ fontFamily: C.sans, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--theme-text-muted, #9fb0c7)', cursor: 'pointer' }}>Export CSV →</span>
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
  a.href = url; a.download = `screener-${new Date().toISOString().split('T')[0]}.csv`; a.click()
  URL.revokeObjectURL(url)
}
