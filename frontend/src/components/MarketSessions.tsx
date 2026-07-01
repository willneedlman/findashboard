import { useEffect, useState } from 'react'
import {
  MARKETS, marketStatus, daySegments, countdown,
  PHASE_LABEL, PHASE_COLOR, type MarketDef, type Region, type Phase,
} from '../lib/marketHours'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', text: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #8099b0)', faint: 'var(--theme-text-faint, rgba(255,255,255,0.35))',
  gold: 'var(--theme-primary, #c9a84c)', mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

const REGIONS: Region[] = ['Futures', 'Americas', 'Europe', 'Asia-Pacific']

// Single shared clock so every row updates on the same tick.
function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function StatusPill({ phase }: { phase: Phase }) {
  const c = PHASE_COLOR[phase]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.sans, fontSize: 9, fontWeight: 700,
      letterSpacing: '0.08em', textTransform: 'uppercase', color: c, whiteSpace: 'nowrap',
      background: `color-mix(in srgb, ${c} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)`,
      padding: '2px 7px', borderRadius: 2,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, flex: 'none' }} />
      {PHASE_LABEL[phase]}
    </span>
  )
}

// 24h timeline in the market's local time: session segments + a "now" marker.
function TimelineBar({ m, weekday, localTime }: { m: MarketDef; weekday: number; localTime: string }) {
  const segs = daySegments(m, weekday)
  const [h, mn] = localTime.split(':').map(Number)
  const nowPct = ((h * 60 + mn) / 1440) * 100
  return (
    <div style={{ position: 'relative', height: 8, background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 6%, transparent)', borderRadius: 2 }}>
      {segs.map((s, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0, bottom: 0, left: `${(s.start / 1440) * 100}%`, width: `${((s.end - s.start) / 1440) * 100}%`,
          background: PHASE_COLOR[s.phase], opacity: s.phase === 'closed' ? 0 : 0.7,
        }} />
      ))}
      <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${nowPct}%`, width: 1.5, background: T.text, boxShadow: '0 0 4px rgba(255,255,255,0.6)' }} />
    </div>
  )
}

function nextLabel(phase: Phase, nextPhase: Phase): string {
  const trading = (p: Phase) => p === 'regular' || p === 'pre' || p === 'after' || p === 'overnight'
  if (trading(phase) && !trading(nextPhase)) return 'closes'
  if (!trading(phase) && trading(nextPhase)) return 'opens'
  return PHASE_LABEL[nextPhase].toLowerCase()
}

export default function MarketSessions({ compact = false }: { compact?: boolean }) {
  const now = useNow(1000)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 10 }}>
      {REGIONS.map(region => {
        const markets = MARKETS.filter(m => m.region === region)
        return (
          <div key={region}>
            <div style={{
              fontFamily: T.sans, fontSize: compact ? 8 : 9, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: T.faint, marginBottom: compact ? 3 : 6, paddingLeft: 1,
            }}>
              {region}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 6 }}>
              {markets.map(m => {
                const st = marketStatus(m, now)
                return compact ? (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 2px' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: PHASE_COLOR[st.phase], flex: 'none', opacity: st.open ? 1 : 0.5 }} />
                    <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text, width: 52, flex: 'none' }}>{m.short}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, width: 56, flex: 'none' }}>{st.localTime.slice(0, 5)}</span>
                    <span style={{ fontFamily: T.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: PHASE_COLOR[st.phase], flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {PHASE_LABEL[st.phase]}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint, flex: 'none' }}>{nextLabel(st.phase, st.nextPhase)} {countdown(st.msToNext)}</span>
                  </div>
                ) : (
                  <div key={m.id} style={{
                    display: 'grid', gridTemplateColumns: '160px 88px 130px 1fr 150px', alignItems: 'center', gap: 14,
                    padding: '10px 12px', background: T.bg, border: `1px solid ${T.border}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.gold }}>{m.short}</span>
                      <span style={{ fontFamily: T.sans, fontSize: 10, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: st.open ? T.text : T.muted, fontVariantNumeric: 'tabular-nums' }}>{st.localTime}</span>
                    <StatusPill phase={st.phase} />
                    <TimelineBar m={m} weekday={st.weekday} localTime={st.localTime} />
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, textAlign: 'right' }}>
                      {nextLabel(st.phase, st.nextPhase)} in {countdown(st.msToNext)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
