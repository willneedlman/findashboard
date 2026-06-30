import { T } from '../lib/theme'
import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerInput from '../components/TickerInput'
import TickerLogo from '../components/TickerLogo'
import useIsMobile from '../hooks/useIsMobile'


const SEGMENT_COLORS = ['var(--theme-primary, #c9a84c)', '#60a5fa', 'var(--theme-positive, #22c55e)', '#f97316', '#a78bfa', '#38bdf8', '#fb7185', '#34d399', '#fbbf24', '#e879f9']

interface SegItem { name: string; value: number; pct: number; yoy_pct: number | null }
interface SegHistYear { year: number | string; total: number; segments: { name: string; value: number }[] }
interface SegConcentration { topShare: number; hhi: number; count: number }
interface SegBlock {
  fiscalYear:    number | string | null
  currency:      string | null
  latest:        SegItem[]
  history:       SegHistYear[]
  concentration: SegConcentration | null
  error?:        boolean
  source?:       string
}

// Where the breakdown came from — shown as a small provenance chip.
function SourceChip({ source }: { source?: string }) {
  if (!source) return null
  const sec = source === 'sec'
  const label = sec ? 'SEC EDGAR' : 'FMP'
  const c = sec ? 'var(--theme-tertiary, #60a5fa)' : 'var(--theme-primary, #c9a84c)'
  return (
    <span title={sec ? 'Sourced from SEC EDGAR 10-K (FMP fallback)' : 'Sourced from Financial Modeling Prep'}
      style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: c, border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`, borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
      via {label}
    </span>
  )
}

const labelStyle: React.CSSProperties = {
  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: T.muted, marginBottom: 10,
}

// FMP returns some geography labels in ALL CAPS (UNITED STATES, CHINA) and others
// already cased. Title-case the all-caps ones; leave mixed-case names (iPhone,
// International Segment) and known acronyms untouched.
const GEO_ACRONYMS = new Set(['US', 'USA', 'UK', 'EU', 'EMEA', 'APAC', 'UAE', 'LATAM', 'ROW', 'ASEAN', 'MEA'])
function prettyName(name: string): string {
  if (/[a-z]/.test(name)) return name
  return name.replace(/[A-Z0-9]+/g, w => GEO_ACRONYMS.has(w) ? w : w[0] + w.slice(1).toLowerCase())
}

function colorMapFor(block: SegBlock): Record<string, string> {
  const names: string[] = []
  block.latest.forEach(s => { if (!names.includes(s.name)) names.push(s.name) })
  block.history.forEach(y => y.segments.forEach(s => { if (!names.includes(s.name)) names.push(s.name) }))
  const map: Record<string, string> = {}
  names.forEach((n, i) => { map[n] = SEGMENT_COLORS[i % SEGMENT_COLORS.length] })
  return map
}

function YoYChip({ v }: { v: number | null }) {
  if (v == null) return <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, opacity: 0.5 }}>·</span>
  const up = v >= 0
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, minWidth: 52, textAlign: 'right',
      color: up ? 'var(--theme-positive)' : 'var(--theme-negative)' }}>
      {up ? '↑' : '↓'} {Math.abs(v).toFixed(1)}%
    </span>
  )
}

interface SupplyChainData {
  ticker:           string
  name:             string
  sector:           string
  industry:         string
  description:      string
  price:            number | null
  market_cap:       number | null
  employees:        number | null
  pe_ratio?:        number | null
  eps_ttm?:         number | null
  rev_growth?:      number | null
  div_yield?:       number | null
  product_segments: SegBlock
  geo_segments:     SegBlock
  revenue_activity?: SegBlock
  peers:            string[]
}

interface Holder { holder: string; shares: number; value: number; pct_out: number | null; date: string | null }
interface InstData {
  ticker: string
  pct_institutions: number | null
  pct_insiders: number | null
  holders: Holder[]
  funds: Holder[]
  source: string
}

function fmtCap(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}

function fmtEmp(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1000) return `${Math.round(v / 1000).toLocaleString('en-US')}K`
  return `${v}`
}

// Latest breakdown + YoY + concentration + multi-year mix trend. `hideHeader`
// suppresses the internal title row when an enclosing panel header carries it.
function SegmentBreakdown({ title, block, hideHeader = false }: { title: string; block: SegBlock; hideHeader?: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const isMobile = useIsMobile()

  if (!block.latest.length) {
    return (
      <div style={{ marginBottom: hideHeader ? 0 : 24 }}>
        {!hideHeader && <div style={labelStyle}>{title}</div>}
        <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>
          {block.error ? 'Temporarily unavailable — retry shortly.' : 'Not reported by this issuer.'}
        </div>
      </div>
    )
  }

  const color  = colorMapFor(block)
  const data   = block.latest
  const maxPct = Math.max(...data.map(d => d.pct))

  return (
    <div style={{ marginBottom: hideHeader ? 0 : 28 }}>
      {!hideHeader && (
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ ...labelStyle, marginBottom: 0 }}>{title}</div>
          <SourceChip source={block.source} />
        </div>
        {block.fiscalYear != null && (
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
            FY{block.fiscalYear}{block.currency ? ` · ${block.currency}` : ''}
          </span>
        )}
      </div>
      )}

      {/* Stacked color bar (latest year) */}
      <div style={{ display: 'flex', height: 10, borderRadius: 2, overflow: 'hidden', marginBottom: 16, gap: 1 }}>
        {data.map((s, i) => (
          <div
            key={i}
            style={{ width: `${s.pct}%`, background: color[s.name], transition: 'opacity 0.15s', opacity: hovered !== null && hovered !== i ? 0.4 : 1, cursor: 'default' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>

      {/* Rows with YoY */}
      {data.map((s, i) => (
        <div
          key={i}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
          style={{
            padding: '7px 0',
            borderBottom: i < data.length - 1 ? `1px solid var(--theme-hover, rgba(255,255,255,0.04))` : 'none',
            opacity: hovered !== null && hovered !== i ? 0.45 : 1,
            transition: 'opacity 0.12s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: color[s.name], flexShrink: 0 }} />
              <span style={{ fontFamily: T.label, fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prettyName(s.name)}</span>
            </div>
            <div style={{ display: 'flex', gap: isMobile ? 8 : 12, alignItems: 'center', flexShrink: 0 }}>
              <YoYChip v={s.yoy_pct} />
              {s.value > 0 && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{fmtCap(s.value)}</span>
              )}
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: color[s.name], minWidth: 44, textAlign: 'right' }}>{s.pct.toFixed(1)}%</span>
            </div>
          </div>
          <div style={{ height: 4, background: 'var(--theme-hover, rgba(255,255,255,0.06))', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${(s.pct / maxPct) * 100}%`, height: '100%', background: color[s.name], borderRadius: 2 }} />
          </div>
        </div>
      ))}

      {/* Concentration */}
      {block.concentration && (
        <div style={{ marginTop: 12, fontFamily: T.mono, fontSize: 10, color: T.muted, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>Top <b style={{ color: T.text }}>{block.concentration.topShare.toFixed(1)}%</b></span>
          <span>{block.concentration.count} segments</span>
          <span title="Herfindahl-Hirschman index (0–10,000). Higher = more concentrated.">
            HHI <b style={{ color: block.concentration.hhi >= 2500 ? T.gold : T.text }}>{block.concentration.hhi.toLocaleString()}</b>
          </span>
        </div>
      )}

      {/* Multi-year mix trend */}
      {block.history.length > 1 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ ...labelStyle, fontSize: 8, marginBottom: 8 }}>Mix trend · {block.history.length}y</div>
          {block.history.map(y => {
            const tot = y.total || 1
            return (
              <div key={String(y.year)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, width: 30, flexShrink: 0 }}>
                  {typeof y.year === 'number' ? `'${String(y.year).slice(2)}` : y.year}
                </span>
                <div style={{ flex: 1, display: 'flex', height: 7, borderRadius: 2, overflow: 'hidden', gap: 1, background: 'var(--theme-hover, rgba(255,255,255,0.04))' }}>
                  {y.segments.map((s, j) => {
                    // FMP relabels segments between years (e.g. international is "Walmart
                    // International" in FY26 but "Non-United States" earlier). Present the
                    // trend with the latest breakdown's segment identity, matched by rank,
                    // so every year shows the same segments as the legend.
                    const seg = block.latest[j]
                    return (
                      <div key={j} title={`${prettyName(seg?.name ?? s.name)}: ${fmtCap(s.value)}`}
                        style={{ width: `${(s.value / tot) * 100}%`, background: (seg && color[seg.name]) || SEGMENT_COLORS[j % SEGMENT_COLORS.length] }} />
                    )
                  })}
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, width: 54, textAlign: 'right', flexShrink: 0 }}>{fmtCap(y.total)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// One revenue panel: ft-panel with a header that carries the title + source chip
// + fiscal-year meta, and the existing SegmentBreakdown (header suppressed) below.
function RevenuePanel({ title, block }: { title: string; block: SegBlock }) {
  return (
    <div className="ft-panel">
      <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{title}<SourceChip source={block.source} /></span>
        {block.fiscalYear != null && (
          <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 400, letterSpacing: 0, color: T.muted }}>
            FY{block.fiscalYear}{block.currency ? ` · ${block.currency}` : ''}
          </span>
        )}
      </div>
      <div style={{ padding: '16px 18px' }}>
        <SegmentBreakdown title={title} block={block} hideHeader />
      </div>
    </div>
  )
}

function pctHeld(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

function HolderRow({ h, last, maxPct }: { h: Holder; last: boolean; maxPct: number }) {
  return (
    <div style={{ padding: '6px 0', borderBottom: last ? 'none' : `1px solid var(--theme-hover, rgba(255,255,255,0.04))` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <span style={{ fontFamily: T.label, fontSize: 11, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{h.holder}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexShrink: 0 }}>
          {h.value > 0 && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>{fmtCap(h.value)}</span>}
          <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.gold, minWidth: 46, textAlign: 'right' }}>{h.pct_out != null ? `${h.pct_out.toFixed(2)}%` : '—'}</span>
        </span>
      </div>
      <div style={{ height: 4, background: 'var(--theme-hover, rgba(255,255,255,0.06))', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${((h.pct_out ?? 0) / maxPct) * 100}%`, height: '100%', background: T.gold, borderRadius: 2 }} />
      </div>
    </div>
  )
}

// Full-width institutional ownership: summary stats in a narrow first column,
// then the top holders split across two columns so the list never feels cramped.
function InstitutionalPanel({ inst, loading, tab, onTab }:
  { inst: InstData | null; loading: boolean; tab: 'holders' | 'funds'; onTab: (t: 'holders' | 'funds') => void }) {
  const isMobile = useIsMobile()
  const hasData = inst && (inst.holders.length > 0 || inst.funds.length > 0)
  const rows = inst ? (tab === 'holders' ? inst.holders : inst.funds) : []
  const asOf = rows.find(r => r.date)?.date
  const half = Math.ceil(rows.length / 2)
  const cols = [rows.slice(0, half), rows.slice(half)]

  return (
    <div className="ft-panel">
      <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Institutional Ownership</span>
        {hasData && (
          <span style={{ display: 'flex', gap: 2 }}>
            {(['holders', 'funds'] as const).map(t => (
              <button key={t} onClick={() => onTab(t)} style={{
                fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                padding: '2px 7px', cursor: 'pointer', border: 'none',
                color: tab === t ? T.gold : T.muted,
                background: tab === t ? 'color-mix(in srgb, var(--theme-primary) 14%, transparent)' : 'transparent',
              }}>{t === 'holders' ? 'Institutions' : 'Funds'}</button>
            ))}
          </span>
        )}
      </div>
      <div style={{ padding: '18px 20px' }}>
        {loading ? (
          <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>Loading 13F data…</div>
        ) : !hasData ? (
          <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>No institutional ownership reported.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '200px 1fr 1fr', gap: 32, alignItems: 'start' }}>
            {/* Summary stats + provenance */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {[
                { label: '% Institutions', value: pctHeld(inst!.pct_institutions) },
                { label: '% Insiders', value: pctHeld(inst!.pct_insiders) },
              ].map(m => (
                <div key={m.label}>
                  <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 4 }}>{m.label}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: T.text }}>{m.value}</div>
                </div>
              ))}
              <div style={{ marginTop: 2, paddingTop: 12, borderTop: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 9, color: T.muted, lineHeight: 1.5 }}>
                Top {rows.length} {tab === 'holders' ? 'institutional holders' : 'fund holders'} · 13F via yfinance{asOf ? ` · as of ${asOf}` : ''}
              </div>
            </div>

            {/* Holder rows, split across two columns */}
            {cols.map((list, ci) => {
              const m = Math.max(1, ...list.map(r => r.pct_out ?? 0))
              return (
                <div key={ci}>
                  {list.map((h, i) => <HolderRow key={i} h={h} last={i === list.length - 1} maxPct={m} />)}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function SupplyChainContent() {
  const isMobileLayout = useIsMobile()
  const [searchParams] = useSearchParams()
  const [input,   setInput]   = useState(searchParams.get('ticker') || '')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [data,    setData]    = useState<SupplyChainData | null>(null)
  const [inst,    setInst]    = useState<InstData | null>(null)
  const [instLoading, setInstLoading] = useState(false)
  const [instTab, setInstTab] = useState<'holders' | 'funds'>('holders')

  const doFetch = async (sym?: string) => {
    const ticker = (sym ?? input).trim().toUpperCase()
    if (!ticker) return
    setInput(ticker)
    setLoading(true)
    setError(null)
    setData(null)
    // Institutional ownership loads in parallel so it never blocks the profile.
    setInst(null); setInstLoading(true)
    axios.get(`/api/corporate/institutional?ticker=${ticker}`)
      .then(r => setInst(r.data)).catch(() => setInst(null)).finally(() => setInstLoading(false))
    try {
      const res = await axios.get(`/api/corporate/supply-chain?ticker=${ticker}`)
      setData(res.data)
    } catch {
      setError('Could not load company data. Try a valid US equity ticker.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = searchParams.get('ticker')
    if (t) doFetch(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id="supply-chain-content" style={{ width: '100%' }}>

        <PageHeader
          title="Company Profile"
        />

        {/* Search bar */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 28, alignItems: 'center' }}>
          <TickerInput
            value={input}
            onChange={setInput}
            onEnter={() => doFetch()}
            placeholder="Ticker or company"
            style={{
              background: T.surface, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.text,
              fontFamily: T.mono, fontSize: 13, fontWeight: 700, padding: '8px 12px',
              outline: 'none', width: 200, letterSpacing: '0.06em',
            }}
          />
          <button
            onClick={() => doFetch()}
            disabled={loading}
            style={{
              background: loading ? T.surface : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
              border: `1px solid ${T.gold}60`, color: loading ? T.muted : T.gold,
              fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
              padding: '8px 20px', cursor: loading ? 'not-allowed' : 'pointer', outline: 'none',
            }}
          >
            {loading ? 'Loading…' : 'Fetch'}
          </button>
          {error && <span style={{ fontFamily: T.mono, fontSize: 10, color: 'var(--theme-negative)' }}>{error}</span>}
        </div>

        {data && (() => {
          const metrics: { label: string; value: string; color?: string }[] = [
            { label: 'Price',      value: data.price != null ? `$${data.price.toFixed(2)}` : '—' },
            { label: 'Market Cap', value: fmtCap(data.market_cap) },
            { label: 'P/E Ratio',  value: data.pe_ratio != null ? data.pe_ratio.toFixed(1) : '—' },
            { label: 'EPS (TTM)',  value: data.eps_ttm != null ? `$${data.eps_ttm.toFixed(2)}` : '—' },
            { label: 'Rev Growth', value: data.rev_growth != null ? `${data.rev_growth >= 0 ? '↑' : '↓'} ${Math.abs(data.rev_growth * 100).toFixed(1)}%` : '—',
              color: data.rev_growth != null ? (data.rev_growth >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)') : undefined },
            { label: 'Div Yield',  value: data.div_yield != null ? `${data.div_yield.toFixed(2)}%` : '—' },
            { label: 'Employees',  value: fmtEmp(data.employees) },
          ]
          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* ── Identity strip: title row + 7-metric grid ──────────── */}
            <div className="ft-panel">
              <div style={{ padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                <TickerLogo ticker={data.ticker} size={40} />
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 700, color: T.gold }}>{data.ticker}</span>
                  <span style={{ fontFamily: T.label, fontSize: 15, color: T.text }}>{data.name}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {data.sector && <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, background: 'color-mix(in srgb, var(--theme-primary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)', padding: '2px 7px' }}>{data.sector}</span>}
                  {data.industry && <span style={{ fontFamily: T.label, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`, padding: '2px 7px' }}>{data.industry}</span>}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobileLayout ? 'repeat(2,1fr)' : 'repeat(7,1fr)', borderTop: `1px solid ${T.border}` }}>
                {metrics.map((m, i) => (
                  <div key={m.label} style={{ padding: '14px 18px', borderRight: !isMobileLayout && i < metrics.length - 1 ? `1px solid ${T.border}` : 'none', borderTop: isMobileLayout && i >= 2 ? `1px solid ${T.border}` : 'none' }}>
                    <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: m.color ?? T.text }}>{m.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Row 1: About + Peers · Revenue by Segment · by Geography ── */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobileLayout ? '1fr' : '1fr 1fr 1fr', gap: 18, alignItems: 'stretch' }}>
              <div className="ft-panel" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="ft-panel-header">About</div>
                <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <div style={{ flex: 1, fontFamily: T.label, fontSize: 12, color: T.muted, lineHeight: 1.7, overflowY: 'auto', maxHeight: 340 }}>
                    {data.description || 'No description available.'}
                  </div>
                  {data.peers.length > 0 && (
                    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                      <div style={{ ...labelStyle, marginBottom: 8 }}>Sector Peers</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {data.peers.map(p => (
                          <button key={p} onClick={() => doFetch(p)}
                            style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text, background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`, padding: '6px 12px', cursor: 'pointer', letterSpacing: '0.06em', transition: 'all 0.12s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = T.gold; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--theme-primary) 35%, transparent)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = T.text; (e.currentTarget as HTMLElement).style.borderColor = T.border }}>
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <RevenuePanel title="Revenue · By Segment" block={data.product_segments} />
              <RevenuePanel title="Revenue · By Geography" block={data.geo_segments} />
            </div>

            {/* Bank fees-vs-trading mix, only when reported */}
            {data.revenue_activity && data.revenue_activity.latest.length > 0 && (
              <RevenuePanel title="Revenue · By Activity (Fees vs Trading)" block={data.revenue_activity} />
            )}

            {/* ── Row 2: Institutional ownership (full width) ────────── */}
            <InstitutionalPanel inst={inst} loading={instLoading} tab={instTab} onTab={setInstTab} />
          </div>
          )
        })()}

        {!data && !loading && (
          <div style={{ textAlign: 'center', padding: '80px 0', color: T.muted, fontFamily: T.label, fontSize: 11 }}>
            Enter a ticker to view revenue breakdown and company profile.
          </div>
        )}
      </div>
  )
}

export default function SupplyChain() {
  return <PageWrapper><SupplyChainContent /></PageWrapper>
}
