import { useState, useMemo, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from 'recharts'
import PageWrapper from '../../components/PageWrapper'
import { KpiCell } from '../../components/mmCockpit'
import { useChartColors } from '../../hooks/useChartColors'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../../components/StrategySelector'
import { rulesForTicker } from '../../components/CustomStrategyModal'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../../components/ChartTooltip'
import { FUTURES } from '../../lib/futures'
import ChartTooltip from '../../components/ChartTooltip'
import axios from 'axios'
import SidebarLayout from '../../components/SidebarLayout'
import { RailSection } from '../valuationShared'
import EmptyState from '../../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../../components/PortfolioIO'
import PMImportPicker from '../../components/PMImportPicker'
import { CASH_SYMBOL, type ImportResult } from '../../lib/pmImport'
import { usePortfolio } from '../../contexts/PortfolioContext'
import ConfigHeader, { RebalanceSelect, type RebalanceFreq } from '../../components/portfolio/ConfigHeader'
import HelpTip from '../../components/HelpTip'
import { TAB_BAR, TAB_BASE, type Tab, type Asset, makeAsset, PORT_DEFAULTS, PORT_INPUT, PORT_LABEL, PORT_TICK, ALGO_STRATEGIES, ALGO_DEFAULT_PARAMS, ALGO_PARAM_LABELS, ALGO_INPUT, ALGO_LABEL, ALGO_TICK, ALGO_SECTION_DIVIDER, type BacktestResult, type SignalResult } from './shared'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const POS = 'var(--theme-positive)', NEG = 'var(--theme-negative)'

// ── Shared sub-components ────────────────────────────────────────────────────

function PortChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
      }}>
        {label}
      </div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

function AlgoChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.85))', padding: '3px 10px',
        borderRight: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))',
        borderBottom: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
        color: 'var(--theme-text, #d7e3fc)',
      }}>
        {label}
      </div>
      <div style={{ paddingTop: 30, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

// ── Portfolio tab content ────────────────────────────────────────────────────

export function PortfolioTab() {
  const cc = useChartColors()
  const { holdings } = usePortfolio()
  const initialAssets = useMemo(() => {
    if (holdings.length === 0) return PORT_DEFAULTS
    const total = holdings.reduce((s, h) => s + h.weight, 0) || holdings.length
    return holdings.map(h => makeAsset(h.ticker, Math.round(h.weight / total * 100)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [assets, setAssets] = useState<Asset[]>(initialAssets)
  const [benchmark, setBenchmark] = useState('SPY')
  const [collapsed, setCollapsed] = useState(false)
  const [start, setStart] = useState('2020-01-01')
  const [end, setEnd] = useState(() => new Date().toISOString().split('T')[0])
  const [portSignalData, setPortSignalData] = useState<{ ticker: string; data: SignalChartPoint[]; trades: { date: string; action: string; price: number }[] }[]>([])
  const [slPct,    setSlPct]    = useState('')
  const [tpPct,    setTpPct]    = useState('')
  const [trailPct, setTrailPct] = useState('')
  const [posPct,   setPosPct]   = useState('100')
  const [cashYield, setCashYield] = useState('4.5')   // % APY earned on the un-deployed / idle cash sleeve
  const [leverage,   setLeverage]   = useState('1')
  const [borrowRate, setBorrowRate] = useState('0')
  const [rebalance,  setRebalance]  = useState<RebalanceFreq>('none')

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const totalWeight = assets.reduce((s, a) => s + a.weight, 0) || 100
      const weights = assets.map(a => a.weight / totalWeight * 100)

      const [{ data: bt }, ...legSigs] = await Promise.all([
        axios.post('/api/portfolio/backtest', {
          tickers: assets.map(a => a.ticker),
          weights,
          benchmark, start, end,
          leverage: Number(leverage) || 1,
          borrow_rate: Number(borrowRate) || 0,
          rebalance,
        }),
        ...assets.map(a => {
          if (a.strategy === STRATEGIES[0]) return Promise.resolve(null)
          if (a.strategy === CUSTOM_STRATEGY_KEY) {
            const customDef = a.stratParams._custom_def ? JSON.parse(a.stratParams._custom_def) : null
            if (!customDef) return Promise.resolve(null)
            return axios.post('/api/strategy/custom-signal', {
              ticker: a.ticker, start, end,
              rules: rulesForTicker(customDef, a.ticker), bull_drift: customDef.bull_drift ?? 5, bear_drift: customDef.bear_drift ?? -3,
            }).then(r => r.data).catch(() => null)
          }
          return axios.post('/api/strategy/signal', { ticker: a.ticker, strategy: a.strategy, start, end, params: a.stratParams })
            .then(r => r.data).catch(() => null)
        }),
      ])

      const rfDaily = (parseFloat(cashYield) || 0) / 100 / 252   // cash sleeve grows at the chosen yield
      const hasAnyStrategy = legSigs.some(s => s?.signal?.length > 0)

      let strategyResult = null
      if (hasAnyStrategy) {
        const sigMaps: Record<string, number>[] = legSigs.map(sig => {
          const m: Record<string, number> = {}
          if (sig?.signal) sig.signal.forEach((s: any) => { m[s.date] = s.value })
          return m
        })
        const lastSigs = assets.map(() => 1)

        const tickerRetMaps: Record<string, Record<string, number>> = {}
        for (const a of assets) {
          const map: Record<string, number> = {}
          bt.per_ticker_returns[a.ticker]?.forEach((r: any) => { map[r.date] = r.value / 100 })
          tickerRetMaps[a.ticker] = map
        }

        const sl    = slPct    ? parseFloat(slPct)    / 100 : null
        const tp    = tpPct    ? parseFloat(tpPct)    / 100 : null
        const trail = trailPct ? parseFloat(trailPct) / 100 : null
        const pos   = parseFloat(posPct || '100') / 100

        const legInTrade  = assets.map(() => false)
        const legEntryCum = assets.map(() => 1.0)
        const legPeakCum  = assets.map(() => 1.0)
        const legStopped  = assets.map(() => false)

        let stratVal = 100, portVal = 100, benchVal = 100
        const stratCumulative: { date: string; strategy: number; portfolio: number; benchmark: number }[] = []

        bt.cumulative.forEach((row: any, i: number) => {
          assets.forEach((_, li) => {
            const sv = sigMaps[li][row.date]
            if (sv !== undefined) {
              const wasIn = lastSigs[li] > 0.5
              const nowIn = sv > 0.5
              if (wasIn && !nowIn) {
                legInTrade[li] = false; legEntryCum[li] = 1.0; legPeakCum[li] = 1.0; legStopped[li] = false
              } else if (!wasIn && nowIn) {
                legInTrade[li] = true; legEntryCum[li] = 1.0; legPeakCum[li] = 1.0; legStopped[li] = false
              }
              lastSigs[li] = sv
            }
          })

          if (i > 0) {
            const prevRow = bt.cumulative[i - 1]
            const benchRet = (row.benchmark / prevRow.benchmark) - 1

            let stratPortRet = 0
            assets.forEach((a, li) => {
              const wt = a.weight / totalWeight
              const actualRet = tickerRetMaps[a.ticker][row.date] ?? 0
              if (!legInTrade[li] || legStopped[li]) { stratPortRet += wt * rfDaily; return }
              legEntryCum[li] *= (1 + actualRet)
              legPeakCum[li]   = Math.max(legPeakCum[li], legEntryCum[li])
              const gain         = legEntryCum[li] - 1.0
              const drawFromPeak = legPeakCum[li] > 0 ? (legPeakCum[li] - legEntryCum[li]) / legPeakCum[li] : 0
              if ((sl    !== null && gain         < -sl)    ||
                  (tp    !== null && gain         > tp)     ||
                  (trail !== null && drawFromPeak > trail)) {
                legStopped[li] = true; stratPortRet += wt * rfDaily; return
              }
              stratPortRet += wt * (pos * actualRet + (1 - pos) * rfDaily)
            })

            const portRet = bt.daily_returns[i]?.value / 100 || 0
            portVal *= (1 + portRet)
            stratVal *= (1 + stratPortRet)
            benchVal *= (1 + benchRet)
          }
          stratCumulative.push({ date: row.date, strategy: +stratVal.toFixed(2), portfolio: +portVal.toFixed(2), benchmark: +benchVal.toFixed(2) })
        })

        const finalStrat = stratCumulative[stratCumulative.length - 1]?.strategy ?? 100
        const years = Math.max((new Date(end).getTime() - new Date(start).getTime()) / (365.25 * 86400000), 1)
        const signalTrades: { ticker: string; trades: { date: string; action: string; price: number }[] }[] = []
        assets.forEach((a, i) => {
          const sig: { date: string; value: number }[] = legSigs[i]?.signal ?? []
          if (!sig.length || a.strategy === STRATEGIES[0]) return
          const trades: { date: string; action: string; price: number }[] = []
          for (let j = 1; j < sig.length; j++) {
            if (sig[j - 1].value < 0.5 && sig[j].value >= 0.5)
              trades.push({ date: sig[j].date, action: 'BUY', price: 0 })
            else if (sig[j - 1].value >= 0.5 && sig[j].value < 0.5)
              trades.push({ date: sig[j].date, action: 'SELL', price: 0 })
          }
          if (trades.length > 0) signalTrades.push({ ticker: a.ticker, trades })
        })

        strategyResult = {
          cumulative: stratCumulative,
          cagr: +(((finalStrat / 100) ** (1 / years) - 1) * 100).toFixed(2),
          signalTrades,
          legs: assets.map((a, i) => ({
            ticker: a.ticker,
            strategy: a.strategy,
            label: legSigs[i]?.label ?? '',
            detail: legSigs[i]?.detail ?? '',
            drift_adj: legSigs[i]?.drift_adj ?? 0,
          })).filter(l => l.strategy !== STRATEGIES[0] && l.label),
        }
      }

      return { ...bt, strategyResult }
    },
  })

  useEffect(() => {
    const legs = data?.strategyResult?.signalTrades as { ticker: string; trades: { date: string; action: string; price: number }[] }[] | undefined
    if (!legs?.length) { setPortSignalData([]); return }
    Promise.all(
      legs.map(leg =>
        axios.get(`/api/market/history?ticker=${encodeURIComponent(leg.ticker)}&start=${start}`)
          .then(r => {
            const prices: { date: string; value: number }[] = r.data.price ?? []
            const priceByDate: Record<string, number> = {}
            prices.forEach(p => { priceByDate[p.date] = p.value })
            const tradeMap: Record<string, { buy?: number; sell?: number }> = {}
            leg.trades.forEach(tr => {
              if (!tradeMap[tr.date]) tradeMap[tr.date] = {}
              const px = priceByDate[tr.date] ?? 0
              if (tr.action === 'BUY') tradeMap[tr.date].buy = px
              else tradeMap[tr.date].sell = px
            })
            return {
              ticker: leg.ticker,
              data: prices.map(p => ({ date: p.date, price: p.value, ...tradeMap[p.date] })),
              trades: leg.trades.map(tr => ({ ...tr, price: priceByDate[tr.date] ?? 0 })),
            }
          })
          .catch(() => null)
      )
    ).then(res => setPortSignalData(res.filter(Boolean) as typeof portSignalData))
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateAsset = (i: number, patch: Partial<Asset>) =>
    setAssets(prev => prev.map((a, idx) => idx === i ? { ...a, ...patch } : a))

  return (
    <>
      <ConfigHeader
        mode="backtester"
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(c => !c)}
        holdings={assets}
        onHoldingsChange={setAssets}
        benchmark={benchmark} setBenchmark={setBenchmark}
        leverage={leverage} setLeverage={setLeverage}
        borrowRate={borrowRate} setBorrowRate={setBorrowRate}
        sl={{ val: slPct, set: setSlPct }}
        tp={{ val: tpPct, set: setTpPct }}
        trail={{ val: trailPct, set: setTrailPct }}
        pos={{ val: posPct, set: setPosPct }}
        cash={{ val: cashYield, set: setCashYield }}
        start={start} setStart={setStart}
        end={end} setEnd={setEnd}
        paramExtra={<RebalanceSelect value={rebalance} onChange={setRebalance} />}
        onRun={() => mutate()}
        isRunning={isPending}
        tickerListId="ft-futures"
        tickerList={<datalist id="ft-futures">{FUTURES.map(f => <option key={f.sym} value={f.sym}>{f.label}</option>)}</datalist>}
        overflow={
          <>
            <PMImportPicker
              style={{ ...PORT_INPUT, cursor: 'pointer' }}
              onImport={(r: ImportResult) => {
                const next: Asset[] = r.legs.map(l => makeAsset(l.ticker, l.weight))
                if (r.cashWeight > 0) next.push(makeAsset(CASH_SYMBOL, r.cashWeight))
                if (next.length) setAssets(next)
              }}
            />
            <PortfolioIO
              mode="portfolio"
              assets={assets.map(a => ({ ticker: a.ticker, weight: a.weight, strategy: a.strategy, stratParams: a.stratParams as Record<string, unknown> }))}
              onImportAssets={(imported: PortfolioAsset[]) =>
                setAssets(imported.map(a => ({
                  ticker: a.ticker,
                  weight: a.weight,
                  strategy: a.strategy ?? STRATEGIES[0],
                  stratParams: (a.stratParams ?? {}) as StrategyParams,
                })))
              }
              name="portfolio"
            />
          </>
        }
      />
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!data && !isPending && (
          <EmptyState title="Portfolio Backtester" hint="Set tickers, weights and a date range, then run the backtest."
            action="Run Portfolio Engine" />
        )}

        {data && (
          <>
            {data.leverage > 1 && (
              <div style={{
                background: 'var(--theme-bg, #101c2e)',
                border: `1px solid color-mix(in srgb, ${data.liquidated ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)'} 35%, transparent)`,
                borderLeft: `4px solid ${data.liquidated ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)'}`,
                padding: '8px 14px', fontFamily: 'var(--theme-mono)', fontSize: 11, lineHeight: 1.5,
              }}>
                <span style={{ color: data.liquidated ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>
                  {data.liquidated ? 'LIQUIDATED' : `LEVERED ${data.leverage}x`}
                </span>
                <span style={{ color: 'var(--theme-secondary, #99907e)', marginLeft: 8 }}>
                  {data.liquidated
                    ? `Equity hit zero at ${data.leverage}x leverage. The portfolio was wiped out; the curve below stops at -100%.`
                    : `Borrowing ${(data.leverage - 1).toFixed(2)}x capital at ${data.borrow_rate}% to magnify returns. Metrics reflect the levered equity.`}
                </span>
              </div>
            )}
            {data.strategyResult?.legs?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.strategyResult.legs.map((l: any, i: number) => (
                  <div key={i} style={{
                    background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                    borderLeft: `4px solid ${l.drift_adj >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)'}`,
                    padding: '8px 14px',
                  }}>
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: l.drift_adj >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)', marginBottom: 3 }}>
                      {l.ticker} · {l.strategy} · {l.label}
                      <span style={{ marginLeft: 10, fontSize: 10, color: 'var(--theme-secondary, #99907e)', fontWeight: 400 }}>
                        Drift adj: {l.drift_adj > 0 ? '+' : ''}{l.drift_adj}%
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)' }}>{l.detail}</div>
                  </div>
                ))}
              </div>
            )}

            {(() => {
              const m = data.metrics
              const vsBench = m.port_cagr - m.bench_cagr
              return (
                <div style={STRIP}>
                  <KpiCell grow minWidth={155} label="Portfolio CAGR" value={`${m.port_cagr}%`} valueSize={16}
                    color={m.port_cagr >= 0 ? POS : NEG}
                    sub={`${vsBench > 0 ? '+' : ''}${vsBench.toFixed(2)}% vs ${benchmark}`} subColor={vsBench > 0 ? POS : NEG} />
                  <KpiCell grow label={`${benchmark} CAGR`} value={`${m.bench_cagr}%`} />
                  <KpiCell grow label="Sharpe" value={String(m.port_sharpe)} color={m.port_sharpe >= 1 ? POS : undefined} />
                  <KpiCell grow label="Ann. Vol" value={`${m.port_vol}%`} />
                  <KpiCell grow label="Max Drawdown" value={`${m.max_drawdown}%`} color={NEG} />
                  <KpiCell grow label="Sortino" value={String(m.sortino)} color={m.sortino >= 1 ? POS : undefined} />
                  {data.strategyResult
                    ? <KpiCell grow label="Strategy CAGR" value={`${data.strategyResult.cagr}%`} color={data.strategyResult.cagr >= m.port_cagr ? POS : NEG}
                        sub={`${(data.strategyResult.cagr - m.port_cagr).toFixed(2)}% vs port`} subColor={data.strategyResult.cagr >= m.port_cagr ? POS : NEG} />
                    : <KpiCell grow label="Calmar" value={String(m.calmar)} />}
                  <KpiCell grow label="Beta" value={String(m.beta)} />
                </div>
              )
            })()}

            <PortChartPanel label="Cumulative Return — Base 100" height={308}>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.strategyResult?.cumulative || data.cumulative}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="date" tick={PORT_TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                  <YAxis tick={PORT_TICK} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke={cc.c2} strokeWidth={2.5} dot={false} />
                  <Line type="monotone" dataKey="benchmark" name={benchmark} stroke={cc.primary} strokeWidth={2} strokeDasharray="5 3" dot={false} />
                  {data.strategyResult && (
                    <Line type="monotone" dataKey="strategy" name="Strategy Overlay"
                      stroke={cc.gain} strokeWidth={2} strokeDasharray="4 2" dot={false} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </PortChartPanel>

            <div className="chart-pair">
              <PortChartPanel label="Daily Portfolio Returns" height={208}>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.daily_returns}>
                    <XAxis dataKey="date" tick={false} />
                    <YAxis tick={PORT_TICK} tickFormatter={v => `${v}%`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={BAR_CURSOR} />
                    <Bar dataKey="value" fill={cc.c2Muted} opacity={0.7} />
                  </BarChart>
                </ResponsiveContainer>
              </PortChartPanel>
              <PortChartPanel label={`Rolling 60D Beta vs ${benchmark}`} height={208}>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={data.rolling_beta}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={PORT_TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={PORT_TICK} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                    <ReferenceLine y={1} stroke="rgba(128,128,128,0.4)" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="value" stroke={cc.gain} strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </PortChartPanel>
            </div>

            {portSignalData.map(leg => (
              <BacktestSignalChart
                key={leg.ticker}
                data={leg.data}
                ticker={leg.ticker}
                trades={leg.trades}
              />
            ))}
          </>
        )}
      </div>
    </>
  )
}

// ── Backtest signal chart ────────────────────────────────────────────────────

interface SignalChartPoint {
  date: string
  price: number
  buy?: number
  sell?: number
}

function BacktestSignalChart({ data, ticker, trades }: {
  data: SignalChartPoint[]
  ticker: string
  trades: { date: string; action: string; price: number }[]
}) {
  const cc = useChartColors()
  const buyCount = trades.filter(t => t.action === 'BUY').length
  const sellCount = trades.filter(t => t.action === 'SELL').length

  type DotProps = { cx?: number; cy?: number; value?: number }

  const BuyDot = (props: DotProps) => {
    const { cx = 0, cy = 0, value } = props
    if (value == null) return null
    return <polygon points={`${cx},${cy - 7} ${cx - 5},${cy + 1} ${cx + 5},${cy + 1}`} style={{ fill: 'var(--theme-positive)' }} stroke="none" />
  }

  const SellDot = (props: DotProps) => {
    const { cx = 0, cy = 0, value } = props
    if (value == null) return null
    return <polygon points={`${cx},${cy + 7} ${cx - 5},${cy - 1} ${cx + 5},${cy - 1}`} style={{ fill: 'var(--theme-negative)' }} stroke="none" />
  }

  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--theme-surface, rgba(46,57,77,0.85))', padding: '4px 10px',
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>
        <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>REPLAY · {ticker}</span>
        <span style={{ color: 'var(--theme-positive)' }}>↑ {buyCount} BUY</span>
        <span style={{ color: 'var(--theme-negative)' }}>↓ {sellCount} SELL</span>
      </div>
      <div style={{ padding: '4px 8px 8px 8px', height: 260 }}>
        {data.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, color: 'var(--theme-text-muted, rgba(215,227,252,0.35))', fontFamily: 'var(--theme-mono)' }}>
            Fetching price history…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
              <XAxis
                dataKey="date"
                tick={ALGO_TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={d => d.slice(0, 7)}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={ALGO_TICK}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={v => `$${(v as number).toFixed(0)}`}
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={<ChartTooltip formatter={(v, _n) => `$${(v as number).toFixed(2)}`} />}
                contentStyle={TOOLTIP_STYLE}
                cursor={CROSSHAIR_CURSOR}
              />
              <Line
                type="monotone"
                dataKey="price"
                name="Price"
                stroke={cc.primary}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: cc.primary }}
              />
              <Line
                type="monotone"
                dataKey="buy"
                name="BUY"
                stroke="transparent"
                dot={<BuyDot />}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="sell"
                name="SELL"
                stroke="transparent"
                dot={<SellDot />}
                activeDot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

// ── Strategy tab content ─────────────────────────────────────────────────────

export function StrategyTab() {
  const cc = useChartColors()

  const [ticker, setTicker] = useState('SPY')
  const [strategy, setStrategy] = useState('rsi_mean_reversion')
  const [params, setParams] = useState<Record<string, number>>(ALGO_DEFAULT_PARAMS.rsi_mean_reversion)
  const [startDate, setStartDate] = useState('2022-01-01')
  const [stratOpen, setStratOpen] = useState(true)
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [trailingStop, setTrailingStop] = useState('')
  const [maxHoldBars, setMaxHoldBars] = useState('')
  const [positionSize, setPositionSize] = useState('100')
  const [initialCapital, setInitialCapital] = useState('10000')

  const [oosSplit, setOosSplit] = useState(0)   // 0 = off; else in-sample fraction (0.7, 0.5)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [priceChartData, setPriceChartData] = useState<SignalChartPoint[]>([])
  const [liveSignal, setLiveSignal] = useState<SignalResult | null>(null)
  const [aiCommentary, setAiCommentary] = useState<any>(null)
  const [aiCommentaryPending, setAiCommentaryPending] = useState(false)

  const signalMutation = useMutation({
    mutationFn: (body: object) =>
      axios.post('/api/algo/signal', body).then(r => r.data as SignalResult),
    onSuccess: data => setLiveSignal(data),
  })

  const backtestMutation = useMutation({
    mutationFn: (body: object) =>
      axios.post('/api/algo/backtest', body).then(r => r.data as BacktestResult),
    onSuccess: data => {
      setResult(data)
      setPriceChartData([])
      signalMutation.mutate({ ticker: ticker.trim().toUpperCase(), strategy, params })
      const t = ticker.trim().toUpperCase()
      axios.get(`/api/market/history?ticker=${encodeURIComponent(t)}&start=${startDate}`)
        .then(r => {
          const prices: { date: string; value: number }[] = r.data.price ?? []
          const tradeMap: Record<string, { buy?: number; sell?: number }> = {}
          data.trades.forEach(tr => {
            if (!tradeMap[tr.date]) tradeMap[tr.date] = {}
            if (tr.action === 'BUY') tradeMap[tr.date].buy = tr.price
            else if (tr.action === 'SELL') tradeMap[tr.date].sell = tr.price
          })
          setPriceChartData(prices.map(p => ({ date: p.date, price: p.value, ...tradeMap[p.date] })))
        })
        .catch(() => {})
    },
  })

  function handleStrategyChange(val: string) {
    setStrategy(val)
    setParams(ALGO_DEFAULT_PARAMS[val] ?? {})
  }

  function handleParamChange(key: string, val: string) {
    const n = parseFloat(val)
    setParams(prev => ({ ...prev, [key]: val === '' ? 0 : isNaN(n) ? prev[key] ?? 0 : n }))
  }

  function runBacktest() {
    const sl = parseFloat(stopLoss)
    const tp = parseFloat(takeProfit)
    const ts = parseFloat(trailingStop)
    const mh = parseInt(maxHoldBars)
    const ps = parseFloat(positionSize)
    const ic = parseFloat(initialCapital)
    backtestMutation.mutate({
      ticker: ticker.trim().toUpperCase(),
      strategy,
      params,
      start: startDate,
      stop_loss:      isNaN(sl) || sl <= 0 ? undefined : sl,
      take_profit:    isNaN(tp) || tp <= 0 ? undefined : tp,
      trailing_stop:  isNaN(ts) || ts <= 0 ? undefined : ts,
      max_hold_bars:  isNaN(mh) || mh <= 0 ? undefined : mh,
      position_size:  isNaN(ps) ? 100 : Math.min(100, Math.max(5, ps)),
      initial_capital: isNaN(ic) || ic <= 0 ? 10000 : ic,
    })
  }

  const monthlyReturns = useMemo(() => {
    if (!result) return []
    const curve = result.equity_curve
    const monthly: Record<string, { start: number; end: number }> = {}
    for (const pt of curve) {
      const month = pt.date.slice(0, 7)
      if (!monthly[month]) monthly[month] = { start: pt.strategy, end: pt.strategy }
      monthly[month].end = pt.strategy
    }
    return Object.entries(monthly).map(([month, { start, end }]) => ({
      month,
      return: parseFloat(((end / start - 1) * 100).toFixed(2)),
    }))
  }, [result])

  // Walk-forward sanity: split the equity curve into in-sample / out-of-sample
  // and compute each segment's return / Sharpe / max-drawdown client-side.
  const oos = useMemo(() => {
    if (!result || oosSplit <= 0) return null
    const c = result.equity_curve
    if (c.length < 10) return null
    const splitIdx = Math.max(2, Math.min(c.length - 3, Math.floor(c.length * oosSplit)))
    const seg = (lo: number, hi: number) => {
      const s = c.slice(lo, hi + 1)
      if (s.length < 2) return null
      let peak = s[0].strategy, mdd = 0
      const rets: number[] = []
      for (let i = 0; i < s.length; i++) {
        peak = Math.max(peak, s[i].strategy)
        mdd = Math.min(mdd, s[i].strategy / peak - 1)
        if (i > 0) rets.push(s[i].strategy / s[i - 1].strategy - 1)
      }
      const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1)
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)) || 1e-9
      return { ret: (s[s.length - 1].strategy / s[0].strategy - 1) * 100, mdd: mdd * 100, sharpe: (mean / sd) * Math.sqrt(252) }
    }
    return { splitDate: c[splitIdx]?.date, is: seg(0, splitIdx), oosM: seg(splitIdx, c.length - 1) }
  }, [result, oosSplit])

  const signalColor = liveSignal
    ? liveSignal.signal === 'BUY' ? cc.gain
      : liveSignal.signal === 'SELL' ? cc.loss
      : cc.muted
    : cc.muted

  const paramKeys = Object.keys(ALGO_DEFAULT_PARAMS[strategy] ?? {})
  const paramLabels = ALGO_PARAM_LABELS[strategy] ?? {}

  const sidebar = (
    <RailSection title="Strategy Controls" open={stratOpen} onToggle={() => setStratOpen(o => !o)}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <span style={ALGO_LABEL}>Ticker</span>
        <input
          style={ALGO_INPUT}
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          placeholder="e.g. SPY"
        />
      </div>

      <div>
        <span style={ALGO_LABEL}>
          Strategy
          <HelpTip text="RSI Mean Reversion: buys oversold, sells overbought. MA Crossover: long when fast MA > slow MA. Bollinger Breakout: enters on band breaks. Momentum: long when N-day return is positive." position="bottom" width={230} />
        </span>
        <select
          style={{ ...ALGO_INPUT, cursor: 'pointer' }}
          value={strategy}
          onChange={e => handleStrategyChange(e.target.value)}
        >
          {ALGO_STRATEGIES.map(s => (
            <option key={s.value} value={s.value} style={{ background: 'var(--theme-surface)' }}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {paramKeys.length > 0 && (
        <div style={ALGO_SECTION_DIVIDER}>
          <span style={{ ...ALGO_LABEL, color: 'var(--theme-primary, #c9a84c)', marginBottom: 8 }}>Parameters</span>
          {paramKeys.map(key => (
            <div key={key} style={{ marginBottom: 8 }}>
              <span style={ALGO_LABEL}>{paramLabels[key] ?? key}</span>
              <input
                type="number"
                style={ALGO_INPUT}
                value={params[key] ?? ''}
                onChange={e => handleParamChange(key, e.target.value)}
                step={key === 'std_dev' ? 0.1 : 1}
              />
            </div>
          ))}
        </div>
      )}

      <div style={ALGO_SECTION_DIVIDER}>
        <span style={{ ...ALGO_LABEL, color: 'var(--theme-primary, #c9a84c)', marginBottom: 8 }}>
          Risk Management
          <HelpTip text="Stop-loss and take-profit exit the position when price moves the specified % from entry. Position size controls how much of the portfolio is deployed per trade. The remainder stays in cash." position="bottom" width={230} />
        </span>
        {/* Preset risk profiles */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
          {([
            { label: 'Conservative', sl: '5', tp: '10', trail: '4', pos: '25' },
            { label: 'Moderate',     sl: '8', tp: '20', trail: '6', pos: '50' },
            { label: 'Aggressive',   sl: '15', tp: '40', trail: '10', pos: '100' },
            { label: 'Scalp',        sl: '2', tp: '4',  trail: '1.5', pos: '75' },
          ] as const).map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => { setStopLoss(p.sl); setTakeProfit(p.tp); setTrailingStop(p.trail); setPositionSize(p.pos) }}
              style={{
                background: 'color-mix(in srgb, var(--theme-primary) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)',
                color: 'color-mix(in srgb, var(--theme-primary) 85%, transparent)',
                fontFamily: 'var(--theme-mono)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                padding: '3px 7px',
                cursor: 'pointer',
                borderRadius: 2,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary) 18%, transparent)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary) 8%, transparent)')}
            >
              {p.label.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Stop-Loss %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={stopLoss}
            onChange={e => setStopLoss(e.target.value)}
            placeholder="e.g. 5  (off if blank)"
            min={0.1}
            step={0.5}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Take-Profit %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={takeProfit}
            onChange={e => setTakeProfit(e.target.value)}
            placeholder="e.g. 15  (off if blank)"
            min={0.1}
            step={0.5}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Trailing Stop %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={trailingStop}
            onChange={e => setTrailingStop(e.target.value)}
            placeholder="e.g. 8  (off if blank)"
            min={0.1}
            step={0.5}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Max Hold (days)</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={maxHoldBars}
            onChange={e => setMaxHoldBars(e.target.value)}
            placeholder="e.g. 20  (off if blank)"
            min={1}
            step={1}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Position Size %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={positionSize}
            onChange={e => setPositionSize(e.target.value)}
            min={5}
            max={100}
            step={5}
          />
        </div>
        <div>
          <span style={ALGO_LABEL}>Initial Capital ($)</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={initialCapital}
            onChange={e => setInitialCapital(e.target.value)}
            min={100}
            step={1000}
          />
        </div>
      </div>

      <div style={ALGO_SECTION_DIVIDER}>
        <span style={ALGO_LABEL}>Start Date</span>
        <input
          type="date"
          style={ALGO_INPUT}
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
        />
      </div>

      <button
        onClick={runBacktest}
        disabled={backtestMutation.isPending}
        style={{
          marginTop: 6,
          background: backtestMutation.isPending
            ? 'color-mix(in srgb, var(--theme-primary) 15%, transparent)'
            : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
          color: backtestMutation.isPending ? 'color-mix(in srgb, var(--theme-primary) 45%, transparent)' : 'var(--theme-primary, #c9a84c)',
          fontFamily: 'var(--theme-mono)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.12em',
          padding: '8px 12px',
          cursor: backtestMutation.isPending ? 'not-allowed' : 'pointer',
          width: '100%',
          textTransform: 'uppercase',
          transition: 'all 0.15s',
        }}
      >
        {backtestMutation.isPending ? '· Running ·' : '↓ Run Backtest'}
      </button>

      {backtestMutation.isError && (
        <div style={{ fontSize: 10, color: cc.loss, letterSpacing: '0.04em', padding: '4px 0' }}>
          Error: {(backtestMutation.error as Error)?.message ?? 'Request failed'}
        </div>
      )}

      <div style={{ ...ALGO_SECTION_DIVIDER, marginTop: 18 }}>
        <span style={{ ...ALGO_LABEL, marginBottom: 8 }}>Live Signal</span>
        {liveSignal ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '5px 14px',
              border: `1px solid ${signalColor}`,
              background: `color-mix(in srgb, ${signalColor} 12%, transparent)`,
              color: signalColor,
              fontFamily: 'var(--theme-mono)',
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: '0.18em',
            }}>
              {liveSignal.signal}
            </div>
            <div style={{ fontSize: 9, color: 'var(--theme-secondary, #5e768f)', letterSpacing: '0.05em', lineHeight: '14px' }}>
              {liveSignal.description}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.2))', letterSpacing: '0.06em' }}>
            Run backtest to compute
          </div>
        )}
      </div>
    </div>
    </RailSection>
  )

  return (
    <SidebarLayout sidebar={sidebar} sidebarTitle="" sidebarWidth={220}>
      {!result && !backtestMutation.isPending && (
        <EmptyState
          title="No backtest results yet"
          hint="Configure a strategy in the sidebar and click Run Backtest."
          action="Run Backtest"
        />
      )}

      {backtestMutation.isPending && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 300, color: 'var(--theme-secondary, #5e768f)',
          fontFamily: 'var(--theme-mono)', fontSize: 11, letterSpacing: '0.12em',
        }}>
          Computing strategy signals…
        </div>
      )}

      {result && !backtestMutation.isPending && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(() => {
            const m = result.metrics
            return (
              <div style={STRIP}>
                <KpiCell grow minWidth={150} label="Total Return" value={`${m.total_return > 0 ? '+' : ''}${m.total_return.toFixed(2)}%`} valueSize={16} color={m.total_return >= 0 ? POS : NEG} />
                <KpiCell grow label="Ann. Return" value={`${m.ann_return > 0 ? '+' : ''}${m.ann_return.toFixed(2)}%`} color={m.ann_return >= 0 ? POS : NEG} />
                <KpiCell grow label="Max Drawdown" value={`${m.max_drawdown.toFixed(2)}%`} color={NEG} />
                <KpiCell grow label="Sharpe Ratio" value={m.sharpe.toFixed(3)} color={m.sharpe >= 1 ? POS : undefined} />
                <KpiCell grow label="Num Trades" value={String(m.num_trades)} />
                <KpiCell grow label="Win Rate" value={`${m.win_rate.toFixed(1)}%`} color={m.win_rate >= 50 ? POS : NEG} />
                <KpiCell grow label="Final Capital" value={`$${m.final_capital >= 1000 ? (m.final_capital / 1000).toFixed(1) + 'K' : m.final_capital.toFixed(0)}`} />
                <KpiCell grow label="P&L ($)" value={`${m.total_pnl >= 0 ? '+' : ''}$${Math.abs(m.total_pnl) >= 1000 ? (m.total_pnl / 1000).toFixed(1) + 'K' : m.total_pnl.toFixed(0)}`} color={m.total_pnl >= 0 ? POS : NEG} />
              </div>
            )
          })()}

          {/* AI Backtest Commentary */}
          <div style={{ border: '1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 3%, transparent)' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary) 12%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>AI Backtest Commentary</span>
              <button
                onClick={async () => {
                  setAiCommentaryPending(true)
                  try {
                    const { data: r } = await axios.post('/api/ai/backtest-commentary', {
                      strategy_name: strategy,
                      ticker: ticker.trim().toUpperCase(),
                      total_return: result.metrics.total_return,
                      ann_return: result.metrics.ann_return,
                      max_drawdown: result.metrics.max_drawdown,
                      sharpe: result.metrics.sharpe,
                      win_rate: result.metrics.win_rate,
                      num_trades: result.metrics.num_trades,
                    })
                    setAiCommentary(r)
                  } catch { /* silent */ }
                  setAiCommentaryPending(false)
                }}
                disabled={aiCommentaryPending}
                style={{
                  background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--theme-primary) 40%, transparent)', color: 'var(--theme-primary, #c9a84c)',
                  fontFamily: 'var(--theme-mono)', fontSize: 9,
                  padding: '2px 6px', cursor: aiCommentaryPending ? 'default' : 'pointer',
                  opacity: aiCommentaryPending ? 0.5 : 1,
                }}
              >{aiCommentaryPending ? '…' : 'Analyze'}</button>
            </div>
            {!aiCommentary && !aiCommentaryPending && (
              <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-sans)' }}>
                Click Analyze for AI commentary on these backtest results.
              </div>
            )}
            {aiCommentary && (
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '16px', fontFamily: 'var(--theme-sans)' }}>{aiCommentary.verdict}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Strengths', items: aiCommentary.strengths, color: 'var(--theme-positive)' },
                    { label: 'Weaknesses', items: aiCommentary.weaknesses, color: 'var(--theme-negative)' },
                  ].map(({ label, items, color }) => (
                    <div key={label}>
                      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
                      {(items ?? []).map((s: string, i: number) => (
                        <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', paddingLeft: 8, borderLeft: `2px solid ${color}44`, marginBottom: 3, fontFamily: 'var(--theme-sans)' }}>{s}</div>
                      ))}
                    </div>
                  ))}
                </div>
                {Array.isArray(aiCommentary.suggestions) && aiCommentary.suggestions.length > 0 && (
                  <div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase', marginBottom: 4 }}>Suggestions</div>
                    {aiCommentary.suggestions.map((s: string, i: number) => (
                      <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', paddingLeft: 8, borderLeft: '2px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)', marginBottom: 3, fontFamily: 'var(--theme-sans)' }}>{s}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={ALGO_LABEL}>Out-of-sample test</span>
            <div style={{ display: 'flex', border: '1px solid var(--theme-border, rgba(255,255,255,0.1))' }}>
              {([['Off', 0], ['70 / 30', 0.7], ['50 / 50', 0.5]] as const).map(([lbl, v], i) => (
                <button key={lbl} onClick={() => setOosSplit(v)} style={{
                  background: oosSplit === v ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'transparent',
                  border: 'none', borderRight: i < 2 ? '1px solid var(--theme-border, rgba(255,255,255,0.1))' : 'none', cursor: 'pointer',
                  color: oosSplit === v ? cc.primary : cc.muted, fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 10px',
                }}>{lbl}</button>
              ))}
            </div>
            {oos?.is && oos.oosM && (
              <div style={{ display: 'flex', gap: 16, marginLeft: 'auto', fontFamily: 'var(--theme-mono)', fontSize: 10, flexWrap: 'wrap' }}>
                {([['IN-SAMPLE', oos.is], ['OUT-OF-SAMPLE', oos.oosM]] as const).map(([k, m]) => (
                  <span key={k} style={{ color: cc.muted }}>
                    {k}: <span style={{ color: m.ret >= 0 ? cc.gain : cc.loss, fontWeight: 700 }}>{m.ret >= 0 ? '+' : ''}{m.ret.toFixed(1)}%</span>
                    {' · '}Sharpe {m.sharpe.toFixed(2)}{' · '}DD {m.mdd.toFixed(1)}%
                  </span>
                ))}
              </div>
            )}
          </div>

          <AlgoChartPanel label={`Equity Curve — Strategy vs Buy & Hold (starts $${Number(initialCapital || 10000).toLocaleString()})`} height={350}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={result.equity_curve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="stratGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={cc.c2} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={cc.c2} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                <XAxis
                  dataKey="date"
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={d => d.slice(0, 7)}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `$${v}`}
                  width={48}
                />
                <Tooltip
                  content={<ChartTooltip formatter={(v, _n) => `$${(v as number).toFixed(2)}`} />}
                  contentStyle={TOOLTIP_STYLE}
                  cursor={CROSSHAIR_CURSOR}
                />
                <Legend
                  wrapperStyle={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.08em', paddingTop: 6 }}
                />
                <ReferenceLine y={100} stroke="var(--theme-text-subtle, rgba(255,255,255,0.12))" strokeDasharray="4 2" />
                {oos?.splitDate && <ReferenceLine x={oos.splitDate} stroke={cc.primary} strokeOpacity={0.6} strokeDasharray="3 4" label={{ value: 'OOS →', fill: cc.primary, fontSize: 9, position: 'insideTopRight' }} />}
                <Area
                  type="monotone"
                  dataKey="strategy"
                  name="Strategy"
                  stroke={cc.c2}
                  strokeWidth={2}
                  fill="url(#stratGrad)"
                  dot={false}
                  activeDot={{ r: 3, fill: cc.c2 }}
                />
                <Line
                  type="monotone"
                  dataKey="benchmark"
                  name="Buy & Hold"
                  stroke={cc.primary}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  activeDot={{ r: 3, fill: cc.primary }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </AlgoChartPanel>

          <BacktestSignalChart
            data={priceChartData}
            ticker={ticker.trim().toUpperCase()}
            trades={result.trades}
          />

          <AlgoChartPanel label="Monthly Strategy Returns" height={200}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyReturns} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                <XAxis
                  dataKey="month"
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  padding={{ left: 0, right: 0 }}
                />
                <YAxis
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `${v}%`}
                  width={40}
                  domain={[
                    (dataMin: number) => Math.floor(dataMin * 1.15),
                    (dataMax: number) => Math.ceil(dataMax * 1.15),
                  ]}
                />
                <Tooltip
                  content={<ChartTooltip formatter={(v, _n) => `${(v as number).toFixed(2)}%`} />}
                  contentStyle={TOOLTIP_STYLE}
                  cursor={BAR_CURSOR}
                />
                <ReferenceLine y={0} stroke="var(--theme-secondary, var(--theme-text-faint, rgba(255,255,255,0.15)))" strokeOpacity={0.4} />
                <Bar
                  dataKey="return"
                  name="Monthly Return"
                  radius={[2, 2, 0, 0]}
                  fill={cc.gain}
                  shape={(props: {
                    x?: number; y?: number; width?: number; height?: number;
                    value?: number;
                  }) => {
                    const { x = 0, y = 0, width = 0, height = 0, value = 0 } = props
                    const fill = value >= 0 ? cc.gain : cc.loss
                    return <rect x={x} y={y} width={width} height={Math.abs(height)} fill={fill} rx={2} />
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </AlgoChartPanel>

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--theme-text, #d7e3fc)', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Trade Log</span>
              <span style={{ color: 'var(--theme-secondary, #5e768f)', fontWeight: 400 }}>
                {result.trades.length} trades
              </span>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                    {['Date', 'Action', 'Price'].map(col => (
                      <th key={col} style={{
                        padding: '5px 12px', textAlign: 'left',
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                        color: 'var(--theme-secondary, #5e768f)', position: 'sticky', top: 0,
                        background: 'var(--theme-bg, #101c2e)',
                      }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((trade, i) => (
                    <tr
                      key={i}
                      style={{
                        borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))',
                        background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))',
                      }}
                    >
                      <td style={{ padding: '5px 12px', color: 'var(--theme-secondary, #5e768f)' }}>
                        {trade.date}
                      </td>
                      <td style={{ padding: '5px 12px' }}>
                        <span style={{
                          color: trade.action === 'BUY' ? cc.gain : cc.loss,
                          fontWeight: 700,
                          fontSize: 10,
                          letterSpacing: '0.08em',
                        }}>
                          {trade.action}
                        </span>
                      </td>
                      <td style={{ padding: '5px 12px', color: 'var(--theme-text, #d7e3fc)' }}>
                        ${trade.price.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  {result.trades.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: '16px 12px', color: 'var(--theme-text-dim, rgba(255,255,255,0.2))', textAlign: 'center', fontSize: 10 }}>
                        No trades generated
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}
