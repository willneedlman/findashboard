import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import MarketSessions from '../../MarketSessions'
import MarketDial from '../../MarketDial'
import { T } from '../../../lib/theme'

interface SessionStatus {
  label: string
  is_open: boolean
  holiday: string | null
  early_close: boolean
}

// Market Hours widget. Layout ('clock' dial vs 'rows') is chosen from the toggle
// in the WidgetFrame header and persisted in WidgetConfig (default 'clock').
// Dial shows its ring legend only when the tile is wide enough; rows use the
// compact session list.
export default function MarketHoursWidget({ config }: { config: WidgetConfig }) {
  const ref = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 560))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const { data: session } = useQuery<SessionStatus>({
    queryKey: ['market-session'],
    queryFn: () => axios.get('/api/market/session').then(response => response.data),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  })

  const layout = config.layout ?? 'clock'
  const detail = session?.holiday ?? (session?.early_close ? '1:00 PM close' : null)
  return (
    <div ref={ref} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: layout === 'clock' ? 'hidden' : 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 9px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted }}>US CASH SESSION</span>
        <span style={{ fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, color: session?.is_open ? T.pos : T.gold }}>
          {session ? session.label.toUpperCase() : 'SYNCING'}{detail ? ` | ${detail}` : ''}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: layout === 'clock' ? 6 : '8px 10px' }}>
        {layout === 'clock' ? <MarketDial showLegend={wide} /> : <MarketSessions compact />}
      </div>
    </div>
  )
}
