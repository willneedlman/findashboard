import { useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import ToolTabs, { type ToolTab } from '../components/ToolTabs'
import { IVTrackerContent } from './IVTracker'
import { SkewToolContent } from './SkewTool'

// Consolidated Implied Volatility tool: IV rank + term structure (formerly IV
// Tracker) and skew/smile (formerly Volatility Skew) as two tabs. Tab persists
// in ?tab= so /skew can redirect straight to the skew view.
const TABS: ToolTab[] = [
  { key: 'rank', label: 'IV Rank & Term' },
  { key: 'skew', label: 'Volatility Skew' },
]

export default function ImpliedVolatility() {
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') === 'skew' ? 'skew' : 'rank'
  const setTab = (k: string) => setSp(prev => {
    const n = new URLSearchParams(prev); n.set('tab', k); return n
  }, { replace: true })

  return (
    <PageWrapper title="Implied Volatility">
      <ToolTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'skew' ? <SkewToolContent /> : <IVTrackerContent />}
    </PageWrapper>
  )
}
