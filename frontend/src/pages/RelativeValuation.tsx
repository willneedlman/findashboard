import { T } from '../lib/theme'
import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerInput from '../components/TickerInput'
import TickerLogo from '../components/TickerLogo'
import { recordRecentTicker } from '../lib/recentTickers'
import EmptyState from '../components/EmptyState'
import TickerLink from '../components/TickerLink'
import useIsMobile from '../hooks/useIsMobile'


const METRICS = [
  { key: 'pe',             label: 'P/E',        lowerBetter: true,  isPct: false },
  { key: 'ev_ebitda',      label: 'EV/EBITDA',  lowerBetter: true,  isPct: false },
  { key: 'ps',             label: 'P/S',         lowerBetter: true,  isPct: false },
  { key: 'pb',             label: 'P/B',         lowerBetter: true,  isPct: false },
  { key: 'pfcf',           label: 'P/FCF',       lowerBetter: true,  isPct: false },
  { key: 'roe',            label: 'ROE',         lowerBetter: false, isPct: true  },
  { key: 'revenue_growth', label: 'Rev Growth',  lowerBetter: false, isPct: true  },
] as const

const VISUAL_METRICS = [
  { key: 'pe',             label: 'Price / Earnings',    lowerBetter: true,  isPct: false },
  { key: 'ev_ebitda',      label: 'EV / EBITDA',         lowerBetter: true,  isPct: false },
  { key: 'ps',             label: 'Price / Sales',        lowerBetter: true,  isPct: false },
  { key: 'pb',             label: 'Price / Book',         lowerBetter: true,  isPct: false },
  { key: 'roe',            label: 'Return on Equity',    lowerBetter: false, isPct: true  },
  { key: 'revenue_growth', label: 'Revenue Growth',      lowerBetter: false, isPct: true  },
]

type MetricKey = typeof METRICS[number]['key']

interface PeerRow {
  ticker:               string
  name:                 string
  pe:                   number | null
  ev_ebitda:            number | null
  ps:                   number | null
  pb:                   number | null
  pfcf:                 number | null
  roe:                  number | null
  revenue_growth:       number | null
  price:                number | null
  recommendation_key:   string | null
  recommendation_mean:  number | null
  num_analyst_opinions: number | null
  target_mean_price:    number | null
}

interface ValuationResponse {
  ticker:       string
  sector:       string | null
  peers:        PeerRow[]
  comps_source: 'ai_generated' | 'sector_fallback' | undefined
}

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2
}

function recColor(mean: number | null, key: string | null): string {
  if (mean !== null) {
    if (mean <= 1.5) return 'var(--theme-positive, #22c55e)'
    if (mean <= 2.5) return '#4ade80'
    if (mean <= 3.5) return 'var(--theme-primary, #c9a84c)'
    if (mean <= 4.5) return '#f97316'
    return 'var(--theme-negative, #ef4444)'
  }
  switch (key) {
    case 'strong_buy':                            return 'var(--theme-positive, #22c55e)'
    case 'buy': case 'outperform': case 'overweight': return '#4ade80'
    case 'hold': case 'neutral':                  return 'var(--theme-primary, #c9a84c)'
    case 'sell': case 'underperform': case 'underweight': return '#f97316'
    case 'strong_sell':                           return 'var(--theme-negative, #ef4444)'
    default: return T.muted
  }
}

function recLabel(mean: number | null, key: string | null): string {
  if (mean !== null) {
    if (mean <= 1.5) return 'Strong Buy'
    if (mean <= 2.5) return 'Buy'
    if (mean <= 3.5) return 'Hold'
    if (mean <= 4.5) return 'Sell'
    return 'Strong Sell'
  }
  if (!key) return '—'
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function SentimentCard({ row, isTarget }: { row: PeerRow; isTarget: boolean }) {
  const color   = recColor(row.recommendation_mean, row.recommendation_key)
  const label   = recLabel(row.recommendation_mean, row.recommendation_key)
  const upside  = row.target_mean_price && row.price
    ? ((row.target_mean_price - row.price) / row.price) * 100
    : null

  return (
    <div style={{
      background: isTarget
        ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)'
        : 'var(--theme-hover, rgba(255,255,255,0.02))',
      border: `1px solid ${isTarget ? 'color-mix(in srgb, var(--theme-primary) 35%, transparent)' : T.border}`,
      padding: '10px 12px',
      minWidth: 128,
      flexShrink: 0,
    }}>
      <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: isTarget ? T.gold : T.text, letterSpacing: '0.05em', marginBottom: 2 }}>
        {row.ticker}
      </div>
      <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>
        {row.name}
      </div>

      <div style={{
        display: 'inline-block', fontFamily: T.label, fontSize: 8, fontWeight: 700,
        letterSpacing: '0.1em', textTransform: 'uppercase', color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        padding: '2px 6px', marginBottom: 6,
      }}>
        {label}
      </div>

      {row.num_analyst_opinions != null && (
        <div style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, marginBottom: 4 }}>
          {row.num_analyst_opinions} analysts
        </div>
      )}
      {row.target_mean_price != null && (
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
          Target{' '}
          <span style={{ color: T.text, fontWeight: 700 }}>${row.target_mean_price.toFixed(0)}</span>
        </div>
      )}
      {upside !== null && (
        <div style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: upside >= 0 ? T.pos : T.neg, marginTop: 2 }}>
          {upside >= 0 ? '+' : ''}{upside.toFixed(1)}%
        </div>
      )}
    </div>
  )
}

function MetricBars({
  metricKey, label, lowerBetter, isPct, peers, medians, targetTicker,
}: {
  metricKey: string; label: string; lowerBetter: boolean; isPct: boolean
  peers: PeerRow[]; medians: Record<MetricKey, number | null>; targetTicker: string
}) {
  const valid = peers.filter(p => (p as any)[metricKey] !== null)
  if (!valid.length) return <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, fontStyle: 'italic' }}>No data</div>

  const values   = valid.map(p => (p as any)[metricKey] as number)
  const maxVal   = Math.max(...values)
  const med      = medians[metricKey as MetricKey]
  const medLinePct = (med !== null && maxVal > 0) ? (med / maxVal) * 100 : null

  return (
    <div>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 10 }}>
        {label}
        {med !== null && (
          <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginLeft: 6 }}>
            median {isPct ? `${(med * 100).toFixed(1)}%` : `${med.toFixed(1)}x`}
          </span>
        )}
      </div>
      {valid.map(p => {
        const val       = (p as any)[metricKey] as number
        const widthPct  = maxVal > 0 ? (val / maxVal) * 100 : 0
        const isTarget  = p.ticker === targetTicker
        const good      = lowerBetter ? val <= (med ?? Infinity) : val >= (med ?? 0)
        const barColor  = isTarget ? 'var(--theme-primary, #c9a84c)' : good ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'

        return (
          <div key={p.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ width: 40, fontFamily: T.mono, fontSize: 9, color: isTarget ? T.gold : T.muted, textAlign: 'right', flexShrink: 0, fontWeight: isTarget ? 700 : 400 }}>
              {p.ticker}
            </div>
            <div style={{ flex: 1, height: 14, background: 'var(--theme-hover, rgba(255,255,255,0.04))', position: 'relative', overflow: 'visible' }}>
              <div style={{
                width: `${widthPct}%`, height: '100%',
                background: `color-mix(in srgb, ${barColor} 42%, transparent)`,
                borderRight: `2px solid ${barColor}`,
              }} />
              {medLinePct !== null && (
                <div style={{
                  position: 'absolute', top: -2, bottom: -2,
                  left: `${medLinePct}%`,
                  width: 1, background: 'var(--theme-hover, rgba(255,255,255,0.2))',
                  pointerEvents: 'none',
                }} />
              )}
            </div>
            <div style={{ width: 44, fontFamily: T.mono, fontSize: 9, color: isTarget ? T.gold : T.text, textAlign: 'right', flexShrink: 0, fontWeight: isTarget ? 700 : 400 }}>
              {isPct ? `${(val * 100).toFixed(1)}%` : `${val.toFixed(1)}x`}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function fmt(val: number | null, isPct = false): string {
  if (val == null) return '—'
  return isPct ? `${(val * 100).toFixed(1)}%` : `${val.toFixed(1)}x`
}

function cellColor(val: number | null, med: number | null, lowerBetter: boolean): string {
  if (val == null || med == null) return 'transparent'
  return (lowerBetter ? val < med : val > med) ? 'color-mix(in srgb, var(--theme-positive) 10%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 10%, transparent)'
}

export function RelativeValuationContent() {
  const isMobile = useIsMobile()
  const [searchParams] = useSearchParams()
  const [input,   setInput]   = useState(searchParams.get('ticker') || '')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [data,    setData]    = useState<ValuationResponse | null>(null)

  const doFetch = async (refresh = false, symArg?: string) => {
    const sym = (symArg ?? ((refresh ? data?.ticker : input) || input)).trim().toUpperCase()
    if (!sym) return
    setInput(sym)
    setLoading(true)
    setError(null)
    
    try {
      const res = await axios.get(`/api/corporate/peer-valuation?ticker=${sym}${refresh ? '&refresh=true' : ''}`)
      
      // THE INTERCEPTOR: Deep-clean the payload before React renders it
      const safeData = {
        ...res.data,
        peers: (res.data.peers || []).map((row: any) => {
          const safeRow = { ...row }
          // The exact keys React attempts to run math or .toFixed() on
          const numericKeys = [
            'pe', 'ev_ebitda', 'ps', 'pb', 'pfcf', 'roe', 
            'revenue_growth', 'price', 'target_mean_price', 'recommendation_mean'
          ]
          
          numericKeys.forEach(k => {
            // If the data is missing, explicitly null, or Not-A-Number, force it to null
            if (safeRow[k] === undefined || safeRow[k] === null || Number.isNaN(Number(safeRow[k]))) {
              safeRow[k] = null
            } else if (typeof safeRow[k] === 'string') {
              // Catch any string numbers and cast them to pure floats
              safeRow[k] = parseFloat(safeRow[k])
            }
          })
          return safeRow
        })
      }

      setData(safeData)
      recordRecentTicker(sym)
    } catch {
      setError('Failed to fetch valuation data.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = searchParams.get('ticker')
    if (t) doFetch(false, t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const medians: Record<MetricKey, number | null> = {} as Record<MetricKey, number | null>
  if (data) {
    for (const m of METRICS) {
      const vals = data.peers.map(r => r[m.key]).filter((v): v is number => v != null)
      medians[m.key] = vals.length ? median(vals) : null
    }
  }

  const inp: React.CSSProperties = {
    background: T.surface, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.text,
    fontFamily: T.mono, fontSize: 12, padding: '6px 10px', outline: 'none',
  }

  return (
    <div id="relative-valuation-content" style={{ width: '100%' }}>

        <PageHeader
          title="Peer Comparison"
        />

        {/* Search remains available while the output preview is empty. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 28, alignItems: 'center', flexWrap: 'wrap' }}>
          <TickerInput
            value={input}
            onChange={setInput}
            onEnter={() => doFetch()}
            placeholder="Ticker or company"
            style={{ ...inp, width: 200, fontSize: 14, fontWeight: 700 }}
          />
          <button
            onClick={() => doFetch()}
            disabled={loading}
            style={{
              background: loading ? T.surface : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
              border: `1px solid color-mix(in srgb, var(--theme-primary) 50%, transparent)`, color: loading ? T.muted : T.gold,
              fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
              padding: '6px 16px', cursor: loading ? 'not-allowed' : 'pointer', outline: 'none',
            }}
          >
            {loading ? 'LOADING…' : 'FETCH'}
          </button>
          {data && (
            <button
              onClick={() => doFetch(true)}
              disabled={loading}
              title="Re-run AI comp discovery and bust the 24hr cache"
              style={{
                background: 'transparent',
                border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                padding: '6px 12px', cursor: loading ? 'not-allowed' : 'pointer', outline: 'none',
              }}
            >
              ↺ Refresh Comps
            </button>
          )}
          {data?.sector && (
            <span style={{ fontFamily: T.label, fontSize: 10, color: T.muted, letterSpacing: '0.06em' }}>
              Sector: <span style={{ color: T.text }}>{data.sector}</span>
            </span>
          )}
          {data?.comps_source && (
            <span style={{
              fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', padding: '2px 6px',
              border: `1px solid ${data.comps_source === 'ai_generated' ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : T.border}`,
              color: data.comps_source === 'ai_generated' ? T.gold : T.muted,
              background: data.comps_source === 'ai_generated' ? 'color-mix(in srgb, var(--theme-primary) 7%, transparent)' : 'transparent',
            }}>
              {data.comps_source === 'ai_generated' ? 'AI Comps' : 'Sector Fallback'}
            </span>
          )}
          {error && (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.neg }}>{error}</span>
          )}
        </div>

        {data && (
          <>
            {/* ── Selected company identity ──────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
              <TickerLogo ticker={data.ticker} size={40} />
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 700, color: T.gold }}>{data.ticker}</span>
                {(() => {
                  const name = data.peers.find(p => p.ticker === data.ticker)?.name
                  return name ? <span style={{ fontFamily: T.label, fontSize: 15, color: T.text }}>{name}</span> : null
                })()}
              </div>
            </div>

            {/* ── Analyst Consensus ──────────────────────────────────── */}
            <div className="ft-panel" style={{ marginBottom: 20 }}>
              <div className="ft-panel-header">Analyst Consensus</div>
              <div style={{ padding: '14px 16px', display: 'flex', gap: 10, overflowX: 'auto' }}>
                {data.peers.map(row => (
                  <SentimentCard key={row.ticker} row={row} isTarget={row.ticker === data.ticker} />
                ))}
              </div>
            </div>

            {/* ── Valuation Comparison ───────────────────────────────── */}
            <div className="ft-panel" style={{ marginBottom: 20 }}>
              <div className="ft-panel-header">
                Valuation Comparison
                <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none', marginLeft: 10, opacity: 0.5 }}>
                  — dashed line = sector median
                </span>
              </div>
              <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '20px 32px' }}>
                {VISUAL_METRICS.map(m => (
                  <MetricBars
                    key={m.key}
                    metricKey={m.key}
                    label={m.label}
                    lowerBetter={m.lowerBetter}
                    isPct={m.isPct}
                    peers={data.peers}
                    medians={medians}
                    targetTicker={data.ticker}
                  />
                ))}
              </div>
            </div>

            {/* ── Full Table ─────────────────────────────────────────── */}
            <div className="ft-panel">
              <div className="ft-panel-header">All Metrics</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                      {['Ticker', 'Name', 'P/E', 'EV/EBITDA', 'P/S', 'P/B', 'P/FCF', 'ROE', 'Rev Growth'].map((h, i) => (
                        <th key={h} style={{
                          fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                          textTransform: 'uppercase', color: T.muted,
                          textAlign: i < 2 ? 'left' : 'right',
                          padding: '8px 10px', whiteSpace: 'nowrap',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                    <tr style={{ borderBottom: `1px solid ${T.border}`, background: 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                      <td colSpan={2} style={{ padding: '4px 10px', fontFamily: T.label, fontSize: 9, color: T.muted, fontStyle: 'italic' }}>
                        Sector median
                      </td>
                      {METRICS.map(m => (
                        <td key={m.key} style={{ padding: '4px 10px', textAlign: 'right', color: T.muted, fontFamily: T.mono, fontSize: 9 }}>
                          {fmt(medians[m.key], m.isPct)}
                        </td>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.peers.map((row, i) => {
                      const isTarget = row.ticker === data.ticker
                      return (
                        <tr
                          key={row.ticker}
                          style={{
                            borderBottom: `1px solid ${T.border}`,
                            background: isTarget
                              ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, transparent)'
                              : i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))',
                          }}
                        >
                          <td style={{ padding: '7px 10px', color: isTarget ? T.gold : T.text, fontWeight: isTarget ? 700 : 400, whiteSpace: 'nowrap' }}>
                            <TickerLink ticker={row.ticker} style={{ color: 'inherit' }} />
                          </td>
                          <td style={{ padding: '7px 10px', color: T.muted, fontSize: 10, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.name}
                          </td>
                          {METRICS.map(m => {
                            const val = row[m.key]
                            const bg  = isTarget ? 'transparent' : cellColor(val, medians[m.key], m.lowerBetter)
                            return (
                              <td key={m.key} style={{ padding: '7px 10px', textAlign: 'right', background: bg, color: val != null ? T.text : T.muted }}>
                                {fmt(val, m.isPct)}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '8px 14px', display: 'flex', gap: 20, fontFamily: T.label, fontSize: 9, color: T.muted, borderTop: `1px solid ${T.border}` }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 10, height: 10, background: 'color-mix(in srgb, var(--theme-positive) 25%, transparent)', display: 'inline-block' }} />
                  Below median (favorable)
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 10, height: 10, background: 'color-mix(in srgb, var(--theme-negative) 25%, transparent)', display: 'inline-block' }} />
                  Above median (unfavorable)
                </span>
                <span>Gold row = searched ticker · Data from Yahoo Finance</span>
              </div>
            </div>
          </>
        )}

        {!data && loading && (
          <EmptyState
            title="Loading Peer Comparison"
            hint="Building the peer set and normalizing valuation, growth, and analyst data."
            kpis={['Target', 'Peer Median', 'Sector', 'Analyst View', 'Upside']}
            preview="table"
            previewLabel="Valuation Comparison"
            columns={['Company', 'P/E', 'EV/EBITDA', 'P/S', 'ROE']}
          />
        )}

        {!data && !loading && (
          <>
            {error && <div style={{ marginTop: 12, fontFamily: T.mono, fontSize: 11, color: T.neg }}>{error}</div>}
            <EmptyState
              title="Peer Comparison"
              hint="Search a ticker or company to compare valuation, growth, and analyst expectations."
              keys={['Enter']}
              kpis={['Target', 'Peer Median', 'Sector', 'Analyst View', 'Upside']}
              preview="table"
              previewLabel="Valuation Comparison"
              columns={['Company', 'P/E', 'EV/EBITDA', 'P/S', 'ROE']}
            />
          </>
        )}
      </div>
  )
}

export default function RelativeValuation() {
  return <PageWrapper><RelativeValuationContent /></PageWrapper>
}
