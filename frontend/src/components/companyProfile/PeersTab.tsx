import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import EmptyState from '../EmptyState'
import { Panel, MONO, SANS, BRIGHT, ROW_LINE, STRIP } from './ui'
import { DASH, multiple, ratePct, tone } from './format'

interface Peer {
  ticker?: string; name?: string; is_target?: boolean
  pe?: number | null; forward_pe?: number | null; ev_ebitda?: number | null
  ps?: number | null; pb?: number | null; peg?: number | null
  revenue_growth?: number | null; roe?: number | null
}

const median = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export default function PeersTab({ ticker }: { ticker: string }) {
  const q = useQuery<{ peers?: Peer[]; sector?: string }>({
    queryKey: ['cp-peers', ticker],
    queryFn: () => axios.get(`/api/corporate/peer-valuation?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const peers = q.data?.peers ?? []
  if (!q.isLoading && !peers.length) {
    return (
      <EmptyState
        title="Peers and comps"
        hint="No peer set resolved for this symbol. Peers are drawn from the industry classification, so a name with no classified peers returns nothing."
      />
    )
  }

  // The subject is excluded from its own comparison. A median that includes the
  // name being measured against it is self-referential, and on a short list it
  // pulls the median toward the very number the reader is checking.
  const comps = peers.filter(p => !p.is_target)
  const med = {
    pe: median(comps.map(p => p.pe)),
    forward_pe: median(comps.map(p => p.forward_pe)),
    ev_ebitda: median(comps.map(p => p.ev_ebitda)),
    ps: median(comps.map(p => p.ps)),
    revenue_growth: median(comps.map(p => p.revenue_growth)),
  }

  const cols = ['Trailing P/E', 'Forward P/E', 'EV / EBITDA', 'Price / sales', 'Revenue growth']

  return (
    <Panel
      title="Peers and comps"
      meta={`Same industry classification, ${comps.length} peers`}
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 220 }}>Name</th>
              {cols.map(c => <th key={c} style={th}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {peers.map(p => (
              <PeerRow key={p.ticker} p={p} subject={!!p.is_target} />
            ))}
            <tr style={{ borderBottom: ROW_LINE, background: 'rgba(255,255,255,0.022)' }}>
              <td style={{ ...td, textAlign: 'left' }}>
                <span style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: 600, color: T.muted }}>
                  Peer median, n={comps.length}
                </span>
              </td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.pe, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.forward_pe, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.ev_ebitda, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.ps, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{ratePct(med.revenue_growth, 1, true)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{
        padding: '10px 16px', borderTop: `1px solid ${T.borderFaint}`,
        fontFamily: MONO, fontSize: 10, color: T.muted,
      }}>
        Peers are drawn from the industry classification, not a curated comp set.
        Market cap and gross margin are not carried by this source.
      </div>
    </Panel>
  )
}

function PeerRow({ p, subject }: { p: Peer; subject: boolean }) {
  return (
    <tr style={{
      borderBottom: ROW_LINE,
      background: subject ? 'color-mix(in srgb, var(--theme-primary) 8%, transparent)' : 'transparent',
    }}>
      <td style={{ ...td, textAlign: 'left' }}>
        <span style={{
          fontFamily: MONO, fontSize: 12.5, fontWeight: 700, letterSpacing: '0.04em',
          color: subject ? T.gold : BRIGHT,
        }}>
          {p.ticker ?? DASH}
        </span>
        <span style={{ fontFamily: SANS, fontSize: 11, color: T.muted, marginLeft: 9 }}>
          {p.name ?? ''}
        </span>
      </td>
      {/* A negative trailing multiple is not a multiple. It prints as an
          em-dash rather than a negative number, a zero, or a hidden row. */}
      <td style={cell(subject)}>{p.pe != null && p.pe > 0 ? multiple(p.pe, 1) : DASH}</td>
      <td style={cell(subject)}>{p.forward_pe != null && p.forward_pe > 0 ? multiple(p.forward_pe, 1) : DASH}</td>
      <td style={cell(subject)}>{p.ev_ebitda != null && p.ev_ebitda > 0 ? multiple(p.ev_ebitda, 1) : DASH}</td>
      <td style={cell(subject)}>{multiple(p.ps, 1)}</td>
      <td style={{ ...cell(subject), color: tone(p.revenue_growth) }}>
        {ratePct(p.revenue_growth, 1, true)}
      </td>
    </tr>
  )
}

const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.muted, textAlign: 'right',
  padding: '11px 14px', whiteSpace: 'nowrap',
  background: STRIP, borderBottom: `1px solid ${T.border}`,
}

const td: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap',
  fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums',
}

const cell = (subject: boolean): React.CSSProperties => ({
  ...td,
  color: subject ? BRIGHT : T.text,
})
