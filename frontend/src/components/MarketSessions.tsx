import { useEffect, useState } from 'react'
import {
  MARKETS, marketStatus, daySegments, countdown,
  PHASE_LABEL, PHASE_COLOR, PHASE_OPACITY, PHASE_TEXT, type MarketDef, type Region, type Phase,
} from '../lib/marketHours'

const T = {
  bg: '#101c2e', track: '#0a1524',
  border: 'rgba(255,255,255,0.05)', text: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #8099b0)', faint: '#3f5268', scale: '#41556b',
  gold: 'var(--theme-primary, #c9a84c)', verb: '#4b5f75', when: '#647a93',
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

function TimelineBar({ m, weekday, localTime }: { m: MarketDef; weekday: number; localTime: string }) {
  const segs = daySegments(m, weekday)
  const [h, mn] = localTime.split(':').map(Number)
  const nowPct = ((h * 60 + mn) / 1440) * 100
  return (
    <div style={{ position: 'relative', height: 16, borderRadius: 3, background: T.track, overflow: 'hidden', backgroundImage: HOUR_TICKS }}>
      {segs.map((s, i) => s.phase === 'closed' ? null : (
        <div key={i} style={{
          position: 'absolute', top: 0, bottom: 0,
          left: `${(s.start / 1440) * 100}%`, width: `${((s.end - s.start) / 1440) * 100}%`,
          background: PHASE_COLOR[s.phase], opacity: PHASE_OPACITY[s.phase],
        }} />
      ))}
      <div className="fdb-now-marker" style={{
        position: 'absolute', top: -2, bottom: -2, left: `${nowPct}%`, width: 2,
        background: '#f4f8ff', boxShadow: '0 0 8px 1px rgba(244,248,255,0.8)',
      }} />
    </div>
  )
}

export default function MarketSessions({ compact = false }: { compact?: boolean }) {
  const now = useNow(1000)

  if (compact) {
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
                    <span style={{ fontFamily: T.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: PHASE_TEXT[st.phase], flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{PHASE_LABEL[st.phase]}</span>
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
                  <TimelineBar m={m} weekday={st.weekday} localTime={st.localTime} />
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
