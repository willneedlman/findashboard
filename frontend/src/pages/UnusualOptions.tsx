import { T } from '../lib/theme'
import { useState, useMemo } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import { VerdictStrip } from './valuationShared'
import { normalizeTicker } from '../lib/pmImport'
import { screenerFilterToApi } from '../lib/format'
import UniversePicker from '../components/UniversePicker'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'


interface Row {
  ticker:       string
  type:         'call' | 'put'
  strike:       number
  expiry:       string
  dte:          number
  spot:         number | null
  moneyness:    number | null
  volume:       number
  openInterest: number
  volOiRatio:   number
  iv:           number
  mid:          number
  premium:      number
}

interface UnusualResponse {
  asOf:    string
  scanned: string[]
  count:   number
  rows:    Row[]
  params:  { expiries: number; minVolume: number; minVolOi: number }
}

interface ScanParams {
  tickers:   string
  expiries:  number
  minVolume: number
  minVolOi:  number
}

// Backend /api/options/unusual caps the universe at 25 names.
const TICKER_CAP = 25

const DEFAULT_PARAMS: ScanParams = { tickers: 'SPY', expiries: 2, minVolume: 300, minVolOi: 1.5 }

type SavedScreen = {
  id: string
  name: string
  filters: { field: string; operator: string; value: string | number; value2?: string | number | null; param?: string | null }[]
  sortBy: string
  sortDir: string
}

function readSavedScreens(): SavedScreen[] {
  try {
    const raw = localStorage.getItem('fdb_screener_saved_screens_v1')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s: any) => s?.id && s?.name)
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        filters: Array.isArray(s.filters) ? s.filters : [],
        sortBy: s.sortBy || 'marketCap',
        sortDir: s.sortDir || 'desc',
      }))
  } catch {
    return []
  }
}

function dedupeTickers(raw: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    const sym = normalizeTicker(t)
    if (!sym || sym === 'CASH' || sym === 'USD' || seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
    if (out.length >= TICKER_CAP) break
  }
  return out
}

const importSelectStyle: React.CSSProperties = {
  background:   T.bg,
  border:       `1px solid ${T.border}`,
  color:        T.gold,
  fontFamily:   T.mono,
  fontSize:     9,
  fontWeight:   700,
  letterSpacing: '0.04em',
  padding:      '3px 6px',
  outline:      'none',
  cursor:       'pointer',
  maxWidth:     140,
}

type SortKey = 'dte' | 'moneyness' | 'volume' | 'volOiRatio' | 'premium'

const COLUMNS: { label: string; align: 'left' | 'right'; sortKey?: SortKey }[] = [
  { label: 'Ticker',  align: 'left'  },
  { label: 'Type',    align: 'left'  },
  { label: 'Strike',  align: 'right' },
  { label: 'Expiry',  align: 'right' },
  { label: 'DTE',     align: 'right', sortKey: 'dte' },
  { label: 'Spot',    align: 'right' },
  { label: 'OTM%',    align: 'right', sortKey: 'moneyness' },
  { label: 'Volume',  align: 'right', sortKey: 'volume' },
  { label: 'OI',      align: 'right' },
  { label: 'Vol/OI',  align: 'right', sortKey: 'volOiRatio' },
  { label: 'IV%',     align: 'right' },
  { label: 'Mid',     align: 'right' },
  { label: 'Premium', align: 'right', sortKey: 'premium' },
]

function fmtPremium(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

const inputStyle: React.CSSProperties = {
  background:   T.bg,
  border:       '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color:        T.text,
  fontFamily:   T.mono,
  fontSize:     12,
  padding:      '6px 9px',
  outline:      'none',
}

const labelStyle: React.CSSProperties = {
  fontFamily:    T.label,
  fontSize:      9,
  fontWeight:    700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color:         T.muted,
  marginBottom:  5,
  display:       'block',
}

export function UnusualOptionsContent() {
  const [draft, setDraft]   = useState<ScanParams>(DEFAULT_PARAMS)
  const [active, setActive] = useState<ScanParams>(DEFAULT_PARAMS)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [screenerLoading, setScreenerLoading] = useState(false)
  const [screenerError, setScreenerError] = useState<string | null>(null)

  const savedScreens = useMemo(() => readSavedScreens(), [])

  const applyTickers = (list: string[], source: string) => {
    const cleaned = dedupeTickers(list)
    if (cleaned.length === 0) {
      setImportNote(`No equity tickers found in ${source}.`)
      return
    }
    setDraft(d => ({ ...d, tickers: cleaned.join(', ') }))
    setImportNote(
      cleaned.length >= TICKER_CAP
        ? `Loaded ${cleaned.length} from ${source} (capped at ${TICKER_CAP}).`
        : `Loaded ${cleaned.length} from ${source}.`,
    )
    setScreenerError(null)
  }

  const handleScreenSelect = async (screenId: string) => {
    if (!screenId) return
    const screen = savedScreens.find(s => s.id === screenId)
    if (!screen) return

    setScreenerLoading(true)
    setScreenerError(null)
    setImportNote(null)
    try {
      const { data: body } = await axios.post('/api/screener/run', {
        filters: screen.filters.map(f => ({
          ...f,
          value: screenerFilterToApi(f.field, String(f.value)) ?? Number(f.value),
          value2: f.value2 != null && f.value2 !== ''
            ? (screenerFilterToApi(f.field, String(f.value2)) ?? Number(f.value2))
            : null,
        })),
        sector: null,
        exchange: null,
        sort_by: screen.sortBy,
        sort_dir: screen.sortDir,
        limit: TICKER_CAP,
      })
      const results = body?.results ?? []
      const list = results.map((r: any) => String(r.ticker ?? '')).filter(Boolean)
      if (list.length === 0) {
        setScreenerError('No symbols matched in screen.')
        return
      }
      applyTickers(list, screen.name)
    } catch (err: any) {
      setScreenerError(err?.response?.data?.detail || err?.message || 'Failed to run screen.')
    } finally {
      setScreenerLoading(false)
    }
  }

  const { data, isFetching, isError, refetch } = useQuery<UnusualResponse>({
    queryKey: ['unusual-options', active],
    queryFn: () => {
      const p = new URLSearchParams()
      if (active.tickers.trim()) p.set('tickers', active.tickers.trim().toUpperCase())
      p.set('expiries',   String(active.expiries))
      p.set('min_volume', String(active.minVolume))
      p.set('min_vol_oi', String(active.minVolOi))
      return axios.get(`/api/options/unusual?${p.toString()}`).then(r => r.data)
    },
    staleTime: 300_000,
    retry: 1,
  })

  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'premium', dir: 'desc' })

  const runScan = () => {
    // Re-fetch even if params are unchanged.
    if (JSON.stringify(draft) === JSON.stringify(active)) refetch()
    else setActive(draft)
  }

  const toggleSort = (key: SortKey) => setSort(prev =>
    prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }
  )

  const rows = data?.rows ?? []

  const sortedRows = useMemo(() => {
    const { key, dir } = sort
    const mult = dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      // Null moneyness (no spot) always sinks to the bottom regardless of direction.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return (av - bv) * mult
    })
  }, [rows, sort])

  const TAB = 'Options Flow'
  useReportCapture(() => {
    if (!data || !rows.length) return null
    const total = rows.reduce((s, r) => s + r.premium, 0)
    const callPrem = rows.filter(r => r.type === 'call').reduce((s, r) => s + r.premium, 0)
    const callPct = total > 0 ? Math.round(callPrem / total * 100) : 0
    const fmt = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`
    const topVO = [...rows].sort((a, b) => b.volOiRatio - a.volOiRatio)[0]
    const mostA = [...rows].sort((a, b) => b.volume - a.volume)[0]
    const pieces: ClipDraft[] = [
      kpiClip(TAB, 'Flow Pulse', [
        { label: 'Total Premium', value: fmt(total), sub: `${data.count} contracts` },
        { label: 'Calls', value: `${callPct}%`, sub: fmt(callPrem) },
        { label: 'Puts', value: `${100 - callPct}%`, sub: fmt(total - callPrem) },
        { label: 'Top Vol/OI', value: `${topVO.ticker} ${topVO.volOiRatio.toFixed(1)}` },
        { label: 'Most Active', value: `${mostA.ticker} ${mostA.volume.toLocaleString()}` },
      ]),
      tableClip(TAB, 'Unusual Options Flow',
        ['Ticker', 'Type', 'Strike', 'Expiry', 'DTE', 'Spot', 'OTM%', 'Volume', 'OI', 'Vol/OI', 'IV%', 'Mid', 'Premium'],
        sortedRows.map(r => [
          r.ticker,
          r.type.toUpperCase(),
          r.strike.toFixed(2),
          r.expiry,
          r.dte,
          r.spot != null ? r.spot.toFixed(2) : null,
          r.moneyness != null ? `${r.moneyness >= 0 ? '+' : ''}${r.moneyness.toFixed(1)}%` : null,
          r.volume,
          r.openInterest,
          r.volOiRatio.toFixed(1),
          r.iv.toFixed(1),
          r.mid.toFixed(2),
          fmtPremium(r.premium),
        ]),
      ),
    ]
    return pieces
  }, { disabled: !data || !rows.length, sourceTab: TAB })

  return (
    <div style={{ width: '100%' }}>
      <PageHeader
        title="Options Flow"
      />

      {/* Controls */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 14,
        background: T.surface, border: `1px solid ${T.border}`, padding: '16px 18px', marginBottom: 18,
      }}>
        <div style={{ flex: '1 1 280px', minWidth: 200 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>Tickers (blank = liquid default set)</label>
            <UniversePicker
              mode="tickers"
              tickerCap={TICKER_CAP}
              onImportTickers={(list, name) => applyTickers(list, name)}
              screenHandoff={{ screens: savedScreens, loading: screenerLoading, onSelect: id => { void handleScreenSelect(id) } }}
              style={importSelectStyle}
              showNote={false}
            />
          </div>
          <input
            value={draft.tickers}
            onChange={e => { setDraft({ ...draft, tickers: e.target.value }); setImportNote(null) }}
            onKeyDown={e => { if (e.key === 'Enter') runScan() }}
            placeholder="AAPL, NVDA, TSLA …"
            style={{ ...inputStyle, width: '100%' }}
          />
          {(importNote || screenerError || screenerLoading) && (
            <div style={{ fontFamily: T.mono, fontSize: 9, marginTop: 5, lineHeight: 1.4, color: screenerError ? T.neg : T.muted }}>
              {screenerLoading ? 'Running screen…' : (screenerError || importNote)}
            </div>
          )}
        </div>
        <div style={{ width: 110 }}>
          <label style={labelStyle}>Expiries</label>
          <select
            value={draft.expiries}
            onChange={e => setDraft({ ...draft, expiries: Number(e.target.value) })}
            style={{ ...inputStyle, width: '100%' }}
          >
            {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} nearest</option>)}
          </select>
        </div>
        <div style={{ width: 120 }}>
          <label style={labelStyle}>Min volume</label>
          <input
            type="number" min={0} step={50}
            value={draft.minVolume}
            onChange={e => setDraft({ ...draft, minVolume: Number(e.target.value) })}
            style={{ ...inputStyle, width: '100%' }}
          />
        </div>
        <div style={{ width: 120 }}>
          <label style={labelStyle}>Min vol/OI</label>
          <input
            type="number" min={0} step={0.5}
            value={draft.minVolOi}
            onChange={e => setDraft({ ...draft, minVolOi: Number(e.target.value) })}
            style={{ ...inputStyle, width: '100%' }}
          />
        </div>
        <button
          onClick={runScan}
          disabled={isFetching}
          style={{
            background:    isFetching ? T.surface : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)',
            border:        `1px solid ${T.gold}`,
            color:         T.gold,
            fontFamily:    T.label,
            fontSize:      11,
            fontWeight:    700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding:       '8px 22px',
            cursor:        isFetching ? 'wait' : 'pointer',
            opacity:       isFetching ? 0.6 : 1,
            height:        34,
          }}
        >
          {isFetching ? 'SCANNING…' : 'SCAN'}
        </button>
      </div>

      {/* Verdict strip — total premium + call/put split */}
      {data && rows.length > 0 && (() => {
        const total = rows.reduce((s, r) => s + r.premium, 0)
        const callPrem = rows.filter(r => r.type === 'call').reduce((s, r) => s + r.premium, 0)
        const callPct = total > 0 ? Math.round(callPrem / total * 100) : 0
        const fmt = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`
        const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`
        const topVO = [...rows].sort((a, b) => b.volOiRatio - a.volOiRatio)[0]
        const mostA = [...rows].sort((a, b) => b.volume - a.volume)[0]
        return (
          <div style={{ marginBottom: 12 }}>
            <VerdictStrip
              primary={{ label: 'Total premium', value: fmt(total), tone: 'gold', context: `${data.count} contracts` }}
              cells={[
                { label: 'Calls', value: `${callPct}%`, tone: 'pos', labelTone: 'pos', sub: fmt(callPrem) },
                { label: 'Puts', value: `${100 - callPct}%`, tone: 'neg', labelTone: 'neg', sub: fmt(total - callPrem) },
                { label: 'Top vol/OI', value: `${topVO.ticker} ${topVO.volOiRatio.toFixed(1)}`, tone: 'gold' },
                { label: 'Most active', value: `${mostA.ticker} ${k(mostA.volume)}` },
              ]}
            />
          </div>
        )
      })()}

      {/* Meta line */}
      {data && !isFetching && (
        <div style={{
          fontFamily: T.mono, fontSize: 10, color: T.muted, marginBottom: 10,
          display: 'flex', gap: 18, flexWrap: 'wrap',
        }}>
          <span>{data.count} contracts</span>
          <span>scanned: {data.scanned.join(', ') || '—'}</span>
          <span>as of {new Date(data.asOf).toLocaleTimeString()}</span>
        </div>
      )}

      {isError && (
        <div style={{ fontFamily: T.mono, fontSize: 12, color: T.neg, padding: 20 }}>
          Scan failed. The options data source may be unavailable — try again.
        </div>
      )}

      {!isError && !isFetching && rows.length === 0 && data && (
        <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, padding: 20, textAlign: 'center' }}>
          No contracts cleared the thresholds. Lower min volume or vol/OI and re-scan.
        </div>
      )}

      {/* Table */}
      {rows.length > 0 && (
        <div style={{ border: `1px solid ${T.border}`, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.surface }}>
                {COLUMNS.map(col => {
                  const active = col.sortKey && sort.key === col.sortKey
                  return (
                    <th key={col.label}
                      onClick={col.sortKey ? () => toggleSort(col.sortKey!) : undefined}
                      style={{
                        fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: active ? T.gold : T.muted, padding: '9px 12px',
                        textAlign: col.align, borderBottom: `1px solid ${T.border}`,
                        whiteSpace: 'nowrap', userSelect: 'none',
                        cursor: col.sortKey ? 'pointer' : 'default',
                      }}>
                      {col.label}{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r, idx) => {
                const isCall = r.type === 'call'
                const hot = r.volOiRatio >= 5
                return (
                  <tr key={`${r.ticker}-${r.type}-${r.strike}-${r.expiry}-${idx}`}
                      style={{ borderBottom: `1px solid ${T.border}`, background: idx % 2 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                    <td style={{ padding: '8px 12px', color: T.text, fontWeight: 700 }}>{r.ticker}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{
                        color: isCall ? T.pos : T.neg, fontWeight: 700, fontSize: 10,
                        letterSpacing: '0.06em',
                      }}>{isCall ? 'CALL' : 'PUT'}</span>
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{r.strike.toFixed(2)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{r.expiry}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{r.dte}d</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{r.spot != null ? r.spot.toFixed(2) : '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: r.moneyness == null ? T.muted : r.moneyness >= 0 ? T.pos : T.neg }}>
                      {r.moneyness != null ? `${r.moneyness >= 0 ? '+' : ''}${r.moneyness.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text, fontWeight: 700 }}>{fmtNum(r.volume)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{fmtNum(r.openInterest)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: hot ? T.gold : T.text, fontWeight: hot ? 700 : 400 }}>
                      {r.volOiRatio.toFixed(1)}{r.openInterest === 0 ? '+' : ''}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{r.iv.toFixed(1)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{r.mid.toFixed(2)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: T.gold, fontWeight: 700 }}>{fmtPremium(r.premium)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.6, marginTop: 12, lineHeight: 1.5 }}>
        Vol/OI = today's volume ÷ open interest; a high ratio signals fresh positioning. A "+" marks contracts with zero
        prior open interest (newly opened). Premium = volume × mid × 100. Not investment advice.
      </div>
    </div>
  )
}

export default function UnusualOptions() {
  return (
    <PageWrapper>
      <UnusualOptionsContent />
    </PageWrapper>
  )
}
