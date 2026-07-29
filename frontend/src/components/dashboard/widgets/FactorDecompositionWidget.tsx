import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { fetchFactorDecomposition } from '../../../hooks/useApi'
import { T } from '../../../lib/theme'
import { loadActivePortfolio } from './usePortfolio'
import { useWidgetContentState } from '../widgetContentState'

interface FactorRow {
  factor: string
  proxy: string
  beta: number
  t_stat: number | null
  risk_pct: number
}

interface FactorResponse {
  factors: FactorRow[]
  systematic_pct: number
  idiosyncratic_pct: number
  ann_vol_pct: number
  alpha_ann_pct: number
  observations: number
  source: string
}

const cap: React.CSSProperties = {
  fontFamily: T.label,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: T.muted,
}

export default function FactorDecompositionWidget({ config }: { config: WidgetConfig }) {
  const portfolio = useMemo(() => loadActivePortfolio(config.portfolioId), [config.portfolioId])
  const holdings = portfolio.holdings.map(holding => ({ ticker: holding.ticker, shares: holding.shares }))
  const signature = holdings.map(holding => `${holding.ticker}:${holding.shares}`).join(',')
  const mode = config.factorModel ?? 'macro'
  const lookback = config.lookback ?? 365
  const benchmark = (config.benchmark || 'SPY').toUpperCase()

  const { data, isLoading, isError } = useQuery<FactorResponse>({
    queryKey: ['factor-decomposition-widget', signature, mode, lookback, benchmark],
    enabled: holdings.length > 0,
    staleTime: 30 * 60_000,
    retry: 1,
    queryFn: () => fetchFactorDecomposition({
      holdings,
      mode,
      lookback_days: lookback,
      benchmark,
    }),
  })
  useWidgetContentState(config.id, !holdings.length ? 'empty' : isLoading ? 'loading' : isError ? 'error' : data ? 'ready' : 'empty')

  if (!holdings.length) {
    return <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', background: T.bg, color: T.muted, fontFamily: T.label, fontSize: 10 }}>Choose a saved portfolio with holdings.</div>
  }
  if (isLoading) {
    return <div style={{ padding: 12, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>Calculating factor exposures...</div>
  }
  if (isError || !data) {
    return <div style={{ padding: 12, color: T.neg, fontFamily: T.mono, fontSize: 10 }}>Factor decomposition unavailable</div>
  }

  const filter = (config.filter ?? '').trim().toLowerCase()
  const allowed = new Set((config.factorCategories ?? []).map(value => value.toLowerCase()))
  const factors = data.factors
    .filter(factor => (!allowed.size || allowed.has(factor.factor.toLowerCase())) && (!filter || `${factor.factor} ${factor.proxy}`.toLowerCase().includes(filter)))
    .sort((a, b) => {
      if (config.sortBy === 'factor') return a.factor.localeCompare(b.factor)
      if (config.sortBy === 'exposure') return Math.abs(b.beta) - Math.abs(a.beta)
      return Math.abs(b.risk_pct) - Math.abs(a.risk_pct)
    })
  const maxValue = Math.max(1, ...factors.map(factor => Math.abs(config.valueMode === 'relative'
    ? factor.risk_pct / Math.max(data.systematic_pct, 1) * 100
    : factor.risk_pct)))
  const minimal = config.displayState === 'minimum'
  const presentation = config.presentation ?? 'chart'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.bg, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: minimal ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {[
          ['Systematic', `${data.systematic_pct.toFixed(1)}%`, T.gold],
          ['Idiosyncratic', `${data.idiosyncratic_pct.toFixed(1)}%`, T.text],
          ['Annualized vol', `${data.ann_vol_pct.toFixed(1)}%`, T.blue],
          ['Alpha', `${data.alpha_ann_pct >= 0 ? '+' : ''}${data.alpha_ann_pct.toFixed(1)}%`, data.alpha_ann_pct >= 0 ? T.pos : T.neg],
        ].slice(0, minimal ? 2 : 4).map(([label, value, color]) => (
          <div key={label} style={{ padding: '7px 9px', borderRight: `1px solid ${T.border}` }}>
            <div style={cap}>{label}</div>
            <div style={{ marginTop: 3, fontFamily: T.mono, fontSize: 13, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {presentation === 'table' ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 9.5 }}>
            <thead>
              <tr>{['Factor', 'Proxy', config.exposureDisplay === false ? null : 'Beta', config.contributionDisplay === false ? null : 'Risk'].filter(Boolean).map(label => <th key={label} style={{ ...cap, padding: '7px 9px', textAlign: label === 'Factor' || label === 'Proxy' ? 'left' : 'right', borderBottom: `1px solid ${T.border}` }}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {factors.map(factor => (
                <tr key={factor.factor} style={{ borderBottom: `1px solid ${T.borderFaint}` }}>
                  <td style={{ padding: '7px 9px', color: T.text, fontWeight: 700 }}>{factor.factor}</td>
                  <td style={{ padding: '7px 9px', color: T.muted }}>{factor.proxy}</td>
                  {config.exposureDisplay !== false && <td style={{ padding: '7px 9px', color: T.text, textAlign: 'right' }}>{factor.beta >= 0 ? '+' : ''}{factor.beta.toFixed(2)}</td>}
                  {config.contributionDisplay !== false && <td style={{ padding: '7px 9px', color: factor.risk_pct >= 0 ? T.gold : T.neg, textAlign: 'right' }}>{factor.risk_pct >= 0 ? '+' : ''}{factor.risk_pct.toFixed(1)}%</td>}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {factors.map(factor => {
              const value = config.valueMode === 'relative' ? factor.risk_pct / Math.max(data.systematic_pct, 1) * 100 : factor.risk_pct
              return (
                <div key={factor.factor} style={{ display: 'grid', gridTemplateColumns: minimal ? '72px 1fr 42px' : '90px 54px 1fr 50px', alignItems: 'center', gap: 7, padding: '7px 9px', borderBottom: `1px solid ${T.borderFaint}` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.text }}>{factor.factor}</span>
                  {!minimal && <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{config.exposureDisplay === false ? factor.proxy : `beta ${factor.beta >= 0 ? '+' : ''}${factor.beta.toFixed(2)}`}</span>}
                  <div style={{ height: 8, background: 'rgba(255,255,255,0.05)' }}>
                    <div style={{ width: `${Math.abs(value) / maxValue * 100}%`, height: '100%', background: value >= 0 ? T.gold : T.neg }} />
                  </div>
                  <span style={{ fontFamily: T.mono, fontSize: 9, textAlign: 'right', color: value >= 0 ? T.gold : T.neg }}>{value >= 0 ? '+' : ''}{value.toFixed(1)}%</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div style={{ padding: '4px 9px', borderTop: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 7.5, flexShrink: 0 }}>
        {portfolio.name || 'Active portfolio'} | {mode} | {benchmark} | {data.observations} observations
      </div>
    </div>
  )
}
