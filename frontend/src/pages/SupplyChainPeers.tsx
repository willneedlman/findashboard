import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerLaunch from '../components/TickerLaunch'
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

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const labelStyle: React.CSSProperties = {
  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: T.muted, marginBottom: 10,
}

const fmtBn = (v: number | null) => v == null ? '—'
  : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B`
  : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(0)}M`
  : `$${v.toLocaleString()}`
const fmtEmp = (v: number | null) => v == null ? '—' : v.toLocaleString()

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color,
      border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, borderRadius: 3, padding: '2px 7px', whiteSpace: 'nowrap' }}>
      {text}
    </span>
  )
}

function PeerRow({ p, maxScore, onOpen }: { p: Peer; maxScore: number; onOpen: (s: string) => void }) {
  const clickable = !!p.symbol
  const sub = [p.industry, p.country].filter(Boolean).join(' · ')
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '38px 1fr auto', gap: 14, alignItems: 'start',
      padding: '12px 0', borderBottom: `1px solid var(--theme-hover, rgba(255,255,255,0.04))` }}>
      {/* score meter */}
      <div style={{ paddingTop: 2 }}>
        <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1 }}>{p.score}</div>
        <div style={{ height: 3, background: 'var(--theme-hover, rgba(255,255,255,0.06))', marginTop: 5 }}>
          <div style={{ height: '100%', width: `${Math.round((p.score / maxScore) * 100)}%`, background: GOLD }} />
        </div>
      </div>

      {/* identity + shared tags */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          {clickable ? (
            <button onClick={() => onOpen(p.symbol!)}
              style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', color: GOLD, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
              onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
              {p.symbol}
            </button>
          ) : (
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>—</span>
          )}
          <span style={{ fontFamily: T.label, fontSize: 12.5, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
        </div>
        {sub && <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, marginTop: 3 }}>{sub}</div>}
        {(p.same_industry || p.shared_focus.length > 0 || p.shared_markets.length > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
            {p.same_industry && <Chip text="same industry" color={T.text} />}
            {p.shared_focus.map(t => <Chip key={`f-${t}`} text={t} color={GOLD} />)}
            {p.shared_markets.map(t => <Chip key={`m-${t}`} text={t} color={BLUE} />)}
          </div>
        )}
      </div>

      {/* size */}
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{fmtBn(p.revenue)}</div>
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, marginTop: 3 }}>{fmtEmp(p.employees)} emp</div>
      </div>
    </div>
  )
}

export function SupplyChainPeersContent() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<PeersResp | null>(null)
  const [notFound, setNotFound] = useState<string | null>(null)

  const doFetch = async (sym: string) => {
    const ticker = sym.trim().toUpperCase()
    if (!ticker) return
    setLoading(true); setData(null); setNotFound(null)
    try {
      const res = await axios.get<PeersResp>(`/api/corporate/peers-by-tags?ticker=${encodeURIComponent(ticker)}`)
      if (res.data.matched) { setData(res.data); recordRecentTicker(ticker) }
      else setNotFound(ticker)
    } catch {
      setNotFound(ticker)
    } finally {
      setLoading(false)
    }
  }

  const openProfile = (s: string) => navigate(`/supply-chain?ticker=${encodeURIComponent(s)}`)
  const maxScore = data?.peers?.length ? Math.max(...data.peers.map(p => p.score)) : 1

  return (
    <div>
      <PageHeader title="Supply Chain Peers" />
      <div style={{ maxWidth: 1100 }}>
        {data && data.base && (
          <>
            {/* base company + its tags */}
            <div className="ft-panel" style={{ marginBottom: 18 }}>
              <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{data.base.name}{data.base.exchange ? ` · ${data.base.exchange}:${data.ticker}` : ''}</span>
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 400, color: T.muted }}>via Veridion</span>
              </div>
              <div style={{ padding: '16px 18px' }}>
                {data.base.industry && (
                  <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, marginBottom: 12 }}>
                    {data.base.industry}{data.base.business_category ? ` · ${data.base.business_category}` : ''}
                  </div>
                )}
                {data.base.supply_chain_focus.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ ...labelStyle, marginBottom: 6 }}>Sourcing Focus</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{data.base.supply_chain_focus.map(t => <Chip key={t} text={t} color={GOLD} />)}</div>
                  </div>
                )}
                {data.base.target_markets.length > 0 && (
                  <div>
                    <div style={{ ...labelStyle, marginBottom: 6 }}>Target Markets</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{data.base.target_markets.map(t => <Chip key={t} text={t} color={BLUE} />)}</div>
                  </div>
                )}
              </div>
            </div>

            {/* ranked peers */}
            <div className="ft-panel">
              <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>Ranked Peers</span>
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 400, color: T.muted }}>
                  {data.count} matched · shared sourcing + end-markets + industry
                </span>
              </div>
              <div style={{ padding: '4px 18px 8px' }}>
                {data.peers && data.peers.length > 0 ? (
                  data.peers.map(p => <PeerRow key={p.name} p={p} maxScore={maxScore} onOpen={openProfile} />)
                ) : (
                  <div style={{ padding: '24px 0', color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>
                    No firmographic overlap found for this name.
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {loading && (
          <div style={{ padding: '40px 0', color: T.muted, fontFamily: T.mono, fontSize: 11, fontStyle: 'italic' }}>
            Ranking peers…
          </div>
        )}

        {!loading && !data && (
          <>
            {notFound && (
              <div style={{ marginBottom: 12, fontFamily: T.mono, fontSize: 11.5, color: T.muted, lineHeight: 1.6, maxWidth: 620 }}>
                No Veridion firmographic coverage for <span style={{ color: T.text, fontWeight: 700 }}>{notFound}</span>.
                Coverage skews to small- and mid-cap and international names; most US mega-caps are not in the set.
              </div>
            )}
            <TickerLaunch
              hint="Enter a ticker to rank its supply-chain peers and counterparties by shared sourcing focus, end-markets, and industry, drawn from Veridion firmographics."
              onLoad={doFetch}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default function SupplyChainPeers() {
  return <PageWrapper><SupplyChainPeersContent /></PageWrapper>
}
