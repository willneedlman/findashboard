import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import TickerLogo from '../TickerLogo'
import ShellActions from '../ShellActions'
import { MONO, SANS, BRIGHT } from './ui'

/** The page's single title. The route used to carry both a "Company Profile"
 *  page header and this identity row, which is two title bars saying the same
 *  thing: the name of the company IS the title of the page. */
export default function IdentityBar({ ticker, right }: {
  ticker: string
  right?: React.ReactNode
}) {
  const q = useQuery<{ name?: string; sector?: string; industry?: string }>({
    queryKey: ['cp-profile', ticker],
    queryFn: () => axios.get(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const p = q.data ?? {}

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      paddingBottom: 12, marginBottom: 16,
      borderBottom: '1px solid color-mix(in srgb, var(--theme-primary) 45%, transparent)',
    }}>
      <TickerLogo ticker={ticker} size={32} />
      <span style={{
        fontFamily: MONO, fontSize: 21, fontWeight: 700, letterSpacing: '0.02em', color: T.gold,
      }}>
        {ticker}
      </span>
      <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: BRIGHT }}>
        {p.name ?? ''}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {p.sector && <Tag>{p.sector}</Tag>}
        {p.industry && <Tag>{p.industry}</Tag>}
      </div>
      {/* The shell cluster rides here rather than in a PageHeader. Dropping the
          page header to remove the duplicate title also dropped Settings and
          Send to Report with it, which are page chrome and belong on every
          view, ticker loaded or not. */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {right}
        <ShellActions />
      </div>
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, padding: '2px 7px',
      border: `1px solid ${T.border}`, color: T.muted, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}
