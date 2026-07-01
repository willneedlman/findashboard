import { useEffect, useRef, useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import MarketSessions from '../../MarketSessions'
import MarketDial from '../../MarketDial'

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

  const layout = config.layout ?? 'clock'
  return (
    <div ref={ref} style={{ height: '100%', overflow: layout === 'clock' ? 'hidden' : 'auto', padding: layout === 'clock' ? 6 : '8px 10px' }}>
      {layout === 'clock' ? <MarketDial showLegend={wide} /> : <MarketSessions compact />}
    </div>
  )
}
