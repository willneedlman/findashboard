import { useState } from 'react'
import { useToolState } from '../hooks/useToolState'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { useTickerParam } from '../hooks/useTickerParam'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { KpiStrip, MONO, SANS, mix } from './cockpitKit'
import { T } from '../lib/theme'
import { TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, LABEL } from './valuationShared'

// Calendar patterns in a price series.
//
// Every figure is shown with the sample behind it. An average January built on
// nine observations is a different claim from one built on forty, and a
// seasonality view that hides its denominators is the kind that gets traded on
// and then disappoints.

interface Bucket {
  label: string; n: number
  mean_pct: number | null; median_pct: number | null; hit_rate_pct: number | null
  best_pct: number | null; worst_pct: number | null
}
interface Seasonality {
  available: boolean
  reason?: string
  ticker?: string
  first_date?: string; last_date?: string; years_covered?: number; sessions?: number
  months?: Bucket[]
  weekdays?: Bucket[]
  turn_of_month?: { turn_of_month: Bucket; rest_of_month: Bucket }
  year_grid?: Record<string, number | string>[]
  best_month?: Bucket | null
  worst_month?: Bucket | null
  current_month?: Bucket
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const signed = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`)
const tone = (v: number | null | undefined) => (v == null ? T.muted : v >= 0 ? T.pos : T.neg)

function Panel({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ft-chart-panel">
      <div className="ft-chart-label" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span>{title}</span>
        {meta && <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', textTransform: 'none' }}>{meta}</span>}
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  )
}

const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: T.muted, padding: '0 8px 7px', textAlign: 'right', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontFamily: MONO, fontSize: 10.5, padding: '4px 8px', textAlign: 'right',
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

export default function Seasonality() {
  const [draft, setDraft] = useState('SPY')
  const [ticker, setTicker] = useState('SPY')

  // The drawer and palette offer this page for a symbol. It never read the
  // URL, so a deep link opened on the hardcoded default instead.
  useTickerParam(sym => { setDraft(sym); setTicker(sym) })
  const [years, setYears] = useToolState('seasonality.years', 20)

  const q = useQuery<Seasonality>({
    queryKey: ['seasonality', ticker, years],
    queryFn: () => axios.get('/api/market/seasonality', { params: { ticker, years } }).then(r => r.data),
    staleTime: 6 * 3600_000,
    retry: 0,
  })
  const d = q.data
  const months = d?.months ?? []
  const grid = d?.year_grid ?? []
  const turn = d?.turn_of_month

  return (
    <PageWrapper title="Ticker Seasonality"
      meta={d?.available ? `${d.ticker} · ${d.years_covered}y · ${d.first_date} to ${d.last_date}` : undefined}>

      {/* One control row on one baseline. Each field owns its own column so the
          labels line up and the three inputs share the 32px control height. */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ width: 150 }}>
          <span style={LABEL}>Symbol</span>
          <TickerInput value={draft} onChange={setDraft}
            onEnter={() => setTicker(draft.toUpperCase())}
            onSelect={sym => { setDraft(sym); setTicker(sym.toUpperCase()) }} />
        </div>
        <div>
          <span style={LABEL}>History</span>
          <div style={{ display: 'flex' }}>
            {[10, 20, 30, 40].map((y, i) => {
              const on = y === years
              return (
                <button key={y} onClick={() => setYears(y)}
                  style={{
                    fontFamily: MONO, fontSize: 11.5, fontWeight: 700, padding: '0 13px',
                    height: 32, boxSizing: 'border-box', cursor: 'pointer',
                    background: on ? mix(T.gold, 14) : 'transparent',
                    border: `1px solid ${on ? T.gold : T.border}`,
                    color: on ? T.gold : T.muted,
                    // Collapse the shared edge, and keep the selected cell's
                    // gold border on top of its neighbours.
                    marginLeft: i ? -1 : 0,
                    position: 'relative', zIndex: on ? 1 : 0,
                  }}>{y}y</button>
              )
            })}
          </div>
        </div>
        <button onClick={() => setTicker(draft.toUpperCase())}
          style={{
            height: 32, boxSizing: 'border-box', padding: '0 18px', cursor: 'pointer',
            fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: T.gold,
            background: mix(T.gold, 8), border: `1px solid ${T.gold}`,
          }}>Run</button>
      </div>

      {q.isLoading && <EmptyState variant="loading" title={`Reading ${ticker} history`} hint="Bucketing every session by calendar month and weekday." />}

      {!q.isLoading && !d?.available && (
        <EmptyState variant="unavailable" title="Seasonality unavailable"
          hint={d?.reason ?? 'That symbol did not return enough history.'} />
      )}

      {d?.available && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <KpiStrip cells={[
            { label: 'Best month', value: d.best_month?.label ?? '—', vc: T.pos,
              sub: d.best_month ? `${signed(d.best_month.mean_pct)} avg · ${d.best_month.hit_rate_pct}% positive` : undefined },
            { label: 'Worst month', value: d.worst_month?.label ?? '—', vc: T.neg,
              sub: d.worst_month ? `${signed(d.worst_month.mean_pct)} avg · ${d.worst_month.hit_rate_pct}% positive` : undefined },
            { label: 'This month', value: d.current_month?.label ?? '—',
              vc: tone(d.current_month?.mean_pct),
              // 21 August observations inside 20 years of history is not a
              // contradiction, but calling them "21 years" next to a SAMPLE tile
              // reading 20y made it look like one.
              sub: d.current_month ? `${signed(d.current_month.mean_pct)} avg of ${d.current_month.n} ${d.current_month.label} observations` : undefined },
            { label: 'Turn of month', value: signed(turn?.turn_of_month.mean_pct, 3),
              vc: tone(turn?.turn_of_month.mean_pct),
              sub: turn ? `vs ${signed(turn.rest_of_month.mean_pct, 3)} the rest of the month` : undefined },
            { label: 'Sample', value: `${d.years_covered}y`, sub: `${d.sessions?.toLocaleString()} sessions` },
          ]} />

          <Panel title="Average return by month" meta={(() => {
            const ns = months.map(m => m.n).filter(n => n > 0)
            if (!ns.length) return 'bar height is the mean'
            const lo = Math.min(...ns), hi = Math.max(...ns)
            return `bar height is the mean, ${lo === hi ? lo : `${lo} to ${hi}`} observations per month`
          })()}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={months} margin={{ top: 6, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.borderFaint} vertical={false} />
                <XAxis dataKey="label" stroke={T.muted} tick={{ fill: T.muted, fontSize: 10 }} />
                <YAxis unit="%" stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} width={46} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: mix(T.text, 4) }}
                  formatter={(v: number, _n, item) => [`${signed(v)} mean · ${item.payload.hit_rate_pct}% positive · n=${item.payload.n}`, 'Return']} />
                <ReferenceLine y={0} stroke={T.muted} />
                <Bar isAnimationActive={false} dataKey="mean_pct" name="mean">
                  {months.map(m => <Cell key={m.label} fill={(m.mean_pct ?? 0) >= 0 ? T.pos : T.neg} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <Panel title="Month detail">
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>Month</th>
                    <th style={th}>Mean</th><th style={th}>Median</th>
                    <th style={th}>Positive</th><th style={th}>Best</th><th style={th}>Worst</th><th style={th}>n</th>
                  </tr></thead>
                  <tbody>
                    {months.map(m => (
                      <tr key={m.label} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                        <td style={{ ...td, textAlign: 'left', color: T.text, fontWeight: 700 }}>{m.label}</td>
                        <td style={{ ...td, color: tone(m.mean_pct) }}>{signed(m.mean_pct)}</td>
                        <td style={{ ...td, color: tone(m.median_pct) }}>{signed(m.median_pct)}</td>
                        <td style={{ ...td, color: T.text }}>{m.hit_rate_pct == null ? '—' : `${m.hit_rate_pct}%`}</td>
                        <td style={{ ...td, color: T.muted }}>{signed(m.best_pct, 1)}</td>
                        <td style={{ ...td, color: T.muted }}>{signed(m.worst_pct, 1)}</td>
                        <td style={{ ...td, color: T.muted }}>{m.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Day of week" meta="average daily return by weekday">
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 280 }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>Day</th>
                    <th style={th}>Mean</th><th style={th}>Positive</th><th style={th}>n</th>
                  </tr></thead>
                  <tbody>
                    {(d.weekdays ?? []).map(w => (
                      <tr key={w.label} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                        <td style={{ ...td, textAlign: 'left', color: T.text, fontWeight: 700 }}>{w.label}</td>
                        <td style={{ ...td, color: tone(w.mean_pct) }}>{signed(w.mean_pct, 3)}</td>
                        <td style={{ ...td, color: T.text }}>{w.hit_rate_pct == null ? '—' : `${w.hit_rate_pct}%`}</td>
                        <td style={{ ...td, color: T.muted }}>{w.n.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.borderFaint}`, fontFamily: SANS, fontSize: 11, lineHeight: 1.5, color: T.muted }}>
                Weekday effects are a fraction of a percent on samples of a few thousand days. Read them as
                texture, not as an edge.
              </div>
            </Panel>
          </div>

          <Panel title="Year by year" meta="every month of every year, so an average is checkable against the years behind it">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Year</th>
                  {MONTHS.map(m => <th key={m} style={th}>{m}</th>)}
                </tr></thead>
                <tbody>
                  {grid.map(row => (
                    <tr key={String(row.year)} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                      <td style={{ ...td, textAlign: 'left', color: T.text, fontWeight: 700 }}>{row.year}</td>
                      {MONTHS.map(m => {
                        const v = row[m] as number | undefined
                        return (
                          <td key={m} style={{
                            ...td,
                            color: v == null ? T.muted : v >= 0 ? T.pos : T.neg,
                            background: v == null ? 'transparent'
                              : v >= 0 ? mix(T.pos, Math.min(22, Math.abs(v) * 2.6))
                                : mix(T.neg, Math.min(22, Math.abs(v) * 2.6)),
                          }}>{v == null ? '' : v.toFixed(1)}</td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div style={{ fontFamily: SANS, fontSize: 11, lineHeight: 1.55, color: T.muted, padding: '0 2px' }}>
            No significance test is reported here and none is implied. Ten to forty observations per month make
            these descriptive, not predictive. Check the year grid before trading any average.
          </div>
        </div>
      )}
    </PageWrapper>
  )
}
