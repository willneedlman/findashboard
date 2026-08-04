import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TickerLogo from '../components/TickerLogo'
import Provenance from '../components/Provenance'
import { KpiCell } from '../components/mmCockpit'
import { recordRecentTicker, getRecentTickers } from '../lib/recentTickers'

const GOLD = 'var(--theme-primary, #c9a84c)'
const POS = 'var(--theme-positive, #3fb950)'
const NEG = 'var(--theme-negative, #f85149)'
const TEXT = 'var(--theme-text, #d7e3fc)'
const SEC = 'var(--theme-secondary, #8099b0)'
const FAINT = 'var(--theme-text-faint, #5e768f)'
const MONO = 'var(--theme-mono, monospace)'
const SANS = 'var(--theme-sans, sans-serif)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const SURFACE = 'var(--theme-surface, #0d1826)'

const lbl: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: FAINT, fontFamily: SANS, marginBottom: 6, display: 'block' }
const inp: React.CSSProperties = { background: 'var(--theme-bg)', border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`, color: TEXT, fontFamily: MONO, fontSize: 13, padding: '9px 12px', outline: 'none', textTransform: 'uppercase' }

interface EvidenceItem { source: string; headline: string; sentiment: number | null; url: string | null; timestamp: string; is_market_context?: boolean }
interface Narrative { summary: string; confidence: 'high' | 'medium' | 'low'; cited_indices: number[] }
interface MoverResult {
  ticker: string; available: boolean; reason?: string
  company_name?: string | null; sector?: string | null
  price?: { pct_move: number; z_score: number | null; relative_volume: number | null; last_close: number }
  relative?: { spy_pct: number | null; sector_pct: number | null; sector_etf: string | null; excess_vs_market: number | null }
  verdict?: 'noise' | 'explained' | 'evidence_only'
  evidence?: EvidenceItem[]
  narrative?: Narrative | null
  source_status?: Record<string, { count: number; error: string | null }>
  as_of?: string
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const CONFIDENCE_COLOR: Record<string, string> = { high: POS, medium: GOLD, low: SEC }
const TIMEFRAMES: { key: string; label: string }[] = [
  { key: '5m', label: '5M' }, { key: '15m', label: '15M' }, { key: '30m', label: '30M' },
  { key: '1h', label: '1H' }, { key: '1d', label: '1D' }, { key: '1w', label: '1W' },
]

export function MoverRadarContent() {
  const [searchParams] = useSearchParams()
  const [input, setInput] = useState(searchParams.get('ticker') || 'AAPL')
  const [ticker, setTicker] = useState<string | null>((searchParams.get('ticker') || 'AAPL').toUpperCase())
  const [timeframe, setTimeframe] = useState('1d')
  const [evidenceSort, setEvidenceSort] = useState<'relevance' | 'recency'>('relevance')
  const recent = getRecentTickers()

  const { data, isFetching, isError } = useQuery<MoverResult>({
    queryKey: ['mover-radar', ticker, timeframe],
    queryFn: () => axios.get(`/api/movers/explain?ticker=${encodeURIComponent(ticker!)}&timeframe=${timeframe}`).then(r => r.data),
    enabled: !!ticker,
    staleTime: 60_000,
  })

  const analyze = (sym?: string) => {
    const s = (sym ?? input).trim().toUpperCase()
    if (!s) return
    setInput(s)
    setTicker(s)
    recordRecentTicker(s)
  }

  // Keep the original index attached — the LLM's cited_indices refer to the
  // backend's order (relevance-tiered: SEC filings > news > social > market
  // context), so re-sorting for display must not disturb which item a ★ points to.
  const sortedEvidence = useMemo(() => {
    const withIdx = (data?.evidence ?? []).map((e, i) => ({ ...e, _idx: i }))
    // Market-context items are unfiltered general market headlines the backend
    // pulls in case one explains a sector-wide move — most don't. Only show
    // one if the model actually found it relevant enough to cite; the rest
    // stay in the data the model reasoned over, just not on screen.
    const cited = data?.narrative?.cited_indices ?? []
    const visible = withIdx.filter(e => !e.is_market_context || cited.includes(e._idx))
    const byRecency = (a: typeof visible[number], b: typeof visible[number]) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    if (evidenceSort === 'recency') {
      return [...visible].sort(byRecency)
    }
    // Relevance: what the model actually cited first, then SEC filings (the
    // most attributable source), then the strongest sentiment signal — recency
    // only breaks ties. Falling back to source-tier-then-recency (the
    // backend's own order) made "relevance" indistinguishable from "recency"
    // whenever every visible item happened to share one tier.
    const relevanceRank = (e: typeof visible[number]): number => {
      if (cited.includes(e._idx)) return 0
      if (e.source === 'SEC EDGAR') return 1
      return 2
    }
    return [...visible].sort((a, b) => {
      const r = relevanceRank(a) - relevanceRank(b)
      if (r !== 0) return r
      const s = Math.abs(b.sentiment ?? 0) - Math.abs(a.sentiment ?? 0)
      if (s !== 0) return s
      return byRecency(a, b)
    })
  }, [data?.evidence, data?.narrative, evidenceSort])

  return (
    <PageWrapper title="Mover Radar">
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderTop: `2px solid ${GOLD}`, padding: '14px 16px', display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <label style={lbl}>Ticker</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && analyze()}
                placeholder="AAPL" style={{ ...inp, width: 140 }} />
              <button onClick={() => analyze()} disabled={isFetching} style={{
                background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: SANS, fontSize: 10,
                fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '0 16px',
                cursor: isFetching ? 'default' : 'pointer', opacity: isFetching ? 0.6 : 1,
              }}>{isFetching ? 'SCANNING…' : 'SCAN'}</button>
            </div>
          </div>
          <div>
            <label style={lbl}>Timeframe</label>
            <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
              {TIMEFRAMES.map((t, i) => (
                <button key={t.key} onClick={() => setTimeframe(t.key)} title={`Move, volume, and evidence freshness measured over ${t.label}`} style={{
                  background: timeframe === t.key ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent',
                  border: 'none', borderRight: i < TIMEFRAMES.length - 1 ? `1px solid ${BORDER}` : 'none',
                  color: timeframe === t.key ? GOLD : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700,
                  padding: '9px 11px', cursor: 'pointer',
                }}>{t.label}</button>
              ))}
            </div>
          </div>
          {recent.length > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ ...lbl, marginBottom: 0 }}>Recent</span>
              {recent.slice(0, 6).map(t => (
                <button key={t} onClick={() => analyze(t)} style={{
                  background: t === ticker ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent',
                  border: `1px solid ${t === ticker ? GOLD : BORDER}`, color: t === ticker ? GOLD : SEC,
                  fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '5px 9px', cursor: 'pointer',
                }}>{t}</button>
              ))}
            </div>
          )}
        </div>

        {!ticker && (
          <EmptyState title="Mover Radar" hint="Enter a ticker to see what's actually moving it — real news, filings, and social chatter, or confirmation it's just noise." action="SCAN" />
        )}
        {ticker && isFetching && (
          <EmptyState title="Scanning…" hint={`Pulling price action, filings, and news/social evidence for ${ticker}.`} variant="loading" />
        )}
        {ticker && !isFetching && (isError || (data && !data.available)) && (
          <EmptyState title="Unavailable" hint={data?.reason || 'Could not analyze this ticker. Check the symbol and try again.'} variant="unavailable" />
        )}

        {ticker && !isFetching && data && data.available && data.price && (
          <>
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${BORDER}` }}>
                <TickerLogo ticker={data.ticker} size={26} />
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: GOLD }}>{data.ticker}</div>
                  {data.company_name && <div style={{ fontFamily: SANS, fontSize: 10, color: FAINT }}>{data.company_name}{data.sector ? ` · ${data.sector}` : ''}</div>}
                </div>
                <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: FAINT }}>${data.price.last_close.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex' }}>
                <KpiCell grow align="top" label="Move" value={`${data.price.pct_move >= 0 ? '+' : ''}${data.price.pct_move.toFixed(2)}%`} valueSize={20} color={data.price.pct_move >= 0 ? POS : NEG} sub="today" />
                <KpiCell grow align="top" label="Z-Score" value={data.price.z_score != null ? data.price.z_score.toFixed(2) : '—'} valueSize={20} color={data.price.z_score != null && Math.abs(data.price.z_score) >= 1.25 ? GOLD : TEXT} sub="vs its own normal daily move" />
                <KpiCell grow align="top" label="Rel. Volume" value={data.price.relative_volume != null ? `${data.price.relative_volume.toFixed(2)}x` : '—'} valueSize={20} sub="vs 20-day avg" />
                <KpiCell grow align="top" label="Vs S&P 500" value={data.relative?.excess_vs_market != null ? `${data.relative.excess_vs_market >= 0 ? '+' : ''}${data.relative.excess_vs_market.toFixed(2)}%` : '—'} valueSize={20} color={data.relative?.excess_vs_market != null && data.relative.excess_vs_market >= 0 ? POS : NEG} sub="idiosyncratic move" />
              </div>
            </div>

            {data.verdict === 'noise' && (
              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, padding: '16px 18px' }}>
                <div style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: SEC, marginBottom: 6 }}>No Identifiable Catalyst</div>
                <div style={{ fontFamily: SANS, fontSize: 12, color: TEXT, lineHeight: 1.6 }}>
                  This move is within {data.ticker}'s normal daily range, and no recent news, filing, or social chatter matched it. Likely noise, not a catalyst-driven move.
                </div>
              </div>
            )}

            {data.verdict === 'explained' && data.narrative && (
              <div style={{ background: SURFACE, border: `1px solid ${GOLD}`, padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: GOLD }}>Driven By</span>
                  <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: CONFIDENCE_COLOR[data.narrative.confidence] ?? SEC, border: `1px solid ${CONFIDENCE_COLOR[data.narrative.confidence] ?? BORDER}`, padding: '2px 7px', textTransform: 'uppercase' }}>{data.narrative.confidence} confidence</span>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: TEXT, lineHeight: 1.6 }}>{data.narrative.summary}</div>
                <div style={{ fontFamily: SANS, fontSize: 9, color: FAINT, marginTop: 8 }}>AI-synthesized from the evidence below — cited items marked ★.</div>
              </div>
            )}

            {data.verdict === 'evidence_only' && (
              <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, padding: '16px 18px' }}>
                <div style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: SEC, marginBottom: 6 }}>Evidence Found — Synthesis Unavailable</div>
                <div style={{ fontFamily: SANS, fontSize: 12, color: TEXT, lineHeight: 1.6 }}>
                  {data.evidence?.length ? 'There is real, fresh evidence below, but the AI summarizer is temporarily unavailable — read the raw evidence directly.' : 'No fresh evidence, but the move is outside the normal range for this name.'}
                </div>
              </div>
            )}

            {!!data.evidence?.length && (
              <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: `1px solid ${BORDER}` }}>
                  <span style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>Evidence</span>
                  <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
                    {(['relevance', 'recency'] as const).map((mode, i) => (
                      <button key={mode} onClick={() => setEvidenceSort(mode)} style={{
                        background: evidenceSort === mode ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent',
                        border: 'none', borderRight: i === 0 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer',
                        color: evidenceSort === mode ? GOLD : SEC, fontFamily: MONO, fontSize: 9.5, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 9px',
                      }}>{mode}</button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {sortedEvidence.map(e => {
                    const cited = data.narrative?.cited_indices?.includes(e._idx)
                    return (
                      <div key={e._idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${BORDER}`, background: cited ? `color-mix(in srgb, ${GOLD} 6%, transparent)` : 'transparent' }}>
                        <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: SEC, border: `1px solid ${BORDER}`, padding: '2px 6px', whiteSpace: 'nowrap', marginTop: 1 }}>{e.source}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {e.url
                            ? <a href={e.url} target="_blank" rel="noreferrer" style={{ color: TEXT, fontFamily: SANS, fontSize: 12, textDecoration: 'none' }}>{cited && <span style={{ color: GOLD }}>★ </span>}{e.headline}</a>
                            : <span style={{ color: TEXT, fontFamily: SANS, fontSize: 12 }}>{cited && <span style={{ color: GOLD }}>★ </span>}{e.headline}</span>}
                        </div>
                        {e.sentiment != null && (
                          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: e.sentiment >= 0 ? POS : NEG, whiteSpace: 'nowrap' }}>{e.sentiment >= 0 ? '+' : ''}{e.sentiment.toFixed(2)}</span>
                        )}
                        <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT, whiteSpace: 'nowrap' }}>{timeAgo(e.timestamp)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontFamily: MONO, fontSize: 9, color: FAINT }}>
              {data.source_status && Object.entries(data.source_status).map(([name, s]) => (
                <span key={name}>{name}: {s.error ? 'error' : `${s.count}`}</span>
              ))}
              <Provenance kind="live" source="multi-source aggregation" />
            </div>
          </>
        )}
      </div>
    </PageWrapper>
  )
}

export default function MoverRadar() {
  return <MoverRadarContent />
}
