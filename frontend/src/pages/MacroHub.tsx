import { useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import { FedRatesContent } from './FedRates'
import { BondAnalyticsContent } from './BondAnalytics'
import { CreditSpreadsContent } from './CreditSpreads'
import { EconomyMonitorContent } from './EconomyMonitor'
import { SectorRotationContent } from './SectorRotation'

const TABS = [
  { key: 'rates',   label: 'Rate Engine' },
  { key: 'economy', label: 'Jobs & Inflation' },
  { key: 'bonds',   label: 'Bond Analytics' },
  { key: 'credit',  label: 'Credit Spreads' },
  { key: 'sectors', label: 'Sector Rotation' },
] as const

type TabKey = typeof TABS[number]['key']

export default function MacroHub() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: TabKey = TABS.some(t => t.key === raw) ? (raw as TabKey) : 'rates'
  const setTab = (key: TabKey) => { params.set('tab', key); setParams(params, { replace: true }) }

  return (
    <PageWrapper title="Macro Hub">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', marginBottom: 16 }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 18px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--theme-mono)',
                color: tab === t.key ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-dim, rgba(255,255,255,0.28))',
                borderBottom: tab === t.key ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'rates'   && <FedRatesContent />}
        {tab === 'economy' && <EconomyMonitorContent />}
        {tab === 'bonds'   && <BondAnalyticsContent />}
        {tab === 'credit'  && <CreditSpreadsContent />}
        {tab === 'sectors' && <SectorRotationContent />}
      </div>
    </PageWrapper>
  )
}
