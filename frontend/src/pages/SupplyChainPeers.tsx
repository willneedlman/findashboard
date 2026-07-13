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
  revenue: number | null
  employees: number | null
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
    supply_chain_focus: string[]
    target_markets: string[]
  }
  count?: number
  peers?: Peer[]
}

type SortMode = 'score' | 'name' | 'revenue'
type Side = 'sourcing' | 'markets'

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const PANEL = 'var(--theme-surface, #0d1826)'

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

function CompanyNode({ peer, side, color, dimmed, onHover, onOpen }: { peer: Peer; side: Side; color: string; dimmed: boolean; onHover: (peer: Peer | null) => void; onOpen: (symbol: string) => void }) {
  const ticker = peer.symbol ?? peer.exchange_tickers[0]
  return <button onMouseEnter={() => onHover(peer)} onMouseLeave={() => onHover(null)} onClick={() => ticker && onOpen(ticker)} disabled={!ticker} style={{ width: '100%', minHeight: 49, textAlign: side === 'sourcing' ? 'right' : 'left', background: PANEL, border: `1px solid color-mix(in srgb, ${color} 46%, var(--theme-border, rgba(255,255,255,0.12)))`, borderRight: side === 'sourcing' ? `3px solid ${color}` : undefined, borderLeft: side === 'markets' ? `3px solid ${color}` : undefined, padding: '8px 10px', cursor: ticker ? 'pointer' : 'default', opacity: dimmed ? 0.24 : 1, transition: 'opacity 0.14s, transform 0.14s', overflow: 'hidden' }}>
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
  const peers = data.peers ?? []
  const layout = useMemo(() => {
    const sorted = sortPeers(peers, sortMode)
    return {
      sourcing: sorted.filter(p => peerSide(p) === 'sourcing'),
      markets: sorted.filter(p => peerSide(p) === 'markets'),
    }
  }, [peers, sortMode])
  const shown = [...layout.sourcing, ...layout.markets]
  const maxScore = Math.max(...shown.map(p => p.score), 1)
  const focus = hovered

  return <>
    <div className="ft-panel" style={{ overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 14px', borderBottom: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)', flexWrap: 'wrap' }}>
        <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 400 }}>{data.count ?? peers.length} matched firms · Veridion firmographics</span>
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
            {layout.sourcing.map((peer, i) => {
              const y = ((i + 0.5) / Math.max(layout.sourcing.length, 1)) * 100
              const width = 0.7 + (peer.score / maxScore) * 2.8
              return <path key={peer.name} d={`M 32 ${y} C 42 ${y}, 43 50, 48 50`} stroke={nodeColor(peer)} strokeWidth={width} opacity={focus && focus !== peer ? 0.12 : 0.42} fill="none" />
            })}
            {layout.markets.map((peer, i) => {
              const y = ((i + 0.5) / Math.max(layout.markets.length, 1)) * 100
              const width = 0.7 + (peer.score / maxScore) * 2.8
              return <path key={peer.name} d={`M 52 50 C 57 50, 58 ${y}, 68 ${y}`} stroke={nodeColor(peer)} strokeWidth={width} opacity={focus && focus !== peer ? 0.12 : 0.42} fill="none" />
            })}
          </svg>
          <section style={{ zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, marginBottom: 12 }}><span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: GOLD }}>SOURCING OVERLAP</span><ArrowLeft size={13} color={GOLD} /></div>
            <div style={{ display: 'grid', gap: 7 }}>{layout.sourcing.length ? layout.sourcing.map(p => <CompanyNode key={p.name} peer={p} side="sourcing" color={nodeColor(p)} dimmed={!!focus && focus !== p} onHover={setHovered} onOpen={onOpen} />) : <Unavailable label="No sourcing overlap available" />}</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}><ArrowRight size={13} color={BLUE} /><span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: BLUE }}>MARKET OVERLAP</span></div>
            <div style={{ display: 'grid', gap: 7 }}>{layout.markets.length ? layout.markets.map(p => <CompanyNode key={p.name} peer={p} side="markets" color={nodeColor(p)} dimmed={!!focus && focus !== p} onHover={setHovered} onOpen={onOpen} />) : <Unavailable label="No market overlap available" />}</div>
          </section>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '11px 14px', borderTop: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>Link width represents Veridion match score; it is not reported transaction exposure.</span>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>Sourcing and market labels indicate shared attributes, not verified supplier/customer links.</span>
      </div>
    </div>
    <div className="ft-panel" style={{ marginTop: 14 }}>
      <div className="ft-panel-header">{focus ? `${focus.name} · overlap detail` : 'Map methodology'}</div>
      <div style={{ padding: '13px 16px', fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.65 }}>
        {focus ? <><span style={{ color: T.text, fontWeight: 700 }}>Match score {focus.score}</span> · {fmtBn(focus.revenue)}{focus.employees != null ? ` · ${focus.employees.toLocaleString()} employees` : ''}<br /><span style={{ color: GOLD }}>Sourcing:</span> {focus.shared_focus.join(', ') || 'Data unavailable'} &nbsp; <span style={{ color: BLUE }}>Markets:</span> {focus.shared_markets.join(', ') || 'Data unavailable'}</> : <>This is an overlap map built from Veridion firmographic categories, supply-chain focus, end markets, and industry. Hover a firm to inspect the underlying attributes; select a ticker to open its company profile.</>}
      </div>
    </div>
  </>
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
      const response = await axios.get<PeersResp>(`/api/corporate/peers-by-tags?ticker=${encodeURIComponent(ticker)}`)
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, maxWidth: 510, margin: '0 0 18px', padding: '7px 9px', background: 'var(--theme-surface, #0d1826)', border: `1px solid ${T.border}` }}>
        <Search size={15} color={GOLD} />
        <TickerInput value={search} onChange={setSearch} onEnter={() => doFetch(search)} onSelect={doFetch} placeholder="Search ticker or company" aria-label="Search company" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700 }} />
        <button onClick={() => doFetch(search)} disabled={!search.trim() || loading} style={{ background: 'transparent', border: 'none', color: search.trim() ? GOLD : T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 800, cursor: search.trim() ? 'pointer' : 'default' }}>MAP</button>
      </div>
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
