import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Star } from 'lucide-react'
import { T } from '../../lib/theme'
import TickerLogo from '../TickerLogo'
import { readWatchlist, toggleWatchlist } from '../../lib/watchlist'
import { MONO, SANS, BRIGHT } from './ui'

/** Yahoo's exchange codes, which are not what anyone calls the exchange. */
const EXCHANGE_LABEL: Record<string, string> = {
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NasdaqGS: 'NASDAQ', NNM: 'NASDAQ',
  NYQ: 'NYSE', PCX: 'NYSE ARCA', ASE: 'NYSE AMERICAN', BATS: 'CBOE BZX',
  GER: 'XETRA', FRA: 'FRANKFURT', LSE: 'LSE', TOR: 'TSX', TAI: 'TWSE', CPH: 'NASDAQ COPENHAGEN',
}

/** The company's identity. The PAGE is called Company Profile; this row names
 *  the company the page is currently showing, which is a different thing and
 *  belongs under the title rather than replacing it. */
export default function IdentityBar({ ticker }: { ticker: string }) {
  const [watched, setWatched] = useState(() => readWatchlist().includes(ticker.toUpperCase()))

  const profile = useQuery<{ name?: string; sector?: string; industry?: string }>({
    queryKey: ['cp-profile', ticker],
    queryFn: () => axios.get(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const quote = useQuery<{ exchange?: string | null }>({
    queryKey: ['cp-quote-detail', ticker],
    queryFn: () => axios.get(`/api/corporate/quote-detail?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const p = profile.data ?? {}
  const raw = quote.data?.exchange ?? ''
  const exchange = EXCHANGE_LABEL[raw] ?? (raw || null)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      paddingBottom: 12, marginBottom: 16,
      borderBottom: `1px solid ${T.borderFaint}`,
    }}>
      <TickerLogo ticker={ticker} size={30} />
      <span style={{
        fontFamily: MONO, fontSize: 20, fontWeight: 700, letterSpacing: '0.02em', color: T.gold,
      }}>
        {ticker}
      </span>
      <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: BRIGHT }}>
        {p.name ?? ''}
      </span>

      <button
        type="button"
        aria-label={watched ? `Remove ${ticker} from watchlist` : `Add ${ticker} to watchlist`}
        aria-pressed={watched}
        onClick={() => { toggleWatchlist(ticker); setWatched(w => !w) }}
        style={{
          display: 'inline-flex', background: 'none', border: 'none', padding: 2,
          cursor: 'pointer', color: watched ? T.gold : T.muted, lineHeight: 0,
        }}
      >
        <Star size={14} fill={watched ? 'currentColor' : 'none'} />
      </button>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {exchange && <Tag accent>{exchange}</Tag>}
        {p.sector && <Tag>{p.sector}</Tag>}
        {p.industry && <Tag>{p.industry}</Tag>}
      </div>

    </div>
  )
}

function Tag({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, padding: '2px 7px', whiteSpace: 'nowrap',
      border: `1px solid ${accent ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : T.border}`,
      color: accent ? T.gold : T.muted,
    }}>
      {children}
    </span>
  )
}
