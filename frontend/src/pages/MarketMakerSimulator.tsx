import { useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import ToolTabs, { type ToolTab } from '../components/ToolTabs'
import { OptionsMarketMakerContent } from './OptionsMarketMaker'
import { FixedIncomeMarketMakerContent } from './FixedIncomeMarketMaker'

// Consolidated Market Maker Simulator: an Options desk and a Fixed Income desk
// as two tabs. Each desk keeps its OWN 5-minute challenge + global leaderboard
// (the underlying content components call their own per-asset endpoints) — the
// leaderboards are intentionally NOT merged. Tab persists in ?desk=.
const TABS: ToolTab[] = [
  { key: 'options', label: 'Options Desk' },
  { key: 'fixed-income', label: 'Fixed Income Desk' },
]

export default function MarketMakerSimulator() {
  const [sp, setSp] = useSearchParams()
  const desk = sp.get('desk') === 'fixed-income' ? 'fixed-income' : 'options'
  const setDesk = (k: string) => setSp(prev => {
    const n = new URLSearchParams(prev); n.set('desk', k); return n
  }, { replace: true })

  return (
    <PageWrapper title="Market Maker">
      <ToolTabs tabs={TABS} value={desk} onChange={setDesk} />
      {desk === 'fixed-income' ? <FixedIncomeMarketMakerContent /> : <OptionsMarketMakerContent />}
    </PageWrapper>
  )
}
