import { useState, useEffect, useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { RailSection } from './valuationShared'
import EmptyState from '../components/EmptyState'

const C = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', header: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)', dim: 'var(--theme-text-dim, rgba(215,227,252,0.45))',
  pos: '#22C55E', neg: '#EF4444', warn: '#f59e0b',
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
  fontFamily: C.mono, fontSize: 11, padding: '4px 7px', outline: 'none',
  width: '100%', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}
const SELECT: React.CSSProperties = { ...INPUT, cursor: 'pointer' }

interface FieldMeta { id: string; label: string; group: string }
interface FilterRow { id: number; field: string; operator: string; value: string; value2: string }
interface ScreenResult {
  ticker: string; companyName: string; price: number | null; marketCap: number | null
  beta: number | null; volume: number | null; sector: string; exchange: string
  change1d: number | null; peRatio: number | null; forwardPE: number | null
  pbRatio: number | null; psRatio: number | null; evEbitda: number | null
  grossMargin: number | null; operatingMargin: number | null; netMargin: number | null
  roe: number | null; debtEquity: number | null; currentRatio: number | null
  revenueGrowth: number | null; epsGrowth: number | null; dividendYield: number | null
  change52wHiPct: number | null; avgVolume: number | null
}

// ── Columns shown in the results table ───────────────────────────────────────
const TABLE_COLS: { key: keyof ScreenResult; label: string; fmt: (v: unknown) => string; colorFn?: (v: number) => string }[] = [
  { key: 'ticker',          label: 'Ticker',       fmt: v => String(v) },
  { key: 'companyName',     label: 'Name',         fmt: v => String(v ?? '—') },
  { key: 'price',           label: 'Price',        fmt: v => v != null ? `$${Number(v).toFixed(2)}` : '—' },
  { key: 'change1d',        label: '1D %',         fmt: v => v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '—', colorFn: v => v >= 0 ? C.pos : C.neg },
  { key: 'marketCap',       label: 'Mkt Cap',      fmt: v => v != null ? `$${Number(v).toFixed(1)}B` : '—' },
  { key: 'volume',          label: 'Volume',       fmt: v => v != null ? Intl.NumberFormat('en',{notation:'compact'}).format(Number(v)) : '—' },
  { key: 'beta',            label: 'Beta',         fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v > 1.5 ? C.warn : v < 0 ? C.neg : C.text },
  { key: 'peRatio',         label: 'P/E',          fmt: v => v != null ? Number(v).toFixed(1) : '—' },
  { key: 'forwardPE',       label: 'Fwd P/E',      fmt: v => v != null ? Number(v).toFixed(1) : '—' },
  { key: 'pbRatio',         label: 'P/B',          fmt: v => v != null ? Number(v).toFixed(2) : '—' },
  { key: 'psRatio',         label: 'P/S',          fmt: v => v != null ? Number(v).toFixed(2) : '—' },
  { key: 'evEbitda',        label: 'EV/EBITDA',    fmt: v => v != null ? Number(v).toFixed(1) : '—' },
  { key: 'grossMargin',     label: 'Gross %',      fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 60 ? C.pos : v > 30 ? C.text : C.neg },
  { key: 'operatingMargin', label: 'Op %',         fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 20 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'netMargin',       label: 'Net %',        fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 15 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'roe',             label: 'ROE %',        fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 15 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'debtEquity',      label: 'D/E',          fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v < 0.5 ? C.pos : v < 1.5 ? C.warn : C.neg },
  { key: 'currentRatio',    label: 'Curr Ratio',   fmt: v => v != null ? Number(v).toFixed(2) : '—', colorFn: v => v > 1.5 ? C.pos : v > 1 ? C.warn : C.neg },
  { key: 'revenueGrowth',   label: 'Rev Growth',   fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 15 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'epsGrowth',       label: 'EPS Growth',   fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > 10 ? C.pos : v > 0 ? C.text : C.neg },
  { key: 'dividendYield',   label: 'Div Yield',    fmt: v => v != null ? `${Number(v).toFixed(2)}%` : '—' },
  { key: 'change52wHiPct',  label: '52W Hi%',      fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '—', colorFn: v => v > -5 ? C.pos : v > -20 ? C.warn : C.neg },
  { key: 'sector',          label: 'Sector',       fmt: v => String(v ?? '—') },
]

// ── Grouped field options for the filter selector ────────────────────────────
function FieldSelect({ value, fields, onChange }: { value: string; fields: FieldMeta[]; onChange: (v: string) => void }) {
  const groups = [...new Set(fields.map(f => f.group))]
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...SELECT, flex: 2, minWidth: 0 }}>
      {groups.map(g => (
        <optgroup key={g} label={g}>
          {fields.filter(f => f.group === g).map(f => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export default function StockScreener() {
  const [filters, setFilters] = useState<FilterRow[]>([
    { id: 1, field: 'marketCap', operator: 'gt', value: '1', value2: '' },
  ])
  const [paramsOpen, setParamsOpen] = useState(true)
  const [sector,   setSector]   = useState('')
  const [exchange, setExchange] = useState('')
  const [sortBy,   setSortBy]   = useState('marketCap')
  const [sortDir,  setSortDir]  = useState<'desc' | 'asc'>('desc')
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(['ticker','companyName','price','change1d','marketCap','peRatio','operatingMargin','revenueGrowth','sector'])
  )
  const [colPanelOpen, setColPanelOpen] = useState(false)
  const [localSort, setLocalSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'marketCap', dir: 'desc' })
  const [textFilter, setTextFilter] = useState('')
  const nextId = () => Date.now()

  const { data: meta } = useQuery({
    queryKey: ['screener-fields'],
    queryFn: () => axios.get('/api/screener/fields').then(r => r.data),
    staleTime: Infinity,
  })

  const fields: FieldMeta[] = meta?.fields ?? []
  const sectors: string[]   = meta?.sectors ?? []
  const exchanges: string[] = meta?.exchanges ?? []

  const { mutate, data, isPending, error } = useMutation({
    mutationFn: () => axios.post('/api/screener/run', {
      filters: filters.filter(f => f.value !== '').map(f => ({
        field: f.field, operator: f.operator,
        value: parseFloat(f.value),
        value2: f.value2 ? parseFloat(f.value2) : null,
      })),
      sector:   sector || null,
      exchange: exchange || null,
      sort_by:  sortBy,
      sort_dir: sortDir,
      limit:    100,
    }).then(r => r.data),
  })

  const addFilter = () => setFilters(p => [...p, { id: nextId(), field: fields[0]?.id ?? 'marketCap', operator: 'gt', value: '', value2: '' }])
  const removeFilter = (id: number) => setFilters(p => p.filter(f => f.id !== id))
  const patchFilter = (id: number, patch: Partial<FilterRow>) => setFilters(p => p.map(f => f.id === id ? { ...f, ...patch } : f))

  useEffect(() => {
    if (data) {
      setLocalSort({ key: sortBy, dir: sortDir })
      setTextFilter('')
    }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSort = (col: string) => {
    setLocalSort(prev => ({ key: col, dir: prev.key === col && prev.dir === 'desc' ? 'asc' : 'desc' }))
  }

  const STRING_KEYS = useMemo(() => new Set(['ticker', 'companyName', 'sector', 'exchange']), [])

  const displayRows = useMemo(() => {
    if (!data?.results) return []
    let rows = [...data.results] as ScreenResult[]
    if (textFilter.trim()) {
      const q = textFilter.trim().toLowerCase()
      rows = rows.filter(r =>
        r.ticker.toLowerCase().includes(q) ||
        (r.companyName ?? '').toLowerCase().includes(q) ||
        (r.sector ?? '').toLowerCase().includes(q)
      )
    }
    rows.sort((a, b) => {
      const av = a[localSort.key as keyof ScreenResult]
      const bv = b[localSort.key as keyof ScreenResult]
      let cmp: number
      if (STRING_KEYS.has(localSort.key)) {
        cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      } else {
        if (av == null && bv == null) cmp = 0
        else if (av == null) cmp = 1
        else if (bv == null) cmp = -1
        else cmp = (Number(av) - Number(bv))
      }
      return localSort.dir === 'desc' ? -cmp : cmp
    })
    return rows
  }, [data, localSort, textFilter, STRING_KEYS])

  const activeCols = TABLE_COLS.filter(c => visibleCols.has(c.key as string))

  const focus = (e: React.FocusEvent<HTMLElement>) => ((e.target as HTMLElement).style.borderColor = C.gold)
  const blur  = (e: React.FocusEvent<HTMLElement>) => ((e.target as HTMLElement).style.borderColor = C.border)

  return (
    <PageWrapper title="Stock Screener">
      <SidebarLayout sidebarWidth={260} sidebarTitle="" sidebar={<>
          <RailSection title="Screen Controls" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Sector + Exchange */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>
              <label style={LABEL}>Sector</label>
              <select value={sector} onChange={e => setSector(e.target.value)} style={SELECT} onFocus={focus} onBlur={blur}>
                <option value="">All Sectors</option>
                {sectors.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={LABEL}>Exchange</label>
              <select value={exchange} onChange={e => setExchange(e.target.value)} style={SELECT} onFocus={focus} onBlur={blur}>
                <option value="">All Exchanges</option>
                {exchanges.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Filter rows */}
          <div>
            <label style={LABEL}>Filters</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {filters.map(f => (
                <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, background: 'var(--theme-bg, #0a1220)', border: `1px solid ${C.border}`, padding: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <FieldSelect value={f.field} fields={fields} onChange={v => patchFilter(f.id, { field: v })} />
                    <select value={f.operator} onChange={e => patchFilter(f.id, { operator: e.target.value })} style={{ ...SELECT, width: 44, flexShrink: 0, padding: '4px 3px' }}>
                      {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <button onClick={() => removeFilter(f.id)} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0 }}
                      onMouseEnter={e => ((e.target as HTMLElement).style.color = C.neg)}
                      onMouseLeave={e => ((e.target as HTMLElement).style.color = C.dim)}>×</button>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="number" value={f.value} placeholder="Value" style={{ ...INPUT, flex: 1 }}
                      onChange={e => patchFilter(f.id, { value: e.target.value })}
                      onFocus={focus} onBlur={blur} />
                    {f.operator === 'between' && (
                      <input type="number" value={f.value2} placeholder="To" style={{ ...INPUT, flex: 1 }}
                        onChange={e => patchFilter(f.id, { value2: e.target.value })}
                        onFocus={focus} onBlur={blur} />
                    )}
                  </div>
                </div>
              ))}
              <button onClick={addFilter} style={{ fontSize: 10, color: C.dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.1em', textAlign: 'left' }}
                onMouseEnter={e => ((e.target as HTMLElement).style.color = C.gold)}
                onMouseLeave={e => ((e.target as HTMLElement).style.color = C.dim)}>
                + Add filter
              </button>
            </div>
          </div>

          {/* Sort */}
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ flex: 1 }}>
              <label style={LABEL}>Sort by</label>
              <select value={sortBy} onChange={e => { setSortBy(e.target.value); setLocalSort(prev => ({ ...prev, key: e.target.value })) }} style={SELECT} onFocus={focus} onBlur={blur}>
                {TABLE_COLS.filter(c => !['ticker','companyName','sector'].includes(c.key as string)).map(c => (
                  <option key={c.key as string} value={c.key as string}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LABEL}>Dir</label>
              <select value={sortDir} onChange={e => { setSortDir(e.target.value as 'asc' | 'desc'); setLocalSort(prev => ({ ...prev, dir: e.target.value as 'asc' | 'desc' })) }} style={{ ...SELECT, width: 60 }}>
                <option value="desc">↓ High</option>
                <option value="asc">↑ Low</option>
              </select>
            </div>
          </div>

          {/* Run button — inline after controls */}
          <button onClick={() => mutate()} disabled={isPending} style={{
            width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: `1px solid ${C.gold}`, color: C.gold,
            fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
            textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
            opacity: isPending ? 0.6 : 1,
          }}>
            {isPending ? 'Screening…' : 'Run Screen'}
          </button>
        </div>
        </RailSection>
      </>}>

        {/* Results */}
        {!data && !isPending && !error && (
          <EmptyState title="Stock Screener" hint="Set filters in the sidebar and press Run Screen. Supports market cap, valuation, growth, profitability, and more." />
        )}

        {error && (
          <div style={{ padding: 24, color: C.neg, fontFamily: C.sans, fontSize: 12 }}>
            {(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Screen failed. Check FMP_API_KEY is configured.'}
          </div>
        )}

        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderBottom: `1px solid ${C.border}`, background: C.header, flexShrink: 0, gap: 10 }}>
              <span style={{ fontFamily: C.mono, fontSize: 11, color: C.gold, fontWeight: 700, whiteSpace: 'nowrap' }}>
                {displayRows.length !== data.total
                  ? `${displayRows.length} / ${data.total}`
                  : `${data.total} result${data.total !== 1 ? 's' : ''}`}
              </span>
              <input
                value={textFilter}
                onChange={e => setTextFilter(e.target.value)}
                placeholder="Filter by ticker / name / sector…"
                style={{ ...INPUT, flex: 1, maxWidth: 260, padding: '3px 7px', fontSize: 10 }}
                onFocus={focus} onBlur={blur}
              />

              {/* Column selector */}
              <div style={{ position: 'relative' }}>
                <button onClick={() => setColPanelOpen(o => !o)} style={{ background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: `1px solid ${C.border}`, color: C.muted, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 10px', cursor: 'pointer' }}>
                  Columns ▾
                </button>
                {colPanelOpen && (
                  <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, background: C.header, border: `1px solid ${C.border}`, padding: 10, minWidth: 200, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', maxHeight: 320, overflowY: 'auto' }}>
                    {TABLE_COLS.map(col => {
                      const on = visibleCols.has(col.key as string)
                      return (
                        <label key={col.key as string} onClick={() => setVisibleCols(prev => { const n = new Set(prev); on ? n.delete(col.key as string) : n.add(col.key as string); return n })}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                          <div style={{ width: 10, height: 10, flexShrink: 0, border: `1px solid ${on ? C.gold : C.dim}`, background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {on && <div style={{ width: 4, height: 4, background: C.gold }} />}
                          </div>
                          <span style={{ fontFamily: C.sans, fontSize: 9, color: on ? C.text : C.dim, whiteSpace: 'nowrap' }}>{col.label}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Table */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: C.mono }}>
                <thead>
                  <tr style={{ background: 'var(--theme-bg, #080f1d)', position: 'sticky', top: 0, zIndex: 1 }}>
                    {activeCols.map(col => (
                      <th key={col.key as string} onClick={() => handleSort(col.key as string)}
                        style={{ padding: '7px 10px', textAlign: col.key === 'ticker' || col.key === 'companyName' || col.key === 'sector' ? 'left' : 'right', fontFamily: C.sans, fontSize: 9, color: localSort.key === col.key ? C.gold : C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}`, userSelect: 'none' }}>
                        {col.label}{localSort.key === col.key ? (localSort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row: ScreenResult, i: number) => (
                    <tr key={row.ticker} style={{ background: i % 2 === 0 ? 'var(--theme-surface, #0d1826)' : 'var(--theme-bg, #101c2e)', borderBottom: `1px solid var(--theme-border-faint, rgba(255,255,255,0.05))` }}
                      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = 'rgba(201,168,76,0.05)')}
                      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = i % 2 === 0 ? 'var(--theme-surface, #0d1826)' : 'var(--theme-bg, #101c2e)')}>
                      {activeCols.map(col => {
                        const raw = row[col.key]
                        const display = col.fmt(raw)
                        const color = col.colorFn && raw != null ? col.colorFn(Number(raw)) : col.key === 'ticker' ? C.gold : C.text
                        return (
                          <td key={col.key as string} style={{ padding: '7px 10px', color, textAlign: col.key === 'ticker' || col.key === 'companyName' || col.key === 'sector' ? 'left' : 'right', whiteSpace: 'nowrap', maxWidth: col.key === 'companyName' ? 160 : undefined, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {col.key === 'ticker' ? <strong>{display}</strong> : display}
                          </td>
                        )
                      })}
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
