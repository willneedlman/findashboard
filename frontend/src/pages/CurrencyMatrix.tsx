import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadingState from '../components/LoadingState'
import ErrorState from '../components/ErrorState'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)',
  gold: 'var(--theme-primary, #c9a84c)', pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
  blue: 'var(--theme-tertiary, #60a5fa)', mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
  // structural chrome — route through theme tokens so it survives light presets;
  // hex values are the handoff's dark-theme defaults.
  panelBorder: 'var(--theme-border, rgba(255,255,255,0.09))',
  stripOverlay: 'var(--theme-border-faint, rgba(0,0,0,0.20))',
  stripHair: 'var(--theme-border-faint, rgba(255,255,255,0.06))',
  rowHair: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  flagBorder: 'var(--theme-border, rgba(255,255,255,0.14))',
  faint: 'var(--theme-text-faint, rgba(255,255,255,0.34))',
  diag: 'var(--theme-text-faint, rgba(255,255,255,0.26))',
  volTrack: 'var(--theme-border-faint, rgba(255,255,255,0.08))',
}

// Max alpha of the per-column heatmap glow (README default; tunable 0.08–0.50).
const HEAT_INTENSITY = 0.44

const FLAG: Record<string, string> = {
  USD: 'us', EUR: 'eu', GBP: 'gb', AUD: 'au', NZD: 'nz', JPY: 'jp', CHF: 'ch', CAD: 'ca',
}
// accent at alpha `a` (0..1), theme-aware — mirrors rgba(accent, a) without hardcoding rgb.
const goldAlpha = (a: number) => `color-mix(in srgb, ${T.gold} ${(a * 100).toFixed(1)}%, transparent)`

interface FxRow {
  ccy: string; name: string; pair: string; spot: number; chg_pct: number | null
  fwd_pts_3m: number; basis_3m_bps: number; vol_1w: number | null; vol_1m: number | null
  vol_trend: 'up' | 'down' | 'flat'; short_rate: number
}
interface FxResp {
  currencies: string[]; names: Record<string, string>; matrix: number[][]; rows: FxRow[]
  short_rates: Record<string, number>; usd_short_rate: number; as_of: number
}

function Flag({ ccy, w, h }: { ccy: string; w: number; h: number }) {
  const cc = FLAG[ccy]
  return (
    <span
      aria-hidden
      style={{
        width: w, height: h, flex: '0 0 auto', display: 'inline-block',
        border: `1px solid ${T.flagBorder}`, backgroundSize: 'cover', backgroundPosition: 'center',
        backgroundImage: cc ? `url(https://flagcdn.com/w40/${cc}.png)` : undefined,
      }}
    />
  )
}

const eyebrow: React.CSSProperties = { fontFamily: T.sans, fontWeight: 700, textTransform: 'uppercase' }
const stripTitle: React.CSSProperties = { ...eyebrow, fontSize: 10, letterSpacing: '0.16em', color: T.text }
const th: React.CSSProperties = { ...eyebrow, fontSize: 9, letterSpacing: '0.14em', color: T.faint, padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { fontFamily: T.mono, fontSize: 12.5, padding: '11px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function Panel({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.panelBorder}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', background: T.stripOverlay, borderBottom: `1px solid ${T.stripHair}` }}>
        <span style={stripTitle}>{title}</span>
        {sub && <span style={{ ...eyebrow, fontSize: 9, letterSpacing: '0.14em', color: T.faint }}>{sub}</span>}
      </div>
      {children}
    </div>
  )
}

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

  const { currencies, matrix, rows } = data
  const asOf = new Date(data.as_of * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  // Per-column min/max over off-diagonal values — each quote column is its own scale.
  const colRange = currencies.map((_, j) => {
    const vs = currencies.map((_, i) => matrix[i][j]).filter((_, i) => i !== j)
    return { min: Math.min(...vs), max: Math.max(...vs) }
  })

  const trendMark = (t: FxRow['vol_trend']) => t === 'up' ? '↑' : t === 'down' ? '↓' : '→'
  const trendColor = (t: FxRow['vol_trend']) => t === 'up' ? T.gold : t === 'down' ? T.blue : T.muted

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ ...eyebrow, fontSize: 14, letterSpacing: '0.22em', color: T.gold }}>Currency Matrix</span>
        <span style={{ fontFamily: T.sans, fontSize: 10, color: T.muted, letterSpacing: '0.08em' }}>G10 · as of {asOf}</span>
      </div>

      {/* Panel A — Spot Cross-Rate Heatmap */}
      <Panel title="Spot Cross Rates" sub={`G10 · AS OF ${asOf.toUpperCase()}`}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...eyebrow, fontSize: 9, letterSpacing: '0.14em', color: T.faint, padding: '11px 13px', textAlign: 'left', whiteSpace: 'nowrap' }}>1 ↓ = … →</th>
                {currencies.map(c => (
                  <th key={c} style={{ padding: '11px 13px', textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      <Flag ccy={c} w={19} h={13} />
                      <span style={{ ...eyebrow, fontSize: 10, letterSpacing: '0.10em', color: T.gold }}>{c}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {currencies.map((rowc, i) => (
                <tr key={rowc}>
                  <td style={{ padding: '10px 13px', borderTop: `1px solid rgba(255,255,255,0.045)`, whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Flag ccy={rowc} w={19} h={13} />
                      <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.gold }}>{rowc}</span>
                    </span>
                  </td>
                  {currencies.map((colc, j) => {
                    if (i === j) return (
                      <td key={colc} style={{ ...td, fontSize: 12.5, padding: '10px 13px', borderTop: `1px solid rgba(255,255,255,0.045)`, color: T.diag, background: T.surface }}>—</td>
                    )
                    const v = matrix[i][j]
                    const { min, max } = colRange[j]
                    const t = (v - min) / ((max - min) || 1)
                    return (
                      <td key={colc} style={{ ...td, fontSize: 12.5, padding: '10px 13px', borderTop: `1px solid rgba(255,255,255,0.045)`, color: T.text, background: goldAlpha(t * HEAT_INTENSITY) }}>
                        {v.toLocaleString('en-US', { maximumFractionDigits: colc === 'JPY' ? 2 : 4 })}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: `1px solid ${T.stripHair}` }}>
          <span style={{ ...eyebrow, fontSize: 9, letterSpacing: '0.12em', color: T.muted }}>Weak</span>
          <span style={{ width: 220, height: 6, background: `linear-gradient(90deg, ${goldAlpha(0.02)}, ${goldAlpha(HEAT_INTENSITY)})` }} />
          <span style={{ ...eyebrow, fontSize: 9, letterSpacing: '0.12em', color: T.gold }}>Strong</span>
        </div>
      </Panel>

      {/* Panel B — Forwards · Basis · Volatility */}
      <Panel title="Forwards · Basis · Volatility">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left', padding: '10px 16px' }}>Pair</th>
                <th style={th}>Spot</th>
                <th style={th}>1D</th>
                <th style={th}>Fwd 3M</th>
                <th style={th}>XCCY 3M</th>
                <th style={th}>3M Rate</th>
                <th style={th}>Vol 1W</th>
                <th style={th}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const [base, quote] = r.pair.split('/')
                const volPct = r.vol_1w == null ? 0 : Math.min(r.vol_1w / 6 * 100, 100)
                return (
                  <tr key={r.ccy} style={{ borderTop: `1px solid ${T.rowHair}` }}>
                    <td style={{ padding: '11px 16px', textAlign: 'left', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Flag ccy={base} w={18} h={12} />
                        <Flag ccy={quote} w={18} h={12} />
                        <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.gold, marginLeft: 2 }}>{r.pair}</span>
                        <span style={{ fontFamily: T.sans, fontSize: 10, color: T.muted, marginLeft: 9 }}>{r.name}</span>
                      </span>
                    </td>
                    <td style={{ ...td, color: T.text }}>{r.spot}</td>
                    <td style={{ ...td, color: r.chg_pct == null ? T.muted : r.chg_pct >= 0 ? T.pos : T.neg }}>{r.chg_pct == null ? '—' : `${r.chg_pct >= 0 ? '+' : ''}${r.chg_pct.toFixed(2)}%`}</td>
                    <td style={{ ...td, color: r.fwd_pts_3m >= 0 ? T.pos : T.neg }}>{r.fwd_pts_3m >= 0 ? '+' : ''}{r.fwd_pts_3m}</td>
                    <td style={{ ...td, color: r.basis_3m_bps >= 0 ? T.pos : T.neg }}>{r.basis_3m_bps >= 0 ? '+' : ''}{r.basis_3m_bps} bp</td>
                    <td style={{ ...td, color: T.muted }}>{r.short_rate.toFixed(2)}%</td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, justifyContent: 'flex-end' }}>
                        <span style={{ width: 52, height: 3, background: T.volTrack, flex: '0 0 auto' }}>
                          <span style={{ display: 'block', height: '100%', width: `${volPct}%`, background: T.gold }} />
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text, minWidth: 36, textAlign: 'right', display: 'inline-block' }}>{r.vol_1w != null ? `${r.vol_1w.toFixed(1)}%` : '—'}</span>
                      </span>
                    </td>
                    <td style={{ ...td, fontSize: 14, color: trendColor(r.vol_trend) }}>{trendMark(r.vol_trend)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div style={{ padding: '12px 14px', background: T.surface, border: `1px solid ${T.panelBorder}`, borderLeft: `2px solid ${T.gold}`, fontFamily: T.sans, fontSize: 10, color: T.muted, lineHeight: '17px' }}>
        Spot and realized volatility are live. Forward points are covered-interest-parity implied from indicative 3-month money rates. The cross-currency basis is an indicative reference. Vol is annualized 1-week realized. The trend arrow compares it to the 1-month.
      </div>
    </div>
  )
}

export default function CurrencyMatrix() {
  return <PageWrapper title="Currency Matrix"><CurrencyMatrixContent /></PageWrapper>
}
