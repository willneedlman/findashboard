import { useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import ToolTabs, { type ToolTab } from '../components/ToolTabs'
import { CorporateHubContent } from './CorporateHub'
import { EarningsCalendarContent } from './EarningsCalendar'

// Consolidated Market Calendar: corporate catalysts (formerly Corporate Calendar,
// which keeps its own Radar/Timeline sub-toggle) and the earnings calendar
// (formerly Earnings Calendar) as two tabs. Tab persists in ?tab= so
// /earnings-calendar can redirect straight to the earnings view.
const TABS: ToolTab[] = [
  { key: 'catalysts', label: 'Catalysts' },
  { key: 'earnings', label: 'Earnings' },
]

export default function MarketCalendar() {
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') === 'earnings' ? 'earnings' : 'catalysts'
  const setTab = (k: string) => setSp(prev => {
    const n = new URLSearchParams(prev); n.set('tab', k); return n
  }, { replace: true })

  return (
    <PageWrapper title="Market Calendar">
      <ToolTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'earnings' ? <EarningsCalendarContent /> : <CorporateHubContent />}
    </PageWrapper>
  )
}
