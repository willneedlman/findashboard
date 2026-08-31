import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { X } from 'lucide-react'
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

const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/
const key = (subject: string) => `cp_peers_${subject.toUpperCase()}`

/** Added peers persist per subject. A comp set is a piece of research, and
 *  retyping it on every visit is the reason nobody keeps one. */
function readAdded(subject: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(subject)) || '[]')
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch { return [] }
}
function writeAdded(subject: string, list: string[]) {
  try { localStorage.setItem(key(subject), JSON.stringify(list)) } catch { /* private mode */ }
}

export default function PeersTab({ ticker }: { ticker: string }) {
  const [added, setAdded] = useState<string[]>(() => readAdded(ticker))
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')

  const q = useQuery<{ peers?: Peer[]; sector?: string }>({
    queryKey: ['cp-peers', ticker],
    queryFn: () => axios.get(`/api/corporate/peer-valuation?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  // Each added symbol is looked up as its own subject and its self row taken,
  // which is the same shape and the same source as the resolved peers.
  const extra = useQueries({
    queries: added.map(sym => ({
      queryKey: ['cp-peers', sym],
      queryFn: () => axios.get(`/api/corporate/peer-valuation?ticker=${encodeURIComponent(sym)}`).then(r => r.data),
      staleTime: 300_000, retry: 0,
    })),
  })

  const resolved = q.data?.peers ?? []

  const addedRows = useMemo<Peer[]>(() => extra.map((r, i) => {
    const rows: Peer[] = (r.data as { peers?: Peer[] } | undefined)?.peers ?? []
    const self = rows.find(x => x.is_target) ?? rows.find(x => x.ticker === added[i])
    return self ? { ...self, is_target: false } : { ticker: added[i], name: r.isLoading ? 'Loading' : 'No data' }
  }), [extra, added])

  const seen = new Set(resolved.map(p => p.ticker))
  const rows = [...resolved, ...addedRows.filter(p => p.ticker && !seen.has(p.ticker))]

  const add = () => {
    const s = draft.trim().toUpperCase()
    if (!s) return
    if (!SYM.test(s)) return setErr('Not a valid symbol')
    if (s === ticker.toUpperCase()) return setErr('That is the subject of this page')
    if (rows.some(p => p.ticker === s)) return setErr(`${s} is already in the table`)
    const next = [...added, s]
    setAdded(next); writeAdded(ticker, next); setDraft(''); setErr('')
  }
  const remove = (sym: string) => {
    const next = added.filter(s => s !== sym)
    setAdded(next); writeAdded(ticker, next)
  }

  if (!q.isLoading && !rows.length) {
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
  const comps = rows.filter(p => !p.is_target)
  const med = {
    pe: median(comps.map(p => p.pe)),
    forward_pe: median(comps.map(p => p.forward_pe)),
    peg: median(comps.map(p => p.peg)),
    ev_ebitda: median(comps.map(p => p.ev_ebitda)),
    ps: median(comps.map(p => p.ps)),
    revenue_growth: median(comps.map(p => p.revenue_growth)),
  }

  const cols = ['Trailing P/E', 'Forward P/E', 'PEG', 'EV / EBITDA', 'Price / sales', 'Revenue growth']

  return (
    <Panel
      title="Peers and comps"
      meta={`${comps.length} peers${added.length ? `, ${added.length} added` : ''}`}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '10px 16px', borderBottom: `1px solid ${T.borderFaint}`,
      }}>
        <span style={{
          fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.muted,
        }}>
          Add a peer
        </span>
        <input
          value={draft}
          onChange={e => { setDraft(e.target.value.toUpperCase()); setErr('') }}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder="Ticker"
          aria-label="Add a peer by ticker"
          style={{
            width: 108, height: 27, padding: '0 9px',
            fontFamily: MONO, fontSize: 11.5, letterSpacing: '0.04em',
            color: BRIGHT, background: T.bg,
            border: `1px solid ${T.border}`, outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          style={{
            fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
            textTransform: 'uppercase', padding: '6px 11px',
            cursor: draft.trim() ? 'pointer' : 'not-allowed', opacity: draft.trim() ? 1 : 0.4,
            color: T.gold, background: 'color-mix(in srgb, var(--theme-primary) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--theme-primary) 45%, transparent)',
          }}
        >
          Add
        </button>
        {err && (
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--theme-negative)' }}>{err}</span>
        )}
        {added.length > 0 && (
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: T.muted }}>
            Added peers are kept for {ticker} on this device
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 220 }}>Name</th>
              {cols.map(c => <th key={c} style={th}>{c}</th>)}
              <th style={{ ...th, width: 34 }} aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <PeerRow
                key={p.ticker}
                p={p}
                subject={!!p.is_target}
                onRemove={p.ticker && added.includes(p.ticker) ? () => remove(p.ticker!) : undefined}
              />
            ))}
            <tr style={{ borderBottom: ROW_LINE, background: 'rgba(255,255,255,0.022)' }}>
              <td style={{ ...td, textAlign: 'left' }}>
                <span style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: 600, color: T.muted }}>
                  Peer median, n={comps.length}
                </span>
              </td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.pe, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.forward_pe, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.peg, 2)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.ev_ebitda, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{multiple(med.ps, 1)}</td>
              <td style={{ ...td, color: T.muted }}>{ratePct(med.revenue_growth, 1, true)}</td>
              <td style={td} />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{
        padding: '10px 16px', borderTop: `1px solid ${T.borderFaint}`,
        fontFamily: MONO, fontSize: 10, color: T.muted,
      }}>
        Peers are drawn from the industry classification, not a curated comp set.
        The median covers every row above it, added peers included.
        Market cap and gross margin are not carried by this source.
      </div>
    </Panel>
  )
}

function PeerRow({ p, subject, onRemove }: { p: Peer; subject: boolean; onRemove?: () => void }) {
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
        {onRemove && (
          <span style={{
            fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: T.muted, marginLeft: 9,
          }}>
            Added
          </span>
        )}
      </td>
      {/* A negative trailing multiple is not a multiple. It prints as an
          em-dash rather than a negative number, a zero, or a hidden row. */}
      <td style={cell(subject)}>{p.pe != null && p.pe > 0 ? multiple(p.pe, 1) : DASH}</td>
      <td style={cell(subject)}>{p.forward_pe != null && p.forward_pe > 0 ? multiple(p.forward_pe, 1) : DASH}</td>
      <td style={cell(subject)}>{p.peg != null && p.peg > 0 ? multiple(p.peg, 2) : DASH}</td>
      <td style={cell(subject)}>{p.ev_ebitda != null && p.ev_ebitda > 0 ? multiple(p.ev_ebitda, 1) : DASH}</td>
      <td style={cell(subject)}>{multiple(p.ps, 1)}</td>
      <td style={{ ...cell(subject), color: tone(p.revenue_growth) }}>
        {ratePct(p.revenue_growth, 1, true)}
      </td>
      <td style={{ ...td, padding: '10px 8px' }}>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${p.ticker} from the comp set`}
            style={{
              display: 'inline-flex', background: 'none', border: 'none',
              padding: 2, cursor: 'pointer', color: T.muted, lineHeight: 0,
            }}
          >
            <X size={12} />
          </button>
        )}
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
