import { useEffect, useState, type MouseEvent } from 'react'
import {
  MARKETS, marketStatus, localArcs, localNowHours, countdown,
  PHASE_LABEL, PHASE_COLOR, PHASE_OPACITY, PHASE_TEXT, type MarketDef, type Region, type Phase,
} from '../lib/marketHours'
import useIsMobile from '../hooks/useIsMobile'

const T = {
  bg: 'var(--theme-bg, #101c2e)', track: 'color-mix(in srgb, var(--theme-bg, #101c2e) 55%, #000 45%)',
  border: 'var(--theme-border-faint, rgba(255,255,255,0.05))', text: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #8099b0)', faint: 'var(--theme-text-faint, #3f5268)', scale: 'var(--theme-text-faint, #41556b)',
  gold: 'var(--theme-primary, #c9a84c)', verb: 'var(--theme-text-faint, #4b5f75)', when: 'var(--theme-secondary, #647a93)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

const REGIONS: Region[] = ['Futures', 'Americas', 'Europe', 'Asia-Pacific']
const GRID = '150px 92px 128px 1fr 132px'
const HOUR_TICKS = 'repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px calc(100%/24))'

function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), ms); return () => clearInterval(id) }, [ms])
  return now
}

function nextVerb(phase: Phase, nextPhase: Phase): string {
  const trading = (p: Phase) => p === 'regular' || p === 'pre' || p === 'after' || p === 'overnight'
  if (trading(phase) && !trading(nextPhase)) return 'closes'
  if (!trading(phase) && trading(nextPhase)) return 'opens'
  if (phase === 'regular' && nextPhase === 'break') return 'halts'
  if (phase === 'break') return 'reg opens'
  return PHASE_LABEL[nextPhase].toLowerCase()
}

// The bar spans the viewer's local 24h clock, so an x-fraction maps straight to a
// wall-clock time in the viewer's zone — same axis as the 00..24 scale above.
function hoverTime(pct: number): string {
  const hours = (pct / 100) * 24
  if (hours >= 24) return '24:00'
  const hh = Math.floor(hours)
  const mm = Math.floor(hours * 60) % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// Phase key for the timeline colors. pre and after share one swatch (same fill).
const LEGEND: { label: string; phase: Phase }[] = [
  { label: 'Open', phase: 'regular' },
  { label: 'Pre / After-hours', phase: 'pre' },
  { label: 'Overnight', phase: 'overnight' },
  { label: 'Lunch break', phase: 'break' },
  { label: 'Closed', phase: 'closed' },
]

function PhaseLegend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
      {LEGEND.map(({ label, phase }) => (
        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: PHASE_COLOR[phase], opacity: PHASE_OPACITY[phase], flex: 'none' }} />
          {label}
        </span>
      ))}
    </div>
  )
}

function TimelineBar({ m, now, holiday }: { m: MarketDef; now: Date; holiday?: string }) {
  // Plot every market on the viewer's shared 24h clock (absolute time) so
  // simultaneous opens line up across rows — e.g. Tokyo/Seoul/Sydney all open at
  // 00:00 UTC. Reuses localArcs(), the same source of truth the dial draws from,
  // so the two surfaces can never drift apart again. A session that straddles
  // viewer midnight comes back as two arcs (splitWrap), rendered as two bars.
  const arcs = localArcs(m, now)
  const nowPct = (localNowHours(now) / 24) * 100
  const [hover, setHover] = useState<number | null>(null)
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setHover(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)))
  }
  return (
    <div style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <div style={{ position: 'relative', height: 16, borderRadius: 3, background: T.track, overflow: 'hidden', backgroundImage: HOUR_TICKS }}>
        {arcs.map((a, i) => (
          <div key={i} style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${(a.t0 / 24) * 100}%`, width: `${((a.t1 - a.t0) / 24) * 100}%`,
            background: PHASE_COLOR[a.phase], opacity: PHASE_OPACITY[a.phase],
          }} />
        ))}
        {holiday && (
          <span style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: arcs.length ? 'flex-end' : 'center', paddingRight: arcs.length ? 8 : 0,
            fontFamily: T.sans, fontSize: 9, fontWeight: 600, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: T.when, pointerEvents: 'none',
          }}>{arcs.length ? `early close · ${holiday}` : holiday}</span>
        )}
        <div className="fdb-now-marker" style={{
          position: 'absolute', top: -2, bottom: -2, left: `${nowPct}%`, width: 2,
          background: '#f4f8ff', boxShadow: '0 0 8px 1px rgba(244,248,255,0.8)',
        }} />
        {hover !== null && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${hover}%`, width: 1, background: 'rgba(244,248,255,0.55)', pointerEvents: 'none' }} />
        )}
      </div>
      {hover !== null && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 4px)', left: `${hover}%`, transform: 'translateX(-50%)',
          fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.text, background: T.track,
          border: `1px solid ${T.border}`, borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap',
          pointerEvents: 'none', zIndex: 5,
        }}>{hoverTime(hover)}</div>
      )}
    </div>
  )
}

export default function MarketSessions({ compact = false }: { compact?: boolean }) {
  const now = useNow(1000)
  const isMobile = useIsMobile()

  if (compact || isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {REGIONS.map(region => (
          <div key={region}>
            <div style={{ fontFamily: T.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.faint, marginBottom: 3, paddingLeft: 1 }}>{region}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {MARKETS.filter(m => m.region === region).map(m => {
                const st = marketStatus(m, now)
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 2px' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: PHASE_COLOR[st.phase], flex: 'none', opacity: st.open ? 1 : 0.5 }} />
                    <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text, width: 52, flex: 'none' }}>{m.short}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, width: 56, flex: 'none' }}>{st.localTime.slice(0, 5)}</span>
                    <span style={{ fontFamily: T.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: PHASE_TEXT[st.phase], flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.phase === 'holiday' ? st.holiday : PHASE_LABEL[st.phase]}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 9, color: T.verb, flex: 'none' }}>{nextVerb(st.phase, st.nextPhase)} {countdown(st.msToNext)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Hour scale, aligned to the bar column only */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <span /><span /><span />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.mono, fontSize: 10, color: T.scale, letterSpacing: '0.05em' }}>
          {['00', '04', '08', '12', '16', '20', '24'].map(h => <span key={h}>{h}</span>)}
        </div>
        <span />
      </div>

      {/* Phase color key, aligned under the timeline bars */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <span /><span /><span />
        <PhaseLegend />
        <span />
      </div>

      {REGIONS.map(region => (
        <div key={region} style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.faint, marginBottom: 8 }}>{region}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {MARKETS.filter(m => m.region === region).map(m => {
              const st = marketStatus(m, now)
              const c = PHASE_TEXT[st.phase]
              return (
                <div key={m.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 14, padding: '9px 12px', background: T.bg, border: `1px solid ${T.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.gold }}>{m.short}</span>
                    <span style={{ fontFamily: T.sans, fontSize: 11, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                  </div>
                  <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums' }}>{st.localTime}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start', fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: c, border: `1px solid ${c}`, background: 'rgba(255,255,255,0.03)', padding: '3px 9px', borderRadius: 2 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />{PHASE_LABEL[st.phase]}
                  </span>
                  <TimelineBar m={m} now={now} holiday={st.holiday} />
                  <span style={{ fontFamily: T.mono, fontSize: 12, textAlign: 'right' }}>
                    <span style={{ color: T.verb, textTransform: 'uppercase' }}>{nextVerb(st.phase, st.nextPhase)}</span>{' '}
                    <span style={{ color: T.when }}>{countdown(st.msToNext)}</span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
