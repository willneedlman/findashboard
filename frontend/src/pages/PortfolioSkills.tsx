import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import { PortfolioCompareContent } from './PortfolioCompare'
import { MonteCarloContent } from './MonteCarlo'
import { PortfolioTab } from './PortfolioBacktester'

// Unified "Portfolio Skills" module: Compare, Monte Carlo, and Backtester in one
// tabbed surface. All three stay mounted (visibility-toggled) so a user's inputs
// and computed results survive tab switches, and the analysis tools already share
// the working allocation through PortfolioContext.
const TABS = [
  { id: 'compare',    label: 'Compare' },
  { id: 'montecarlo', label: 'Monte Carlo' },
  { id: 'backtest',   label: 'Backtester' },
] as const
type TabId = typeof TABS[number]['id']

const isTabId = (v: string | null): v is TabId => TABS.some(t => t.id === v)

export default function PortfolioSkills() {
  const [params, setParams] = useSearchParams()
  const initial = isTabId(params.get('tab')) ? (params.get('tab') as TabId) : 'compare'
  const [tab, setTab] = useState<TabId>(initial)
  const selectTab = (id: TabId) => { setTab(id); setParams(p => { p.set('tab', id); return p }, { replace: true }) }
  return (
    <PageWrapper title="Portfolio Skills">
      <div role="tablist" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--theme-border)', marginBottom: 16 }}>
        {TABS.map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(t.id)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: active ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent',
                marginBottom: -1,
                color: active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-dim)',
                cursor: 'pointer',
                fontFamily: 'var(--theme-sans)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                padding: '9px 16px',
                transition: 'color 0.15s',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      <div style={{ display: tab === 'compare'    ? 'block' : 'none' }}><PortfolioCompareContent /></div>
      <div style={{ display: tab === 'montecarlo' ? 'block' : 'none' }}><MonteCarloContent /></div>
      <div style={{ display: tab === 'backtest'   ? 'block' : 'none' }}><PortfolioTab /></div>
    </PageWrapper>
  )
}
