import { useState } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import useIsMobile from '../hooks/useIsMobile'

const T = {
  bg:      'var(--theme-bg, #060e1c)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.06))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
}

const SEGMENT_COLORS = ['#c9a84c', '#60a5fa', '#22c55e', '#f97316', '#a78bfa', '#38bdf8', '#fb7185', '#34d399', '#fbbf24', '#e879f9']

interface Segment { name: string; value: number; pct: number }

interface SupplyChainData {
  ticker:           string
  name:             string
  sector:           string
  industry:         string
  description:      string
  price:            number | null
  market_cap:       number | null
  employees:        number | null
  product_segments: Segment[]
  geo_segments:     Segment[]
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

// Horizontal stacked bar breakdown
function SegmentBreakdown({ title, data }: { title: string; data: Segment[] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const isMobile = useIsMobile()

  if (!data.length) {
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10 }}>{title}</div>
        <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>No segment data available for this ticker.</div>
      </div>
    )
  }

  const maxPct = Math.max(...data.map(d => d.pct))

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 12 }}>{title}</div>

      {/* Stacked color bar */}
      <div style={{ display: 'flex', height: 10, borderRadius: 2, overflow: 'hidden', marginBottom: 16, gap: 1 }}>
        {data.map((s, i) => (
          <div
            key={i}
            style={{ width: `${s.pct}%`, background: SEGMENT_COLORS[i % SEGMENT_COLORS.length], transition: 'opacity 0.15s', opacity: hovered !== null && hovered !== i ? 0.4 : 1, cursor: 'default' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>

      {/* Rows */}
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
          {/* Label row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: SEGMENT_COLORS[i % SEGMENT_COLORS.length], flexShrink: 0 }} />
              <span style={{ fontFamily: T.label, fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            </div>
            <div style={{ display: 'flex', gap: isMobile ? 8 : 12, alignItems: 'center', flexShrink: 0 }}>
              {s.value > 0 && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{fmtCap(s.value)}</span>
              )}
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: SEGMENT_COLORS[i % SEGMENT_COLORS.length], minWidth: 44, textAlign: 'right' }}>{s.pct.toFixed(1)}%</span>
            </div>
          </div>
          {/* Bar */}
          <div style={{ height: 4, background: 'var(--theme-hover, rgba(255,255,255,0.06))', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${(s.pct / maxPct) * 100}%`, height: '100%', background: SEGMENT_COLORS[i % SEGMENT_COLORS.length], borderRadius: 2 }} />
          </div>
        </div>
      ))}
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
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>

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
              background: T.surface, border: `1px solid ${T.border}`, color: T.text,
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
          {error && <span style={{ fontFamily: T.mono, fontSize: 10, color: '#ef4444' }}>{error}</span>}
        </div>

        {data && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobileLayout ? '1fr' : '300px 1fr', gap: 20, alignItems: 'start' }}>

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
                    {data.sector && <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.2)', padding: '2px 7px' }}>{data.sector}</span>}
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
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = T.gold; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(201,168,76,0.35)' }}
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
              <div style={{ padding: '20px 20px 8px' }}>
                <SegmentBreakdown title="By Product / Segment" data={data.product_segments} />
                <SegmentBreakdown title="By Geography" data={data.geo_segments} />
                {!data.product_segments.length && !data.geo_segments.length && (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>
                    Detailed segment data not yet available for {data.ticker}.<br />
                    <span style={{ fontSize: 10, opacity: 0.7 }}>Coverage includes AAPL, MSFT, GOOGL, AMZN, META, NVDA, and 30+ others.</span>
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
