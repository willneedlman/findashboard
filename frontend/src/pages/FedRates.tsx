import { T } from '../lib/theme'
import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend, LabelList, Customized,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { fetchYieldCurve, fetchFedProjections, fetchSepDots, fetchCurveSpreads } from '../hooks/useApi'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../components/ChartTooltip'
import { formatLocalTime, localTimeZone } from '../lib/time'

// Weight models — how a front-end funds shock decays across meetings / tenors.
const FED_WEIGHTS = [1.0, 0.9, 0.7, 0.5, 0.3, 0.1]
const YC_TENORS = ['FF', '1Y', '2Y', '5Y', '10Y', '20Y', '30Y']
const YC_WEIGHTS = [1.0, 0.98, 0.85, 0.40, 0.1, -0.19, -0.325]
const CURVE_TENORS = ['FF', '1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y']
const TWIST_W: Record<string, number> = { FF: 1.0, '1M': 1.0, '3M': 0.99, '6M': 0.98, '1Y': 0.98, '2Y': 0.85, '3Y': 0.65, '5Y': 0.40, '7Y': 0.25, '10Y': 0.1, '20Y': -0.19, '30Y': -0.325 }
const PRESETS = [-100, -50, -25, 0, 25, 50, 100]

// Outcome trio — same as the prior build.
const C_HIKE = '#c0394d'
const C_HOLD = 'var(--theme-chart-neutral, #4a7fa5)'
const C_CUT = '#2e9a62'
const VIOLET = 'var(--theme-accent-violet, #c084fc)'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-mono)' }
// Fed prose uses fractions ("3-1/2 to 3-3/4 percent"); show plain numbers.
// Applied on render too, so a client-cached (pre-fix) response still displays right.
const _FRAC: Record<string, string> = { '1/8': '.125', '1/4': '.25', '3/8': '.375', '1/2': '.50', '5/8': '.625', '3/4': '.75', '7/8': '.875' }
const decimalize = (t?: string) => (t ?? '')
  .replace(/(\d+)[- ](1\/8|1\/4|3\/8|1\/2|5\/8|3\/4|7\/8)/g, (_m, a, f) => a + _FRAC[f])
  .replace(/\s*percent\b/g, '%')

const eyebrow: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: T.muted }
const bandTitle: React.CSSProperties = { fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: T.text }
const band: React.CSSProperties = { padding: '14px 24px', borderTop: `1px solid ${T.borderFaint}` }

// ── Measure a container's width (for hand-rolled SVG charts) ────────────────
function useWidth<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(entries => setW(entries[0].contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const fmtClock = () => formatLocalTime(new Date(), { second: '2-digit' })

// Isolated so the 1s tick doesn't re-render the charts / dot plot.
function LiveClock() {
  const [clock, setClock] = useState(fmtClock)
  useEffect(() => { const id = setInterval(() => setClock(fmtClock()), 1000); return () => clearInterval(id) }, [])
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.pos }} />
      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>LIVE · {clock} {localTimeZone()}</span>
    </span>
  )
}

// ── Band 2: scenario chips + centre-anchored slider ─────────────────────────
function ScenarioBand({ twist, setTwist }: { twist: number; setTwist: (n: number) => void }) {
  const pct = (twist + 200) / 400 * 100          // thumb position 0..100
  const fillLeft = Math.min(50, pct)             // centre-anchored gold fill
  const fillWidth = Math.abs(pct - 50)
  return (
    <div style={{ ...band, borderTop: 'none', background: T.goldTint(5), borderBottom: `1px solid ${T.goldTint(28)}`, display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
      <div style={{ flex: 'none' }}>
        <div style={{ ...eyebrow, marginBottom: 3 }}>Rate Scenario</div>
        <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700, lineHeight: 1, color: twist === 0 ? T.muted : T.gold }}>
          {twist > 0 ? '+' : ''}{twist}<span style={{ fontSize: 13, marginLeft: 4 }}>bps</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
        {PRESETS.map(p => {
          const on = twist === p
          const neutral = p === 0
          return (
            <button key={p} onClick={() => setTwist(p)} style={{
              fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, padding: '5px 10px', cursor: 'pointer',
              background: on ? (neutral ? 'rgba(255,255,255,0.1)' : T.gold) : 'transparent',
              color: on ? (neutral ? T.text : 'var(--theme-bg, #101c2e)') : T.muted,
              border: `1px solid ${on && !neutral ? T.gold : 'rgba(255,255,255,0.14)'}`,
            }}>{p > 0 ? '+' : ''}{p}</button>
          )
        })}
      </div>
      <div style={{ position: 'relative', flex: '1 1 240px', height: 16, display: 'flex', alignItems: 'center', minWidth: 200 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.12)' }} />
        <div style={{ position: 'absolute', left: `${fillLeft}%`, width: `${fillWidth}%`, height: 3, background: T.gold }} />
        <div style={{ position: 'absolute', left: `calc(${pct}% - 6px)`, width: 12, height: 12, background: T.gold, border: '2px solid var(--theme-bg, #101c2e)', boxShadow: `0 0 0 1px ${T.gold}` }} />
        <input type="range" min={-200} max={200} step={5} value={twist} onChange={e => setTwist(+e.target.value)}
          aria-label="Rate scenario shock in basis points"
          style={{ position: 'absolute', left: 0, right: 0, width: '100%', margin: 0, opacity: 0, cursor: 'pointer', height: 16 }} />
      </div>
      {twist !== 0 && (
        <button onClick={() => setTwist(0)} style={{ flex: 'none', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, background: 'none', border: `1px solid ${T.border}`, padding: '5px 10px', cursor: 'pointer' }}>Reset</button>
      )}
      <div style={{ flex: '1 1 180px', minWidth: 160, fontFamily: T.label, fontSize: 11, color: T.muted }}>
        Shock decays along the strip. Full at the front, fading past 10Y.
      </div>
    </div>
  )
}

// ── Band 3: base→adjusted connectors drawn in chart pixel space ─────────────
function PathConnectors(props: any) {
  const { xAxisMap, yAxisMap, data, twist } = props
  if (!xAxisMap || !yAxisMap || twist === 0) return null
  const xScale = (Object.values(xAxisMap)[0] as any).scale
  const yScale = (Object.values(yAxisMap)[0] as any).scale
  const bw = xScale.bandwidth ? xScale.bandwidth() : 0
  return (
    <g>
      {[0, 2, 4].map(i => {
        const d = data[i]
        if (!d) return null
        const x = xScale(d.date) + bw / 2
        const yb = yScale(d.base_rate), ya = yScale(d.adjusted_rate)
        const bp = Math.round((d.adjusted_rate - d.base_rate) * 100)
        if (!bp) return null
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yb} y2={ya} stroke={T.gold} strokeWidth={1} strokeDasharray="2 2" opacity={0.55} />
            <text x={x + 5} y={(yb + ya) / 2 + 3} fontFamily="var(--theme-mono)" fontSize={8.5} fill="#8099b0">+{bp} bp</text>
          </g>
        )
      })}
    </g>
  )
}

const goldLabel = (p: any) => (
  <text x={p.x} y={p.y - 9} textAnchor="middle" fontFamily="var(--theme-mono)" fontSize={9.5} fontWeight={700} fill={p.fill}>
    {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
  </text>
)

function FedPathChart({ meetings, twist }: { meetings: any[]; twist: number }) {
  const active = twist !== 0
  const vals = meetings.flatMap(m => [m.base_rate, m.adjusted_rate])
  const lo = Math.floor(Math.min(...vals) * 5) / 5 - 0.1
  const hi = Math.ceil(Math.max(...vals) * 5) / 5 + 0.1
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={meetings} margin={{ left: 4, right: 24, top: 26, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
        <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tick={TICK} tickFormatter={v => `${v}%`} domain={[lo, hi]} axisLine={false} tickLine={false} width={44} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]} />
        <Legend verticalAlign="top" align="right" wrapperStyle={{ fontFamily: T.label, fontSize: 9, letterSpacing: '0.1em', paddingBottom: 4 }} />
        {active && <Line type="monotone" dataKey="base_rate" stroke="rgba(255,255,255,0.22)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="BASE" isAnimationActive={false} />}
        <Line type="monotone" dataKey="adjusted_rate" stroke={T.gold} strokeWidth={2.25}
          dot={{ fill: T.gold, stroke: 'var(--theme-bg, #101c2e)', strokeWidth: 1.5, r: 4.5 }}
          name={active ? 'SCENARIO' : 'IMPLIED'} isAnimationActive={false}>
          <LabelList dataKey="adjusted_rate" content={(p: any) => goldLabel({ ...p, fill: active ? T.gold : T.text })} />
        </Line>
        <Customized component={(p: any) => <PathConnectors {...p} data={meetings} twist={twist} />} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Band 4: meeting odds strip ──────────────────────────────────────────────
function OddsStrip({ meetings }: { meetings: any[] }) {
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div style={band}>
      <div style={{ ...bandTitle, marginBottom: 12 }}>Meeting Odds — Hike / Hold / Cut</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(meetings.length, 8)}, 1fr)`, gap: 14 }}>
      {meetings.slice(0, 8).map((m, i) => {
        const outcomes: [string, number, string][] = [['HIKE', m.prob_hike, C_HIKE], ['HOLD', m.prob_hold, C_HOLD], ['CUT', m.prob_cut, C_CUT]]
        const [domLabel, domVal, domCol] = outcomes.reduce((a, b) => b[1] > a[1] ? b : a)
        return (
          <div key={m.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ position: 'relative', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 6 }}>
              <span style={{ fontFamily: T.mono, fontSize: 9, color: i === 0 ? T.gold : T.muted, fontWeight: i === 0 ? 700 : 400, whiteSpace: 'nowrap' }}>{i === 0 ? '▸ ' : ''}{m.date}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: domCol, whiteSpace: 'nowrap' }}>{domLabel} {Math.round(domVal)}</span>
            </div>
            <div style={{ display: 'flex', height: 8, background: 'rgba(255,255,255,0.05)' }}>
              {outcomes.map(([lbl, v, c]) => v > 0 && <div key={lbl} style={{ width: `${v}%`, background: c }} />)}
            </div>
            {hover === i && (
              <div style={{ position: 'absolute', top: -6, left: '50%', transform: 'translate(-50%,-100%)', zIndex: 10, ...TOOLTIP_STYLE, whiteSpace: 'nowrap' }}>
                {outcomes.map(([lbl, v, c]) => (
                  <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: c }}><span>{lbl}</span><span>{Math.round(v)}%</span></div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      </div>
    </div>
  )
}

// ── Band 5: yield curve ─────────────────────────────────────────────────────
function YieldCurveChart({ rows, twist }: { rows: any[]; twist: number }) {
  const active = twist !== 0
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ left: 4, right: 20, top: 20, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
        <XAxis dataKey="tenor" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tick={TICK} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} axisLine={false} tickLine={false} width={44} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]} />
        <Legend verticalAlign="top" align="right" wrapperStyle={{ fontFamily: T.label, fontSize: 9, letterSpacing: '0.08em', paddingBottom: 4 }} />
        <Line type="monotone" dataKey="m6" stroke="rgba(255,255,255,0.30)" strokeWidth={1.25} strokeDasharray="2 4" dot={false} name="6M ago" connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="m1" stroke="#5e768f" strokeWidth={1.5} strokeDasharray="6 4" dot={false} name="1M ago" connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="d1" stroke={VIOLET} strokeWidth={1.25} strokeDasharray="7 3" strokeOpacity={0.7} dot={false} name="1D ago" connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="today"
          stroke={active ? 'rgba(255,255,255,0.28)' : T.gold} strokeWidth={active ? 1.75 : 2}
          dot={active ? false : { fill: T.gold, r: 2.5 }} name="Today" connectNulls isAnimationActive={false} />
        {active && <Line type="monotone" dataKey="adjusted" stroke={T.gold} strokeWidth={2} strokeDasharray="4 3" dot={false} name="Scenario" connectNulls isAnimationActive={false} />}
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Band 6a: FOMC dot plot (median + central tendency + range) ──────────────
function DotPlot({ data }: { data: any }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const h = 250, padL = 42, padR = 12, padT = 8, padB = 26
  const cols: { key: string; label: string; d: any }[] = [
    ...data.years.map((y: any) => ({ key: String(y.year), label: String(y.year), d: y })),
  ]
  if (data.longer_run) cols.push({ key: 'lr', label: 'LONGER RUN', d: { ...data.longer_run, market: null } })
  const yLo = 2.5, yHi = 4.5
  const plotH = h - padT - padB
  const yPix = (v: number) => padT + (yHi - v) / (yHi - yLo) * plotH
  const colW = w > 0 ? (w - padL - padR) / cols.length : 0
  const cx = (i: number) => padL + colW * (i + 0.5)
  const gridVals = [2.5, 3.0, 3.5, 4.0, 4.5]

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {w > 0 && (
        <svg width={w} height={h}>
          {gridVals.map(v => (
            <g key={v}>
              <line x1={padL} x2={w - padR} y1={yPix(v)} y2={yPix(v)} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <text x={padL - 8} y={yPix(v) + 3} textAnchor="end" fontFamily="var(--theme-mono)" fontSize={9} fill="#8099b0">{v.toFixed(1)}%</text>
            </g>
          ))}
          {cols.map((c, i) => {
            const x = cx(i)
            const d = c.d
            return (
              <g key={c.key}>
                {d.range_low != null && d.range_high != null && (
                  <line x1={x} x2={x} y1={yPix(d.range_high)} y2={yPix(d.range_low)} stroke="#5e768f" strokeWidth={1} opacity={0.5} />
                )}
                {d.ct_low != null && d.ct_high != null && (
                  <line x1={x} x2={x} y1={yPix(d.ct_high)} y2={yPix(d.ct_low)} stroke="#5e768f" strokeWidth={7} opacity={0.55} strokeLinecap="round" />
                )}
                {d.median != null && (
                  <line x1={x - 14} x2={x + 14} y1={yPix(d.median)} y2={yPix(d.median)} stroke={T.gold} strokeWidth={2.5} />
                )}
                {d.market != null && (
                  <g>
                    <rect x={x - 5} y={yPix(d.market) - 5} width={10} height={10} fill={T.blue} transform={`rotate(45 ${x} ${yPix(d.market)})`} />
                    <text x={x + 12} y={yPix(d.market) + 3} fontFamily="var(--theme-mono)" fontSize={8.5} fontWeight={700} fill={T.blue}>MKT {d.market.toFixed(2)}</text>
                  </g>
                )}
                <text x={x} y={h - 8} textAnchor="middle" fontFamily="var(--theme-mono)" fontSize={9} fontWeight={700} letterSpacing="0.08em" fill="#8099b0">{c.label}</text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

// ── Band 6b: curve spreads ──────────────────────────────────────────────────
function Sparkline({ pts, w = 120, h = 30 }: { pts: number[]; w?: number; h?: number }) {
  if (pts.length < 2) return <svg width={w} height={h} />
  const min = Math.min(...pts, 0), max = Math.max(...pts, 0), span = max - min || 1
  const y = (v: number) => h - 2 - (v - min) / span * (h - 4)
  const x = (i: number) => (i / (pts.length - 1)) * w
  const line = pts.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {min <= 0 && max >= 0 && <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.10)" strokeDasharray="3 3" />}
      <polyline points={line} fill="none" stroke={T.blue} strokeWidth={1.75} />
    </svg>
  )
}

function SpreadsPanel({ spreads }: { spreads: any[] }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  return (
    <div ref={ref}>
      {spreads.map((s, i) => {
        const pos = (s.current ?? 0) >= 0
        const hist = s.history ?? []
        const startBp = hist.length ? Math.round(hist[0].bp) : null       // 6 months ago
        const nowBp = s.current == null ? null : Math.round(s.current)
        const change = (nowBp != null && startBp != null) ? nowBp - startBp : null
        const steeper = change != null && change > 0
        return (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderTop: i ? `1px solid ${T.borderFaint}` : 'none' }}>
            <span style={{ flex: 'none', width: 52, fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: '#8099b0' }}>{s.name}</span>
            <span title="Current spread" style={{ flex: 'none', width: 68, textAlign: 'right', fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: pos ? T.pos : T.neg }}>
              {nowBp == null ? '—' : `${pos ? '+' : ''}${nowBp}bp`}
            </span>
            {/* Sparkline flanked by the 6mo-ago value (left) and now (right). */}
            <span title="6 months ago" style={{ flex: 'none', fontFamily: T.mono, fontSize: 9, color: T.muted, width: 26, textAlign: 'right' }}>{startBp ?? ''}</span>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex' }}>
              <Sparkline pts={hist.map((p: any) => p.bp)} w={Math.max(40, w - 356)} />
            </div>
            <span title="Now" style={{ flex: 'none', fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: pos ? T.pos : T.neg, width: 28, textAlign: 'left' }}>{nowBp ?? ''}</span>
            <span style={{ flex: 'none', width: 118, textAlign: 'right', fontFamily: T.mono, fontSize: 9, color: T.muted, whiteSpace: 'nowrap', lineHeight: 1.5 }}>
              {change != null && (
                <div style={{ color: steeper ? T.pos : '#c98b3a', fontWeight: 700 }} title="Change over 6 months">
                  {steeper ? 'steeper' : 'flatter'} {change > 0 ? '+' : ''}{change}bp
                </div>
              )}
              {s.low != null && <div>6M range {Math.round(s.low)}–{Math.round(s.high)}</div>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Small inline stat (value + optional scenario delta) ─────────────────────
function InlineStat({ label, value, delta, deltaPos }: { label: string; value: string; delta?: string; deltaPos?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
      <span style={{ ...eyebrow, fontSize: 9 }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{value}</span>
      {delta && <span style={{ fontFamily: T.mono, fontSize: 10, color: deltaPos ? T.gold : '#8099b0' }}>{delta}</span>}
    </span>
  )
}

// ── Band 6c: FOMC statement AI read ──────────────────────────────────────────
interface FomcRead { available: boolean; date?: string; url?: string; stance?: string; score?: number; decision?: string; summary?: string; key_points?: string[] }
function FomcStatementRead() {
  const { data } = useQuery<FomcRead>({
    queryKey: ['fomc-analysis'],
    queryFn: () => axios.get('/api/rates/fomc-analysis').then(r => r.data),
    staleTime: 6 * 3600 * 1000,
  })
  if (!data?.available) return null
  const score = Math.max(-10, Math.min(10, data.score ?? 0))
  const stance = (data.stance || 'neutral').toLowerCase()
  const stanceColor = stance === 'hawkish' ? T.neg : stance === 'dovish' ? T.pos : T.gold
  const markerPct = ((score + 10) / 20) * 100
  return (
    <div style={band}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={bandTitle}>FOMC Statement — AI Read</span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {data.date && <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: '0.1em', color: T.muted }}>{data.date}</span>}
          {data.url && <a href={data.url} target="_blank" rel="noreferrer" style={{ fontFamily: T.label, fontSize: 8.5, letterSpacing: '0.06em', color: T.muted, textDecoration: 'underline' }}>SOURCE</a>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 40fr) minmax(0, 60fr)', gap: 28 }} className="rate-split">
        {/* Left: stance + hawkish-dovish scale */}
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: stanceColor, textTransform: 'capitalize' }}>{stance}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: stanceColor }}>{score > 0 ? '+' : ''}{score}</span>
          </div>
          <div style={{ position: 'relative', height: 8, background: `linear-gradient(90deg, ${T.pos}, ${T.gold}, ${T.neg})`, borderRadius: 4, opacity: 0.85 }}>
            <div style={{ position: 'absolute', left: `${markerPct}%`, top: -3, transform: 'translateX(-50%)', width: 3, height: 14, background: T.text, borderRadius: 2 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.label, fontSize: 8.5, letterSpacing: '0.08em', color: T.muted, marginTop: 5 }}>
            <span>DOVISH −10</span><span>NEUTRAL</span><span>+10 HAWKISH</span>
          </div>
          {data.decision && <div style={{ fontFamily: T.mono, fontSize: 11, color: T.text, marginTop: 14, lineHeight: 1.5 }}>{decimalize(data.decision)}</div>}
        </div>
        {/* Right: summary + key points */}
        <div>
          {data.summary && <div style={{ fontFamily: T.label, fontSize: 12.5, color: T.text, lineHeight: 1.55, marginBottom: 10 }}>{decimalize(data.summary)}</div>}
          {(data.key_points ?? []).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {data.key_points!.map((k, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontFamily: T.label, fontSize: 11.5, color: T.muted, lineHeight: 1.45 }}>
                  <span style={{ color: T.gold, flex: 'none' }}>·</span><span>{decimalize(k)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, marginTop: 10, opacity: 0.8 }}>AI-generated read of the official statement. Verify against the source.</div>
        </div>
      </div>
    </div>
  )
}

export function FedRatesContent() {
  const [twist, setTwist] = useState(0)

  // Yields, futures-implied odds, and spreads all move through the trading day —
  // poll every minute so an open tab tracks them without a manual refresh. The
  // backend caches each at 5 min (matching its own upstream data's refresh rate),
  // so this just picks up that cache turning over as soon as it happens.
  const LIVE = { staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false }
  const { data: curveData, isError: curveErr } = useQuery({ queryKey: ['yield-curve'], queryFn: fetchYieldCurve, ...LIVE })
  const { data: fedData, isError: fedErr } = useQuery({ queryKey: ['fed-projections'], queryFn: fetchFedProjections, ...LIVE })
  const { data: sepData } = useQuery({ queryKey: ['sep-dots'], queryFn: fetchSepDots })
  const { data: spreadsData } = useQuery({ queryKey: ['curve-spreads'], queryFn: fetchCurveSpreads, ...LIVE })

  const ready = !!curveData && !!fedData
  const failed = curveErr || fedErr

  const adjustedMeetings = fedData?.meetings.map((m: any, i: number) => ({
    ...m,
    base_rate: m.rate,
    adjusted_rate: +(m.rate + (twist / 100) * (FED_WEIGHTS[i] ?? 0.05)).toFixed(2),
  })) ?? []

  const adjustedCurve = curveData ? YC_TENORS.map((t, i) => ({
    tenor: t,
    current: curveData.curve[t] ?? 0,
    adjusted: +Math.max(0.1, (curveData.curve[t] ?? 0) + (twist / 100) * YC_WEIGHTS[i]).toFixed(3),
  })) : []

  const curveChart = curveData ? CURVE_TENORS.filter(t => curveData.curve[t] != null).map(t => ({
    tenor: t,
    today: curveData.curve[t] ?? null,
    d1: curveData.curve_1d?.[t] ?? null,
    m1: curveData.curve_1m?.[t] ?? null,
    m6: curveData.curve_6m?.[t] ?? null,
    adjusted: twist !== 0 ? +Math.max(0.1, (curveData.curve[t] ?? 0) + (twist / 100) * (TWIST_W[t] ?? 0.1)).toFixed(3) : null,
  })) : []

  const getTenorVal = (tenor: string) => {
    if (!curveData) return 0
    if (twist === 0) return curveData.curve[tenor] ?? 0
    const weight = TWIST_W[tenor] ?? 0.1
    return Math.max(0.1, (curveData.curve[tenor] ?? 0) + (twist / 100) * weight)
  }

  // Header inline stats for the fed-path band.
  const m0 = adjustedMeetings[0]
  const yEnd = adjustedMeetings.find((m: any) => m.date.startsWith('2027-01')) ?? adjustedMeetings[4]
  const totalMove = adjustedMeetings.length >= 2
    ? (adjustedMeetings.at(-1).adjusted_rate - adjustedMeetings[0].adjusted_rate) * 100 : 0
  const dBp = (m: any) => m ? Math.round((m.adjusted_rate - m.base_rate) * 100) : 0

  // Countdown to the next FOMC meeting.
  let fomcLabel = '', fomcDays = ''
  if (fedData?.next_meeting_date) {
    const d = new Date(fedData.next_meeting_date + 'T00:00:00')
    fomcLabel = `${MONTHS[d.getMonth()]} ${d.getDate()}`
    const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000))
    fomcDays = `${days}D`
  }

  // Dot-plot caption: where the market prices year-end vs the near SEP median.
  let sepCaption: React.ReactNode = null
  const sy = sepData?.years?.[0]
  if (sy && sy.market != null && sy.median != null) {
    const bp = Math.round((sy.market - sy.median) * 100)
    sepCaption = <>Market prices year-end <b style={{ color: T.blue }}>{Math.abs(bp)} bp {bp >= 0 ? 'above' : 'below'}</b> the {sy.year} SEP median.</>
  }
  let sepVintage = ''
  if (sepData?.vintage) {
    const d = new Date(sepData.vintage + 'T00:00:00')
    sepVintage = `${MONTHS[d.getMonth()]} ${d.getFullYear()} SEP`
  }

  return (
    <div style={{ maxWidth: 1560, margin: '0 auto', border: `1px solid ${T.border}`, background: T.bg }}>
      {/* Band 1 — header */}
      <div style={{ padding: '13px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, letterSpacing: '0.22em', color: T.gold }}>RATE ENGINE</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          {fomcLabel && (
            <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.08em', color: T.muted }}>
              NEXT FOMC <span style={{ color: T.text }}>{fomcLabel}</span> · <span style={{ color: T.gold }}>{fomcDays}</span>
            </span>
          )}
          <LiveClock />
        </div>
      </div>

      {/* Band 2 — scenario */}
      <ScenarioBand twist={twist} setTwist={setTwist} />

      {failed ? (
        <div style={{ ...band, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320, fontFamily: T.label, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.neg }}>
          Rate data is unavailable right now. Try again shortly.
        </div>
      ) : !ready ? (
        <div style={{ ...band, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320, fontFamily: T.label, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
          Loading rate engine
        </div>
      ) : (
        <>
          {/* Bands 3 + 4 need the implied path; skip both if it's empty. */}
          {adjustedMeetings.length > 0 && (
            <>
              {/* Band 3 — fed funds path */}
              <div style={band}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={bandTitle}>Market-Implied Fed Funds Rate Path</span>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                    <InlineStat label="Next Meeting" value={`${m0.adjusted_rate.toFixed(2)}%`} delta={twist ? `${dBp(m0) >= 0 ? '+' : ''}${dBp(m0)}` : undefined} deltaPos={dBp(m0) >= 0} />
                    {yEnd && <InlineStat label={yEnd.date} value={`${yEnd.adjusted_rate.toFixed(2)}%`} delta={twist ? `${dBp(yEnd) >= 0 ? '+' : ''}${dBp(yEnd)}` : undefined} deltaPos={dBp(yEnd) >= 0} />}
                    <InlineStat label="Total Move" value={`${totalMove > 0 ? '+' : ''}${totalMove.toFixed(0)} bps`} />
                  </div>
                </div>
                <div style={{ height: 400 }}><FedPathChart meetings={adjustedMeetings} twist={twist} /></div>
              </div>

              {/* Band 4 — meeting odds */}
              <OddsStrip meetings={adjustedMeetings} />
            </>
          )}

          {/* Band 5 — yield curve */}
          <div style={band}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={bandTitle}>US Treasury Yield Curve</span>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
                {/* Spreads */}
                <div style={{ display: 'flex', gap: 12, marginRight: 8, borderRight: `1px solid ${T.borderFaint}`, paddingRight: 12 }}>
                  {(() => {
                    const ten10Y = getTenorVal('10Y')
                    const ten2Y = getTenorVal('2Y')
                    const ten3M = getTenorVal('3M')
                    const spread10Y2Y = ten10Y - ten2Y
                    const spread10Y3M = ten10Y - ten3M
                    return (
                      <>
                        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.gold }}>10Y-2Y</span>
                          <span style={{ fontFamily: T.mono, fontSize: 11.5, fontWeight: 700, color: spread10Y2Y >= 0 ? T.pos : T.neg }}>
                            {(spread10Y2Y * 100).toFixed(0)}bp
                          </span>
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.gold }}>10Y-3M</span>
                          <span style={{ fontFamily: T.mono, fontSize: 11.5, fontWeight: 700, color: spread10Y3M >= 0 ? T.pos : T.neg }}>
                            {(spread10Y3M * 100).toFixed(0)}bp
                          </span>
                        </span>
                      </>
                    )
                  })()}
                </div>
                {/* Tenors */}
                {adjustedCurve.map(a => {
                  const d = twist ? Math.round((a.adjusted - a.current) * 100) : null
                  return (
                    <span key={a.tenor} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>{a.tenor}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{(twist ? a.adjusted : a.current).toFixed(2)}</span>
                      {d != null && d !== 0 && <span style={{ fontFamily: T.mono, fontSize: 9, color: d > 0 ? T.gold : '#8099b0' }}>{d > 0 ? '+' : ''}{d}</span>}
                    </span>
                  )
                })}
              </div>
            </div>
            <div style={{ height: 220 }}><YieldCurveChart rows={curveChart} twist={twist} /></div>
          </div>

          {/* Band 6 — dot plot + spreads */}
          <div style={{ ...band, display: 'grid', gridTemplateColumns: 'minmax(0, 55fr) minmax(0, 45fr)', gap: 28 }} className="rate-split">
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={bandTitle}>FOMC Dot Plot — SEP Projections vs Market</span>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  {sepVintage && <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: '0.1em', color: T.muted }}>{sepVintage}</span>}
                  <span style={{ display: 'inline-flex', gap: 12, fontFamily: T.label, fontSize: 8.5, letterSpacing: '0.06em', color: T.muted }}>
                    <span><span style={{ color: T.gold }}>—</span> MEDIAN</span>
                    <span><span style={{ color: '#5e768f' }}>▮</span> CT / RANGE</span>
                    <span><span style={{ color: T.blue }}>◆</span> MARKET</span>
                  </span>
                </div>
              </div>
              {sepData?.years?.length ? <DotPlot data={sepData} /> : <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T.mono, fontSize: 11, color: T.muted }}>SEP projections unavailable.</div>}
              {sepCaption && <div style={{ fontFamily: T.label, fontSize: 11, color: T.muted, marginTop: 8 }}>{sepCaption}</div>}
            </div>
            <div>
              <div style={{ ...bandTitle, marginBottom: 8 }}>Curve Spreads — 6M Trend</div>
              {spreadsData?.spreads?.length ? <SpreadsPanel spreads={spreadsData.spreads} /> : <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T.mono, fontSize: 11, color: T.muted }}>Spread history unavailable.</div>}
              {spreadsData?.spreads?.length > 0 && (() => {
                const sp = spreadsData.spreads
                const chg = (s: any) => (s.current != null && s.history?.length) ? s.current - s.history[0].bp : 0
                const steep = sp.filter((s: any) => chg(s) > 0).length
                const allPos = sp.every((s: any) => (s.current ?? 0) > 0)
                const dir = steep === sp.length ? 'all steepening' : steep === 0 ? 'all flattening' : `${steep} steepening, ${sp.length - steep} flattening`
                return <div style={{ fontFamily: T.label, fontSize: 11, color: T.muted, marginTop: 8 }}>{allPos ? 'All three spreads are positive' : 'Spreads mixed in sign'} · {dir} over the last six months.</div>
              })()}
            </div>
          </div>

          {/* Band 6c — FOMC statement AI read */}
          <FomcStatementRead />

          {/* Band 7 — disclaimer */}
          <div style={{ padding: '10px 24px', borderTop: `1px solid ${T.borderFaint}`, fontFamily: T.label, fontSize: 10, color: T.muted }}>
            Informational and educational purposes only. Not investment advice. <Link to="/risk-disclosure" style={{ color: T.muted, textDecoration: 'underline' }}>Full disclaimer</Link>
          </div>
        </>
      )}
      <style>{`@media (max-width: 1080px) { .rate-split { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  )
}

export default function FedRates() {
  return <PageWrapper><FedRatesContent /></PageWrapper>
}
