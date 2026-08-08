import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import EmptyState from './EmptyState'

// The facts panel under the Global Markets chart.
//
// Split in two on purpose. The top half is derived from the asset's own price
// history, so it renders for every row on the board — an index, a currency
// pair, a barrel of crude. The bottom half needs a member list, which only
// exists for the indices the backend tracks, and says so plainly when it does
// not rather than showing an empty table that reads like a failed request.

const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'
const GOLD = 'var(--theme-primary, #c9a84c)'
const POS = 'var(--theme-positive, #3fb6a0)'
const NEG = 'var(--theme-negative, #cf4b3f)'
const SEC = 'var(--theme-secondary, #8099b0)'
const TXT = 'var(--theme-text, #d7e3fc)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const FAINT = 'var(--theme-border-faint, rgba(255,255,255,0.05))'

interface Member { ticker: string; name: string; sector: string | null; price: number | null; change_pct: number | null; market_cap_usd: number | null; weight_pct: number | null }
interface Sector { sector: string; weight_pct: number; count: number; change_pct: number | null }
interface Constituents {
  available: boolean
  reason?: string
  weighting?: 'cap' | 'price'
  currency?: string | null
  as_of?: string
  source?: string
  note?: string | null
  coverage?: { listed: number; priced: number }
  total_market_cap_usd?: number | null
  breadth?: { advancing: number; declining: number; unchanged: number; priced: number }
  concentration?: { top5_pct: number | null; top10_pct: number | null }
  members?: Member[]
  sectors?: Sector[]
  leaders?: Member[]
  laggards?: Member[]
}
interface Stats {
  last: number
  as_of: string
  returns: Record<string, number | null>
  changes_abs: Record<string, number | null>
  range_52w: { low: number | null; high: number | null; position_pct: number | null; from_high_pct: number | null; from_low_pct: number | null }
  vol_30d: number | null
  max_drawdown_1y: number | null
  vs_benchmark: { benchmark: string; benchmark_label: string; correlation: number; beta: number; correlation_lag_days: number; session_offset: boolean } | null
}
interface StatsResponse { ticker: string; stats: Stats | null }
interface ConstituentsResponse { ticker: string; constituents: Constituents }

const RETURN_ORDER: { key: string; label: string }[] = [
  { key: '1w', label: '1W' }, { key: '1m', label: '1M' }, { key: '3m', label: '3M' },
  { key: '6m', label: '6M' }, { key: 'ytd', label: 'YTD' }, { key: '1y', label: '1Y' },
  { key: '3y', label: '3Y' }, { key: '5y', label: '5Y' },
]

const num = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 2 })
const signed = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
const tone = (v: number | null | undefined) => (v == null ? SEC : v >= 0 ? POS : NEG)

/** Caps span six orders of magnitude across one index, so a fixed unit either
 *  loses the small names or prints twelve digits for the big ones. */
function cap(v: number | null): string {
  if (!v) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}

const eyebrow: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: SEC,
}

function Section({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${BORDER}` }}>
      <div className="ft-chart-label" style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span>{title}</span>
        {meta && <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, letterSpacing: '0.04em', textTransform: 'none', fontWeight: 400 }}>{meta}</span>}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  )
}

// ── 52-week range ────────────────────────────────────────────────────────────
function RangeBar({ range, yields }: { range: Stats['range_52w']; yields?: boolean }) {
  const { low, high, position_pct: pos } = range
  if (low == null || high == null) return null
  const unit = yields ? '%' : ''
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 11, color: TXT, fontVariantNumeric: 'tabular-nums' }}>
        <span>{num(low)}{unit}</span>
        <span>{num(high)}{unit}</span>
      </div>
      <div style={{ position: 'relative', height: 4, background: FAINT, margin: '7px 0 6px' }}>
        {pos != null && (
          <>
            <div style={{ position: 'absolute', inset: 0, width: `${Math.max(0, Math.min(100, pos))}%`, background: 'color-mix(in srgb, var(--theme-primary) 34%, transparent)' }} />
            <div style={{ position: 'absolute', top: -3, left: `${Math.max(0, Math.min(100, pos))}%`, width: 2, height: 10, background: GOLD, transform: 'translateX(-1px)' }} />
          </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: SANS, fontSize: 10, color: SEC }}>
        <span>52-week low</span>
        <span style={{ color: TXT }}>
          {pos != null ? `${pos.toFixed(0)}% of the band` : ''}
          {range.from_high_pct != null && <span style={{ color: SEC }}> · {signed(range.from_high_pct, 1)} from high</span>}
        </span>
        <span>high</span>
      </div>
    </div>
  )
}

// ── Return ladder + realised risk ────────────────────────────────────────────
function StatGrid({ stats, yields }: { stats: Stats; yields?: boolean }) {
  const cells = RETURN_ORDER.filter(r => stats.returns?.[r.key] != null)
  // A yield going 4.00 to 4.66 has not returned 16%, it has risen 66 basis
  // points. Same payload, the reading that matches the instrument.
  const value = (key: string) => {
    if (!yields) return signed(stats.returns[key], 1)
    const abs = stats.changes_abs?.[key]
    return abs == null ? '—' : `${abs >= 0 ? '+' : ''}${Math.round(abs * 100)} bp`
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
      {cells.map((r, i) => (
        <div key={r.key} style={{ flex: '1 1 62px', minWidth: 62, padding: '2px 10px', borderLeft: i ? `1px solid ${FAINT}` : 'none' }}>
          <div style={{ ...eyebrow, fontSize: 8.5, marginBottom: 4 }}>{r.label}</div>
          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: tone(yields ? stats.changes_abs?.[r.key] : stats.returns[r.key]), fontVariantNumeric: 'tabular-nums' }}>
            {value(r.key)}
          </div>
        </div>
      ))}
    </div>
  )
}

function RiskRow({ stats, label }: { stats: Stats; label: string }) {
  const vs = stats.vs_benchmark
  const items: [string, string, string?][] = []
  if (stats.vol_30d != null) items.push(['30d volatility', `${stats.vol_30d.toFixed(1)}%`])
  if (stats.max_drawdown_1y != null) items.push(['Deepest 1y fall', `${stats.max_drawdown_1y.toFixed(1)}%`, NEG])
  if (vs) {
    items.push([`Beta vs ${vs.benchmark_label}`, vs.beta.toFixed(2)])
    items.push([vs.session_offset ? 'Correlation, lagged' : 'Correlation', vs.correlation.toFixed(2)])
  }
  if (!items.length) return null
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
        {items.map(([itemLabel, value, color], i) => (
          <div key={itemLabel} style={{ flex: '1 1 110px', minWidth: 110, padding: '2px 10px', borderLeft: i ? `1px solid ${FAINT}` : 'none' }}>
            <div style={{ ...eyebrow, fontSize: 8.5, marginBottom: 4 }}>{itemLabel}</div>
            <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: color ?? TXT, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>
      {vs?.session_offset && (
        // Without this the reader is left to reconcile a huge volatility number
        // with a small beta, and the reason is a clock, not the market.
        <div style={{ marginTop: 11, paddingTop: 9, borderTop: `1px solid ${FAINT}`, fontFamily: SANS, fontSize: 10.5, lineHeight: 1.5, color: SEC }}>
          {label} closes before {vs.benchmark_label} does, so a same-day comparison misses the link.
          Beta is corrected for the session offset, and the correlation is against the previous {vs.benchmark_label} session.
        </div>
      )}
    </>
  )
}

// ── Constituents ─────────────────────────────────────────────────────────────
function Breadth({ b }: { b: NonNullable<Constituents['breadth']> }) {
  const total = b.priced || 1
  const upPct = (b.advancing / total) * 100
  const downPct = (b.declining / total) * 100
  return (
    <div>
      <div style={{ display: 'flex', height: 4, background: FAINT, overflow: 'hidden' }}>
        <div style={{ width: `${upPct}%`, background: POS }} />
        <div style={{ width: `${100 - upPct - downPct}%`, background: 'transparent' }} />
        <div style={{ width: `${downPct}%`, background: NEG }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: MONO, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: POS }}>{b.advancing} advancing</span>
        <span style={{ color: SEC }}>{b.unchanged ? `${b.unchanged} flat` : ''}</span>
        <span style={{ color: NEG }}>{b.declining} declining</span>
      </div>
    </div>
  )
}

function MoverList({ title, rows }: { title: string; rows: Member[] }) {
  if (!rows.length) return null
  return (
    <div style={{ flex: '1 1 190px', minWidth: 170 }}>
      <div style={{ ...eyebrow, marginBottom: 7 }}>{title}</div>
      {rows.map(r => (
        <div key={r.ticker} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: TXT, flex: 'none' }}>{r.ticker.split('.')[0]}</span>
          <span style={{ fontFamily: SANS, fontSize: 10, color: SEC, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, fontWeight: 700, color: tone(r.change_pct), flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
            {signed(r.change_pct, 2)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Weight bars per sector. Long tails get rolled up rather than printed: the
 *  FTSE publishes forty-four buckets and a chart of forty-four bars is a list
 *  with extra steps. */
function SectorMix({ rows }: { rows: Sector[] }) {
  const [all, setAll] = useState(false)
  const top = all ? rows : rows.slice(0, 8)
  const rest = all ? [] : rows.slice(8)
  const restWeight = rest.reduce((sum, r) => sum + r.weight_pct, 0)
  const widest = Math.max(...rows.map(r => r.weight_pct), 1)
  return (
    <div>
      {top.map(r => (
        <div key={r.sector} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
          <span style={{ fontFamily: SANS, fontSize: 11, color: TXT, width: 150, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sector}</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: SEC, width: 26, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.count}</span>
          <span style={{ flex: 1, minWidth: 40, height: 6, background: FAINT }}>
            <span style={{ display: 'block', width: `${(r.weight_pct / widest) * 100}%`, height: '100%', background: 'color-mix(in srgb, var(--theme-primary) 55%, transparent)' }} />
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: TXT, width: 48, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.weight_pct.toFixed(1)}%</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: tone(r.change_pct), width: 52, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{signed(r.change_pct, 2)}</span>
        </div>
      ))}
      {rest.length > 0 && (
        <button onClick={() => setAll(true)}
          style={{ marginTop: 7, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontFamily: SANS, fontSize: 10, color: SEC, textAlign: 'left' }}>
          {rest.length} more sectors, {restWeight.toFixed(1)}% of market cap
        </button>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  ...eyebrow, fontSize: 8.5, padding: '0 10px 7px', textAlign: 'right', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontFamily: MONO, fontSize: 11, padding: '5px 10px', textAlign: 'right',
  color: TXT, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

function Members({ rows, weighting }: { rows: Member[]; weighting?: 'cap' | 'price' }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 12)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Company</th>
            <th style={{ ...th, textAlign: 'left' }}>Sector</th>
            <th style={th}>Price</th>
            <th style={th}>1D</th>
            <th style={th}>Market cap</th>
            {weighting === 'cap' && <th style={th}>Share</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map(r => (
            <tr key={r.ticker} style={{ borderTop: `1px solid ${FAINT}` }}>
              <td style={{ ...td, textAlign: 'left', maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ fontWeight: 700 }}>{r.ticker.split('.')[0]}</span>
                <span style={{ fontFamily: SANS, fontSize: 10, color: SEC, marginLeft: 7 }}>{r.name}</span>
              </td>
              <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontSize: 10, color: SEC, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sector ?? '—'}</td>
              <td style={td}>{r.price == null ? '—' : num(r.price)}</td>
              <td style={{ ...td, color: tone(r.change_pct) }}>{signed(r.change_pct, 2)}</td>
              <td style={td}>{cap(r.market_cap_usd)}</td>
              {weighting === 'cap' && <td style={{ ...td, color: SEC }}>{r.weight_pct == null ? '—' : `${r.weight_pct.toFixed(2)}%`}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 12 && (
        <button onClick={() => setAll(v => !v)}
          style={{ marginTop: 9, background: 'none', border: `1px solid ${BORDER}`, color: SEC, cursor: 'pointer',
            fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 12px' }}>
          {all ? 'Show top 12' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────────
export default function AssetFacts({ ticker, label, yields }: { ticker: string; label: string; yields?: boolean }) {
  // Two requests, not one. The stats land in about a second; pricing the S&P's
  // 500 members takes Yahoo fifteen. Behind one request the range and the
  // return ladder would wait on the member table for no reason.
  const statsQ = useQuery<StatsResponse>({
    queryKey: ['asset-stats', ticker],
    queryFn: () => axios.get('/api/market/asset-profile', { params: { ticker } }).then(r => r.data),
    staleTime: 10 * 60_000,
    retry: 0,
  })
  const constQ = useQuery<ConstituentsResponse>({
    queryKey: ['index-constituents', ticker],
    queryFn: () => axios.get('/api/market/index-constituents', { params: { ticker } }).then(r => r.data),
    staleTime: 25 * 60_000,
    retry: 0,
  })

  const c = constQ.data?.constituents
  const stats = statsQ.data?.stats
  // A price-weighted index is moved by its highest-priced share, not its
  // biggest company, so the member table is ordered by cap but the caption has
  // to say which of the two the reader is looking at.
  const weightNote = useMemo(() => {
    if (!c?.available) return null
    if (c.weighting === 'price') return 'Price weighted, so share of market cap is context, not influence'
    return 'Cap weighted'
  }, [c])

  if (statsQ.isLoading && constQ.isLoading) {
    return <div style={{ padding: 20 }}><EmptyState variant="loading" size="compact" title={`Loading ${label} detail`} /></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px 16px' }}>
      {statsQ.isError && (
        <div style={{ padding: '4px 0', fontFamily: SANS, fontSize: 11, color: SEC }}>
          Range and performance are unavailable for this asset right now.
        </div>
      )}
      {stats && (
        <>
          <Section title="52-week range">
            <RangeBar range={stats.range_52w} yields={yields} />
          </Section>
          <Section title="Performance">
            <StatGrid stats={stats} yields={yields} />
          </Section>
          <Section title={yields ? 'Level statistics' : 'Risk'}>
            <RiskRow stats={stats} label={label} />
          </Section>
        </>
      )}

      {constQ.isLoading && (
        <Section title="Constituents">
          <EmptyState variant="loading" size="compact" title="Pricing the members" />
        </Section>
      )}

      {c?.available ? (
        <>
          <Section
            title="Constituents"
            meta={`${c.coverage?.priced ?? 0} of ${c.coverage?.listed ?? 0} priced · ${weightNote} · list from Wikipedia, ${c.as_of}`}>
            {c.note && <div style={{ fontFamily: SANS, fontSize: 11, color: SEC, lineHeight: 1.5, marginBottom: 11 }}>{c.note}</div>}
            {c.breadth && <Breadth b={c.breadth} />}
            {c.concentration?.top5_pct != null && (
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 11, fontFamily: MONO, fontSize: 11, color: SEC, fontVariantNumeric: 'tabular-nums' }}>
                <span>Top 5 <span style={{ color: TXT, fontWeight: 700 }}>{c.concentration.top5_pct}%</span> of market cap</span>
                {c.concentration.top10_pct != null && <span>Top 10 <span style={{ color: TXT, fontWeight: 700 }}>{c.concentration.top10_pct}%</span></span>}
                {c.total_market_cap_usd != null && <span>Total <span style={{ color: TXT, fontWeight: 700 }}>{cap(c.total_market_cap_usd)}</span></span>}
              </div>
            )}
          </Section>

          {(c.leaders?.length || c.laggards?.length) && (
            <Section title="Today's movers">
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <MoverList title="Leaders" rows={c.leaders ?? []} />
                <MoverList title="Laggards" rows={c.laggards ?? []} />
              </div>
            </Section>
          )}

          {!!c.sectors?.length && (
            <Section title="Sector mix" meta={`${c.sectors.length} sectors · the index's own classification`}>
              <SectorMix rows={c.sectors} />
            </Section>
          )}

          <Section title="Holdings by market cap">
            <Members rows={c.members ?? []} weighting={c.weighting} />
          </Section>
        </>
      ) : c?.reason ? (
        <Section title="Constituents">
          <div style={{ fontFamily: SANS, fontSize: 11, color: SEC, lineHeight: 1.5 }}>{c.reason}</div>
        </Section>
      ) : constQ.isError ? (
        <Section title="Constituents">
          <div style={{ fontFamily: SANS, fontSize: 11, color: SEC, lineHeight: 1.5 }}>
            The member list did not load. Close and reopen to retry.
          </div>
        </Section>
      ) : null}
    </div>
  )
}
