import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import EmptyState from '../../EmptyState'

const T = {
  bg:    'var(--theme-bg, #101c2e)',
  border: 'rgba(255,255,255,0.06)',
  rowBorder: 'rgba(255,255,255,0.04)',
  gold:  'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #8099b0)',
  sub:   'var(--theme-secondary, #8a9ab0)',
  text:  'var(--theme-text, #dce3ed)',
  mono:  'var(--theme-mono)',
  label: 'var(--theme-sans)',
  blue:  '#60a5fa',
  pos:   'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
}

interface Txn { date: string; insider: string; title: string; transaction: string; side: 'buy' | 'sell' | 'neutral'; shares: number; value: number }
interface InsiderData { transactions: Txn[]; held_pct_institutions: number | null; held_pct_insiders: number | null }

function fmtVal(v: number): string {
  if (!v) return '—'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}
function fmtDate(d: string): string {
  const dt = new Date(d + 'T00:00:00')
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
}
function side(txn: Txn): { text: string; color: string } {
  if (txn.side === 'sell') return { text: 'SELL', color: T.neg }
  if (txn.side === 'buy') return { text: 'BUY', color: T.pos }
  return { text: '—', color: T.muted }
}

export default function InsiderWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()
  const { data, isLoading } = useQuery<InsiderData>({
    queryKey: ['insider-widget', ticker],
    queryFn: () => axios.get(`/api/corporate/hub/insider?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })

  const inst = data?.held_pct_institutions != null ? data.held_pct_institutions * 100 : null
  const insider = data?.held_pct_insiders != null ? data.held_pct_insiders * 100 : null
  const retail = inst != null && insider != null ? Math.max(0, 100 - inst - insider) : null
  const txns = (data?.transactions ?? []).slice(0, 14)

  const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ marginBottom: 6 }}><span style={cap}>Ownership</span></div>
        <div style={{ display: 'flex', height: 8, overflow: 'hidden', border: `1px solid ${T.border}` }}>
          <div style={{ width: `${inst ?? 0}%`, background: 'var(--theme-tertiary, #1f5673)' }} />
          <div style={{ width: `${retail ?? 0}%`, background: 'rgba(255,255,255,0.12)' }} />
          <div style={{ width: `${insider ?? 0}%`, background: T.gold }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: T.mono, fontSize: 9 }}>
          <span style={{ color: T.blue }}>{inst != null ? `${inst.toFixed(0)}% Institutional` : '—'}</span>
          <span style={{ color: T.sub }}>{retail != null ? `${retail.toFixed(0)}% Retail` : ''}</span>
          <span style={{ color: T.gold }}>{insider != null ? `${insider.toFixed(2)}% Insider` : ''}</span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {isLoading ? (
          <EmptyState variant="loading" size="compact" title="Loading insider filings" />
        ) : txns.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, color: T.muted, fontFamily: T.label, fontSize: 11, textAlign: 'center' }}>No recent insider transactions.</div>
        ) : txns.map((t, i) => {
          const s = side(t)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: `1px solid ${T.rowBorder}` }}>
              <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, width: 42, flexShrink: 0 }}>{fmtDate(t.date)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.label, fontSize: 11, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.insider}</div>
                <div style={{ fontFamily: T.label, fontSize: 8.5, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title || '—'}</div>
              </div>
              <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', padding: '1px 6px', color: s.color, border: `1px solid ${s.color}`, flexShrink: 0 }}>{s.text}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.text, width: 48, textAlign: 'right', flexShrink: 0 }}>{fmtVal(t.value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
