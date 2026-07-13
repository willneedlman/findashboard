import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { ArrowLeft, ArrowRight, MapPinned, Search } from 'lucide-react'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerLaunch from '../components/TickerLaunch'
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
  }
  count?: number
  returned?: number
  peers?: Peer[]
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

function overlapCount(peer: Peer, side: Side) {
  return side === 'sourcing'
    ? peer.shared_focus.length + (peer.same_category ? 1 : 0)
    : peer.shared_markets.length
}

function peerSide(peer: Peer): Side {
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
  if (peer.score >= 8) return GOLD
  if (peer.score >= 5) return BLUE
  return T.muted
}

function tags(peer: Peer, side: Side) {
  const values = side === 'sourcing' ? peer.shared_focus : peer.shared_markets
  return values.slice(0, 2).join(' · ') || (side === 'sourcing' && peer.same_category ? 'Shared category' : 'Industry overlap')
}

function Toggle<T extends string>({ value, selected, onClick, children }: { value: T; selected: T; onClick: (value: T) => void; children: React.ReactNode }) {
  const active = value === selected
  return <button onClick={() => onClick(value)} style={{ background: active ? 'rgba(96,165,250,0.14)' : 'transparent', color: active ? T.text : T.muted, border: 'none', borderLeft: active ? `2px solid ${BLUE}` : '2px solid transparent', padding: '7px 10px', fontFamily: T.mono, fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{children}</button>
}

function CompanyNode({ peer, side, color, dimmed, selected, onHover, onSelect }: { peer: Peer; side: Side; color: string; dimmed: boolean; selected: boolean; onHover: (peer: Peer | null) => void; onSelect: (peer: Peer) => void }) {
  const ticker = peer.symbol ?? peer.exchange_tickers[0]
  return <button onMouseEnter={() => onHover(peer)} onMouseLeave={() => onHover(null)} onClick={() => onSelect(peer)} style={{ width: '100%', minHeight: 49, textAlign: side === 'sourcing' ? 'right' : 'left', background: selected ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, var(--theme-surface, #0d1826))' : PANEL, border: `1px solid color-mix(in srgb, ${color} 46%, var(--theme-border, rgba(255,255,255,0.12)))`, borderRight: side === 'sourcing' ? `3px solid ${color}` : undefined, borderLeft: side === 'markets' ? `3px solid ${color}` : undefined, padding: '8px 10px', cursor: 'pointer', opacity: dimmed ? 0.24 : 1, transition: 'opacity 0.14s, transform 0.14s', overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: side === 'sourcing' ? 'flex-end' : 'flex-start', gap: 7, minWidth: 0 }}>
      {side === 'markets' && ticker && <span style={{ color, fontFamily: T.mono, fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{ticker}</span>}
      <span style={{ fontFamily: T.label, fontSize: 11, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{peer.name}</span>
      {side === 'sourcing' && ticker && <span style={{ color, fontFamily: T.mono, fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{ticker}</span>}
    </div>
    <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tags(peer, side)}</div>
  </button>
}

function SupplyMap({ data, onOpen }: { data: PeersResp; onOpen: (ticker: string) => void }) {
  const [sortMode, setSortMode] = useState<SortMode>('score')
  const [hovered, setHovered] = useState<Peer | null>(null)
  const [selected, setSelected] = useState<Peer | null>(null)
  const [expandedSide, setExpandedSide] = useState<Side | null>(null)
  const peers = data.peers ?? []
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
        <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 400 }}>{data.returned ?? peers.length} shown of {data.count ?? peers.length} matched firms · Veridion firmographics</span>
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
        <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) minmax(230px, 0.72fr) minmax(240px, 1fr)', gap: 42, minWidth: 900, padding: '26px 30px 30px', minHeight: 560 }}>
          <svg aria-hidden="true" viewBox="0 0 100 100" style={{ position: 'absolute', inset: '26px 30px 30px', width: 'calc(100% - 60px)', height: 'calc(100% - 56px)', overflow: 'visible', pointerEvents: 'none' }} preserveAspectRatio="none">
            {mapped.sourcing.map((peer, i) => {
              const y = ((i + 0.5) / Math.max(mapped.sourcing.length, 1)) * 100
              const width = 0.7 + (peer.score / maxScore) * 2.8
              return <path key={peer.name} d={`M 32 ${y} C 42 ${y}, 43 50, 48 50`} stroke={nodeColor(peer)} strokeWidth={width} opacity={focus && focus !== peer ? 0.12 : 0.42} fill="none" />
            })}
            {mapped.markets.map((peer, i) => {
              const y = ((i + 0.5) / Math.max(mapped.markets.length, 1)) * 100
              const width = 0.7 + (peer.score / maxScore) * 2.8
              return <path key={peer.name} d={`M 52 50 C 57 50, 58 ${y}, 68 ${y}`} stroke={nodeColor(peer)} strokeWidth={width} opacity={focus && focus !== peer ? 0.12 : 0.42} fill="none" />
            })}
          </svg>
          <section style={{ zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, marginBottom: 12 }}><span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: GOLD }}>SHARED SOURCING</span><ArrowLeft size={13} color={GOLD} /></div>
            <div style={{ display: 'grid', gap: 7 }}>{mapped.sourcing.length ? mapped.sourcing.map(p => <CompanyNode key={p.name} peer={p} side="sourcing" color={nodeColor(p)} dimmed={!!focus && focus !== p} selected={selected === p} onHover={setHovered} onSelect={setSelected} />) : <Unavailable label="No shared sourcing attributes" />}</div>
            {layout.sourcing.length > MAX_MAP_NODES && <button onClick={() => setExpandedSide(expandedSide === 'sourcing' ? null : 'sourcing')} style={{ width: '100%', marginTop: 8, padding: '8px 10px', background: 'transparent', border: `1px dashed ${T.border}`, color: GOLD, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, cursor: 'pointer' }}>{expandedSide === 'sourcing' ? 'HIDE FULL LIST' : `VIEW ${layout.sourcing.length - MAX_MAP_NODES} MORE`}</button>}
          </section>
          <section style={{ alignSelf: 'center', zIndex: 1 }}>
            <div style={{ background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, var(--theme-surface, #0d1826))', border: `1px solid ${GOLD}`, padding: '22px 18px', textAlign: 'center', boxShadow: '0 0 0 6px rgba(201,168,76,0.045)' }}>
              <MapPinned size={20} color={GOLD} style={{ marginBottom: 9 }} />
              <div style={{ fontFamily: T.label, fontSize: 15, fontWeight: 800, color: T.text, lineHeight: 1.25 }}>{data.base?.name}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: GOLD, fontWeight: 800, marginTop: 7 }}>{data.ticker}</div>
              <div style={{ borderTop: `1px solid color-mix(in srgb, ${GOLD} 34%, transparent)`, marginTop: 14, paddingTop: 12, fontFamily: T.mono, fontSize: 9, color: T.muted, lineHeight: 1.55 }}>{data.base?.industry ?? 'Industry data unavailable'}{data.base?.business_category ? ` · ${data.base.business_category}` : ''}</div>
            </div>
          </section>
          <section style={{ zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}><ArrowRight size={13} color={BLUE} /><span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: BLUE }}>SHARED END MARKETS</span></div>
            <div style={{ display: 'grid', gap: 7 }}>{mapped.markets.length ? mapped.markets.map(p => <CompanyNode key={p.name} peer={p} side="markets" color={nodeColor(p)} dimmed={!!focus && focus !== p} selected={selected === p} onHover={setHovered} onSelect={setSelected} />) : <Unavailable label="No shared end-market attributes" />}</div>
            {layout.markets.length > MAX_MAP_NODES && <button onClick={() => setExpandedSide(expandedSide === 'markets' ? null : 'markets')} style={{ width: '100%', marginTop: 8, padding: '8px 10px', background: 'transparent', border: `1px dashed ${T.border}`, color: BLUE, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, cursor: 'pointer' }}>{expandedSide === 'markets' ? 'HIDE FULL LIST' : `VIEW ${layout.markets.length - MAX_MAP_NODES} MORE`}</button>}
          </section>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '11px 14px', borderTop: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>Link width represents Veridion match score; it is not reported transaction exposure.</span>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>Shared sourcing and end-market tags are similarity signals, not verified supplier/customer links.</span>
      </div>
    </div>
    {expandedSide && <MatchList side={expandedSide} peers={layout[expandedSide]} selected={selected} onSelect={setSelected} onHover={setHovered} />}
    <div className="ft-panel" style={{ marginTop: 14 }}>
      <div className="ft-panel-header">{focus ? `${focus.name} · company detail` : 'Select a company'}</div>
      <div style={{ padding: '13px 16px', fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.65 }}>
        {focus ? <CompanyDetail peer={focus} onOpen={onOpen} /> : <>Click a company to keep its brief, products and services, sourcing focus, end markets, and operating facts visible here.</>}
      </div>
    </div>
  </>
}

function MatchList({ side, peers, selected, onSelect, onHover }: { side: Side; peers: Peer[]; selected: Peer | null; onSelect: (peer: Peer) => void; onHover: (peer: Peer | null) => void }) {
  const color = side === 'sourcing' ? GOLD : BLUE
  const label = side === 'sourcing' ? 'All shared sourcing matches' : 'All shared end-market matches'
  return <div className="ft-panel" style={{ marginTop: 14 }}>
    <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{label}</span><span style={{ color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 400 }}>{peers.length} firms</span></div>
    <div style={{ maxHeight: 420, overflowY: 'auto', padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 7 }}>{peers.map(peer => <CompanyNode key={peer.name} peer={peer} side={side} color={color} dimmed={false} selected={selected === peer} onHover={onHover} onSelect={onSelect} />)}</div>
  </div>
}

function DetailTags({ label, values, color }: { label: string; values: string[]; color: string }) {
  return <div style={{ marginTop: 13 }}><div style={{ color, fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.11em', marginBottom: 6 }}>{label}</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{values.length ? values.map(value => <span key={value} style={{ padding: '3px 6px', border: `1px solid color-mix(in srgb, ${color} 42%, transparent)`, color: T.text, fontSize: 9.5 }}>{value}</span>) : <span>Data unavailable</span>}</div></div>
}

function CompanyDetail({ peer, onOpen }: { peer: Peer; onOpen: (ticker: string) => void }) {
  const ticker = peer.symbol ?? peer.exchange_tickers[0]
  const location = [peer.city, peer.country].filter(Boolean).join(', ') || 'Location unavailable'
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

function Unavailable({ label }: { label: string }) {
  return <div style={{ padding: '16px 12px', border: `1px dashed ${T.border}`, fontFamily: T.mono, fontSize: 10, color: T.muted, textAlign: 'center' }}>{label}</div>
}

export function SupplyChainPeersContent() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<PeersResp | null>(null)
  const [notFound, setNotFound] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const doFetch = async (symbol: string) => {
    const ticker = symbol.trim().toUpperCase()
    if (!ticker) return
    setLoading(true); setData(null); setNotFound(null)
    try {
      const response = await axios.get<PeersResp>(`/api/corporate/peers-by-tags?ticker=${encodeURIComponent(ticker)}&limit=600`)
      if (response.data.matched) { setData(response.data); recordRecentTicker(ticker) }
      else setNotFound(ticker)
    } catch { setNotFound(ticker) } finally { setLoading(false) }
  }

  const openProfile = (ticker: string) => navigate(`/supply-chain?ticker=${encodeURIComponent(ticker)}`)
  const initialTicker = searchParams.get('ticker')
  useEffect(() => {
    if (initialTicker && !data && !loading && !notFound) void doFetch(initialTicker)
  }, [initialTicker])

  return <div>
    <PageHeader title="Supply Chain Map" />
    <div style={{ maxWidth: 1320 }}>
      {data?.base && <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 300, maxWidth: '100%', margin: '0 0 18px', padding: '6px 8px 6px 10px', background: 'var(--theme-surface, #0d1826)', border: `1px solid ${T.border}` }}>
        <Search size={14} color={GOLD} />
        <TickerInput value={search} onChange={setSearch} onEnter={() => doFetch(search)} onSelect={doFetch} placeholder="Search" aria-label="Search company" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 700 }} />
        <button onClick={() => doFetch(search)} disabled={!search.trim() || loading} style={{ background: 'transparent', border: 'none', color: search.trim() ? GOLD : T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 800, cursor: search.trim() ? 'pointer' : 'default' }}>GO</button>
      </div>}
      {data?.base && <SupplyMap data={data} onOpen={openProfile} />}
      {loading && <div style={{ padding: '42px 0', color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>Mapping firmographic overlap…</div>}
      {!loading && !data && <>
        {notFound && <div style={{ marginBottom: 12, fontFamily: T.mono, fontSize: 11.5, color: T.muted, lineHeight: 1.6, maxWidth: 640 }}>No Veridion firmographic coverage for <span style={{ color: T.text, fontWeight: 700 }}>{notFound}</span>. Data unavailable for this company.</div>}
        <TickerLaunch hint="Enter a ticker or company name to map firms that share sourcing focus, end markets, and industry attributes. The map does not infer direct supplier or customer relationships." onLoad={doFetch} />
      </>}
    </div>
  </div>
}

export default function SupplyChainPeers() {
  return <PageWrapper><SupplyChainPeersContent /></PageWrapper>
}
