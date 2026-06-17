import { T } from '../lib/theme'
import { useState } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
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
      {up ? '▲' : '▼'} {Math.abs(v).toFixed(1)}%
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
  product_segments: SegBlock
  geo_segments:     SegBlock
  peers:            string[]
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
  if (v >= 1000) return `${(v / 1000).toFixed(0)}K`
  return `${v}`
}

// Latest breakdown + YoY + concentration + multi-year mix trend
function SegmentBreakdown({ title, block }: { title: string; block: SegBlock }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const isMobile = useIsMobile()

  if (!block.latest.length) {
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={labelStyle}>{title}</div>
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
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ ...labelStyle, marginBottom: 0 }}>{title}</div>
        {block.fiscalYear != null && (
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
            FY{block.fiscalYear}{block.currency ? ` · ${block.currency}` : ''}
          </span>
        )}
      </div>

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

export function SupplyChainContent() {
  const isMobileLayout = useIsMobile()
  const [input,   setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [data,    setData]    = useState<SupplyChainData | null>(null)

  const doFetch = async (sym?: string) => {
    const ticker = (sym ?? input).trim().toUpperCase()
    if (!ticker) return
    setInput(ticker)
    setLoading(true)
    setError(null)
    try {
      const res = await axios.get(`/api/corporate/supply-chain?ticker=${ticker}`)
      setData(res.data)
    } catch {
      setError('Could not load company data. Try a valid US equity ticker.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div id="supply-chain-content" style={{ width: '100%', maxWidth: 1340, margin: '0 auto' }}>

        <PageHeader
          title="Company Profile"
          subtitle="Revenue breakdown by product segment and geography, with sector peers."
        />

        {/* Search bar */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 28, alignItems: 'center' }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && doFetch()}
            placeholder="TICKER"
            maxLength={6}
            style={{
              background: T.surface, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.text,
              fontFamily: T.mono, fontSize: 13, fontWeight: 700, padding: '8px 12px',
              outline: 'none', width: 120, textTransform: 'uppercase', letterSpacing: '0.06em',
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

        {data && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobileLayout ? '1fr' : '340px 1fr', gap: 20, alignItems: 'start' }}>

            {/* ── Left: company card ─────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* Identity panel */}
              <div className="ft-panel">
                <div style={{ padding: '16px 16px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.gold }}>{data.ticker}</span>
                    <span style={{ fontFamily: T.label, fontSize: 12, color: T.text }}>{data.name}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                    {data.sector && <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, background: 'color-mix(in srgb, var(--theme-primary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)', padding: '2px 7px' }}>{data.sector}</span>}
                    {data.industry && <span style={{ fontFamily: T.label, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`, padding: '2px 7px' }}>{data.industry}</span>}
                  </div>

                  {/* Key metrics row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
                    {[
                      { label: 'Price',      value: data.price != null ? `$${data.price.toFixed(2)}` : '—' },
                      { label: 'Market Cap', value: fmtCap(data.market_cap) },
                      { label: 'Employees',  value: fmtEmp(data.employees) },
                    ].map((m, i) => (
                      <div key={m.label} style={{ paddingRight: i < 2 ? 12 : 0, borderRight: i < 2 ? `1px solid ${T.border}` : 'none', paddingLeft: i > 0 ? 12 : 0 }}>
                        <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>{m.label}</div>
                        <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{m.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {data.description && (
                  <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.border}`, fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto' }}>
                    {data.description}
                  </div>
                )}
              </div>

              {/* Peers panel */}
              {data.peers.length > 0 && (
                <div className="ft-panel">
                  <div className="ft-panel-header">Sector Peers</div>
                  <div style={{ padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {data.peers.map(p => (
                      <button
                        key={p}
                        onClick={() => doFetch(p)}
                        style={{
                          fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.text,
                          background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`,
                          padding: '4px 9px', cursor: 'pointer', letterSpacing: '0.06em',
                          transition: 'all 0.12s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = T.gold; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--theme-primary) 35%, transparent)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = T.text; (e.currentTarget as HTMLElement).style.borderColor = T.border }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── Right: segment breakdowns ──────────────────────────── */}
            <div className="ft-panel">
              <div className="ft-panel-header">Revenue Breakdown</div>
              <div style={{ padding: '20px 22px 10px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '8px 40px', alignItems: 'start' }}>
                  <SegmentBreakdown title="By Product / Segment" block={data.product_segments} />
                  <SegmentBreakdown title="By Geography" block={data.geo_segments} />
                </div>
                {!data.product_segments.latest.length && !data.geo_segments.latest.length && (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>
                    {(data.product_segments.error || data.geo_segments.error) ? (
                      <>
                        Segment data is temporarily unavailable for {data.ticker}.<br />
                        <span style={{ fontSize: 10, opacity: 0.7 }}>The data provider is rate-limited right now — try again in a little while. Once fetched, results are cached.</span>
                      </>
                    ) : (
                      <>
                        No segment breakdown reported for {data.ticker}.<br />
                        <span style={{ fontSize: 10, opacity: 0.7 }}>Most issuers that file segmented revenue are covered; some (funds, holding companies, certain foreign filers) don't report it.</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

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
