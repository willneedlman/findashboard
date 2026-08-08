import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:    'var(--theme-bg, #101c2e)',
  border: 'rgba(255,255,255,0.06)',
  gold:  'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #8099b0)',
  sub:   'var(--theme-secondary, #8a9ab0)',
  text:  'var(--theme-text, #d7e3fc)',
  mono:  'var(--theme-mono)',
  label: 'var(--theme-sans)',
  pos:   'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
}

interface Analyst {
  distribution: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }
  total_analysts: number | null
  recommendation_key: string | null
  recommendation_mean: number | null
  target_mean: number | null
  target_high: number | null
  target_low: number | null
  implied_upside: number | null
}

const ROWS: { key: keyof Analyst['distribution']; label: string; color: string }[] = [
  { key: 'strongBuy',  label: 'Strong Buy',  color: 'var(--theme-positive, #22c55e)' },
  { key: 'buy',        label: 'Buy',         color: '#5fbf7e' },
  { key: 'hold',       label: 'Hold',        color: 'var(--theme-primary, #c9a84c)' },
  { key: 'sell',       label: 'Sell',        color: '#e07a52' },
  { key: 'strongSell', label: 'Strong Sell', color: 'var(--theme-negative, #ef4444)' },
]

function ratingLabel(key: string | null, mean: number | null): { text: string; color: string } {
  const k = (key || '').toLowerCase()
  if (k.includes('strong_buy') || k === 'strongbuy') return { text: 'STRONG BUY', color: T.pos }
  if (k.includes('buy') || k.includes('outperform')) return { text: 'BUY', color: T.pos }
  if (k.includes('underperform') || k.includes('sell')) return { text: 'SELL', color: T.neg }
  if (k.includes('hold') || k.includes('neutral')) return { text: 'HOLD', color: T.gold }
  if (mean != null) {
    if (mean <= 1.5) return { text: 'STRONG BUY', color: T.pos }
    if (mean <= 2.5) return { text: 'BUY', color: T.pos }
    if (mean <= 3.5) return { text: 'HOLD', color: T.gold }
    return { text: 'SELL', color: T.neg }
  }
  return { text: '—', color: T.muted }
}

export default function AnalystRatingsWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()
  const { data, isLoading } = useQuery<Analyst>({
    queryKey: ['analyst-widget', ticker],
    queryFn: () => axios.get(`/api/corporate/hub/analyst?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })

  const dist = data?.distribution ?? { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }
  const maxN = Math.max(1, ...Object.values(dist))
  const rating = ratingLabel(data?.recommendation_key ?? null, data?.recommendation_mean ?? null)
  const score = data?.recommendation_mean != null ? (6 - data.recommendation_mean) : null
  const up = data?.implied_upside ?? null

  const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 11, padding: '12px 14px', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: 23, fontWeight: 700, color: rating.color, lineHeight: 1 }}>{isLoading ? '·' : rating.text}</div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.sub, marginTop: 3 }}>{score != null ? score.toFixed(1) : '—'} <span style={{ color: T.muted }}>/ 5.0</span></div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={cap}>Coverage</div>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{data?.total_analysts ?? '—'} analysts</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {ROWS.map(r => {
            const n = dist[r.key]
            return (
              <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: T.label, fontSize: 9.5, color: T.sub, width: 78, flexShrink: 0 }}>{r.label}</span>
                <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.05)' }}>
                  <div style={{ height: '100%', width: `${(n / maxN) * 100}%`, background: r.color, transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.text, width: 18, textAlign: 'right' }}>{n}</span>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, paddingTop: 11, borderTop: `1px solid ${T.border}` }}>
          <div>
            <div style={cap}>Mean Tgt</div>
            <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.gold, marginTop: 2 }}>{data?.target_mean != null ? `$${data.target_mean.toFixed(2)}` : '—'}</div>
          </div>
          <div>
            <div style={cap}>High</div>
            <div style={{ fontFamily: T.mono, fontSize: 14, color: T.text, marginTop: 2 }}>{data?.target_high != null ? `$${data.target_high.toFixed(2)}` : '—'}</div>
          </div>
          <div>
            <div style={cap}>Low</div>
            <div style={{ fontFamily: T.mono, fontSize: 14, color: T.text, marginTop: 2 }}>{data?.target_low != null ? `$${data.target_low.toFixed(2)}` : '—'}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: T.mono, fontSize: 11 }}>
          <span style={{ color: T.muted }}>Implied upside</span>
          <span style={{ color: up == null ? T.muted : up >= 0 ? T.pos : T.neg, fontWeight: 700 }}>{up == null ? '—' : `${up >= 0 ? '+' : ''}${up.toFixed(1)}%`}</span>
        </div>
      </div>
    </div>
  )
}
