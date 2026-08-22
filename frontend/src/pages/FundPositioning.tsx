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
  kind?: string | null; kindBasis?: string | null; kindShare?: number | null
  kindMissing?: string | null
  comparedTo: string | null; positions: number; filingRows: number; totalValue: number
  quarters: { accession: string; period: string; amended: boolean }[]
  rows: Row[]; exited: Row[]; unmapped: number
}
interface Manager {
  cik: string; name: string; latest?: string; quarters?: number; value?: number
  kind?: string | null; kindBasis?: string | null; kindShare?: number | null
  kindMissing?: string | null; kindSource?: string | null
}

// From the adviser's own Form ADV, joined on the CRD its cover page carries.
// Managers without a CRD show no chip at all, because the alternative is
// guessing a firm's type from its name.
const KIND_TONE: Record<string, string> = {
  'Hedge fund': '#c084fc',
  'Private equity': '#a78bfa',
  'Venture capital': '#e879f9',
  'Private fund': '#c084fc',
  'Real estate fund': '#e0864a',
  'Securitized assets': '#e0864a',
  'Liquidity fund': '#38bdf8',
  'Asset manager': '#60a5fa',
  'Wealth manager': '#3fb37f',
  'Institutional': '#e0864a',
  'Sub-adviser': '#38bdf8',
  'Corporate': '#8b9bb4',
  'Other': '#8b9bb4',
}

// A label from the adviser's own Form ADV is a different claim from one implied
// by the act of filing, so they do not get to look identical: ADV is solid and
// coloured, the implied one is dashed and muted.
function KindChip({ kind, basis, share, missing, source }: {
  kind?: string | null; basis?: string | null; share?: number | null
  missing?: string | null; source?: string | null
}) {
  if (!kind) {
    // Absence is informative and worth showing quietly. Forty-two of the fifty
    // largest filers are holding companies reporting for their subsidiaries,
    // with no adviser registration to join on at all.
    if (!missing) return null
    return (
      <span title={missing === 'not a registered adviser'
        ? 'This filing carries no adviser registration number. The largest 13F filers are holding companies reporting for their subsidiaries, and are not themselves registered advisers.'
        : 'This adviser registered after the Form ADV archive ends, so it has no registration on record here.'}
        style={{ fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: mix(T.muted, 70), border: `1px solid ${T.borderFaint}`,
          padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {missing === 'not a registered adviser' ? 'no ADV' : 'ADV n/a'}
      </span>
    )
  }
  // A label from the adviser's own filing and one from SEC's registrant code are
  // different claims. The first describes an investment mandate, the second the
  // filing entity, so they do not get to look identical.
  const fromAdv = source === 'adv'
  const c = fromAdv ? (KIND_TONE[kind] ?? T.muted) : T.muted
  const title = fromAdv
    ? (share != null ? `Form ADV: ${Math.round(share)}% ${basis}` : `Form ADV: ${basis}`)
    : `No adviser registration on this filing, so no finer type is available. ${basis}.`
  return (
    <span title={title}
      style={{ fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: c,
        border: `1px ${fromAdv ? 'solid' : 'dashed'} ${mix(c, 40)}`,
        background: fromAdv ? mix(c, 10) : 'transparent',
        padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>
      {kind}
    </span>
  )
}
interface Holders {
  ticker: string; asOf: string | null; comparedTo?: string | null
  source?: string; holderCount?: number; filersTotal?: number; unmapped?: boolean
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
              placeholder="Search 10,000 filers" aria-label="Search managers"
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                    <KindChip kind={m.kind} basis={m.kindBasis} share={m.kindShare} missing={m.kindMissing} source={m.kindSource} />
                    {m.latest && <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>
                      {m.latest}{m.value ? ` · ${money(m.value)}` : ''}
                    </span>}
                  </div>
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
            Every filer that reported this name, biggest position first, from SEC's quarterly dataset.
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
            ? `${(holders.data.holderCount ?? 0).toLocaleString()} of ${(holders.data.filersTotal ?? 0).toLocaleString()} filers · ${holders.data.asOf}`
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
                    sub: b.kind ? (b.kindShare != null
                        ? `${b.kind} · ${Math.round(b.kindShare)}% ${b.kindBasis}`
                        : `${b.kind} · ${b.kindBasis}`)
                      : b.kindMissing ? `CIK ${b.cik} · ${b.kindMissing}` : `CIK ${b.cik}` },
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
              hint={`Looking up every filer that reported ${ticker}.`} />}
            {!holders.isLoading && holders.data && holders.data.holders.length === 0 && (
              <EmptyState title="Not reported" variant="empty"
                hint={holders.data.unmapped
                  ? `No security in the dataset maps to ${ticker}. SEC identifies holdings by CUSIP, and the ticker map covers the names institutions hold in size.`
                  : `No filer reported ${ticker} for the ${holders.data.asOf} quarter.`} />
            )}
            {!holders.isLoading && holders.data && holders.data.holders.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: SANS, fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
                {(holders.data.holderCount ?? 0).toLocaleString()} filers reported {ticker} for{' '}
                {holders.data.asOf}, measured against {holders.data.comparedTo ?? 'no earlier quarter'}.
                Showing the {holders.data.holders.length} largest.
              </div>
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
