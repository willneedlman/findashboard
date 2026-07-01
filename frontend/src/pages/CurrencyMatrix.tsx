import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadingState from '../components/LoadingState'
import ErrorState from '../components/ErrorState'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', borderFaint: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)', faint: 'var(--theme-text-faint, rgba(255,255,255,0.35))',
  gold: 'var(--theme-primary, #c9a84c)', pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
  blue: 'var(--theme-tertiary, #5b8fd6)', mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

interface FxRow {
  ccy: string; name: string; pair: string; spot: number; chg_pct: number | null
  fwd_pts_3m: number; basis_3m_bps: number; vol_1w: number | null; vol_1m: number | null
  vol_trend: 'up' | 'down' | 'flat'; short_rate: number
}
interface FxResp {
  currencies: string[]; names: Record<string, string>; matrix: number[][]; rows: FxRow[]
  short_rates: Record<string, number>; usd_short_rate: number; as_of: number
}

const eyebrow: React.CSSProperties = { fontFamily: T.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.muted }
const th: React.CSSProperties = { ...eyebrow, padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { fontFamily: T.mono, fontSize: 12, padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

export function CurrencyMatrixContent() {
  const { data, isLoading, error, refetch } = useQuery<FxResp>({
    queryKey: ['fx-matrix'],
    queryFn: () => axios.get('/api/fx/matrix').then(r => r.data),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  if (isLoading) return <LoadingState label="Loading FX" />
  if (error) return <ErrorState title="FX feed failed" message="Could not load the currency matrix." onRetry={() => refetch()} />
  if (!data || !data.rows.length) return <EmptyState title="Currency Matrix" hint="No FX data available right now." />

  const asOf = new Date(data.as_of * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const trendMark = (t: FxRow['vol_trend']) => t === 'up' ? '↑' : t === 'down' ? '↓' : '→'
  const trendColor = (t: FxRow['vol_trend']) => t === 'up' ? T.gold : t === 'down' ? T.blue : T.muted

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: T.gold }}>Currency Matrix</span>
        <span style={{ fontFamily: T.sans, fontSize: 10, color: T.faint, letterSpacing: '0.08em' }}>G10 · as of {asOf}</span>
      </div>

      {/* Spot cross-rate grid */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}` }}>
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, ...eyebrow, color: T.text }}>Spot Cross Rates</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left', color: T.faint }}>1 ↓ = … →</th>
                {data.currencies.map(c => <th key={c} style={{ ...th, color: T.gold }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.currencies.map((rowc, i) => (
                <tr key={rowc} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: T.gold }}>{rowc}</td>
                  {data.currencies.map((colc, j) => (
                    <td key={colc} style={{ ...td, color: i === j ? T.faint : T.text, background: i === j ? T.surface : 'transparent' }}>
                      {i === j ? '—' : data.matrix[i][j].toLocaleString('en-US', { maximumFractionDigits: colc === 'JPY' ? 2 : 4 })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Forwards, basis, vol */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}` }}>
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, ...eyebrow, color: T.text }}>Forwards · Basis · Volatility</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Pair</th>
                <th style={th}>Spot</th>
                <th style={th}>1D</th>
                <th style={th}>Fwd pts 3M</th>
                <th style={th}>XCCY basis 3M</th>
                <th style={th}>3M rate</th>
                <th style={th}>Vol 1W</th>
                <th style={th}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.ccy} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <span style={{ fontWeight: 700, color: T.gold }}>{r.pair}</span>
                    <span style={{ color: T.muted, fontFamily: T.sans, fontSize: 10, marginLeft: 8 }}>{r.name}</span>
                  </td>
                  <td style={{ ...td, color: T.text }}>{r.spot}</td>
                  <td style={{ ...td, color: r.chg_pct == null ? T.muted : r.chg_pct >= 0 ? T.pos : T.neg }}>{r.chg_pct == null ? '—' : `${r.chg_pct >= 0 ? '+' : ''}${r.chg_pct.toFixed(2)}%`}</td>
                  <td style={{ ...td, color: r.fwd_pts_3m >= 0 ? T.pos : T.neg }}>{r.fwd_pts_3m >= 0 ? '+' : ''}{r.fwd_pts_3m}</td>
                  <td style={{ ...td, color: r.basis_3m_bps >= 0 ? T.pos : T.neg }}>{r.basis_3m_bps >= 0 ? '+' : ''}{r.basis_3m_bps} bp</td>
                  <td style={{ ...td, color: T.muted }}>{r.short_rate.toFixed(2)}%</td>
                  <td style={{ ...td, color: T.text }}>{r.vol_1w != null ? `${r.vol_1w.toFixed(1)}%` : '—'}</td>
                  <td style={{ ...td, color: trendColor(r.vol_trend) }}>{trendMark(r.vol_trend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ padding: '10px 12px', background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.sans, fontSize: 10, color: T.faint, lineHeight: '16px' }}>
        Spot and realized volatility are live (yfinance). Forward points are covered-interest-parity implied from indicative 3-month money rates; the cross-currency basis is an indicative reference — live forwards and basis require a paid rates feed. Vol is annualized 1-week realized; the trend arrow compares it to the 1-month.
      </div>
    </div>
  )
}

export default function CurrencyMatrix() {
  return <PageWrapper title="Currency Matrix"><CurrencyMatrixContent /></PageWrapper>
}
