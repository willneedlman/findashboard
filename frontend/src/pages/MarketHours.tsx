import { useEffect, useState } from 'react'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import MarketSessions from '../components/MarketSessions'
import { MARKETS, marketStatus } from '../lib/marketHours'

const T = {
  text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)',
  faint: 'var(--theme-text-faint, rgba(255,255,255,0.35))', gold: 'var(--theme-primary, #c9a84c)',
  pos: 'var(--theme-positive, #22c55e)', border: 'var(--theme-border, rgba(255,255,255,0.08))',
  surface: 'var(--theme-surface, #0d1826)', mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

export function MarketHoursContent() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const openCount = MARKETS.filter(m => marketStatus(m, now).open).length
  const localTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <>
      <PageHeader
        title="Market Hours"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontFamily: T.sans, fontSize: 10, color: T.muted }}>
              <span style={{ color: T.pos, fontWeight: 700 }}>{openCount}</span> of {MARKETS.length} trading
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.gold, fontVariantNumeric: 'tabular-nums' }}>{localTime}</span>
            <span style={{ fontFamily: T.sans, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.faint }}>{localZone}</span>
          </div>
        }
      />

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 14, marginBottom: 12 }}>
        {[
          ['Open', '#22c55e'], ['Pre / After', '#c9a84c'], ['Overnight', '#5b8fd6'],
          ['Lunch break', '#7c93ac'], ['Closed', '#33415a'],
        ].map(([label, c]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 22, height: 8, borderRadius: 2, background: c }} />
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>{label}</span>
          </span>
        ))}
      </div>

      <div style={{ background: '#0c1727', border: '1px solid rgba(255,255,255,0.07)', padding: '24px 26px' }}>
        <MarketSessions />
      </div>

      <div style={{ marginTop: 14, padding: '10px 12px', background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.sans, fontSize: 10, color: T.faint, lineHeight: '16px' }}>
        Sessions are computed from each exchange's regular schedule and timezone, updated live. The 24h bar shows the trading day in the market's own local time, with the line marking now. Exchange holidays and ad-hoc halts are not reflected.
      </div>
    </>
  )
}

export default function MarketHours() {
  return <PageWrapper><MarketHoursContent /></PageWrapper>
}
