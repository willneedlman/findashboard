import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { KpiCell } from '../components/mmCockpit'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'
import CustomStrategyModal, { type CustomStrategyDef, DEFAULT_RISK } from '../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy, deleteCustomStrategy } from '../utils/customStrategies'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const POS = 'var(--theme-positive)', NEG = 'var(--theme-negative)'

interface BacktestResult {
  equity_curve: { date: string; strategy: number; benchmark: number }[]
  metrics: {
    total_return: number; ann_return: number; max_drawdown: number; sharpe: number
    num_trades: number; win_rate: number; initial_capital: number; final_capital: number; total_pnl: number
  }
  trades: { date: string; action: string; price: number }[]
}

const fmtCap = (n: number) => `$${Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toFixed(0)}`
const countConds = (def: CustomStrategyDef) => ({
  buy: def.buy.groups.reduce((s, g) => s + g.conditions.length, 0),
  sell: def.sell.groups.reduce((s, g) => s + g.conditions.length, 0),
})

export function AlgoStrategyBuilderContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [start, setStart] = useState('2022-01-01')
  const [end, setEnd] = useState('')
  const [paramsOpen, setParamsOpen] = useState(true)
  const [saved, setSaved] = useState<CustomStrategyDef[]>(() => loadCustomStrategies())
  const [activeName, setActiveName] = useState<string>(() => loadCustomStrategies()[0]?.name ?? '')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CustomStrategyDef | null>(null)

  const activeDef = saved.find(s => s.name === activeName) ?? null
  const refresh = () => setSaved(loadCustomStrategies())

  const onModalSave = (def: CustomStrategyDef) => {
    saveCustomStrategy(def)
    refresh()
    setActiveName(def.name)
  }
  const onDelete = (name: string) => {
    deleteCustomStrategy(name)
    const next = loadCustomStrategies()
    setSaved(next)
    if (activeName === name) setActiveName(next[0]?.name ?? '')
  }

  const { mutate: runBacktest, data, isPending, isError, error } = useMutation<BacktestResult>({
    mutationFn: async () => {
      if (!activeDef) throw new Error('Select or build a strategy first.')
      const r = activeDef.risk ?? DEFAULT_RISK
      const { data } = await axios.post('/api/strategy/custom-backtest', {
        ticker, start, end: end || undefined,
        rules: { buy: activeDef.buy, sell: activeDef.sell },
        position_size: r.sizingPct || 100,
        stop_loss: r.stopLossPct || undefined,
        take_profit: r.takeProfitPct || undefined,
        trailing_stop: r.trailingStopPct || undefined,
        max_hold_bars: r.maxHoldBars || undefined,
      })
      return data
    },
  })

  const sendToPaper = useMutation<{ name: string }, Error>({
    mutationFn: async () => {
      if (!activeDef) throw new Error('Select a strategy first.')
      const { data } = await axios.post('/api/paper/strategies/custom', {
        name: activeDef.name,
        rules: { buy: activeDef.buy, sell: activeDef.sell },
        bull_drift: activeDef.bull_drift ?? 0,
        bear_drift: activeDef.bear_drift ?? 0,
      })
      return data
    },
  })

  const m = data?.metrics

  return (
    <SidebarLayout sidebarWidth={230} sidebarTitle="" sidebar={<>
      <RailSection title="Backtest Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={LABEL}>Ticker</label>
            <TickerInput value={ticker} onChange={setTicker} onEnter={() => activeDef && runBacktest()} style={INPUT} placeholder="Ticker or company" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={LABEL}>Start</label>
              <input type="date" value={start} onChange={e => setStart(e.target.value)} style={INPUT} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={LABEL}>End</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={INPUT} />
            </div>
          </div>
        </div>
      </RailSection>

      <RailSection title={`Saved Strategies · ${saved.length}`} open onToggle={() => {}}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {saved.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', lineHeight: '14px' }}>
              No strategies yet. Build one to get started.
            </div>
          )}
          {saved.map(def => {
            const c = countConds(def)
            const on = def.name === activeName
            return (
              <div key={def.name} onClick={() => setActiveName(def.name)}
                style={{ cursor: 'pointer', padding: '7px 9px', border: `1px solid ${on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                  background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.name}</span>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={e => { e.stopPropagation(); setEditing(def); setModalOpen(true) }} title="Edit"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #8099b0)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em' }}>EDIT</button>
                    <button onClick={e => { e.stopPropagation(); onDelete(def.name) }} title="Delete"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-negative)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em' }}>DEL</button>
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginTop: 2, letterSpacing: '0.06em' }}>
                  BUY {c.buy} · SELL {c.sell}
                </div>
              </div>
            )
          })}
        </div>
      </RailSection>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button onClick={() => { setEditing(null); setModalOpen(true) }} style={{
          width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
          border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
          fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '8px 0', cursor: 'pointer',
        }}>+ New Strategy</button>
        <button onClick={() => runBacktest()} disabled={!activeDef || isPending} style={{
          width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: activeDef ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)',
          fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '8px 0',
          cursor: (!activeDef || isPending) ? 'default' : 'pointer', opacity: (!activeDef || isPending) ? 0.6 : 1,
        }}>{isPending ? 'Running…' : 'Run Backtest'}</button>
        {isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{(error as Error)?.message ?? 'Backtest failed'}</div>}

        <button onClick={() => sendToPaper.mutate()} disabled={!activeDef || sendToPaper.isPending} style={{
          width: '100%', background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: activeDef ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
          fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '7px 0',
          cursor: (!activeDef || sendToPaper.isPending) ? 'default' : 'pointer', opacity: (!activeDef || sendToPaper.isPending) ? 0.6 : 1,
        }}>{sendToPaper.isPending ? 'Sending…' : '→ Send to Paper Trader'}</button>
        {sendToPaper.isSuccess && <div style={{ fontSize: 9, color: 'var(--theme-positive)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>Imported · enable it in Paper Trading</div>}
        {sendToPaper.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{(sendToPaper.error as Error)?.message ?? 'Import failed'}</div>}

        <div style={{ fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', lineHeight: '13px', marginTop: 2 }}>
          Saved strategies also appear under "Custom Rule Strategy" in Monte Carlo and the Backtester.
        </div>
      </div>
    </>}>

      {!data && (
        <EmptyState title="Algorithmic Strategy Builder"
          hint="Build a strategy from entry/exit rules, pick a ticker, then Run Backtest. Saved strategies import into Monte Carlo and the Backtester." />
      )}

      {data && m && (
        <>
          <div style={STRIP}>
            <KpiCell grow minWidth={150} label="Total Return" value={`${m.total_return > 0 ? '+' : ''}${m.total_return.toFixed(2)}%`} valueSize={16} color={m.total_return >= 0 ? POS : NEG} sub={activeDef?.name} />
            <KpiCell grow label="Ann. Return" value={`${m.ann_return > 0 ? '+' : ''}${m.ann_return.toFixed(2)}%`} color={m.ann_return >= 0 ? POS : NEG} />
            <KpiCell grow label="Max Drawdown" value={`${m.max_drawdown.toFixed(2)}%`} color={NEG} />
            <KpiCell grow label="Sharpe" value={m.sharpe.toFixed(3)} color={m.sharpe >= 1 ? POS : undefined} />
            <KpiCell grow label="Trades" value={String(m.num_trades)} />
            <KpiCell grow label="Win Rate" value={`${m.win_rate.toFixed(1)}%`} color={m.win_rate >= 50 ? POS : NEG} />
            <KpiCell grow label="Final Capital" value={fmtCap(m.final_capital)} />
            <KpiCell grow label="P&L" value={`${m.total_pnl >= 0 ? '+' : ''}${fmtCap(m.total_pnl)}`} color={m.total_pnl >= 0 ? POS : NEG} />
          </div>

          {activeDef?.risk && (() => {
            const r = activeDef.risk
            const parts = [`size ${r.sizingPct}%`]
            if (r.stopLossPct) parts.push(`SL ${r.stopLossPct}%`)
            if (r.takeProfitPct) parts.push(`TP ${r.takeProfitPct}%`)
            if (r.trailingStopPct) parts.push(`trail ${r.trailingStopPct}%`)
            if (r.maxHoldBars) parts.push(`max ${r.maxHoldBars} bars`)
            return <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em' }}>Risk applied · {parts.join(' · ')}</div>
          })()}

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, #142032)', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
              Equity Curve — Strategy vs Buy &amp; Hold
            </div>
            <div style={{ paddingTop: 30, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.equity_curve}>
                  <defs>
                    <linearGradient id="algoEq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={cc.primary} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={cc.primary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                  <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" minTickGap={48} />
                  <YAxis tick={TICK} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} orientation="right" domain={['auto', 'auto']} />
                  <Tooltip formatter={(v: number, n: string) => [`$${(+v).toLocaleString()}`, n === 'strategy' ? 'Strategy' : 'Buy & Hold']} contentStyle={TOOLTIP_STYLE} labelFormatter={() => ''} />
                  <Legend wrapperStyle={{ fontSize: 10 }} payload={[
                    { value: 'Strategy', type: 'line', id: 's', color: cc.primary },
                    { value: 'Buy & Hold', type: 'line', id: 'b', color: cc.c2 },
                  ]} />
                  <Area type="monotone" dataKey="strategy" stroke={cc.primary} strokeWidth={2} fill="url(#algoEq)" name="strategy" dot={false} />
                  <Area type="monotone" dataKey="benchmark" stroke={cc.c2} strokeWidth={1.5} strokeDasharray="4 2" fill="transparent" name="benchmark" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      <CustomStrategyModal open={modalOpen} onClose={() => setModalOpen(false)} onSave={onModalSave} initialDef={editing} />
    </SidebarLayout>
  )
}

export default function AlgoStrategyBuilder() {
  return <PageWrapper title="Algorithmic Strategy Builder"><AlgoStrategyBuilderContent /></PageWrapper>
}
