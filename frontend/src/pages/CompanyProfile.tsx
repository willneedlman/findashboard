import { useEffect, useRef, useState } from 'react'
import PageWrapper from '../components/PageWrapper'
import TickerInput from '../components/TickerInput'
import ToolTabs, { type ToolTab } from '../components/ToolTabs'
import EmptyState from '../components/EmptyState'
import { useTickerParam } from '../hooks/useTickerParam'
import { recordRecentTicker } from '../lib/recentTickers'
import OverviewHeader from '../components/companyProfile/OverviewHeader'
import SummaryTab from '../components/companyProfile/SummaryTab'
import FinancialsTab from '../components/companyProfile/FinancialsTab'
import ValuationTab from '../components/companyProfile/ValuationTab'
import RiskTab from '../components/companyProfile/RiskTab'
import OwnershipTab from '../components/companyProfile/OwnershipTab'
import PeersTab from '../components/companyProfile/PeersTab'
import NewsTab from '../components/companyProfile/NewsTab'
import CompanyOutlook from '../components/CompanyOutlook'

// Eight sections, in the order the handoff fixes. Risk and Ownership are split
// apart here; they were one tab on the page this replaces.
const TABS: ToolTab[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'valuation', label: 'Valuation' },
  { key: 'financials', label: 'Financials' },
  { key: 'estimates', label: 'Estimates & Analysts' },
  { key: 'risk', label: 'Risk' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'peers', label: 'Peers & Comps' },
  { key: 'news', label: 'News & Filings' },
]

export default function CompanyProfile() {
  // `input` is what is typed; `ticker` is what is loaded. They diverge while
  // someone is mid-word, and every panel reads the loaded one so a half-typed
  // symbol never fires eight queries.
  const [input, setInput] = useState('')
  const [ticker, setTicker] = useState('')
  const [tab, setTab] = useState<string>('summary')

  const load = (sym?: string) => {
    const next = (sym ?? input).trim().toUpperCase()
    if (!next) return
    setInput(next)
    setTicker(next)
  }
  useTickerParam(load)

  // Each tab mounts on first visit and then stays mounted but hidden, so
  // switching never refetches or flashes a spinner. Carried over from the page
  // this replaces, where it was already the behaviour.
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['summary']))
  useEffect(() => {
    setVisited(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [tab])

  // Switching tabs used to move the page under the reader. A hidden tab is
  // display:none and contributes no height, so leaving a long tab for a short
  // one collapses the document and the browser clamps the scroll position,
  // which lands you somewhere you did not ask to be.
  //
  // Two things fix it together: the panel region holds a floor height so the
  // document cannot collapse, and if the tab strip has been scrolled off the
  // top, the switch brings it back to the top. Both are deterministic, which
  // is the point: a predictable move beats an arbitrary one.
  const stripRef = useRef<HTMLDivElement>(null)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const el = stripRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    if (top < 0) {
      el.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    }
  }, [tab])

  useEffect(() => {
    if (ticker) recordRecentTicker(ticker)
  }, [ticker])

  return (
    <PageWrapper title="Company Profile">
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <TickerInput
          value={input}
          onChange={setInput}
          onEnter={() => load()}
          onSelect={sym => load(sym)}
          placeholder="Ticker or company"
          style={{ width: 186 }}
        />
      </div>

      {!ticker ? (
        <EmptyState
          title="Company Profile"
          hint="Search a ticker to load financials, estimates, ownership and filings."
        />
      ) : (
        <>
          <OverviewHeader ticker={ticker} />

          <div ref={stripRef} style={{ marginBottom: 20, scrollMarginTop: 12 }}>
            <ToolTabs tabs={TABS} value={tab} onChange={setTab} />
          </div>

          <div style={{ minHeight: '60vh' }}>

          {visited.has('summary') && (
            <Panel show={tab === 'summary'}><SummaryTab ticker={ticker} /></Panel>
          )}
          {visited.has('valuation') && (
            <Panel show={tab === 'valuation'}><ValuationTab ticker={ticker} /></Panel>
          )}
          {visited.has('financials') && (
            <Panel show={tab === 'financials'}><FinancialsTab ticker={ticker} /></Panel>
          )}
          {visited.has('estimates') && (
            <Panel show={tab === 'estimates'}><CompanyOutlook ticker={ticker} /></Panel>
          )}
          {visited.has('risk') && (
            <Panel show={tab === 'risk'}><RiskTab ticker={ticker} /></Panel>
          )}
          {visited.has('ownership') && (
            <Panel show={tab === 'ownership'}><OwnershipTab ticker={ticker} /></Panel>
          )}
          {visited.has('peers') && (
            <Panel show={tab === 'peers'}><PeersTab ticker={ticker} /></Panel>
          )}
          {visited.has('news') && (
            <Panel show={tab === 'news'}><NewsTab ticker={ticker} /></Panel>
          )}
          </div>
        </>
      )}
    </PageWrapper>
  )
}

function Panel({ show, children }: { show: boolean; children: React.ReactNode }) {
  return <div style={{ display: show ? 'block' : 'none' }}>{children}</div>
}
