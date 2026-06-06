import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'rgba(255,255,255,0.08)',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    '#d7e3fc',
  mono:    'JetBrains Mono, monospace',
  label:   'IBM Plex Sans, sans-serif',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

const CAT_LABEL: Record<string, string> = {
  fx:        'FX',
  commodity: 'Cmdty',
  bond:      'Rates',
  vol:       'Vol',
  equity:    'Equity',
}

const CAT_COLOR: Record<string, string> = {
  fx:        '#60a5fa',
  commodity: '#f97316',
  bond:      '#a78bfa',
  vol:       '#ef4444',
  equity:    '#22c55e',
}

interface Asset {
  ticker:   string
  label:    string
  category: string
  price:    number | null
  change:   number | null
  pct:      number | null
}

interface MacroResponse {
  assets: Asset[]
  as_of:  string
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
}

const ALL_CATEGORIES = ['equity', 'fx', 'bond', 'commodity', 'vol'] as const

export default function GlobalMacro({ config }: { config: WidgetConfig }) {
  const CATEGORIES = (config.categories?.length ? config.categories : ALL_CATEGORIES) as readonly string[]
  const { data, isLoading, isError } = useQuery<MacroResponse>({
    queryKey: ['macro-dashboard'],
    queryFn: () => axios.get('/api/market/macro-dashboard').then(r => r.data),
    staleTime: 300_000,
    refetchInterval: 300_000,
    retry: 1,
  })

  function fmtPrice(a: Asset): string {
    if (a.price == null) return '—'
    if (a.category === 'bond') return `${a.price.toFixed(2)}%`
    if (a.category === 'fx' && a.label.includes('JPY')) return a.price.toFixed(2)
    if (a.category === 'fx') return a.price.toFixed(4)
    if (a.price >= 1000) return a.price.toLocaleString('en-US', { maximumFractionDigits: 2 })
    return a.price.toFixed(2)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: T.surface, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>Global Macro</span>
        {data && <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>5m delay · {data.as_of}</span>}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Failed to load</div>}

        {CATEGORIES.map(cat => {
          const assets = data?.assets.filter(a => a.category === cat) ?? []
          const color  = CAT_COLOR[cat]

          return (
            <div key={cat}>
              {/* Category divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 2px', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontFamily: T.mono, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', color, opacity: 0.8 }}>
                  {CAT_LABEL[cat]}
                </span>
              </div>

              {isLoading && (
                <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {[1,2,3].map(i => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ ...shimmer, width: 50, height: 10 }} />
                      <div style={{ ...shimmer, width: 60, height: 10 }} />
                    </div>
                  ))}
                </div>
              )}

              {assets.map(a => (
                <div key={a.ticker} style={{ display: 'flex', alignItems: 'center', padding: '4px 10px', borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
                  <span style={{ fontFamily: T.label, fontSize: 10, color: T.text, flex: 1 }}>{a.label}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 600, color: T.text, marginRight: 10 }}>{fmtPrice(a)}</span>
                  <span style={{
                    fontFamily: T.mono, fontSize: 9, fontWeight: 600, minWidth: 50, textAlign: 'right',
                    color: a.pct == null ? T.muted : a.pct >= 0 ? T.pos : T.neg,
                  }}>
                    {a.pct != null ? `${a.pct >= 0 ? '+' : ''}${a.pct.toFixed(2)}%` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
