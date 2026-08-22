import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Search } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { useTickerParam } from '../hooks/useTickerParam'
import { T } from '../lib/theme'
import { MONO, SANS, mix, seg, KpiStrip } from './cockpitKit'

// What institutions reported holding, from 13F filings.
//
// The whole surface is built around one caveat: a 13F is a QUARTERLY SNAPSHOT
// filed up to 45 days late, so the change columns are a diff between two
// snapshots and not a record of trades. Every screen states its as-of date and
// the quarter it is measured against, and an exit reads "no longer reported"
// rather than "sold", because the filing cannot tell those apart.

interface Row {
  cusip: string; ticker: string | null; issuer: string; class: string | null
  value: number; weight: number | null; shares: number
  calls: number | null; puts: number | null
  sharesChange: number | null; pctChange: number | null; pctOutstanding: number | null
  status: 'new' | 'added' | 'trimmed' | 'held' | 'exited'
}
interface Book {
  manager: string; cik: string; period: string; filed: string; amended: boolean
  comparedTo: string | null; positions: number; filingRows: number; totalValue: number
  quarters: { accession: string; period: string; amended: boolean }[]
  rows: Row[]; exited: Row[]; unmapped: number
}
interface Manager { cik: string; name: string; latest?: string; quarters?: number }
interface Holders {
  ticker: string; scanned: number; trackedTotal: number; asOf: string | null
  warming: boolean
  holders: (Row & { manager: string; cik: string; period: string })[]
}

const money = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${v.toFixed(0)}`
}
const num = (v: number | null | undefined, d = 0) =>
  (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d }))
const pct = (v: number | null | undefined, d = 2) =>
  (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`)

const STATUS: Record<string, { label: string; color: () => string }> = {
  new:     { label: 'NEW',     color: () => T.pos },
  added:   { label: 'ADD',     color: () => T.pos },
  trimmed: { label: 'TRIM',    color: () => T.neg },
  held:    { label: 'HOLD',    color: () => T.muted },
  exited:  { label: 'EXITED',  color: () => T.neg },
}

type Mode = 'firm' | 'ticker'
type SortKey = 'value' | 'weight' | 'sharesChange' | 'pctChange' | 'pctOutstanding'

export default function FundPositioning() {
  const [mode, setMode] = useState<Mode>('firm')
  const [query, setQuery] = useState('')
  const [cik, setCik] = useState('1067983')          // Berkshire, a book everyone can check
  const [accession, setAccession] = useState<string | null>(null)
  const [ticker, setTicker] = useState('AAPL')
  const [draft, setDraft] = useState('AAPL')
  const [sort, setSort] = useState<SortKey>('value')
  useTickerParam(sym => { setMode('ticker'); setTicker(sym.toUpperCase()); setDraft(sym.toUpperCase()) })

  const managers = useQuery<{ managers: Manager[] }>({
    queryKey: ['fund-managers', query],
    queryFn: () => axios.get(`/api/funds/managers?q=${encodeURIComponent(query)}`).then(r => r.data),
    staleTime: 6 * 3600 * 1000,
  })

  const book = useQuery<Book>({
    queryKey: ['fund-book', cik, accession],
    queryFn: () => axios.get(`/api/funds/book?cik=${cik}${accession ? `&accession=${accession}` : ''}`)
      .then(r => r.data),
    enabled: mode === 'firm' && !!cik,
    staleTime: 6 * 3600 * 1000,
    retry: 1,
  })

  const holders = useQuery<Holders>({
    queryKey: ['fund-holders', ticker],
    queryFn: () => axios.get(`/api/funds/holders?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: mode === 'ticker' && !!ticker,
    staleTime: 6 * 3600 * 1000,
    retry: 1,
  })

  const rows = useMemo(() => {
    const b = book.data
    if (!b) return []
    const all = [...b.rows, ...b.exited]
    return [...all].sort((x, y) => {
      const a = (x[sort] as number | null) ?? -Infinity
      const c = (y[sort] as number | null) ?? -Infinity
      return sort === 'sharesChange' || sort === 'pctChange' ? c - a : c - a
    })
  }, [book.data, sort])

  const sidebar = (
    <div style={{ padding: 13 }}>
      <div style={{ display: 'flex', marginBottom: 12 }}>
        {([['firm', 'By firm'], ['ticker', 'By ticker']] as const).map(([k, label]) => (
          <div key={k} onClick={() => setMode(k)} style={seg(mode === k)}>{label}</div>
        ))}
      </div>

      {mode === 'firm' ? (
        <>
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: T.muted }} />
            <input value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search managers" aria-label="Search managers"
              className="ft-control" style={{ width: '100%', paddingLeft: 24, boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {(managers.data?.managers ?? []).map(m => {
              const on = m.cik.replace(/^0+/, '') === cik.replace(/^0+/, '')
              return (
                <button key={m.cik} onClick={() => { setCik(m.cik); setAccession(null) }}
                  style={{ textAlign: 'left', padding: '6px 8px', cursor: 'pointer',
                    background: on ? mix(T.gold, 14) : 'transparent',
                    border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.text,
                    fontFamily: SANS, fontSize: 11, lineHeight: 1.35 }}>
                  {m.name}
                  {m.latest && <div style={{ fontFamily: MONO, fontSize: 9, color: T.muted, marginTop: 2 }}>
                    {m.latest} · {m.quarters} quarters
                  </div>}
                </button>
              )
            })}
            {managers.isLoading && <div style={{ fontFamily: SANS, fontSize: 10.5, color: T.muted }}>Searching.</div>}
            {!managers.isLoading && (managers.data?.managers ?? []).length === 0 && query.length > 1 && (
              <div style={{ fontFamily: SANS, fontSize: 10.5, color: T.muted, lineHeight: 1.5 }}>
                No 13F filer matches that. EDGAR matches the start of a name, so try fewer words.
              </div>
            )}
          </div>

          {book.data?.quarters?.length ? (
            <>
              <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', color: T.muted, margin: '16px 0 6px' }}>Quarter</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {book.data.quarters.slice(0, 8).map(q => {
                  const on = accession ? q.accession === accession : q.period === book.data!.period
                  return (
                    <button key={q.accession} onClick={() => setAccession(q.accession)}
                      title={q.amended ? 'Amended filing' : undefined}
                      style={{ fontFamily: MONO, fontSize: 10, padding: '3px 7px', cursor: 'pointer',
                        background: on ? mix(T.gold, 14) : 'transparent',
                        border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.muted }}>
                      {q.period}{q.amended ? '/A' : ''}
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          <TickerInput value={draft} onChange={setDraft}
            onEnter={() => setTicker(draft.toUpperCase())}
            onSelect={s => { setTicker(s.toUpperCase()); setDraft(s.toUpperCase()) }}
            placeholder="Ticker" aria-label="Ticker"
            style={{ width: '100%', boxSizing: 'border-box' }} />
          <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, marginTop: 10, lineHeight: 1.55 }}>
            Which tracked managers reported this name. The filings carry no index from a security back
            to its holders, so this is the funds on the list, not every holder.
          </div>
        </>
      )}

      <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, marginTop: 16, lineHeight: 1.55,
        borderTop: `1px solid ${T.borderFaint}`, paddingTop: 10 }}>
        A 13F is a quarterly snapshot, filed up to 45 days after the quarter ends. Changes are a diff
        between two snapshots, not trades: a fund can buy and sell inside a quarter and show nothing.
        Long US equity only, so shorts, foreign listings and bonds never appear.
      </div>
    </div>
  )

  const b = book.data
  const th: React.CSSProperties = {
    textAlign: 'right', padding: '7px 10px', fontFamily: SANS, fontSize: 8.5, fontWeight: 700,
    letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted,
    borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
  }
  const td: React.CSSProperties = {
    textAlign: 'right', padding: '6px 10px', fontFamily: MONO, fontSize: 11,
    color: T.text, borderBottom: `1px solid ${T.borderFaint}`, whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  }
  const sortable = (k: SortKey, label: string) => (
    <th style={{ ...th, cursor: 'pointer', color: sort === k ? T.gold : T.muted }}
      onClick={() => setSort(k)}>{label}</th>
  )

  return (
    <PageWrapper>
      <PageHeader title="Fund Positioning"
        meta={mode === 'firm' && b
          ? `${b.period} · filed ${b.filed} · ${b.positions} positions`
          : mode === 'ticker' && holders.data
            ? `${holders.data.scanned} of ${holders.data.trackedTotal} tracked managers`
            : undefined} />
      <SidebarLayout sidebar={sidebar} sidebarTitle="Filings" sidebarWidth={252}>
        {mode === 'firm' && (
          <>
            {book.isLoading && <EmptyState title="Fund Positioning" variant="loading"
              hint="Reading the filing from SEC EDGAR and mapping its CUSIPs." />}
            {!book.isLoading && book.error && <EmptyState title="No filing" variant="unavailable"
              hint="No 13F on record for that filer. Managers under $100M do not file one." />}
            {!book.isLoading && b && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <KpiStrip cells={[
                  { label: 'Manager', value: b.manager?.length > 22 ? `${b.manager.slice(0, 22)}…` : b.manager,
                    sub: `CIK ${b.cik}` },
                  { label: 'Reported value', value: money(b.totalValue), sub: `${b.positions} positions` },
                  { label: 'As of', value: b.period, sub: `filed ${b.filed}${b.amended ? ' · amended' : ''}` },
                  { label: 'Compared to', value: b.comparedTo ?? '—',
                    sub: b.comparedTo ? 'previous quarter' : 'no earlier filing' },
                  { label: 'Filing rows', value: String(b.filingRows ?? '—'),
                    sub: 'aggregated by CUSIP' },
                ]} dense />

                <div style={{ border: `1px solid ${T.border}`, background: T.bg, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, background: T.bg }}>Ticker</th>
                        <th style={{ ...th, textAlign: 'left' }}>Company</th>
                        {sortable('value', 'Value')}
                        {sortable('weight', '% of book')}
                        <th style={th}>Shares</th>
                        {sortable('sharesChange', 'Chg in shares')}
                        {sortable('pctChange', '% change')}
                        {sortable('pctOutstanding', '% outstanding')}
                        <th style={{ ...th, textAlign: 'center' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => {
                        const st = STATUS[r.status] ?? STATUS.held
                        const chgColor = r.sharesChange == null ? T.muted
                          : r.sharesChange > 0 ? T.pos : r.sharesChange < 0 ? T.neg : T.muted
                        return (
                          <tr key={`${r.cusip}-${r.status}`}>
                            <td style={{ ...td, textAlign: 'left', fontWeight: 700,
                              color: r.ticker ? T.gold : T.muted, position: 'sticky', left: 0, background: T.bg }}>
                              {/* An unmapped CUSIP still shows: hiding the row would quietly
                                  shrink the book. */}
                              {r.ticker ?? r.cusip}
                            </td>
                            <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontSize: 11.5,
                              color: r.status === 'exited' ? T.muted : T.text }}>
                              {r.issuer}{r.class && r.class !== 'COM' ? ` · ${r.class}` : ''}
                            </td>
                            <td style={td}>{money(r.value)}</td>
                            <td style={td}>{pct(r.weight)}</td>
                            <td style={td}>{num(r.shares)}</td>
                            <td style={{ ...td, color: chgColor }}>
                              {r.sharesChange == null ? '—'
                                : `${r.sharesChange > 0 ? '+' : ''}${num(r.sharesChange)}`}
                            </td>
                            <td style={{ ...td, color: chgColor }}>
                              {r.pctChange == null ? '—' : `${r.pctChange > 0 ? '+' : ''}${pct(r.pctChange, 1)}`}
                            </td>
                            <td style={td}>{pct(r.pctOutstanding)}</td>
                            <td style={{ ...td, textAlign: 'center', fontSize: 9, fontWeight: 700,
                              letterSpacing: '0.08em', color: st.color() }}>{st.label}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, lineHeight: 1.6 }}>
                  EXITED means no longer reported. The filing cannot say whether a position was sold or
                  simply stopped being reportable.
                  {b.unmapped > 0 && ` ${b.unmapped} position${b.unmapped === 1 ? '' : 's'} show a CUSIP because no US listing maps to it.`}
                </div>
              </div>
            )}
          </>
        )}

        {mode === 'ticker' && (
          <>
            {holders.isLoading && <EmptyState title="Fund Positioning" variant="loading"
              hint={`Reading the tracked managers' latest filings for ${ticker}.`} />}
            {!holders.isLoading && holders.data && holders.data.holders.length === 0 && (
              <EmptyState title="Not reported" variant="empty"
                hint={holders.data.warming
                  ? `Read ${holders.data.scanned} of ${holders.data.trackedTotal} tracked managers so far, and none of those reported ${ticker}. The rest are still being built in the background.`
                  : `None of the ${holders.data.trackedTotal} tracked managers reported ${ticker} in their latest 13F.`} />
            )}
            {!holders.isLoading && holders.data && holders.data.holders.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {holders.data.warming && (
                // A partial answer must say it is partial, or an absent fund
                // reads as a fund that does not hold the name.
                <div style={{ fontFamily: SANS, fontSize: 10.5, color: T.warn, lineHeight: 1.5 }}>
                  {holders.data.scanned} of {holders.data.trackedTotal} tracked managers read so far.
                  The rest are being built in the background, so a fund missing here may simply not be
                  ready yet.
                </div>
              )}
              <div style={{ border: `1px solid ${T.border}`, background: T.bg, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left' }}>Manager</th>
                      <th style={th}>Value</th>
                      <th style={th}>% of their book</th>
                      <th style={th}>Shares</th>
                      <th style={th}>Chg in shares</th>
                      <th style={th}>% change</th>
                      <th style={{ ...th, textAlign: 'center' }}>Status</th>
                      <th style={th}>As of</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holders.data.holders.map(h => {
                      const st = STATUS[h.status] ?? STATUS.held
                      const c = h.sharesChange == null ? T.muted
                        : h.sharesChange > 0 ? T.pos : h.sharesChange < 0 ? T.neg : T.muted
                      return (
                        <tr key={h.cik}>
                          <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontSize: 11.5 }}>{h.manager}</td>
                          <td style={td}>{money(h.value)}</td>
                          <td style={td}>{pct(h.weight)}</td>
                          <td style={td}>{num(h.shares)}</td>
                          <td style={{ ...td, color: c }}>
                            {h.sharesChange == null ? '—' : `${h.sharesChange > 0 ? '+' : ''}${num(h.sharesChange)}`}
                          </td>
                          <td style={{ ...td, color: c }}>
                            {h.pctChange == null ? '—' : `${h.pctChange > 0 ? '+' : ''}${pct(h.pctChange, 1)}`}
                          </td>
                          <td style={{ ...td, textAlign: 'center', fontSize: 9, fontWeight: 700, color: st.color() }}>{st.label}</td>
                          <td style={{ ...td, color: T.muted }}>{h.period}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              </div>
            )}
          </>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}
