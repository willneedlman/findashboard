import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { ArrowLeft, ArrowRight, MapPinned, Search } from 'lucide-react'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerInput from '../components/TickerInput'
import { recordRecentTicker } from '../lib/recentTickers'

interface Peer {
  symbol: string | null
  name: string
  exchange_tickers: string[]
  industry: string | null
  business_category: string | null
  country: string | null
  city: string | null
  revenue: number | null
  revenue_type: string | null
  employees: number | null
  year_founded: number | null
  brief: string | null
  core_offerings: string[]
  supply_chain_focus: string[]
  target_markets: string[]
  score: number
  shared_focus: string[]
  shared_markets: string[]
  same_industry: boolean
  same_category: boolean
  forced_side?: Side
  verified?: VerifiedRelationship
  end_market?: EndMarketEvidence
}

interface SegmentRow { name: string; value: number; pct: number }
interface SegmentBlock { fiscalYear: string | null; currency: string; latest: SegmentRow[]; source?: string }
interface CompanyProfileResp {
  ticker: string
  name: string
  sector: string
  industry: string
  description: string
  country: string | null
  city: string | null
  revenue: number | null
  market_cap: number | null
  employees: number | null
  product_segments: SegmentBlock
  geo_segments: SegmentBlock
  profile_sources: string[]
}

interface EndMarketEvidence {
  kind: 'revenue_geography'
  fiscal_year: string | null
  pct: number
  value: number
  currency: string
  source: string
}

interface PeersResp {
  available: boolean
  matched: boolean
  ticker: string
  base?: {
    name: string
    exchange: string | null
    industry: string | null
    business_category: string | null
    country: string | null
    city: string | null
    revenue: number | null
    revenue_type: string | null
    employees: number | null
    year_founded: number | null
    brief: string | null
    core_offerings: string[]
    supply_chain_focus: string[]
    target_markets: string[]
    data_sources?: string[]
  }
  count?: number
  returned?: number
  peers?: Peer[]
  profile?: CompanyProfileResp
}

interface VerifiedRelationship {
  counterparty: string
  counterparty_name: string
  role: string
  flow: string
  category: string
  summary: string
  source: string
  published: string
  url: string
}

interface VerifiedRelationshipsResp {
  company_name: string
  relationships: VerifiedRelationship[]
  disclaimer: string
}

type SortMode = 'score' | 'name' | 'revenue'
type Side = 'sourcing' | 'markets'

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const PANEL = 'var(--theme-surface, #0d1826)'
const MAX_MAP_NODES = 12

const fmtBn = (value: number | null) => value == null ? 'Size unavailable'
  : Math.abs(value) >= 1e9 ? `$${(value / 1e9).toFixed(1)}B revenue`
  : Math.abs(value) >= 1e6 ? `$${(value / 1e6).toFixed(0)}M revenue`
  : `$${value.toLocaleString()} revenue`

const fmtCompact = (value: number) => Math.abs(value) >= 1e9
  ? `$${(value / 1e9).toFixed(1)}B`
  : Math.abs(value) >= 1e6
    ? `$${(value / 1e6).toFixed(0)}M`
    : `$${value.toLocaleString()}`

function overlapCount(peer: Peer, side: Side) {
  return side === 'sourcing'
    ? peer.shared_focus.length + (peer.same_category ? 1 : 0)
    : peer.shared_markets.length
}

function peerSide(peer: Peer): Side {
  if (peer.forced_side) return peer.forced_side
  return overlapCount(peer, 'sourcing') >= overlapCount(peer, 'markets') ? 'sourcing' : 'markets'
}

function sortPeers(peers: Peer[], sort: SortMode) {
  return [...peers].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name)
    if (sort === 'revenue') return (b.revenue ?? -1) - (a.revenue ?? -1)
    return b.score - a.score
  })
}

function nodeColor(peer: Peer) {
  if (peer.verified) return '#34d399'
  if (peer.end_market) return BLUE
  if (peer.score >= 8) return GOLD
  if (peer.score >= 5) return BLUE
  return T.muted
}

function tags(peer: Peer, side: Side) {
  if (peer.verified) return `Verified · ${peer.verified.category}`
  if (peer.end_market) return `${peer.end_market.source.toUpperCase()} FY${peer.end_market.fiscal_year ?? '—'} · ${peer.end_market.pct.toFixed(1)}% revenue`
  const values = side === 'sourcing' ? peer.shared_focus : peer.shared_markets
  return values.slice(0, 2).join(' · ') || (side === 'sourcing' && peer.same_category ? 'Shared category' : 'Industry overlap')
}

function tileMetric(peer: Peer, sortMode: SortMode) {
  if (peer.end_market) {
    return sortMode === 'revenue'
      ? `REPORTED REVENUE ${fmtCompact(peer.end_market.value)} · ${peer.end_market.pct.toFixed(1)}% SHARE`
      : `REPORTED REVENUE SHARE ${peer.end_market.pct.toFixed(1)}%`
  }
  if (sortMode === 'revenue') {
    if (peer.revenue != null) return `COMPANY REVENUE ${fmtCompact(peer.revenue)}`
    if (peer.verified) return 'EVIDENCE 1 VERIFIED DISCLOSURE'
    return `OVERLAP SCORE ${peer.score.toFixed(0)} PTS`
  }
  if (peer.verified) return 'EVIDENCE 1 VERIFIED DISCLOSURE'
  if (sortMode === 'score') return `OVERLAP SCORE ${peer.score.toFixed(0)} PTS`
  return peer.revenue != null ? `COMPANY REVENUE ${fmtCompact(peer.revenue)}` : `OVERLAP SCORE ${peer.score.toFixed(0)} PTS`
}

function Toggle<T extends string>({ value, selected, onClick, children }: { value: T; selected: T; onClick: (value: T) => void; children: React.ReactNode }) {
  const active = value === selected
  return <button onClick={() => onClick(value)} style={{ background: active ? 'rgba(96,165,250,0.14)' : 'transparent', color: active ? T.text : T.muted, border: 'none', boxShadow: active ? `inset 0 -2px ${BLUE}` : 'none', padding: '7px 10px', fontFamily: T.mono, fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{children}</button>
}

function CompanyNode({ peer, side, color, sortMode, dimmed, selected, onHover, onSelect }: { peer: Peer; side: Side; color: string; sortMode: SortMode; dimmed: boolean; selected: boolean; onHover: (peer: Peer | null) => void; onSelect: (peer: Peer) => void }) {
  const ticker = peer.symbol ?? peer.exchange_tickers[0]
  return <button onMouseEnter={() => onHover(peer)} onMouseLeave={() => onHover(null)} onClick={() => onSelect(peer)} style={{ width: '100%', minHeight: 64, textAlign: side === 'sourcing' ? 'right' : 'left', background: selected ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, var(--theme-surface, #0d1826))' : PANEL, border: `1px solid color-mix(in srgb, ${color} 56%, var(--theme-border, rgba(255,255,255,0.12)))`, padding: '8px 10px', cursor: 'pointer', opacity: dimmed ? 0.24 : 1, transition: 'opacity 0.14s, background 0.14s', overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: side === 'sourcing' ? 'flex-end' : 'flex-start', gap: 7, minWidth: 0 }}>
      {side === 'markets' && ticker && <span style={{ color, fontFamily: T.mono, fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{ticker}</span>}
      <span style={{ fontFamily: T.label, fontSize: 11, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{peer.name}</span>
      {side === 'sourcing' && ticker && <span style={{ color, fontFamily: T.mono, fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{ticker}</span>}
    </div>
    <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tags(peer, side)}</div>
    <div style={{ fontFamily: T.mono, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.04em', color, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tileMetric(peer, sortMode)}</div>
  </button>
}

function relationshipPeer(relationship: VerifiedRelationship): Peer {
  const supplierSide = relationship.role.startsWith('BUYER')
  return {
    symbol: relationship.counterparty,
    name: relationship.counterparty_name,
    exchange_tickers: relationship.counterparty ? [relationship.counterparty] : [],
    industry: relationship.category,
    business_category: null,
    country: null,
    city: null,
    revenue: null,
    revenue_type: null,
    employees: null,
    year_founded: null,
    brief: relationship.summary,
    core_offerings: supplierSide ? [relationship.category] : [],
    supply_chain_focus: [],
    target_markets: supplierSide ? [] : [relationship.category],
    score: 12,
    shared_focus: [],
    shared_markets: [],
    same_industry: false,
    same_category: false,
    forced_side: supplierSide ? 'sourcing' : 'markets',
    verified: relationship,
  }
}

function endMarketPeers(profile?: CompanyProfileResp): Peer[] {
  const block = profile?.geo_segments
  if (!block?.latest?.length) return []
  return block.latest.map(segment => ({
    symbol: null,
    name: segment.name,
    exchange_tickers: [],
    industry: 'Geographic end market',
    business_category: 'Reported revenue geography',
    country: segment.name,
    city: null,
    revenue: segment.value,
    revenue_type: `${segment.pct.toFixed(1)}% of FY${block.fiscalYear ?? '—'} revenue`,
    employees: null,
    year_founded: null,
    brief: `${segment.pct.toFixed(1)}% of reported revenue was attributed to ${segment.name} in fiscal ${block.fiscalYear ?? 'the latest year'}. This is an end-market geography, not a named buyer.`,
    core_offerings: [],
    supply_chain_focus: [],
    target_markets: [segment.name],
    score: 8 + Math.min(segment.pct, 50) / 25,
    shared_focus: [],
    shared_markets: [segment.name],
    same_industry: false,
    same_category: false,
    forced_side: 'markets',
    end_market: {
      kind: 'revenue_geography',
      fiscal_year: block.fiscalYear,
      pct: segment.pct,
      value: segment.value,
      currency: block.currency,
      source: block.source ?? 'reported',
    },
  }))
}

function SupplyMap({ data, verified, onOpen }: { data: PeersResp; verified: VerifiedRelationship[]; onOpen: (ticker: string) => void }) {
  const [sortMode, setSortMode] = useState<SortMode>('score')
  const [hovered, setHovered] = useState<Peer | null>(null)
  const [selected, setSelected] = useState<Peer | null>(null)
  const [expandedSide, setExpandedSide] = useState<Side | null>(null)
  const peers = useMemo(() => {
    const verifiedPeers = verified.map(relationshipPeer)
    const reportedMarkets = endMarketPeers(data.profile)
    const verifiedKeys = new Set(verifiedPeers.flatMap(peer => [peer.symbol, peer.name.toLowerCase()].filter(Boolean)))
    const similarityPeers = (data.peers ?? []).filter(peer => !verifiedKeys.has(peer.symbol) && !verifiedKeys.has(peer.name.toLowerCase()))
    return [...verifiedPeers, ...reportedMarkets, ...similarityPeers]
  }, [data.peers, data.profile, verified])
  const layout = useMemo(() => {
    const sorted = sortPeers(peers, sortMode)
    return {
      sourcing: sorted.filter(p => peerSide(p) === 'sourcing'),
      markets: sorted.filter(p => peerSide(p) === 'markets'),
    }
  }, [peers, sortMode])
  const mapped = { sourcing: layout.sourcing.slice(0, MAX_MAP_NODES), markets: layout.markets.slice(0, MAX_MAP_NODES) }
  const shown = [...mapped.sourcing, ...mapped.markets]
  const maxScore = Math.max(...shown.map(p => p.score), 1)
  const focus = hovered ?? selected

  return <>
    <div className="ft-panel" style={{ overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 14px', borderBottom: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)', flexWrap: 'wrap' }}>
        <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 400 }}>{verified.length} verified relationships · {data.profile?.geo_segments.latest?.length ?? 0} reported end markets · {data.returned ?? 0} similarity matches</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: T.muted, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em' }}>SORT</span>
          <div style={{ display: 'flex', border: `1px solid ${T.border}` }}>
            <Toggle value="score" selected={sortMode} onClick={setSortMode}>SCORE</Toggle>
            <Toggle value="revenue" selected={sortMode} onClick={setSortMode}>REVENUE</Toggle>
            <Toggle value="name" selected={sortMode} onClick={setSortMode}>NAME</Toggle>
          </div>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div className="scm-map-grid" style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) minmax(230px, 0.72fr) minmax(240px, 1fr)', gap: 42, minWidth: 900, padding: '26px 30px 30px', minHeight: 560 }}>
          <svg aria-hidden="true" viewBox="0 0 100 100" style={{ position: 'absolute', inset: '26px 30px 30px', width: 'calc(100% - 60px)', height: 'calc(100% - 56px)', overflow: 'visible', pointerEvents: 'none' }} preserveAspectRatio="none">
            {mapped.sourcing.map((peer, i) => {
              const y = ((i + 0.5) / Math.max(mapped.sourcing.length, 1)) * 100
              const width = 0.7 + (peer.score / maxScore) * 2.8
              return <path key={`${peer.name}-${i}`} d={`M 32 ${y} C 42 ${y}, 43 50, 48 50`} stroke={nodeColor(peer)} strokeWidth={width} opacity={focus && focus !== peer ? 0.12 : 0.42} fill="none" />
            })}
            {mapped.markets.map((peer, i) => {
              const y = ((i + 0.5) / Math.max(mapped.markets.length, 1)) * 100
              const width = 0.7 + (peer.score / maxScore) * 2.8
              return <path key={`${peer.name}-${i}`} d={`M 52 50 C 57 50, 58 ${y}, 68 ${y}`} stroke={nodeColor(peer)} strokeWidth={width} opacity={focus && focus !== peer ? 0.12 : 0.42} fill="none" />
            })}
          </svg>
          <section style={{ zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, marginBottom: 12 }}><span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: GOLD }}>SUPPLIERS / SOURCING</span><ArrowLeft size={13} color={GOLD} /></div>
            <div style={{ display: 'grid', gap: 7 }}>{mapped.sourcing.length ? mapped.sourcing.map(p => <CompanyNode key={`${p.name}-${p.verified?.category ?? p.score}`} peer={p} side="sourcing" color={nodeColor(p)} sortMode={sortMode} dimmed={!!focus && focus !== p} selected={selected === p} onHover={setHovered} onSelect={setSelected} />) : <Unavailable label="Data unavailable" />}</div>
            {layout.sourcing.length > MAX_MAP_NODES && <button onClick={() => setExpandedSide(expandedSide === 'sourcing' ? null : 'sourcing')} style={{ width: '100%', marginTop: 8, padding: '8px 10px', background: 'transparent', border: `1px dashed ${T.border}`, color: GOLD, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, cursor: 'pointer' }}>{expandedSide === 'sourcing' ? 'HIDE FULL LIST' : `VIEW ${layout.sourcing.length - MAX_MAP_NODES} MORE`}</button>}
          </section>
          <section style={{ alignSelf: 'center', zIndex: 1 }}>
            <div style={{ background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, var(--theme-surface, #0d1826))', border: `1px solid ${GOLD}`, padding: '22px 18px', textAlign: 'center', boxShadow: '0 0 0 6px rgba(201,168,76,0.045)' }}>
              <MapPinned size={20} color={GOLD} style={{ marginBottom: 9 }} />
              <div style={{ fontFamily: T.label, fontSize: 15, fontWeight: 800, color: T.text, lineHeight: 1.25 }}>{data.base?.name ?? data.ticker}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: GOLD, fontWeight: 800, marginTop: 7 }}>{data.ticker}</div>
              <div style={{ borderTop: `1px solid color-mix(in srgb, ${GOLD} 34%, transparent)`, marginTop: 14, paddingTop: 12, fontFamily: T.mono, fontSize: 9, color: T.muted, lineHeight: 1.55 }}>{data.base?.industry ?? 'Industry data unavailable'}{data.base?.business_category ? ` · ${data.base.business_category}` : ''}</div>
            </div>
          </section>
          <section style={{ zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}><ArrowRight size={13} color={BLUE} /><span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: BLUE }}>BUYERS / END MARKETS</span></div>
            <div style={{ display: 'grid', gap: 7 }}>{mapped.markets.length ? mapped.markets.map(p => <CompanyNode key={`${p.name}-${p.verified?.category ?? p.end_market?.fiscal_year ?? p.score}`} peer={p} side="markets" color={nodeColor(p)} sortMode={sortMode} dimmed={!!focus && focus !== p} selected={selected === p} onHover={setHovered} onSelect={setSelected} />) : <Unavailable label="Data unavailable" />}</div>
            {layout.markets.length > MAX_MAP_NODES && <button onClick={() => setExpandedSide(expandedSide === 'markets' ? null : 'markets')} style={{ width: '100%', marginTop: 8, padding: '8px 10px', background: 'transparent', border: `1px dashed ${T.border}`, color: BLUE, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, cursor: 'pointer' }}>{expandedSide === 'markets' ? 'HIDE FULL LIST' : `VIEW ${layout.markets.length - MAX_MAP_NODES} MORE`}</button>}
          </section>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '11px 14px', borderTop: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>Green links are verified relationships. Blue end-market nodes are reported revenue geographies from SEC/FMP data.</span>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>Company revenue is firm-level, not relationship sales. End markets are not named buyers. Similarity signals do not establish a commercial relationship.</span>
      </div>
      <div style={{ borderTop: `1px solid ${T.border}` }}>
      <div className="ft-panel-header">{focus ? `${focus.name} · company detail` : `${data.base?.name ?? data.ticker} · company detail`}</div>
      <div style={{ padding: '13px 16px', fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.65 }}>
        {focus ? <CompanyDetail peer={focus} onOpen={onOpen} /> : <BaseCompanyDetail data={data} onOpen={onOpen} />}
      </div>
      </div>
    </div>
    {expandedSide && <MatchList side={expandedSide} peers={layout[expandedSide]} sortMode={sortMode} selected={selected} onSelect={setSelected} onHover={setHovered} />}
  </>
}

function MatchList({ side, peers, sortMode, selected, onSelect, onHover }: { side: Side; peers: Peer[]; sortMode: SortMode; selected: Peer | null; onSelect: (peer: Peer) => void; onHover: (peer: Peer | null) => void }) {
  const color = side === 'sourcing' ? GOLD : BLUE
  const label = side === 'sourcing' ? 'All shared sourcing matches' : 'All shared end-market matches'
  return <div className="ft-panel" style={{ marginTop: 14 }}>
    <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{label}</span><span style={{ color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 400 }}>{peers.length} firms</span></div>
    <div style={{ maxHeight: 420, overflowY: 'auto', padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 7 }}>{peers.map((peer, i) => <CompanyNode key={`${peer.name}-${peer.symbol ?? i}`} peer={peer} side={side} color={color} sortMode={sortMode} dimmed={false} selected={selected === peer} onHover={onHover} onSelect={onSelect} />)}</div>
  </div>
}

function DetailTags({ label, values, color }: { label: string; values: string[]; color: string }) {
  return <div style={{ marginTop: 13 }}><div style={{ color, fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.11em', marginBottom: 6 }}>{label}</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{values.length ? values.map(value => <span key={value} style={{ padding: '3px 6px', border: `1px solid color-mix(in srgb, ${color} 42%, transparent)`, color: T.text, fontSize: 9.5 }}>{value}</span>) : <span>Data unavailable</span>}</div></div>
}

function CompanyDetail({ peer, onOpen }: { peer: Peer; onOpen: (ticker: string) => void }) {
  const ticker = peer.symbol ?? peer.exchange_tickers[0]
  const location = [peer.city, peer.country].filter(Boolean).join(', ') || 'Location unavailable'
  if (peer.end_market) return <div>
    <div><span style={{ color: T.text, fontFamily: T.label, fontSize: 14, fontWeight: 800 }}>{peer.name}</span><span style={{ color: BLUE, fontWeight: 800, marginLeft: 8 }}>END MARKET</span><div style={{ marginTop: 4, color: BLUE }}>Reported revenue geography</div></div>
    <p style={{ margin: '12px 0 0', color: T.text, fontFamily: T.label, fontSize: 12, lineHeight: 1.55, maxWidth: 980 }}>{peer.brief}</p>
    <div style={{ marginTop: 10, color: BLUE, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800 }}>{peer.end_market.source.toUpperCase()} · FY{peer.end_market.fiscal_year ?? '—'} · {peer.end_market.pct.toFixed(1)}% OF REVENUE</div>
    <div style={{ marginTop: 6, color: T.muted, fontFamily: T.mono, fontSize: 9 }}>This disclosure identifies where revenue is generated. It does not identify an individual customer.</div>
  </div>
  if (peer.verified) return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
      <div><span style={{ color: T.text, fontFamily: T.label, fontSize: 14, fontWeight: 800 }}>{peer.name}</span>{ticker && <span style={{ color: '#34d399', fontWeight: 800, marginLeft: 8 }}>{ticker}</span>}<div style={{ marginTop: 4, color: GOLD }}>{peer.verified.category}</div></div>
      {ticker && <button onClick={() => onOpen(ticker)} style={{ background: 'transparent', border: `1px solid ${GOLD}`, color: GOLD, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, padding: '6px 9px', cursor: 'pointer' }}>OPEN PROFILE</button>}
    </div>
    <p style={{ margin: '12px 0 0', color: T.text, fontFamily: T.label, fontSize: 12, lineHeight: 1.55, maxWidth: 980 }}>{peer.verified.summary}</p>
    <div style={{ marginTop: 10, color: '#34d399', fontFamily: T.mono, fontSize: 9.5, fontWeight: 800 }}>{peer.verified.flow} · VERIFIED {peer.verified.published}</div>
    <a href={peer.verified.url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 6, color: BLUE, fontFamily: T.mono, fontSize: 9, fontWeight: 800 }}>OPEN {peer.verified.source.toUpperCase()} SOURCE ↗</a>
  </div>
  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
      <div><span style={{ color: T.text, fontFamily: T.label, fontSize: 14, fontWeight: 800 }}>{peer.name}</span>{ticker && <span style={{ color: GOLD, fontWeight: 800, marginLeft: 8 }}>{ticker}</span>}<div style={{ marginTop: 4 }}>{peer.industry ?? 'Industry unavailable'}{peer.business_category ? ` · ${peer.business_category}` : ''}</div></div>
      {ticker && <button onClick={() => onOpen(ticker)} style={{ background: 'transparent', border: `1px solid ${GOLD}`, color: GOLD, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, padding: '6px 9px', cursor: 'pointer' }}>OPEN PROFILE</button>}
    </div>
    {peer.brief ? <p style={{ margin: '13px 0 0', color: T.text, fontFamily: T.label, fontSize: 12, lineHeight: 1.55, maxWidth: 980 }}>{peer.brief}</p> : <p style={{ margin: '13px 0 0' }}>Company brief unavailable.</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 18px', marginTop: 13 }}><span>{fmtBn(peer.revenue)}{peer.revenue_type ? ` · ${peer.revenue_type}` : ''}</span><span>{peer.employees != null ? `${peer.employees.toLocaleString()} employees` : 'Headcount unavailable'}</span><span>{peer.year_founded ? `Founded ${peer.year_founded}` : 'Founding year unavailable'}</span><span>{location}</span><span>Match score {peer.score}</span></div>
    <DetailTags label="PRODUCTS & SERVICES · PROVIDES / SELLS" values={peer.core_offerings} color={GOLD} />
    <DetailTags label="SOURCING FOCUS · BUYS / RELIES ON" values={peer.supply_chain_focus} color={GOLD} />
    <DetailTags label="END MARKETS · SELLS INTO" values={peer.target_markets} color={BLUE} />
  </div>
}

function BaseCompanyDetail({ data, onOpen }: { data: PeersResp; onOpen: (ticker: string) => void }) {
  const base = data.base
  if (!base) return <>Select a company to inspect its available records.</>
  const location = [base.city, base.country].filter(Boolean).join(', ') || 'Location unavailable'
  const hasFirmographics = !!(base.brief || base.industry || base.core_offerings.length || base.supply_chain_focus.length || base.target_markets.length)
  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
      <div><span style={{ color: T.text, fontFamily: T.label, fontSize: 14, fontWeight: 800 }}>{base.name}</span><span style={{ color: GOLD, fontWeight: 800, marginLeft: 8 }}>{data.ticker}</span><div style={{ marginTop: 4 }}>{base.industry ?? 'Industry unavailable'}{base.business_category ? ` · ${base.business_category}` : ''}</div></div>
      <button onClick={() => onOpen(data.ticker)} style={{ background: 'transparent', border: `1px solid ${GOLD}`, color: GOLD, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, padding: '6px 9px', cursor: 'pointer' }}>OPEN PROFILE</button>
    </div>
    {!hasFirmographics && <div style={{ marginTop: 10 }}>Company firmographics unavailable. Verified map nodes remain available above.</div>}
    {hasFirmographics && <>{base.brief ? <p style={{ margin: '13px 0 0', color: T.text, fontFamily: T.label, fontSize: 12, lineHeight: 1.55, maxWidth: 980 }}>{base.brief}</p> : <p style={{ margin: '13px 0 0' }}>Company brief unavailable.</p>}<div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 18px', marginTop: 13 }}><span>{fmtBn(base.revenue)}{base.revenue_type ? ` · ${base.revenue_type}` : ''}</span><span>{base.employees != null ? `${base.employees.toLocaleString()} employees` : 'Headcount unavailable'}</span><span>{base.year_founded ? `Founded ${base.year_founded}` : 'Founding year unavailable'}</span><span>{location}</span></div><DetailTags label="PRODUCTS & SERVICES · PROVIDES / SELLS" values={base.core_offerings} color={GOLD} /><DetailTags label="SOURCING FOCUS · BUYS / RELIES ON" values={base.supply_chain_focus} color={GOLD} /><DetailTags label="END MARKETS · SELLS INTO" values={base.target_markets} color={BLUE} /></>}
    {!!base.data_sources?.length && <div style={{ marginTop: 12, color: T.textDim, fontSize: 9 }}>Sources: {base.data_sources.join(' · ')}</div>}
  </div>
}

function Unavailable({ label }: { label: string }) {
  return <div style={{ padding: '16px 12px', border: `1px dashed ${T.border}`, fontFamily: T.mono, fontSize: 10, color: T.muted, textAlign: 'center' }}>{label}</div>
}

export function SupplyChainPeersContent() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<PeersResp | null>(null)
  const [verified, setVerified] = useState<VerifiedRelationship[]>([])
  const [search, setSearch] = useState('')

  const doFetch = async (symbol: string) => {
    const ticker = symbol.trim().toUpperCase()
    if (!ticker) return
    setLoading(true); setData(null); setVerified([])
    try {
      const [relationshipsResult, profileResult] = await Promise.allSettled([
        axios.get<VerifiedRelationshipsResp>(`/api/corporate/verified-supply-chain-relationships?ticker=${encodeURIComponent(ticker)}`),
        axios.get<CompanyProfileResp>(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`),
      ])
      const relationships = relationshipsResult.status === 'fulfilled' ? relationshipsResult.value.data : null
      const profile = profileResult.status === 'fulfilled' ? profileResult.value.data : null
      const canonicalName = profile?.name || relationships?.company_name || ''
      const peers = await axios.get<PeersResp>(`/api/corporate/peers-by-tags?ticker=${encodeURIComponent(ticker)}&company_name=${encodeURIComponent(canonicalName)}&limit=600`)
        .then(response => response.data)
        .catch(() => null)
      const clean = (value?: string | null) => value && value !== 'N/A' ? value : null
      const productNames = profile?.product_segments.latest?.map(segment => segment.name) ?? []
      const marketNames = profile?.geo_segments.latest?.map(segment => segment.name) ?? []
      const segmentSources = [profile?.product_segments.source, profile?.geo_segments.source]
        .filter((source): source is string => !!source)
        .map(source => source.toUpperCase())
      const dataSources = Array.from(new Set([...(profile?.profile_sources ?? []), ...segmentSources]))
      const existingBase = peers?.matched ? peers.base : undefined
      const enrichedBase: NonNullable<PeersResp['base']> = {
        name: profile?.name || relationships?.company_name || existingBase?.name || ticker,
        exchange: existingBase?.exchange ?? null,
        industry: existingBase?.industry ?? clean(profile?.industry),
        business_category: existingBase?.business_category ?? clean(profile?.sector),
        country: existingBase?.country ?? profile?.country ?? null,
        city: existingBase?.city ?? profile?.city ?? null,
        revenue: existingBase?.revenue ?? profile?.revenue ?? null,
        revenue_type: existingBase?.revenue_type ?? (profile?.revenue ? 'latest reported revenue' : null),
        employees: existingBase?.employees ?? profile?.employees ?? null,
        year_founded: existingBase?.year_founded ?? null,
        brief: existingBase?.brief ?? profile?.description ?? null,
        core_offerings: existingBase?.core_offerings.length ? existingBase.core_offerings : productNames,
        supply_chain_focus: existingBase?.supply_chain_focus.length ? existingBase.supply_chain_focus : (relationships?.relationships ?? []).filter(r => r.role.startsWith('BUYER')).map(r => r.category),
        target_markets: existingBase?.target_markets.length ? existingBase.target_markets : marketNames,
        data_sources: dataSources,
      }
      setVerified(relationships?.relationships ?? [])
      setData({
        available: peers?.available ?? false,
        matched: peers?.matched ?? false,
        ticker,
        base: enrichedBase,
        count: peers?.count ?? 0,
        returned: peers?.returned ?? 0,
        peers: peers?.peers ?? [],
        profile: profile ?? undefined,
      })
      recordRecentTicker(ticker)
    } finally { setLoading(false) }
  }

  const openProfile = (ticker: string) => navigate(`/supply-chain?ticker=${encodeURIComponent(ticker)}`)
  const initialTicker = searchParams.get('ticker')
  useEffect(() => {
    if (initialTicker && !data && !loading) void doFetch(initialTicker)
  }, [initialTicker])

  return <div>
    <PageHeader title="Supply Chain Map" />
    <div style={{ maxWidth: 1320 }}>
      <div
        onMouseDown={event => {
          if ((event.target as HTMLElement).closest('button')) return
          event.currentTarget.querySelector('input')?.focus()
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: 240, maxWidth: '100%', margin: '0 0 18px', padding: '6px 8px 6px 10px', background: 'var(--theme-surface, #0d1826)', border: `1px solid ${T.border}`, cursor: 'text' }}
      >
        <Search size={14} color={GOLD} />
        <TickerInput value={search} onChange={setSearch} onEnter={() => doFetch(search)} onSelect={doFetch} placeholder="Search" aria-label="Search company" style={{ width: '100%', flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 700 }} />
        <button onClick={() => doFetch(search)} disabled={!search.trim() || loading} style={{ background: 'transparent', border: 'none', color: search.trim() ? GOLD : T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 800, cursor: search.trim() ? 'pointer' : 'default' }}>GO</button>
      </div>
      {data?.base && !loading && <SupplyMap data={data} verified={verified} onOpen={openProfile} />}
      {loading && <EmptyMap label="Loading supply-chain data" />}
      {!loading && !data && <EmptyMap label="Search a ticker or company" />}
    </div>
  </div>
}

function EmptyMap({ label }: { label: string }) {
  const loading = label.toLowerCase().startsWith('loading')
  const ghost = 'color-mix(in srgb, var(--theme-text, #d7e3fc) 8%, transparent)'
  const faint = 'color-mix(in srgb, var(--theme-text, #d7e3fc) 4%, transparent)'
  const metrics = ['Verified relationships', 'Reported end markets', 'Similarity matches']
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 390, background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, boxSizing: 'border-box' }}>
    <div className="scm-ghost-metrics" style={{ display: 'flex', border: `1px solid ${T.border}`, background: 'var(--theme-hover, rgba(0,0,0,0.12))' }}>
      {metrics.map((metric, index) => <div key={metric} style={{ flex: 1, padding: '11px 16px', borderLeft: index ? `1px solid ${T.border}` : 'none' }}>
        <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>{metric}</div>
        <div style={{ width: 54 + index * 13, height: 15, marginTop: 7, background: ghost }} />
      </div>)}
    </div>
    <div style={{ position: 'relative', flex: 1, minHeight: 300, border: `1px solid ${T.border}`, overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, padding: '4px 10px', background: PANEL, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, color: T.text, fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', zIndex: 3 }}>Supply Chain Map</div>
      <div style={{ position: 'absolute', top: 6, right: 12, color: T.muted, fontFamily: T.mono, fontSize: 9, letterSpacing: '0.06em', zIndex: 3 }}>output preview</div>
      <div className="scm-map-grid scm-empty-grid" style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(210px, 1fr) minmax(340px, 0.98fr) minmax(210px, 1fr)', gap: 30, minWidth: 860, padding: '46px 28px 22px', minHeight: 300, boxSizing: 'border-box', alignItems: 'center' }}>
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: '46px 28px 22px', width: 'calc(100% - 56px)', height: 'calc(100% - 68px)', pointerEvents: 'none' }}>
          {[18, 39, 61, 82].map(y => <path key={`left-${y}`} d={`M 27 ${y} C 40 ${y}, 42 50, 48 50`} fill="none" stroke={ghost} strokeWidth="1.1" />)}
          {[25, 50, 75].map(y => <path key={`right-${y}`} d={`M 52 50 C 58 50, 60 ${y}, 73 ${y}`} fill="none" stroke={ghost} strokeWidth="1.1" />)}
        </svg>
        <section style={{ zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 7, marginBottom: 10, color: T.muted, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.11em', textTransform: 'uppercase' }}>Suppliers / sourcing <ArrowLeft size={12} /></div>
          <div style={{ display: 'grid', gap: 7 }}>{[0, 1, 2, 3].map(row => <div key={row} style={{ height: 38, border: `1px solid ${faint}`, background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 55%, transparent)', padding: '8px 10px', boxSizing: 'border-box' }}><div style={{ width: `${56 + row * 8}%`, height: 8, marginLeft: 'auto', background: ghost }} /><div style={{ width: `${38 + row * 5}%`, height: 5, margin: '6px 0 0 auto', background: faint }} /></div>)}</div>
        </section>
        <section style={{ zIndex: 2, textAlign: 'center', alignSelf: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '18px 12px' }}>
            <div style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: T.text }}>{loading ? 'Loading company network' : 'Supply Chain Map'}</div>
            <div style={{ maxWidth: 440, color: T.muted, fontFamily: T.label, fontSize: 11.5, lineHeight: 1.5 }}>{loading ? 'Combining company profiles, reported markets, and verified relationships.' : 'Search a ticker or company to map suppliers, buyers, and reported end markets.'}</div>
            {!loading && <span style={{ color: T.muted, border: `1px solid ${T.border}`, borderRadius: 2, padding: '1px 6px', fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif', fontSize: 10, fontWeight: 600 }}>Enter</span>}
          </div>
        </section>
        <section style={{ zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, color: T.muted, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.11em', textTransform: 'uppercase' }}><ArrowRight size={12} /> Buyers / end markets</div>
          <div style={{ display: 'grid', gap: 7 }}>{[0, 1, 2].map(row => <div key={row} style={{ height: 45, border: `1px solid ${faint}`, background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 55%, transparent)', padding: '9px 10px', boxSizing: 'border-box' }}><div style={{ width: `${64 - row * 7}%`, height: 8, background: ghost }} /><div style={{ width: `${42 + row * 6}%`, height: 5, marginTop: 7, background: faint }} /></div>)}</div>
        </section>
      </div>
    </div>
  </div>
}

export default function SupplyChainPeers() {
  return <PageWrapper><SupplyChainPeersContent /></PageWrapper>
}
