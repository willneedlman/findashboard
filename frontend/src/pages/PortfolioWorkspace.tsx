import { useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import ToolTabs, { type ToolTab } from '../components/ToolTabs'
import { PortfolioManagerContent } from './PortfolioManager'
import { PortfolioLiveContent } from './PortfolioLive'

// Consolidated portfolio workspace: the BOOK tab owns the holdings (the only
// writer of the shared pm-portfolios-v2 store), and the LIVE tab is a read-only
// view of that same book marked to real-time prices. They were two routes over
// one dataset, which is why they merged. Tab persists in ?view=.
const TABS: ToolTab[] = [
  { key: 'book', label: 'Book' },
  { key: 'live', label: 'Live' },
]

export default function PortfolioWorkspace() {
  const [sp, setSp] = useSearchParams()
  const view = sp.get('view') === 'live' ? 'live' : 'book'
  const setView = (k: string) => setSp(prev => {
    const next = new URLSearchParams(prev)
    next.set('view', k)
    return next
  }, { replace: true })

  // LIVE brings its own chrome: the Session Board's header row carries the
  // wordmark, the BOOK/LIVE control and the book selector, and its tape and hero
  // band are edge-to-edge. So it renders without the page title or the tab bar,
  // and cancels the shell's gutters (which it re-applies internally at 28px).
  if (view === 'live') {
    return (
      <PageWrapper>
        <div className="-mx-5 2xl:-mx-8">
          <PortfolioLiveContent view={view} onView={setView} />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper title="Portfolio">
      <ToolTabs tabs={TABS} value={view} onChange={setView} />
      <PortfolioManagerContent />
    </PageWrapper>
  )
}
