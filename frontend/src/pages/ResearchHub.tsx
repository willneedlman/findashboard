import { useState } from 'react'
import PageWrapper from '../components/PageWrapper'
import { CorporateHubContent } from './CorporateHub'
import { RelativeValuationContent } from './RelativeValuation'
import { SupplyChainContent } from './SupplyChain'

const TABS = [
  { key: 'overview', label: 'Corporate Hub' },
  { key: 'peers',    label: 'Peer Valuation' },
  { key: 'profile',  label: 'Company Profile' },
] as const

type TabKey = typeof TABS[number]['key']

export default function ResearchHub() {
  const [tab, setTab] = useState<TabKey>('overview')

  return (
    <PageWrapper>
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
        {tab === 'overview' && <CorporateHubContent />}
        {tab === 'peers'    && <RelativeValuationContent />}
        {tab === 'profile'  && <SupplyChainContent />}
      </div>
    </PageWrapper>
  )
}
