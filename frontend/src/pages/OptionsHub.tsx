import { useState } from 'react'
import PageWrapper from '../components/PageWrapper'
import { OptionsChainScannerContent } from './OptionsChainScanner'
import { OptionsPricerContent } from './OptionsPricer'
import { ImpliedProbabilityContent } from './ImpliedProbability'

const TABS = [
  { key: 'chain',       label: 'Chain Scanner' },
  { key: 'pricer',      label: 'Options Pricer' },
  { key: 'probability', label: 'Implied Probability' },
] as const

type TabKey = typeof TABS[number]['key']

export default function OptionsHub() {
  const [tab, setTab] = useState<TabKey>('chain')

  return (
    <PageWrapper title="Options Hub">
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
        {tab === 'chain'       && <OptionsChainScannerContent />}
        {tab === 'pricer'      && <OptionsPricerContent />}
        {tab === 'probability' && <ImpliedProbabilityContent />}
      </div>
    </PageWrapper>
  )
}
