import { useState } from 'react'
import PageWrapper from '../components/PageWrapper'
import { FedRatesContent } from './FedRates'
import { BondAnalyticsContent } from './BondAnalytics'
import { CreditSpreadsContent } from './CreditSpreads'

const TABS = [
  { key: 'rates',   label: 'Rate Engine' },
  { key: 'bonds',   label: 'Bond Analytics' },
  { key: 'credit',  label: 'Credit Spreads' },
] as const

type TabKey = typeof TABS[number]['key']

export default function MacroHub() {
  const [tab, setTab] = useState<TabKey>('rates')

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
        {tab === 'rates'  && <FedRatesContent />}
        {tab === 'bonds'  && <BondAnalyticsContent />}
        {tab === 'credit' && <CreditSpreadsContent />}
      </div>
    </PageWrapper>
  )
}
