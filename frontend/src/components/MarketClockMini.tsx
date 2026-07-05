import { useEffect, useState } from 'react'
import { MARKETS, SUN_ORDER, marketStatus, localArcs, localNowHours, localClock, localTzLabel, PHASE_COLOR, type MarketDef, type Phase } from '../lib/marketHours'

// Home "24-hour dial" widget. Concentric per-market session rings on a shared axis
// drawn in the viewer's own local timezone, a gold now-needle, and a key of market
// chips. A single shared hover state
// (hoveredMarket) drives ring dimming, chip highlight, and the readout — hovering
// any ring OR its chip isolates that market everywhere. Reuses lib/marketHours.
const T = {
  text: 'var(--theme-text, #eaf0f8)', muted: 'var(--theme-secondary, #8099b0)',
  muted2: 'var(--theme-text-faint, #5e768f)',
  track: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 12%, transparent)',
  gold: 'var(--theme-primary, #c9a84c)', needle: 'var(--theme-primary, #c9a84c)',
  closedDot: 'var(--theme-text-faint, #3a4a63)',
  mono: 'var(--theme-mono)',
  sans: 'var(--theme-sans)',
}

const CX = 230, CY = 230
const polar = (r: number, t: number): [number, number] => {
  const a = (t / 24 * 360 - 90) * Math.PI / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}
const arcPath = (r: number, t0: number, t1: number): string => {
  const [x0, y0] = polar(r, t0), [x1, y1] = polar(r, t1)
  const large = (t1 - t0) > 12 ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
const RADIUS = (i: number) => 70 + i * 12

function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), ms); return () => clearInterval(id) }, [ms])
  return now
}

const byId = Object.fromEntries(MARKETS.map(m => [m.id, m])) as Record<string, MarketDef>
const RINGS = SUN_ORDER.map(id => byId[id]).filter(Boolean)

const statusText = (phase: Phase): string =>
  phase === 'regular' ? 'OPEN' : phase === 'overnight' ? 'OVERNIGHT' : phase === 'pre' ? 'PRE-MARKET' : phase === 'after' ? 'AFTER-HOURS' : phase === 'break' ? 'LUNCH' : phase === 'holiday' ? 'HOLIDAY' : 'CLOSED'

export default function MarketClockMini() {
  const now = useNow(1000)
  const [hovered, setHovered] = useState<number | null>(null)

  const states = RINGS.map(m => marketStatus(m, now))
  const openCount = states.filter(s => s.open).length
  const nowH = localNowHours(now)
  const [nx, ny] = polar(198, nowH)
  const clock = localClock(now)
  const tzLabel = localTzLabel(now)

  const read = hovered != null
    ? {
        code: RINGS[hovered].short,
        name: states[hovered].phase === 'holiday' && states[hovered].holiday ? states[hovered].holiday! : RINGS[hovered].name,
        status: statusText(states[hovered].phase), color: PHASE_COLOR[states[hovered].phase],
      }
    : { code: `${openCount} OF ${RINGS.length}`, name: 'trading now', status: 'LIVE', color: PHASE_COLOR.regular }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <span style={{ fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', color: T.muted }}>24-HOUR DIAL · {tzLabel}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}><span style={{ color: PHASE_COLOR.regular, fontWeight: 700 }}>{openCount}</span>/{RINGS.length}</span>
      </div>

      <svg viewBox="0 0 460 460" style={{ width: '100%', maxWidth: 300, display: 'block' }}>
        {RINGS.map((m, i) => {
          const r = RADIUS(i)
          const on = hovered == null || hovered === i
          return (
            <g key={m.id} style={{ opacity: on ? 1 : 0.16, transition: 'opacity 140ms ease', cursor: 'pointer' }}
              onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
              <circle cx={CX} cy={CY} r={r} fill="none" stroke={T.track} strokeWidth={9} />
              {localArcs(m, now).map((a, j) => (
                <path key={j} d={arcPath(r, a.t0, a.t1)} fill="none" stroke={PHASE_COLOR[a.phase]} strokeWidth={9} strokeLinecap="round" />
              ))}
              <circle cx={CX} cy={CY} r={r} fill="none" stroke="transparent" strokeWidth={13} pointerEvents="stroke" />
            </g>
          )
        })}
        <line x1={CX} y1={CY} x2={nx.toFixed(1)} y2={ny.toFixed(1)} stroke={T.needle} strokeWidth={2} strokeLinecap="round" />
        <circle cx={nx.toFixed(1)} cy={ny.toFixed(1)} r={9} fill={T.needle} opacity={0.22} />
        <circle cx={nx.toFixed(1)} cy={ny.toFixed(1)} r={5} fill={T.needle} />
        <circle cx={CX} cy={CY} r={54} fill="var(--theme-bg, #090e16)" />
        <text x={CX} y={CY + 2} textAnchor="middle" fontFamily={T.mono} fontSize={32} fontWeight={700} fill={T.needle} style={{ fontVariantNumeric: 'tabular-nums' }}>{clock}</text>
        <text x={CX} y={CY + 22} textAnchor="middle" fontFamily={T.mono} fontSize={10} letterSpacing="2" fill={T.muted2}>{tzLabel} · NOW</text>
      </svg>

      {/* Readout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', justifyContent: 'center' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: read.color, flex: 'none' }} />
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{read.code}</span>
        <span style={{ fontFamily: T.sans, fontSize: 12, color: T.muted, flex: 'none' }}>{read.name}</span>
        <span style={{ fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: read.color }}>{read.status}</span>
      </div>

      {/* Key */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', justifyContent: 'center' }}>
        {RINGS.map((m, i) => {
          const st = states[i]
          const dot = st.phase === 'regular' ? PHASE_COLOR.regular : st.phase === 'overnight' ? PHASE_COLOR.overnight : st.open ? PHASE_COLOR.pre : T.closedDot
          const active = hovered === i
          return (
            <button key={m.id} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(i)} onBlur={() => setHovered(null)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              <span style={{ width: active ? 8 : 6, height: active ? 8 : 6, borderRadius: '50%', background: dot, transition: 'all 120ms ease' }} />
              <span style={{ fontFamily: T.mono, fontSize: 12, color: active ? T.text : T.muted, transition: 'color 120ms ease' }}>{m.short}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
