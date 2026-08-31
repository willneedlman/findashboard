import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import EmptyState from '../EmptyState'
import { Panel, MONO, SANS, BRIGHT, DIM, ROW_LINE, STRIP } from './ui'
import { DASH, compact, count, multiple, ratePct, tone } from './format'

interface Analyst {
  distribution?: { strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }
  total_analysts?: number | null
  recommendation_key?: string | null
  recommendation_mean?: number | null
  target_mean?: number | null; target_high?: number | null; target_low?: number | null
  price?: number | null; implied_upside?: number | null
}

interface GridRow {
  period: string; label: string
  avg?: number | null; low?: number | null; high?: number | null
  yearAgo?: number | null; analysts?: number | null; growth?: number | null
}
interface Surprise {
  quarter?: string; actual?: number | null; estimate?: number | null
  difference?: number | null; surprisePct?: number | null
}
interface Grid {
  available?: boolean; currency?: string
  eps?: GridRow[]; revenue?: GridRow[]; surprises?: Surprise[]; source?: string
}

interface Drift {
  period: string; label: string
  current?: number | null
  d7_pct?: number | null; d30_pct?: number | null; d90_pct?: number | null
}
interface Breadth { period: string; up_30d?: number | null; down_30d?: number | null }
interface Revisions {
  available?: boolean
  drift?: Drift[]; breadth?: Breadth[]
  targets?: { raises?: number; cuts?: number; maintains?: number; window_days?: number }
}

const GOLD = 'var(--theme-primary)'

/** The five-way recommendation spread, in the order a rating scale runs. */
const VOTES = [
  { key: 'strongBuy', label: 'Strong buy', color: GOLD },
  { key: 'buy', label: 'Buy', color: 'color-mix(in srgb, var(--theme-primary) 62%, transparent)' },
  { key: 'hold', label: 'Hold', color: 'var(--theme-chart-neutral, #4a7fa5)' },
  { key: 'sell', label: 'Sell', color: 'var(--theme-negative)' },
  { key: 'strongSell', label: 'Strong sell', color: 'var(--theme-negative)' },
] as const

export default function EstimatesTab({ ticker }: { ticker: string }) {
  const get = <R,>(path: string, key: string) => useQuery<R>({
    queryKey: [key, ticker],
    queryFn: () => axios.get(`/api/corporate/${path}?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const analyst = get<Analyst>('hub/analyst', 'cp-analyst')
  const grid = get<Grid>('estimates-grid', 'cp-estimates-grid')
  const rev = get<Revisions>('hub/estimates', 'cp-revisions')

  const a = analyst.data ?? {}
  const g = grid.data ?? {}
  const dist = a.distribution ?? {}
  const votes = VOTES.map(v => ({ ...v, n: dist[v.key] ?? 0 }))
  const maxVote = Math.max(...votes.map(v => v.n), 1)
  const hasConsensus = votes.some(v => v.n > 0) || a.target_mean != null

  if (!analyst.isLoading && !grid.isLoading && !hasConsensus && !g.eps?.length) {
    return (
      <EmptyState
        title="Estimates and analysts"
        hint="No analyst coverage published for this symbol. Expected for an ETF, a fund, or a name no sell-side desk models."
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))',
        gap: 20,
      }}>
        <Panel
          title="Analyst consensus"
          meta={a.total_analysts ? `n=${a.total_analysts}` : undefined}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <div style={{
            padding: '16px 18px 18px', flex: 1,
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
              <span style={{
                fontFamily: SANS, fontSize: 24, fontWeight: 700, color: GOLD,
                textTransform: 'capitalize',
              }}>
                {(a.recommendation_key ?? '').replace(/_/g, ' ') || DASH}
              </span>
              {a.recommendation_mean != null && (
                <span style={{ fontFamily: MONO, fontSize: 12, color: T.muted }}>
                  mean {a.recommendation_mean.toFixed(1)} of 5
                </span>
              )}
            </div>

            <div style={{
              display: 'flex', flexDirection: 'column', gap: 7,
              justifyContent: 'space-evenly', minHeight: 0,
            }}>
              {votes.map(v => (
                <div key={v.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    fontFamily: SANS, fontSize: 11.5, color: T.muted,
                    minWidth: 84, flexShrink: 0,
                  }}>
                    {v.label}
                  </span>
                  {/* Scaled to the largest bucket, not to the total: at a
                      lopsided consensus every bar but one is a stub otherwise. */}
                  <div style={{
                    flex: 1, height: 9, minWidth: 60,
                    background: 'rgba(255,255,255,0.05)',
                  }}>
                    <div style={{ width: `${(v.n / maxVote) * 100}%`, height: '100%', background: v.color }} />
                  </div>
                  <span style={{
                    fontFamily: MONO, fontSize: 12, fontWeight: 700, color: BRIGHT,
                    minWidth: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {v.n}
                  </span>
                </div>
              ))}
            </div>

            <div style={{
              marginTop: 'auto', paddingTop: 16,
              borderTop: `1px solid ${T.borderFaint}`,
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                gap: 12, marginBottom: 10,
              }}>
                <span style={{
                  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
                  textTransform: 'uppercase', color: T.muted,
                }}>
                  Price target, low to high
                </span>
                <span style={{
                  fontFamily: MONO, fontSize: 11, fontWeight: 700,
                  color: tone(a.implied_upside),
                }}>
                  {a.implied_upside == null
                    ? DASH
                    : `${a.implied_upside > 0 ? '+' : ''}${a.implied_upside.toFixed(1)}% implied upside`}
                </span>
              </div>
              <TargetRange low={a.target_low} mean={a.target_mean} high={a.target_high} spot={a.price} />
            </div>
          </div>
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Panel title="Earnings surprise" meta="EPS, actual against consensus">
            {g.surprises?.length ? (
              <div style={{
                display: 'grid', gridTemplateColumns: `repeat(${Math.min(g.surprises.length, 4)}, minmax(0, 1fr))`,
                gap: 1, background: T.borderFaint,
              }}>
                {g.surprises.slice(-4).map(s => (
                  <div key={s.quarter} style={{ background: T.bg, padding: '13px 14px 14px' }}>
                    <div style={{
                      fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                      textTransform: 'uppercase', color: T.muted, marginBottom: 7,
                    }}>
                      {s.quarter ?? DASH}
                    </div>
                    <div style={{
                      fontFamily: MONO, fontSize: 21, fontWeight: 700,
                      color: tone(s.surprisePct), marginBottom: 9,
                    }}>
                      {ratePct(s.surprisePct, 1, true)}
                    </div>
                    <MicroRow label="Est" value={multiple(s.estimate, 2)} />
                    <MicroRow label="Actual" value={multiple(s.actual, 2)} />
                    <MicroRow
                      label="Diff"
                      value={s.difference == null
                        ? DASH
                        : `${s.difference > 0 ? '+' : ''}${s.difference.toFixed(2)}`}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState size="compact" title="Earnings surprise"
                hint="No reported quarters to compare against consensus." />
            )}
          </Panel>

          <Panel
            title="Estimate revisions"
            meta={rev.data?.targets
              ? `Targets over ${rev.data.targets.window_days ?? 120} days: `
                + `${rev.data.targets.raises ?? 0} raised, ${rev.data.targets.cuts ?? 0} cut, `
                + `${rev.data.targets.maintains ?? 0} maintained`
              : undefined}
          >
            {rev.data?.drift?.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left' }}>Period</th>
                      <th style={th}>Current</th>
                      <th style={th}>7d</th>
                      <th style={th}>30d</th>
                      <th style={th}>90d</th>
                      <th style={th}>Up / down 30d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rev.data.drift.map(dr => {
                      const b = (rev.data?.breadth ?? []).find(x => x.period === dr.period)
                      return (
                        <tr key={dr.period} style={{ borderBottom: ROW_LINE }}>
                          <td style={{ ...td, textAlign: 'left', fontFamily: SANS, color: BRIGHT }}>
                            {dr.label}
                          </td>
                          <td style={td}>{multiple(dr.current, 2)}</td>
                          <td style={{ ...td, color: tone(dr.d7_pct) }}>{pctOrDash(dr.d7_pct)}</td>
                          <td style={{ ...td, color: tone(dr.d30_pct) }}>{pctOrDash(dr.d30_pct)}</td>
                          <td style={{ ...td, color: tone(dr.d90_pct) }}>{pctOrDash(dr.d90_pct)}</td>
                          <td style={{ ...td, color: T.muted }}>
                            {b ? `${b.up_30d ?? 0} up / ${b.down_30d ?? 0} down` : DASH}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState size="compact" title="Estimate revisions"
                hint="No revision history published for this symbol." />
            )}
          </Panel>
        </div>
      </div>

      <EstimateGrid
        title="Revenue estimates"
        meta={g.currency ? `Currency in ${g.currency}` : undefined}
        rows={g.revenue ?? []}
        format={v => compact(v)}
      />
      <EstimateGrid
        title="Earnings estimates"
        meta={g.currency ? `EPS, currency in ${g.currency}` : undefined}
        rows={g.eps ?? []}
        format={v => multiple(v, 2)}
      />
    </div>
  )
}

/** Periods run down the rows. The old layout put them across the columns with
 *  the measures down the side, which reads as a matrix rather than as four
 *  forward periods each with its own spread. */
function EstimateGrid({ title, meta, rows, format }: {
  title: string; meta?: string; rows: GridRow[]; format: (v: number | null | undefined) => string
}) {
  if (!rows.length) {
    return (
      <Panel title={title} meta={meta}>
        <EmptyState size="compact" title={title} hint="No forward estimates published for this symbol." />
      </Panel>
    )
  }
  return (
    <Panel title={title} meta={meta}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 190 }}>Period</th>
              <th style={th}>Analysts</th>
              <th style={th}>Average</th>
              <th style={th}>Low</th>
              <th style={th}>High</th>
              <th style={th}>Year ago</th>
              <th style={th}>Implied growth</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.period} style={{ borderBottom: ROW_LINE }}>
                <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontWeight: 600, color: BRIGHT }}>
                  {r.label}
                </td>
                <td style={{ ...td, color: T.muted }}>{count(r.analysts)}</td>
                <td style={{ ...td, fontWeight: 700, color: T.gold }}>{format(r.avg)}</td>
                <td style={td}>{format(r.low)}</td>
                <td style={td}>{format(r.high)}</td>
                <td style={{ ...td, color: T.muted }}>{format(r.yearAgo)}</td>
                <td style={{ ...td, color: tone(r.growth) }}>{ratePct(r.growth, 1, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** Low to high with the mean marked, and the spot price marked separately so
 *  the gap the upside figure describes is visible rather than only asserted. */
function TargetRange({ low, mean, high, spot }: {
  low?: number | null; mean?: number | null; high?: number | null; spot?: number | null
}) {
  if (low == null || high == null || high <= low) {
    return <span style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>No target range published</span>
  }
  const at = (v?: number | null) =>
    v == null ? null : Math.max(0, Math.min(100, ((v - low) / (high - low)) * 100))

  return (
    <div>
      <div style={{ position: 'relative', height: 10, background: 'rgba(255,255,255,0.05)' }}>
        <div style={{
          position: 'absolute', left: 0, width: `${at(mean) ?? 0}%`, top: 0, bottom: 0,
          background: 'color-mix(in srgb, var(--theme-primary) 30%, transparent)',
        }} />
        {spot != null && at(spot) != null && (
          <div style={{
            position: 'absolute', left: `${at(spot)}%`, top: -3, bottom: -3,
            width: 2, background: BRIGHT,
          }} />
        )}
        {mean != null && (
          <div style={{
            position: 'absolute', left: `${at(mean)}%`, top: -3, bottom: -3,
            width: 2, background: GOLD,
          }} />
        )}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginTop: 7,
        fontFamily: MONO, fontSize: 10.5, color: DIM,
      }}>
        <span>Low {low.toFixed(2)}</span>
        <span style={{ color: GOLD }}>Mean {mean == null ? DASH : mean.toFixed(2)}</span>
        <span>High {high.toFixed(2)}</span>
      </div>
    </div>
  )
}

function MicroRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 8,
      fontFamily: MONO, fontSize: 10.5, lineHeight: '17px',
    }}>
      <span style={{ color: DIM }}>{label}</span>
      <span style={{ color: T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

const pctOrDash = (v?: number | null) =>
  v == null ? DASH : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`

const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.muted, textAlign: 'right',
  padding: '11px 14px', whiteSpace: 'nowrap',
  background: STRIP, borderBottom: `1px solid ${T.border}`,
}

const td: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap',
  fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: T.text,
}
