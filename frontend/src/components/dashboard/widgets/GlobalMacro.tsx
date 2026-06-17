import { T } from '../../../lib/theme'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'


const CAT_LABEL: Record<string, string> = {
  fx:        'FX',
  commodity: 'Cmdty',
  bond:      'Rates',
  vol:       'Vol',
  equity:    'Equity',
}

const CAT_COLOR: Record<string, string> = {
  fx:        'var(--theme-tertiary, #60a5fa)',
  commodity: 'var(--theme-accent-orange, #f97316)',
  bond:      'var(--theme-accent-violet, #a78bfa)',
  vol:       'var(--theme-negative, #ef4444)',
  equity:    'var(--theme-positive, #22c55e)',
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
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
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
                <div key={a.ticker} style={{ display: 'flex', alignItems: 'center', padding: '4px 10px', borderBottom: `1px solid var(--theme-hover, var(--theme-hover, rgba(255,255,255,0.04)))` }}>
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
