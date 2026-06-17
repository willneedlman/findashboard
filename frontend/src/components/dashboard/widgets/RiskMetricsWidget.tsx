import { T } from '../../../lib/theme'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { loadActivePortfolio, useQuotes, priceHoldings, money } from './usePortfolio'

const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }

interface Metrics { cagr: number; vol: number; sharpe: number; max_drawdown: number; sortino: number; calmar: number; beta: number }

const BENCH = 'SPY'
function windowDates(): { start: string; end: string } {
  const end = new Date()
  const start = new Date(); start.setFullYear(start.getFullYear() - 2)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

export default function RiskMetricsWidget({ config: _c }: { config: WidgetConfig }) {
  const { holdings, cash } = useMemo(() => loadActivePortfolio(), [])
  const quotes = useQuotes(holdings.map(h => h.ticker))
  const priced = priceHoldings(holdings, quotes).sort((a, b) => b.value - a.value)
  const nav = priced.reduce((s, p) => s + p.value, 0) + cash

  // Top 20 by value as market-value weights (compare caps tickers at 20).
  // Drop symbols the backend's validator would reject (it 400s the whole
  // request otherwise — one bad holding would blank every metric).
  const VALID = /^[A-Z0-9\-^=]{1,12}$/
  const top = priced.slice(0, 20)
  const cleaned = top
    .map(p => ({ p, t: p.ticker.toUpperCase().replace('.', '-') }))
    .filter(({ t }) => VALID.test(t))
  const invested = cleaned.reduce((s, c) => s + c.p.value, 0) || 1
  const tickers = cleaned.map(c => c.t)
  const weights = cleaned.map(c => c.p.value / invested)
  const sig = tickers.map((t, i) => `${t}:${weights[i].toFixed(3)}`).join(',')

  const { data, isLoading, isError } = useQuery<{ metrics: Metrics[] }>({
    queryKey: ['risk-metrics', sig],
    enabled: tickers.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () => {
      const { start, end } = windowDates()
      return axios.post('/api/portfolio/compare', {
        portfolios: [
          { name: 'Portfolio', tickers, weights },
          { name: BENCH, tickers: [BENCH], weights: [1] },
        ],
        benchmark: BENCH, start, end,
      }).then(r => r.data)
    },
  })

  if (tickers.length === 0) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, background: T.bg, fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
        No holdings yet. Add positions in the Portfolio Manager to compute risk metrics.
      </div>
    )
  }

  const m = data?.metrics?.[0]
  const dailyVol = m ? (m.vol / 100) / Math.sqrt(252) : 0
  // VaR describes the modelled basket (the priced top holdings, whose vol this
  // is), so scale by that invested value — not full NAV, which folds in cash
  // and any holdings past the 20-name cap that carry no vol here.
  const var95 = 1.645 * dailyVol * invested
  const dash = (v: string) => (m ? v : '—')

  const stats: { l: string; v: string; sub?: string; c: string }[] = [
    { l: 'VaR 95% · 1d', v: dash(money(-var95)), sub: m ? `-${(nav > 0 ? (var95 / nav) * 100 : 0).toFixed(1)}% NAV` : undefined, c: T.neg },
    { l: `Beta vs ${BENCH}`, v: dash(m ? m.beta.toFixed(2) : ''), c: T.text },
    { l: 'Sharpe', v: dash(m ? m.sharpe.toFixed(2) : ''), c: m && m.sharpe >= 0 ? T.pos : T.neg },
    { l: 'Ann. Vol', v: dash(m ? `${m.vol.toFixed(1)}%` : ''), c: T.gold },
    { l: 'Max Drawdown', v: dash(m ? `${m.max_drawdown.toFixed(1)}%` : ''), c: T.neg },
    { l: 'Sortino', v: dash(m ? m.sortino.toFixed(2) : ''), c: m && m.sortino >= 0 ? T.pos : T.neg },
  ]

  const topW = top.slice(0, 5).map(p => ({ ticker: p.ticker, pct: nav > 0 ? (p.value / nav) * 100 : 0 }))
  const maxW = Math.max(...topW.map(t => t.pct), 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', flexShrink: 0 }}>
        {stats.map((s, i) => (
          <div key={s.l} style={{ padding: '8px 10px', borderRight: i % 3 !== 2 ? `1px solid ${T.border}` : 'none', borderBottom: `1px solid ${T.border}` }}>
            <div style={cap}>{s.l}</div>
            <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: s.c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{s.v}</div>
            {s.sub && <div style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '9px 10px' }}>
        <div style={{ ...cap, color: T.gold, letterSpacing: '0.16em', marginBottom: 8 }}>Top Concentration (% NAV)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {topW.map(t => (
            <div key={t.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.text, width: 52, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.ticker}</span>
              <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${(t.pct / maxW) * 100}%`, height: '100%', background: T.gold }} />
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.gold, width: 38, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{t.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 12, paddingTop: 8, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', fontFamily: T.mono, fontSize: 9, color: T.muted }}>
          <span>CAGR <span style={{ color: m && m.cagr >= 0 ? T.pos : T.neg, fontWeight: 700 }}>{m ? `${m.cagr.toFixed(1)}%` : '—'}</span></span>
          <span>Calmar <span style={{ color: T.text, fontWeight: 700 }}>{m ? m.calmar.toFixed(2) : '—'}</span></span>
          <span>{isLoading ? 'loading…' : isError ? 'data error' : `2y · vs ${BENCH}`}</span>
        </div>
      </div>
    </div>
  )
}
