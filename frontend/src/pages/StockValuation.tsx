import { useState } from 'react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { DCFValuationContent } from './DCFValuation'
import { ReverseDCFContent } from './ReverseDCF'

const TABS = [
  { key: 'dcf',       label: 'DCF',          ready: true },
  { key: 'reverse',   label: 'Reverse DCF',  ready: true },
  { key: 'sotp',      label: 'SOTP',         ready: false },
  { key: 'ddm',       label: 'Dividend Discount', ready: false },
  { key: 'multiples', label: 'Multiples',    ready: false },
] as const

type TabKey = typeof TABS[number]['key']

const SOON: Record<string, string> = {
  sotp:      'Sum-of-the-parts: value each business segment on its own multiple, then sum to an enterprise value. Coming in the next pass.',
  ddm:       'Dividend discount model: value the stock off its dividend stream and growth. Coming in the next pass.',
  multiples: 'Multiples: dial a metric and a target multiple to see how the implied valuation moves. Coming in the next pass.',
}

export default function StockValuation() {
  const [tab, setTab] = useState<TabKey>('dcf')

  return (
    <PageWrapper title="Stock Valuation">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', marginBottom: 16 }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 18px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--theme-mono)', display: 'flex', alignItems: 'center', gap: 6,
                color: tab === t.key ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-dim, rgba(255,255,255,0.28))',
                borderBottom: tab === t.key ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.label}
              {!t.ready && <span style={{ fontSize: 7, letterSpacing: '0.1em', padding: '1px 4px', border: '1px solid currentColor', opacity: 0.5 }}>SOON</span>}
            </button>
          ))}
        </div>
        {tab === 'dcf'     && <DCFValuationContent />}
        {tab === 'reverse' && <ReverseDCFContent />}
        {(tab === 'sotp' || tab === 'ddm' || tab === 'multiples') && (
          <EmptyState title={TABS.find(t => t.key === tab)!.label} hint={SOON[tab]} />
        )}
      </div>
    </PageWrapper>
  )
}
