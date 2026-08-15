import { T } from '../lib/theme'
import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import RotationGraph from '../components/RotationGraph'
import { TICK, TOOLTIP_STYLE, TOOLTIP_CURSOR } from './valuationShared'
import { sectorLeadership, type LeadershipTone } from '../lib/sectorRotation'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'


// Cyclical leadership is the risk-on read, defensive the risk-off one, and a
// spread too small to call gets the neutral treatment rather than a coin flip.
const leadershipColor = (tone: LeadershipTone) =>
  tone === 'cyclical' ? T.pos : tone === 'defensive' ? T.neg : T.muted
const leadershipBorder = (tone: LeadershipTone) =>
  tone === 'cyclical' ? 'color-mix(in srgb, var(--theme-positive, #22c55e) 52%, transparent)'
    : tone === 'defensive' ? 'color-mix(in srgb, var(--theme-negative, #ef4444) 52%, transparent)'
    : 'var(--theme-border, rgba(255,255,255,0.1))'

const PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y'] as const
type Period = typeof PERIODS[number]

interface SectorData {
  ticker:       string
  name:         string
  price:        number
  returns:      Record<Period, number | null>
  rel_strength: Record<Period, number | null>
  momentum:     number | null
  ranks:        Record<Period, number>
}

interface RotationResponse {
  sectors:     SectorData[]
  spy_returns: Record<Period, number | null>
  spy_price:   number | null
  as_of:       string
}

function heatColor(v: number | null, maxAbs = 15): string {
  if (v == null) return 'var(--theme-hover, rgba(255,255,255,0.04))'
  const intensity = Math.min(Math.abs(v) / maxAbs, 1)
  if (v > 0) return `rgba(34,197,94,${0.12 + intensity * 0.45})`
  return `rgba(239,68,68,${0.12 + intensity * 0.45})`
}

function pct(v: number | null, plus = true): string {
  if (v == null) return '—'
  return `${plus && v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function MomentumArrow({ val }: { val: number | null }) {
  if (val == null) return <span style={{ color: T.muted }}>—</span>
  if (val > 2)  return <span style={{ color: T.pos, fontSize: 14 }}>↑</span>
  if (val < -2) return <span style={{ color: T.neg, fontSize: 14 }}>↓</span>
  return <span style={{ color: T.muted, fontSize: 14 }}>→</span>
}

export function SectorRotationContent() {
  const [activePeriod, setActivePeriod] = useState<Period>('1M')
  const [sortBy, setSortBy] = useState<'return' | 'momentum'>('return')
  const [view, setView] = useState<'heatmap' | 'chart' | 'rrg'>('heatmap')
  const [showHelp, setShowHelp] = useState(false)

  const { data, isLoading, isError } = useQuery<RotationResponse>({
    queryKey: ['sector-rotation'],
    queryFn: () => axios.get('/api/market/sector-rotation').then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  const sorted = data
    ? [...data.sectors].sort((a, b) => {
        if (sortBy === 'return') {
          const av = a.returns[activePeriod] ?? -Infinity
          const bv = b.returns[activePeriod] ?? -Infinity
          return bv - av
        }
        return (b.momentum ?? -Infinity) - (a.momentum ?? -Infinity)
      })
    : []

  const chartData = sorted.map(s => ({
    name:     s.ticker,
    fullName: s.name,
    value:    s.returns[activePeriod],
    rel:      s.rel_strength[activePeriod],
  }))

  const rotationSignal = data ? (() => {
    const spyRet = data.spy_returns[activePeriod]
    const valid = data.sectors.filter(s => s.returns[activePeriod] != null)
    const beating = spyRet == null ? 0 : valid.filter(s => (s.returns[activePeriod] as number) > spyRet).length
    const ranked = [...valid].sort((a, b) => (b.returns[activePeriod] as number) - (a.returns[activePeriod] as number))
    return {
      broad: valid.length > 0 && beating >= valid.length / 2,
      // Breadth and leadership are two different questions. The chip used to
      // answer the first and label it as the second.
      leadership: sectorLeadership(valid.map(s => ({ ticker: s.ticker, value: s.returns[activePeriod] }))),
      beating,
      total: valid.length,
      spyRet,
      leader: ranked[0],
      laggard: ranked[ranked.length - 1],
    }
  })() : null

  useReportCapture(() => {
    if (!data?.sectors?.length) return null
    const pieces: ClipDraft[] = []
    const per = activePeriod
    const spyRet = data.spy_returns[per]
    const valid = data.sectors.filter(s => s.returns[per] != null)
    const beating = spyRet != null ? valid.filter(s => (s.returns[per] as number) > spyRet).length : 0
    const byRet = [...valid].sort((a, b) => (b.returns[per] as number) - (a.returns[per] as number))
    const top = byRet[0], bottom = byRet[byRet.length - 1]
    const fmtP = (v: number | null) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
    pieces.push(kpiClip('Sector Rotation', `Sector Breadth · ${per}`, [
      { label: `Breadth · ${per}`, value: `${beating}/${valid.length}`, sub: valid.length && beating >= valid.length / 2 ? 'broad' : 'narrow' },
      { label: `Leadership · ${per}`, value: sectorLeadership(valid.map(s => ({ ticker: s.ticker, value: s.returns[per] }))).label },
      { label: `SPY ${per}`, value: fmtP(spyRet) },
      ...(top ? [{ label: 'Leader', value: `${top.ticker} ${fmtP(top.returns[per])}` }] : []),
      ...(bottom ? [{ label: 'Laggard', value: `${bottom.ticker} ${fmtP(bottom.returns[per])}` }] : []),
      ...(top && bottom ? [{ label: 'Dispersion', value: `${((top.returns[per] as number) - (bottom.returns[per] as number)).toFixed(1)}%` }] : []),
    ]))
    pieces.push(tableClip(
      'Sector Rotation',
      `Sector Heatmap${data.as_of ? ` · as of ${data.as_of}` : ''}`,
      ['Sector', 'Name', 'Price', ...PERIODS, `vs SPY (${per})`, 'Mom', `Rank (${per})`],
      [
        ['SPY', 'S&P 500 Benchmark', data.spy_price != null ? `$${data.spy_price.toFixed(2)}` : null, ...PERIODS.map(p => pct(data.spy_returns[p])), null, null, null],
        ...sorted.map(s => [
          s.ticker,
          s.name,
          s.price != null ? `$${s.price.toFixed(2)}` : null,
          ...PERIODS.map(p => pct(s.returns[p])),
          pct(s.rel_strength[per]),
          s.momentum != null ? s.momentum.toFixed(2) : null,
          s.ranks?.[per] != null ? `#${s.ranks[per]}` : null,
        ]),
      ],
    ))
    const barRows = chartData.filter(d => d.value != null)
    if (barRows.length) {
      pieces.push(chartClip(
        'Sector Rotation',
        `Sector Returns · ${per}`,
        'bar',
        'name',
        barRows.map(d => ({ name: d.name, return: d.value })),
        [{ key: 'return', label: `${per} Return %` }],
      ))
    }
    return pieces
  }, { disabled: !data?.sectors?.length, sourceTab: 'Sector Rotation' })

  const tabStyle = (active: boolean): React.CSSProperties => ({
    background:   'none',
    border:       'none',
    borderBottom: active ? `2px solid var(--theme-primary, #c9a84c)` : '2px solid transparent',
    color:        active ? T.gold : T.muted,
    fontFamily:   T.label,
    fontSize:     9,
    fontWeight:   700,
    letterSpacing:'0.12em',
    textTransform:'uppercase',
    padding:      '6px 12px',
    cursor:       'pointer',
  })

  return (
      <div id="sector-rotation-content" style={{ width: '100%' }}>

        <PageHeader
          title="Sector Rotation"
          actions={rotationSignal && (
            <div aria-label="Sector rotation summary" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', fontFamily: T.mono, fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ padding: '4px 7px', border: `1px solid ${leadershipBorder(rotationSignal.leadership.tone)}`, color: leadershipColor(rotationSignal.leadership.tone), fontFamily: T.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {rotationSignal.leadership.label}
              </span>
              {rotationSignal.leadership.spread != null &&
                <span style={{ color: T.muted }}>defensives {pct(rotationSignal.leadership.spread)} vs cyclicals</span>}
              <span style={{ color: T.muted }}>{rotationSignal.beating}/{rotationSignal.total} beat SPY</span>
              <span style={{ paddingLeft: 7, borderLeft: `1px solid ${T.border}`, color: T.muted }}>SPY <strong style={{ color: rotationSignal.spyRet == null ? T.muted : rotationSignal.spyRet >= 0 ? T.pos : T.neg, fontWeight: 700 }}>{pct(rotationSignal.spyRet)}</strong></span>
              {rotationSignal.leader && <span style={{ padding: '4px 7px', border: `1px solid color-mix(in srgb, var(--theme-positive, #22c55e) 40%, transparent)`, color: T.pos }}>Leader <strong>{rotationSignal.leader.ticker} {pct(rotationSignal.leader.returns[activePeriod])}</strong></span>}
              {rotationSignal.laggard && <span style={{ padding: '4px 7px', border: `1px solid color-mix(in srgb, var(--theme-negative, #ef4444) 40%, transparent)`, color: T.neg }}>Laggard <strong>{rotationSignal.laggard.ticker} {pct(rotationSignal.laggard.returns[activePeriod])}</strong></span>}
            </div>
          )}
        />

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          {/* Period tabs */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}` }}>
            {PERIODS.map(p => (
              <button key={p} onClick={() => setActivePeriod(p)} style={tabStyle(activePeriod === p)}>{p}</button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Sort */}
            <div style={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              {([['return', 'Return'], ['momentum', 'Momentum']] as const).map(([k, l]) => (
                <button key={k} onClick={() => setSortBy(k)} style={{
                  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '4px 10px', cursor: 'pointer',
                  background: sortBy === k ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
                  border: `1px solid ${sortBy === k ? T.gold : T.border}`,
                  color: sortBy === k ? T.gold : T.muted,
                }}>
                  {l}
                </button>
              ))}
              <button
                onClick={() => setShowHelp(h => !h)}
                title="What's the difference?"
                style={{
                  marginLeft: 6, width: 18, height: 18, borderRadius: '50%',
                  background: showHelp ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${showHelp ? T.gold : T.border}`,
                  color: showHelp ? T.gold : T.muted,
                  fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                ?
              </button>
            </div>

            {/* View toggle */}
            <div style={{ display: 'flex', gap: 1 }}>
              {(['heatmap', 'chart', 'rrg'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} style={{
                  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '4px 10px', cursor: 'pointer',
                  background: view === v ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
                  border: `1px solid ${view === v ? T.gold : T.border}`,
                  color: view === v ? T.gold : T.muted,
                }}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Help panel */}
        {showHelp && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`, padding: '14px 16px', marginBottom: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 8 }}>
                Return
              </div>
              <p style={{ fontFamily: T.label, fontSize: 11, color: T.text, lineHeight: 1.7, margin: 0 }}>
                The sector ETF's raw price return over the selected window (1W, 1M, 3M…). Ranks sectors by how much they gained or lost in absolute terms.
              </p>
              <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.7, marginTop: 8 }}>
                Best for: identifying the strongest and weakest performing sectors in the current market environment. Use this to see where capital has flowed.
              </p>
            </div>
            <div>
              <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 8 }}>
                Momentum
              </div>
              <p style={{ fontFamily: T.label, fontSize: 11, color: T.text, lineHeight: 1.7, margin: 0 }}>
                Measures whether a sector is <em>accelerating</em> or <em>decelerating</em>. Calculated as the 1M return minus the implied monthly rate from the 3M return — a positive value means the sector has sped up recently.
              </p>
              <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.7, marginTop: 8 }}>
                Best for: catching rotation early — sectors with rising momentum are gaining relative strength even if their absolute return isn't top-ranked yet. ↑ arrows indicate accelerating sectors.
              </p>
            </div>
            <div style={{ gridColumn: '1 / -1', borderTop: `1px solid ${T.border}`, paddingTop: 10, marginTop: -4 }}>
              <p style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, margin: 0 }}>
                Example: XLE has a 3M return of +12% but a 1M return of +1% → momentum is negative (decelerating). XLK has a 3M return of +6% but a 1M return of +5% → momentum is positive (accelerating into strength).
              </p>
            </div>
          </div>
        )}

        {isLoading && (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11 }}>
            Loading sector data…
          </div>
        )}
        {isError && (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${T.border}`, color: T.neg, fontFamily: T.mono, fontSize: 11 }}>
            Failed to load sector data
          </div>
        )}

        {data && view === 'heatmap' && (
          <>
            {/* Full heatmap grid */}
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflowX: 'auto', marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                    <th style={{ padding: '8px 14px', textAlign: 'left', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, width: 170 }}>Sector</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>Price</th>
                    {PERIODS.map(p => (
                      <th key={p} style={{ padding: '8px 10px', textAlign: 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: p === activePeriod ? T.gold : T.muted }}>{p}</th>
                    ))}
                    <th style={{ padding: '8px 10px', textAlign: 'center', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>vs SPY</th>
                    <th style={{ padding: '8px 10px', textAlign: 'center', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>Mom</th>
                    <th style={{ padding: '8px 10px', textAlign: 'center', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>Rank</th>
                  </tr>
                </thead>
                <tbody>
                  {/* SPY benchmark row */}
                  <tr style={{ borderBottom: `1px solid ${T.border}`, background: 'color-mix(in srgb, var(--theme-primary) 4%, transparent)' }}>
                    <td style={{ padding: '7px 14px' }}>
                      <span style={{ fontFamily: T.label, fontWeight: 700, fontSize: 10, color: T.gold }}>SPY</span>
                      <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, marginLeft: 6 }}>S&P 500 Benchmark</span>
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: data.spy_price == null ? T.muted : T.text }}>
                      {data.spy_price == null ? '—' : `$${data.spy_price.toFixed(2)}`}
                    </td>
                    {PERIODS.map(p => {
                      const v = data.spy_returns[p]
                      return (
                        <td key={p} style={{ padding: '7px 10px', textAlign: 'right', background: heatColor(v), color: v == null ? T.muted : v >= 0 ? T.pos : T.neg, fontWeight: 600 }}>
                          {pct(v)}
                        </td>
                      )
                    })}
                    <td style={{ padding: '7px 10px', textAlign: 'center', color: T.muted }}>—</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', color: T.muted }}>—</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', color: T.muted }}>—</td>
                  </tr>

                  {sorted.map((s, i) => {
                    const activeRet = s.returns[activePeriod]
                    const activeRel = s.rel_strength[activePeriod]
                    return (
                      <tr key={s.ticker} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: '7px 14px' }}>
                          <span style={{ fontFamily: T.label, fontWeight: 700, fontSize: 10, color: T.gold }}>{s.ticker}</span>
                          <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, marginLeft: 6 }}>{s.name}</span>
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', color: T.text, fontFamily: T.mono }}>${s.price.toFixed(2)}</td>
                        {PERIODS.map(p => {
                          const v = s.returns[p]
                          const isActive = p === activePeriod
                          return (
                            <td key={p} style={{
                              padding: '7px 10px', textAlign: 'right',
                              background: heatColor(v),
                              color: v == null ? T.muted : v >= 0 ? T.pos : T.neg,
                              fontWeight: isActive ? 700 : 400,
                              outline: isActive ? `1px solid ${T.border}` : 'none',
                            }}>
                              {pct(v)}
                            </td>
                          )
                        })}
                        <td style={{ padding: '7px 10px', textAlign: 'center', color: activeRel == null ? T.muted : activeRel >= 0 ? T.pos : T.neg, fontWeight: 600 }}>
                          {pct(activeRel)}
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                          <MomentumArrow val={s.momentum} />
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: T.mono, fontSize: 9, color: (s.ranks?.[activePeriod] ?? 99) <= 3 ? T.gold : T.muted, fontWeight: (s.ranks?.[activePeriod] ?? 99) <= 3 ? 700 : 400 }}>
                          #{s.ranks?.[activePeriod] ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mini ranking strip */}
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
              {sorted.map((s, i) => {
                const v = s.returns[activePeriod]
                return (
                  <div key={s.ticker} style={{ background: heatColor(v, 20), border: `1px solid ${T.border}`, padding: '8px 6px', textAlign: 'center', minWidth: 72, flexShrink: 0 }}>
                    <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, color: T.muted, letterSpacing: '0.08em', marginBottom: 4 }}>#{i + 1}</div>
                    <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.gold }}>{s.ticker}</div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, color: v == null ? T.muted : v >= 0 ? T.pos : T.neg, marginTop: 2 }}>{pct(v)}</div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {view === 'rrg' && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '16px' }}>
            <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 16 }}>
              Relative Rotation · Sectors vs SPY
            </div>
            <RotationGraph names={Object.fromEntries((data?.sectors ?? []).map(s => [s.ticker, s.name]))} />
          </div>
        )}

        {data && view === 'chart' && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '16px' }}>
            <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 16 }}>
              {activePeriod} Return · All Sectors vs SPY
            </div>
            <ResponsiveContainer width="100%" height={380}>
              <BarChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  height={64}
                  tick={(props) => {
                    const { x, y, payload } = props
                    const entry = chartData.find(d => d.name === payload.value)
                    return (
                      <g transform={`translate(${x},${y})`}>
                        <text x={0} y={0} dy={4} textAnchor="end" transform="rotate(-40)"
                          style={{ fontFamily: T.mono, fontSize: 11, fill: T.gold, fontWeight: 700 }}>
                          {payload.value}
                        </text>
                        <text x={0} y={0} dy={16} textAnchor="end" transform="rotate(-40)"
                          style={{ fontFamily: T.label, fontSize: 10, fill: T.muted }}>
                          {entry?.fullName ?? ''}
                        </text>
                      </g>
                    )
                  }}
                />
                <YAxis tickFormatter={v => `${v}%`} tick={TICK} tickLine={false} axisLine={false} />
                <ReferenceLine y={0} stroke={T.border} />
                {data.spy_returns[activePeriod] != null && (
                  <ReferenceLine y={data.spy_returns[activePeriod]!} stroke={T.gold} strokeDasharray="4 4" label={{ value: 'SPY', position: 'insideTopRight', fill: T.gold, fontSize: 9, fontFamily: T.mono }} />
                )}
                <Tooltip
                  cursor={TOOLTIP_CURSOR}
                  formatter={(v: number, name: string) => [`${v?.toFixed(2)}%`, name === 'value' ? 'Return' : 'vs SPY']}
                  contentStyle={{ ...TOOLTIP_STYLE, fontFamily: T.mono, fontSize: 10 }}
                  labelFormatter={(label) => {
                    const entry = chartData.find(d => d.name === label)
                    return `${label} · ${entry?.fullName ?? ''}`
                  }}
                  labelStyle={{ color: T.gold, fontFamily: T.label, fontWeight: 700 }}
                />
                <Bar isAnimationActive={false} dataKey="value" name="value" radius={[2, 2, 0, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={(d.value ?? 0) >= 0 ? T.pos : T.neg} opacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {data && (
          <div style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, marginTop: 10, textAlign: 'right' }}>
            Data as of {data.as_of} · 1h cache · Source: Yahoo Finance
          </div>
        )}
      </div>
  )
}

export default function SectorRotation() {
  return <PageWrapper><SectorRotationContent /></PageWrapper>
}
