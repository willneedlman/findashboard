import { useEffect, useState } from 'react'
import {
  MARKETS, SUN_ORDER, marketStatus, utcArcs, utcNowHours,
  PHASE_COLOR, PHASE_OPACITY, PHASE_TEXT, PHASE_LABEL, type MarketDef,
} from '../lib/marketHours'

const T = {
  text: 'var(--theme-text, #d7e3fc)', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #8099b0)', faint: 'var(--theme-text-faint, #41556b)', dim: 'var(--theme-text-faint, #3f5268)',
  hand: 'var(--theme-primary, #c9a84c)', hub: 'var(--theme-bg, #0a1524)', track: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 12%, transparent)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

const CX = 300, CY = 300
const polar = (r: number, t: number): [number, number] => {
  const a = (t / 24 * 360 - 90) * Math.PI / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}
const arcPath = (r: number, t0: number, t1: number): string => {
  const [x0, y0] = polar(r, t0), [x1, y1] = polar(r, t1)
  const large = (t1 - t0) > 12 ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), ms); return () => clearInterval(id) }, [ms])
  return now
}

const byId = Object.fromEntries(MARKETS.map(m => [m.id, m])) as Record<string, MarketDef>
const RINGS = SUN_ORDER.map(id => byId[id]).filter(Boolean)

export default function MarketDial({ showLegend = false }: { showLegend?: boolean }) {
  const now = useNow(1000)
  // Shared hover state (same mechanism as the Home dial): hovering a ring or a
  // legend row isolates that market on the dial and swaps the hub readout.
  const [hovered, setHovered] = useState<number | null>(null)
  const nowH = utcNowHours(now)
  const [hx1, hy1] = polar(108, nowH)
  const [hx2, hy2] = polar(272, nowH)
  const utc = new Date(now.getTime())
  const utcClock = `${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}`
  const states = RINGS.map(m => marketStatus(m, now))
  const hov = hovered != null ? { m: RINGS[hovered], st: states[hovered] } : null

  const dial = (
    <svg viewBox="0 0 600 600" style={{ display: 'block', width: '100%', height: '100%' }}>
      {RINGS.map((m, i) => {
        const r = 128 + i * 12.5
        const on = hovered == null || hovered === i
        return (
          <g key={m.id} style={{ opacity: on ? 1 : 0.16, transition: 'opacity 140ms ease', cursor: 'pointer' }}
            onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <circle cx={CX} cy={CY} r={r} fill="none" stroke={T.track} strokeWidth={9} />
            {utcArcs(m, now).map((a, j) => (
              <path key={j} d={arcPath(r, a.t0, a.t1)} fill="none"
                stroke={PHASE_COLOR[a.phase]} strokeOpacity={PHASE_OPACITY[a.phase]} strokeWidth={9} />
            ))}
            <circle cx={CX} cy={CY} r={r} fill="none" stroke="transparent" strokeWidth={13} pointerEvents="stroke" />
          </g>
        )
      })}
      {[0, 3, 6, 9, 12, 15, 18, 21].map(t => {
        const [x, y] = polar(288, t)
        return <text key={t} x={x.toFixed(1)} y={(y + 5).toFixed(1)} textAnchor="middle" fontFamily={T.mono} fontSize={14} fill={T.faint}>{String(t).padStart(2, '0')}</text>
      })}
      <line x1={hx1.toFixed(1)} y1={hy1.toFixed(1)} x2={hx2.toFixed(1)} y2={hy2.toFixed(1)} stroke={T.hand} strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={hx2.toFixed(1)} cy={hy2.toFixed(1)} r={5} fill={T.hand} />
      <circle cx={CX} cy={CY} r={70} fill={T.hub} stroke="rgba(255,255,255,0.06)" />
      {hov ? (
        <>
          <text x={CX} y={284} textAnchor="middle" fontFamily={T.mono} fontSize={24} fontWeight={700} fill={T.gold}>{hov.m.short}</text>
          <text x={CX} y={304} textAnchor="middle" fontFamily={T.sans} fontSize={11} fill={T.muted}>{hov.m.name.length > 18 ? hov.m.short : hov.m.name}</text>
          <text x={CX} y={322} textAnchor="middle" fontFamily={T.sans} fontSize={11} fontWeight={700} letterSpacing="1" fill={PHASE_TEXT[hov.st.phase]}>{PHASE_LABEL[hov.st.phase].toUpperCase()}</text>
        </>
      ) : (
        <>
          <text x={CX} y={290} textAnchor="middle" fontFamily={T.mono} fontSize={30} fontWeight={700} fill={T.gold}>{utcClock}</text>
          <text x={CX} y={314} textAnchor="middle" fontFamily={T.sans} fontSize={11} letterSpacing="2" fill={T.dim}>UTC · NOW</text>
        </>
      )}
    </svg>
  )

  if (!showLegend) {
    return <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>{dial}</div>
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 28, alignItems: 'center', height: '100%', padding: 8 }}>
      <div style={{ maxWidth: 460, margin: '0 auto', width: '100%' }}>{dial}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.dim, marginBottom: 8 }}>Rings · inner → outer</div>
        {RINGS.map((m, i) => {
          const st = states[i]
          const active = hovered === i
          return (
            <div key={m.id} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)' : 'transparent', transition: 'background 120ms ease' }}>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, width: 18, flex: 'none' }}>{i + 1}</span>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: PHASE_COLOR[st.phase], flex: 'none', boxShadow: `0 0 6px ${PHASE_COLOR[st.phase]}` }} />
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.gold, width: 46, flex: 'none' }}>{m.short}</span>
              <span style={{ fontFamily: T.sans, fontSize: 12, color: active ? T.text : T.muted, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', transition: 'color 120ms ease' }}>{m.name}</span>
              <span style={{ fontFamily: T.sans, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: PHASE_TEXT[st.phase], flex: 'none' }}>{PHASE_LABEL[st.phase]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
