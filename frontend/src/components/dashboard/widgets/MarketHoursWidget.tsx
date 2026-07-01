import type { WidgetConfig } from '../../../hooks/useDashboard'
import MarketSessions from '../../MarketSessions'

// Compact global session clock for the dashboard. All logic lives in
// MarketSessions / lib/marketHours; this just hosts the compact variant.
export default function MarketHoursWidget(_props: { config: WidgetConfig }) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '8px 10px' }}>
      <MarketSessions compact />
    </div>
  )
}
