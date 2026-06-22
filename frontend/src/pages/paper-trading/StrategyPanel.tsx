import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ComposedChart, Line } from 'recharts'
import PageWrapper from '../../components/PageWrapper'
import HelpTip from '../../components/HelpTip'
import ExpirySelect from '../../components/ExpirySelect'
import { GammaScalpingContent } from '../GammaScalping'
import CustomStrategyModal, { type CustomStrategyDef } from '../../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy } from '../../utils/customStrategies'
import { useTheme } from '../../contexts/ThemeContext'
import { buildOCC, parseOCC, isOCC } from '../../lib/occ'
import PaperChart, { type ChartFill } from '../../components/PaperChart'
import { loadActivePortfolio } from '../../components/dashboard/widgets/usePortfolio'
import { EMPTY_LEG, OPTION_STRATEGY_TEMPLATES, type LegState, type StrategyTemplate } from './optionTemplates'
import { useAuth, adaptAccount, T, inp, sel, lbl, btn, sectionHeader, fmt$, fmtDate, statusColor, computeReplayStats, applyRiskToChart, PT_LS_KEY, BUILTIN_STRATEGY_INFO, PAPER_DEFAULT_PARAMS, PAPER_PARAM_LABELS, STRATEGY_TEMPLATE, RISK_DEFAULTS, type Balances, type Position, type Order, type AccountData, type PendingOptionStrategy, type ChartPoint, type StrategyEntry, type ReplayEvent, type ReplayResult, type RiskConfig, type SchedulerStatus, type SchedulerJob, type SchedulerLogEntry } from './shared'

function StrategySignalChart({ data, ticker, mode, intervalMs = 15_000 }: {
  data: ChartPoint[]; ticker: string; mode: 'replay' | 'live'; intervalMs?: number
}) {
  const buyCount  = data.filter(d => d.buy  != null).length
  const sellCount = data.filter(d => d.sell != null).length
  const stats = mode === 'replay' ? computeReplayStats(data) : null

  const BuyDot = (props: { cx?: number; cy?: number; payload?: ChartPoint }) => {
    const { cx = 0, cy = 0, payload } = props
    if (!payload?.buy) return null
    return <polygon points={`${cx},${cy - 7} ${cx - 5},${cy + 3} ${cx + 5},${cy + 3}`} fill={T.pos} opacity={0.9} />
  }
  const SellDot = (props: { cx?: number; cy?: number; payload?: ChartPoint }) => {
    const { cx = 0, cy = 0, payload } = props
    if (!payload?.sell) return null
    return <polygon points={`${cx},${cy + 7} ${cx - 5},${cy - 3} ${cx + 5},${cy - 3}`} fill={T.neg} opacity={0.9} />
  }

  const xCount = data.length
  const tickInterval = Math.max(1, Math.floor(xCount / 8))

  return (
    <div style={{ borderTop: `1px solid ${T.border}`, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
          {mode === 'live' ? '● LIVE' : '▶ REPLAY'} · {ticker}
        </span>
        <span style={{ fontSize: 9, color: T.pos, fontFamily: T.mono }}>▲ {buyCount} BUY</span>
        <span style={{ fontSize: 9, color: T.neg, fontFamily: T.mono }}>▼ {sellCount} SELL</span>
        {stats && (
          <>
            <span style={{ width: 1, height: 12, background: T.border, display: 'inline-block' }} />
            <span style={{ fontSize: 9, fontFamily: T.mono, color: stats.pnl >= 0 ? T.pos : T.neg }}>
              P&L {stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(1)}%
            </span>
            <span style={{ fontSize: 9, fontFamily: T.mono, color: T.muted }}>
              Win {stats.winRate.toFixed(0)}%
            </span>
            <span style={{ fontSize: 9, fontFamily: T.mono, color: T.dim }}>
              {stats.trades} trades
            </span>
          </>
        )}
        {mode === 'live' && (
          <span style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, marginLeft: 'auto' }}>
            {xCount} ticks · updates every {intervalMs / 1000}s
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }}
            interval={tickInterval}
            tickLine={false}
            axisLine={{ stroke: T.border }}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            contentStyle={{ background: 'var(--theme-surface,#142032)', border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 10, borderRadius: 0 }}
            labelStyle={{ color: T.gold }}
            formatter={(value: number, name: string) => {
              if (name === 'price') return [`$${value.toFixed(2)}`, 'Price']
              if (name === 'buy')   return [`$${value.toFixed(2)}`, '▲ BUY']
              if (name === 'sell')  return [`$${value.toFixed(2)}`, '▼ SELL']
              return [`${value}`, name]
            }}
          />
          {/* Price line */}
          <Line
            type="monotone"
            dataKey="price"
            stroke={T.gold}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: T.gold }}
            isAnimationActive={false}
          />
          {/* BUY signals */}
          <Line
            type="monotone"
            dataKey="buy"
            stroke="transparent"
            dot={(props) => <BuyDot key={`buy-${props.index}`} cx={props.cx} cy={props.cy} payload={props.payload as ChartPoint} />}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          {/* SELL signals */}
          <Line
            type="monotone"
            dataKey="sell"
            stroke="transparent"
            dot={(props) => <SellDot key={`sell-${props.index}`} cx={props.cx} cy={props.cy} payload={props.payload as ChartPoint} />}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Strategy Panel ──────────────────────────────────────────────────────────


export function StrategyPanel({ pendingBuilderStrategy, onApproveBuilderStrategy, onDismissBuilderStrategy, onAutomatedOrder }: {
  pendingBuilderStrategy: PendingOptionStrategy | null
  onApproveBuilderStrategy: (ps: PendingOptionStrategy) => void
  onDismissBuilderStrategy: () => void
  onAutomatedOrder?: (id: string, strategyName: string) => void
}) {
  const qc = useQueryClient()
  const { uid, authed, headers } = useAuth()
  const [open, setOpen] = useState(false)
  const [replayTicker, setReplayTicker] = useState('SPY')
  const [replayStart, setReplayStart] = useState('2024-01-01')
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null)
  const [execQty, setExecQty] = useState('1')
  const [execStatus, setExecStatus] = useState<string | null>(null)
  const [liveActive, setLiveActive] = useState(false)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [offlineStatus, setOfflineStatus] = useState<string | null>(null)
  const [customModalOpen, setCustomModalOpen] = useState(false)
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [liveIntervalMs, setLiveIntervalMs] = useState(15_000)
  const fileRef = useRef<HTMLInputElement>(null)

  // Per-strategy param overrides and param-editor open state
  const [stratParams, setStratParams] = useState<Record<string, Record<string, number>>>({})
  const [paramsOpen, setParamsOpen] = useState<Record<string, boolean>>({})
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({})
  const [stratColOpen, setStratColOpen] = useState(true)

  // Per-strategy risk controls
  const [riskParams, setRiskParams] = useState<Record<string, RiskConfig>>({})
  const [riskOpen, setRiskOpen] = useState<Record<string, boolean>>({})
  // Live-mode per-strategy position state for risk tracking
  const liveTradeState = useRef<Record<string, { inTrade: boolean; entryPrice: number; peak: number; bars: number }>>({})

  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [liveChart, setLiveChart] = useState<ChartPoint[]>([])

  const { data: strategies = [] } = useQuery<StrategyEntry[]>({
    queryKey: ['paper/strategies'],
    queryFn: () => axios.get('/api/paper/strategies/').then(r => r.data),
    enabled: open,
  })

  // ── Scheduler queries (scoped to this panel, enabled when open) ──────────────
  const { data: schedulerStatus } = useQuery<SchedulerStatus>({
    queryKey: ['paper/scheduler/status'],
    queryFn: () => axios.get(`/api/paper/scheduler/status?user_id=${uid}`, headers).then(r => r.data),
    enabled: authed,
    refetchInterval: 15_000,
  })

  const { data: schedulerJobs = [] } = useQuery<SchedulerJob[]>({
    queryKey: ['paper/scheduler/jobs'],
    queryFn: () => axios.get(`/api/paper/scheduler/jobs?user_id=${uid}`, headers).then(r => r.data),
    enabled: open && authed,
    refetchInterval: open ? 15_000 : false,
  })

  const { data: schedulerLog = [] } = useQuery<SchedulerLogEntry[]>({
    queryKey: ['paper/scheduler/log'],
    queryFn: () => axios.get(`/api/paper/scheduler/log?limit=50&user_id=${uid}`, headers).then(r => r.data),
    enabled: open && authed,
    refetchInterval: open ? 30_000 : false,
  })

  const createJobMut = useMutation({
    mutationFn: (body: { ticker: string; strategy_name: string; qty: number; params: Record<string, number> }) =>
      axios.post('/api/paper/scheduler/jobs', { ...body, user_id: uid }, headers).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['paper/scheduler/jobs'] })
      qc.invalidateQueries({ queryKey: ['paper/scheduler/status'] })
    },
  })

  const deleteJobMut = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/paper/scheduler/jobs/${id}?user_id=${uid}`, headers).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['paper/scheduler/jobs'] })
      qc.invalidateQueries({ queryKey: ['paper/scheduler/status'] })
    },
  })

  const toggleJobMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      axios.patch(`/api/paper/scheduler/jobs/${id}/toggle?user_id=${uid}`, { enabled }, headers).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/scheduler/jobs'] }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      axios.post(`/api/paper/strategies/${name}/toggle`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/strategies'] }),
  })

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData(); fd.append('file', file)
      return axios.post('/api/paper/strategies/upload', fd)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/strategies'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (name: string) => axios.delete(`/api/paper/strategies/${name}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/strategies'] }),
  })

  const createCustomMut = useMutation({
    mutationFn: (body: { name: string; rules: object; bull_drift: number; bear_drift: number }) =>
      axios.post('/api/paper/strategies/custom', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['paper/strategies'] })
      setCustomModalOpen(false)
    },
  })

  const handleCustomSave = (def: CustomStrategyDef) => {
    saveCustomStrategy(def)
    createCustomMut.mutate({
      name: def.name,
      rules: { buy: def.buy, sell: def.sell },
      bull_drift: def.bull_drift,
      bear_drift: def.bear_drift,
    })
  }

  const replayMut = useMutation({
    mutationFn: () => axios.post('/api/paper/strategies/replay', {
      ticker: replayTicker.toUpperCase(), start: replayStart,
    }).then(r => r.data),
    onSuccess: async (d: ReplayResult) => {
      setReplayResult(d); setExecStatus(null); setLiveChart([])
      try {
        const hist = await axios.get(`/api/market/history?ticker=${d.ticker}&start=${replayStart}`)
        const prices: { date: string; value: number }[] = hist.data.price ?? []
        setChartData(applyRiskToChart(d.events, riskParams, prices))
      } catch { /* chart optional */ }
    },
  })

  const placeOrder = (symbol: string, side: 'buy' | 'sell', qty: number) =>
    axios.post('/api/paper/order', {
      user_id: uid, symbol, side, quantity: qty, order_type: 'market',
    }, headers)

  const executeSignals = async () => {
    if (!replayResult) return
    const qty = Math.max(1, parseInt(execQty) || 1)
    const events = replayResult.events.filter(e => e.signal !== 'HOLD')
    if (events.length === 0) { setExecStatus('No BUY/SELL signals to execute.'); return }
    setExecStatus(`Placing ${events.length} orders…`)
    let ok = 0, fail = 0
    for (const ev of events) {
      try {
        const r = await placeOrder(ev.symbol, ev.signal === 'BUY' ? 'buy' : 'sell', qty)
        const orderId = r.data?.order?.id ?? r.data?.id
        if (orderId) onAutomatedOrder?.(String(orderId), 'Replay')
        ok++
      } catch { fail++ }
    }
    setExecStatus(`Done — ${ok} placed${fail ? `, ${fail} failed` : ''}.`)
    qc.invalidateQueries({ queryKey: ['account'] })
  }

  const startLive = () => {
    const ticker = replayTicker.toUpperCase()
    const qty = Math.max(1, parseInt(execQty) || 1)
    const scalping = strategies.some(s => s.enabled && s.name === 'micro_scalp')
    const intervalMs = scalping ? 3_000 : 15_000
    setLiveIntervalMs(intervalMs)
    setLiveActive(true)
    setLiveStatus(`Live — waiting for first tick… (${scalping ? '3s' : '15s'} interval)`)
    setLiveChart([])
    setChartData([])
    liveTradeState.current = {}
    liveIntervalRef.current = setInterval(async () => {
      try {
        const priceRes = await axios.get(`/api/market/quote/${ticker}`)
        const price: number = priceRes.data?.current_price ?? priceRes.data?.last ?? priceRes.data?.price
        if (!price) return
        const now = new Date().toLocaleTimeString()
        const rawSignals: { strategy_name: string; signal: string }[] =
          await axios.post('/api/paper/strategies/tick', {
            timestamp: Date.now() / 1000, symbol: ticker, price, size: 0, side: 'trade',
          }).then(r => r.data)

        // Apply per-strategy risk overrides
        const signals = rawSignals.map(s => {
          const state = liveTradeState.current[s.strategy_name] ??
            (liveTradeState.current[s.strategy_name] = { inTrade: false, entryPrice: 0, peak: 0, bars: 0 })
          const risk = riskParams[s.strategy_name] ?? RISK_DEFAULTS
          const sl  = risk.stop_loss     ? parseFloat(risk.stop_loss)     : null
          const tp  = risk.take_profit   ? parseFloat(risk.take_profit)   : null
          const ts  = risk.trailing_stop ? parseFloat(risk.trailing_stop) : null
          const mh  = risk.max_hold      ? parseInt(risk.max_hold)        : null

          if (s.signal === 'BUY' && !state.inTrade) {
            state.inTrade = true; state.entryPrice = price; state.peak = price; state.bars = 0
            return s
          }
          if (state.inTrade) {
            state.bars++; state.peak = Math.max(state.peak, price)
            const stopHit  = sl && price <= state.entryPrice * (1 - sl / 100)
            const tpHit    = tp && price >= state.entryPrice * (1 + tp / 100)
            const trailHit = ts && price <= state.peak * (1 - ts / 100)
            const timeHit  = mh && state.bars >= mh
            if (stopHit || tpHit || trailHit || timeHit) {
              state.inTrade = false
              return { ...s, signal: 'SELL' }
            }
            if (s.signal === 'SELL') { state.inTrade = false; return s }
          }
          return s
        })

        const firstSig = signals.find(s => s.signal === 'BUY' || s.signal === 'SELL')
        setLiveChart(prev => [...prev.slice(-199), {
          date: now, price,
          buy:  firstSig?.signal === 'BUY'  ? price : undefined,
          sell: firstSig?.signal === 'SELL' ? price : undefined,
        }])
        for (const s of signals) {
          if (s.signal === 'BUY' || s.signal === 'SELL') {
            const r = await placeOrder(ticker, s.signal === 'BUY' ? 'buy' : 'sell', qty)
            const orderId = r.data?.order?.id ?? r.data?.id
            if (orderId) onAutomatedOrder?.(String(orderId), s.strategy_name)
            setLiveStatus(`${now} — ${s.strategy_name}: ${s.signal} ${qty}x ${ticker} @ $${price.toFixed(2)}`)
            qc.invalidateQueries({ queryKey: ['account'] })
          }
        }
        if (!firstSig) setLiveStatus(`${now} — ${ticker} $${price.toFixed(2)} · HOLD`)
      } catch (e) {
        setLiveStatus(`Error: ${(e as Error).message}`)
      }
    }, intervalMs)
  }

  const stopLive = () => {
    if (liveIntervalRef.current) clearInterval(liveIntervalRef.current)
    setLiveActive(false)
    setLiveStatus(null)
  }

  const runOffline = async () => {
    const ticker = replayTicker.toUpperCase()
    const qty = Math.max(1, parseInt(execQty) || 1)
    const active = strategies.filter(s => s.enabled)
    if (active.length === 0) { setOfflineStatus('Enable at least one strategy first.'); return }
    setOfflineStatus('Scheduling…')
    let created = 0
    for (const s of active) {
      const defaults = PAPER_DEFAULT_PARAMS[s.name] ?? {}
      const overrides = stratParams[s.name] ?? {}
      const risk = riskParams[s.name] ?? RISK_DEFAULTS
      const riskNums: Record<string, number> = {}
      if (risk.stop_loss)     riskNums.stop_loss     = parseFloat(risk.stop_loss)
      if (risk.take_profit)   riskNums.take_profit   = parseFloat(risk.take_profit)
      if (risk.trailing_stop) riskNums.trailing_stop = parseFloat(risk.trailing_stop)
      if (risk.max_hold)      riskNums.max_hold      = parseInt(risk.max_hold)
      try {
        await createJobMut.mutateAsync({ ticker, strategy_name: s.name, qty, params: { ...defaults, ...overrides, ...riskNums } })
        created++
      } catch { /* skip duplicates or unknown strategies */ }
    }
    const hasScalp = active.some(s => s.name === 'micro_scalp')
    const intervalNote = hasScalp
      ? active.length > 1
        ? 'micro_scalp every 3s, others every 60s'
        : 'every 3s'
      : 'every 60s'
    setOfflineStatus(`Scheduled ${created} job${created !== 1 ? 's' : ''} for ${ticker} — ${intervalNote} during market hours`)
  }

  useEffect(() => () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current) }, [])

  // All jobs grouped by ticker
  const allTickers = [...new Set(schedulerJobs.map(j => j.ticker))].sort()
  const sigColor   = (s: string) => s === 'BUY' ? T.pos : s === 'SELL' ? T.neg : T.dim

  return (
    <div style={{ marginTop: 10, border: `1px solid ${T.border}`, background: T.surface, flexShrink: 0 }}>
      {/* Header / toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer',
          borderBottom: open ? `1px solid ${T.border}` : 'none',
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: T.gold, fontFamily: T.mono }}>STRATEGIES</span>

        {/* Enabled-for-replay/live count */}
        {(() => {
          const enabledN = strategies.filter(s => s.enabled).length
          return (
            <span style={{
              fontSize: 8, padding: '1px 5px', fontFamily: T.mono, letterSpacing: '0.07em',
              border: `1px solid ${enabledN > 0 ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : T.border}`,
              color: enabledN > 0 ? T.gold : T.muted,
              background: enabledN > 0 ? 'color-mix(in srgb, var(--theme-primary) 6%, transparent)' : 'transparent',
            }}>
              {enabledN} / {strategies.length} enabled
            </span>
          )
        })()}

        {/* Offline scheduler jobs — separate from "enabled" above */}
        {schedulerStatus && schedulerStatus.active_jobs > 0 && (
          <span style={{
            fontSize: 8, padding: '1px 5px', fontFamily: T.mono, letterSpacing: '0.07em',
            border: '1px solid color-mix(in srgb, var(--theme-positive) 40%, transparent)', color: T.pos, background: 'color-mix(in srgb, var(--theme-positive) 6%, transparent)',
          }}>
            {schedulerStatus.active_jobs} scheduler job{schedulerStatus.active_jobs !== 1 ? 's' : ''} running
          </span>
        )}

        {pendingBuilderStrategy && (
          <span style={{ fontSize: 9, fontWeight: 700, color: T.gold, fontFamily: T.mono,
            padding: '1px 6px', border: `1px solid ${T.gold}`, marginLeft: 4, animation: 'pulse 1.5s infinite' }}>
            PENDING
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: T.muted }}>{open ? '▲' : '▼'}</span>
      </button>

      {/* Pending strategy from Strategy Builder */}
      {pendingBuilderStrategy && (
        <div style={{ padding: '10px 14px', background: 'color-mix(in srgb, var(--theme-primary) 7%, transparent)',
          borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.gold, fontFamily: T.mono, marginBottom: 3 }}>
              ↗ From Strategy Builder: <span style={{ color: T.text }}>{pendingBuilderStrategy.name}</span>
            </div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              {pendingBuilderStrategy.underlying} · {pendingBuilderStrategy.legs.length} legs · {pendingBuilderStrategy.orderType}
              {' · '}saved {new Date(pendingBuilderStrategy.savedAt).toLocaleTimeString()}
            </div>
            <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {pendingBuilderStrategy.legs.map((l, i) => (
                <span key={i} style={{ fontSize: 8, fontFamily: T.mono, color: l.side === 'buy_to_open' ? T.pos : T.neg,
                  padding: '1px 5px', border: `1px solid ${l.side === 'buy_to_open' ? 'color-mix(in srgb, var(--theme-positive) 30%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 30%, transparent)'}` }}>
                  {l.side === 'buy_to_open' ? '▲' : '▼'} {l.occ}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onApproveBuilderStrategy(pendingBuilderStrategy)}
              style={{ padding: '6px 14px', fontSize: 10, fontFamily: T.mono, fontWeight: 700,
                cursor: 'pointer', border: 'none', background: T.gold, color: 'var(--theme-bg)', letterSpacing: '0.1em' }}>
              APPROVE
            </button>
            <button onClick={onDismissBuilderStrategy}
              style={{ padding: '6px 10px', fontSize: 10, fontFamily: T.mono, cursor: 'pointer',
                border: `1px solid ${T.border}`, background: 'transparent', color: T.muted }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {open && (
        <div>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>

          {/* Strategy list — collapsible column */}
          <div style={{ flex: stratColOpen ? 1 : 'none', minWidth: stratColOpen ? 300 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <button
                onClick={() => setStratColOpen(o => !o)}
                title={stratColOpen ? 'Collapse strategy list' : 'Expand strategy list'}
                style={{
                  background: 'none', border: `1px solid ${T.border}`, color: T.muted,
                  cursor: 'pointer', padding: '1px 6px', fontFamily: T.mono, fontSize: 9, flexShrink: 0,
                }}
              >{stratColOpen ? '◀ Hide' : '▶ Strategies'}</button>
              {stratColOpen && (
                <>
                  <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
                    Strategies
                  </span>
                  <HelpTip width={280} position="right" text="Enable or disable strategies that run during live auto-trade, replay, and Run Offline. Expand Parameters to set each strategy's options. They flow through to all three execution modes." />
                </>
              )}
            </div>

            {/* Status summary (always shown when column is open) */}
            {stratColOpen && (() => {
              const enabledStrats = strategies.filter(s => s.enabled)
              const jobCount = schedulerStatus?.active_jobs ?? 0
              return (
                <div style={{
                  marginBottom: 8, padding: '7px 10px',
                  background: 'rgba(0,0,0,0.15)', border: `1px solid ${T.border}`,
                  fontSize: 9, fontFamily: T.mono, display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: T.muted }}>For Replay / Live:</span>
                    <span style={{ color: enabledStrats.length > 0 ? T.gold : T.dim, fontWeight: 700 }}>
                      {enabledStrats.length === 0
                        ? 'none enabled'
                        : enabledStrats.map(s => BUILTIN_STRATEGY_INFO[s.name]?.label ?? s.name).join(', ')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: T.muted }}>Scheduler jobs (server-side):</span>
                    <span style={{ color: jobCount > 0 ? T.pos : T.dim, fontWeight: 700 }}>
                      {jobCount > 0 ? `${jobCount} running` : 'none'}
                    </span>
                  </div>
                </div>
              )
            })()}
            {stratColOpen && strategies.length === 0 && (
              <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono }}>No strategies loaded.</div>
            )}
            {stratColOpen && strategies.map(s => {
              const info = BUILTIN_STRATEGY_INFO[s.name]
              const defaults = PAPER_DEFAULT_PARAMS[s.name] ?? {}
              const labels  = PAPER_PARAM_LABELS[s.name]  ?? {}
              const overrides = stratParams[s.name] ?? {}
              const merged  = { ...defaults, ...overrides }
              const paramKeys = Object.keys(defaults)
              const pOpen = paramsOpen[s.name] ?? false
              const risk  = riskParams[s.name] ?? RISK_DEFAULTS
              const rOpen = riskOpen[s.name] ?? false
              const cOpen = cardOpen[s.name] ?? false
              const hasRisk = !!(risk.stop_loss || risk.take_profit || risk.trailing_stop || risk.max_hold)
              const hasCustomParams = Object.keys(overrides).length > 0
              const setRisk = (k: keyof RiskConfig, v: string) =>
                setRiskParams(prev => ({ ...prev, [s.name]: { ...(prev[s.name] ?? RISK_DEFAULTS), [k]: v } }))
              return (
                <div key={s.name} style={{ marginBottom: 4,
                  border: `1px solid ${s.enabled ? 'color-mix(in srgb, var(--theme-primary) 25%, transparent)' : T.border}`,
                  background: s.enabled ? 'color-mix(in srgb, var(--theme-primary) 3%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>

                  {/* ── Collapsed header row (always visible) ── */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                    {/* Expand/collapse toggle */}
                    <button
                      onClick={() => setCardOpen(p => ({ ...p, [s.name]: !cOpen }))}
                      style={{
                        padding: '8px 8px 8px 10px', background: 'none', border: 'none', cursor: 'pointer',
                        color: T.dim, fontSize: 9, flexShrink: 0, lineHeight: 1,
                      }}
                      title={cOpen ? 'Collapse' : 'Expand settings'}
                    >
                      {cOpen ? '▼' : '▶'}
                    </button>

                    {/* Strategy name — clicking also expands */}
                    <button
                      onClick={() => setCardOpen(p => ({ ...p, [s.name]: !cOpen }))}
                      style={{
                        flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                        padding: '8px 4px',
                      }}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, color: s.enabled ? T.text : T.muted, fontFamily: T.mono }}>
                        {info?.label ?? s.name}
                      </span>
                      {/* Inline status indicators when collapsed */}
                      {!cOpen && (
                        <span style={{ marginLeft: 8, fontSize: 8, color: T.dim, fontFamily: T.mono }}>
                          {hasCustomParams && <span style={{ color: T.gold, marginRight: 5 }}>customised</span>}
                          {hasRisk && <span style={{ color: T.warn, marginRight: 5 }}>risk</span>}
                          <span style={{ color: T.dim }}>{s.description?.slice(0, 48)}{(s.description?.length ?? 0) > 48 ? '…' : ''}</span>
                        </span>
                      )}
                    </button>

                    {info && <HelpTip width={300} position="right" text={info.help} />}

                    {/* ON/OFF toggle */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleMut.mutate({ name: s.name, enabled: !s.enabled }) }}
                      style={{
                        padding: '3px 8px', fontSize: 9, fontFamily: T.mono, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: s.enabled ? 'color-mix(in srgb, var(--theme-positive) 50%, transparent)' : T.border,
                        background: s.enabled ? 'color-mix(in srgb, var(--theme-positive) 10%, transparent)' : 'transparent',
                        color: s.enabled ? T.pos : T.muted, letterSpacing: '0.08em',
                        margin: '0 4px', flexShrink: 0,
                      }}
                    >{s.enabled ? 'ON' : 'OFF'}</button>

                    {s.author !== 'builtin' && (
                      <button onClick={(e) => { e.stopPropagation(); deleteMut.mutate(s.name) }}
                        style={{ background: 'none', border: 'none', color: T.neg, cursor: 'pointer', fontSize: 12, padding: '0 8px', flexShrink: 0 }}>×</button>
                    )}
                  </div>

                  {/* ── Expanded body (collapsible) ── */}
                  {cOpen && (
                    <div style={{ padding: '6px 10px 10px', borderTop: `1px solid ${T.border}` }}>
                      {/* Description */}
                      <div style={{ fontSize: 9, color: T.dim, marginBottom: 8, fontFamily: T.mono, lineHeight: '14px' }}>
                        {s.description}
                      </div>

                      {/* Parameters */}
                      {paramKeys.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <button
                            onClick={() => setParamsOpen(p => ({ ...p, [s.name]: !pOpen }))}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              fontSize: 9, fontFamily: T.mono, color: pOpen ? T.gold : T.muted,
                              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                              letterSpacing: '0.08em',
                            }}
                          >
                            <span style={{ fontSize: 8 }}>{pOpen ? '▼' : '▶'}</span> Parameters
                            {hasCustomParams && (
                              <span style={{ fontSize: 7, color: T.gold, fontFamily: T.mono, padding: '0 3px',
                                border: '1px solid color-mix(in srgb, var(--theme-primary) 40%, transparent)', marginLeft: 2 }}>customised</span>
                            )}
                          </button>
                          {pOpen && (
                            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {paramKeys.map(key => (
                                <div key={key} style={{ minWidth: 70, flex: 1 }}>
                                  <span style={{ ...lbl, fontSize: 8 }}>{labels[key] ?? key}</span>
                                  <input
                                    type="number"
                                    value={merged[key] ?? defaults[key]}
                                    step={key.includes('ratio') || key === 'std_dev' ? 0.1 : 1}
                                    onChange={e => setStratParams(p => ({
                                      ...p,
                                      [s.name]: { ...(p[s.name] ?? {}), [key]: parseFloat(e.target.value) || defaults[key] },
                                    }))}
                                    style={{ ...inp, fontSize: 11, padding: '4px 6px' }}
                                  />
                                </div>
                              ))}
                              {hasCustomParams && (
                                <div style={{ width: '100%' }}>
                                  <button
                                    onClick={() => setStratParams(p => { const n = { ...p }; delete n[s.name]; return n })}
                                    style={{ fontSize: 8, fontFamily: T.mono, color: T.muted, background: 'none',
                                      border: `1px solid ${T.border}`, padding: '1px 6px', cursor: 'pointer' }}
                                  >↺ Reset defaults</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Risk controls */}
                      <div style={{ marginBottom: 6 }}>
                        <button
                          onClick={() => setRiskOpen(p => ({ ...p, [s.name]: !rOpen }))}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            fontSize: 9, fontFamily: T.mono, color: rOpen ? T.warn : hasRisk ? T.warn : T.muted,
                            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                            letterSpacing: '0.08em',
                          }}
                        >
                          <span style={{ fontSize: 8 }}>{rOpen ? '▼' : '▶'}</span> Risk Controls
                          {hasRisk && (
                            <span style={{ fontSize: 7, color: T.warn, padding: '0 3px',
                              border: '1px solid color-mix(in srgb, var(--theme-warn) 40%, transparent)', marginLeft: 2 }}>active</span>
                          )}
                        </button>
                        {rOpen && (
                          <div style={{ marginTop: 6, padding: '8px 10px', background: 'color-mix(in srgb, var(--theme-warn) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-warn) 15%, transparent)' }}>
                            <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginBottom: 8, lineHeight: '12px' }}>
                              Leave blank to disable. Applied to replay chart, live mode, and scheduled jobs.
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {([
                                { key: 'stop_loss' as const,     label: 'Stop Loss %',     help: 'Exit if price drops X% from entry. e.g. 2' },
                                { key: 'take_profit' as const,   label: 'Take Profit %',   help: 'Exit if price rises X% from entry. e.g. 5' },
                                { key: 'trailing_stop' as const, label: 'Trailing Stop %', help: 'Exit if price drops X% from its peak since entry. e.g. 1.5' },
                                { key: 'max_hold' as const,      label: 'Max Hold (days)', help: 'Force exit after N trading days regardless of signal.' },
                              ] as { key: keyof RiskConfig; label: string; help: string }[]).map(({ key, label, help }) => (
                                <div key={key} style={{ minWidth: 80, flex: 1 }}>
                                  <span style={{ ...lbl, fontSize: 8, color: 'color-mix(in srgb, var(--theme-warn) 70%, var(--theme-secondary))' }}>{label}</span>
                                  <input
                                    type="number"
                                    min={0}
                                    step={key === 'max_hold' ? 1 : 0.1}
                                    placeholder="off"
                                    value={risk[key]}
                                    title={help}
                                    onChange={e => setRisk(key, e.target.value)}
                                    style={{ ...inp, fontSize: 11, padding: '4px 6px', borderColor: risk[key] ? 'color-mix(in srgb, var(--theme-warn) 40%, transparent)' : undefined }}
                                  />
                                </div>
                              ))}
                            </div>
                            {hasRisk && (
                              <button
                                onClick={() => setRiskParams(p => { const n = { ...p }; delete n[s.name]; return n })}
                                style={{ marginTop: 6, fontSize: 8, fontFamily: T.mono, color: T.muted, background: 'none',
                                  border: `1px solid ${T.border}`, padding: '1px 6px', cursor: 'pointer' }}
                              >↺ Clear risk</button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Cross-tool badges */}
                      {info && info.usedIn.length > 0 && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          {info.usedIn.includes('backtester') && (
                            <a href="/backtester" style={{ textDecoration: 'none' }}>
                              <span style={{ fontSize: 8, padding: '1px 5px', border: '1px solid rgba(96,165,250,0.4)',
                                color: '#60a5fa', fontFamily: T.mono, cursor: 'pointer', letterSpacing: '0.06em' }}>↗ BACKTESTER</span>
                            </a>
                          )}
                          {info.usedIn.includes('montecarlo') && (
                            <a href="/monte-carlo" style={{ textDecoration: 'none' }}>
                              <span style={{ fontSize: 8, padding: '1px 5px', border: '1px solid rgba(167,139,250,0.4)',
                                color: '#a78bfa', fontFamily: T.mono, cursor: 'pointer', letterSpacing: '0.06em' }}>↗ MONTE CARLO</span>
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Upload + Build Custom */}
            {stratColOpen && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <input ref={fileRef} type="file" accept=".py" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadMut.mutate(f) }} />
                <button onClick={() => fileRef.current?.click()} style={{ ...btn, flex: 1 }}>
                  {uploadMut.isPending ? 'Uploading…' : '↑ Upload (.py)'}
                </button>
                <button
                  onClick={() => setCustomModalOpen(true)}
                  style={{ ...btn, flex: 1, borderColor: 'color-mix(in srgb, var(--theme-primary) 50%, transparent)', color: T.gold }}
                >Build Custom</button>
              </div>
            )}
            {stratColOpen && uploadMut.isError && (
              <div style={{ marginTop: 4, fontSize: 9, color: T.neg, fontFamily: T.mono }}>
                {(uploadMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Upload failed'}
              </div>
            )}
            {stratColOpen && createCustomMut.isError && (
              <div style={{ marginTop: 4, fontSize: 9, color: T.neg, fontFamily: T.mono }}>
                {(createCustomMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed to create strategy'}
              </div>
            )}

            {/* Strategy Library — saved custom strategies from other tools */}
            {stratColOpen && (() => {
              const registeredNames = new Set(strategies.map(s => s.name))
              const unregistered = loadCustomStrategies().filter(d => !registeredNames.has(d.name))
              if (unregistered.length === 0) return null
              return (
                <div style={{ marginTop: 10, padding: '8px 10px', border: `1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)`, background: 'color-mix(in srgb, var(--theme-primary) 4%, transparent)' }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 6, fontFamily: T.mono }}>
                    Strategy Library
                  </div>
                  <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, marginBottom: 8 }}>
                    Strategies built in Monte Carlo / Backtester — click Register to add to paper trading
                  </div>
                  {unregistered.map(def => {
                    const buyCount  = def.buy.groups.reduce((s, g) => s + g.conditions.length, 0)
                    const sellCount = def.sell.groups.reduce((s, g) => s + g.conditions.length, 0)
                    return (
                      <div key={def.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: T.text, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {def.name}
                          </div>
                          <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>
                            B:{buyCount} cond · S:{sellCount} cond
                          </div>
                        </div>
                        <button
                          onClick={() => createCustomMut.mutate({
                            name: def.name,
                            rules: { buy: def.buy, sell: def.sell },
                            bull_drift: def.bull_drift ?? 0,
                            bear_drift: def.bear_drift ?? 0,
                          })}
                          disabled={createCustomMut.isPending}
                          style={{ ...btn, fontSize: 8, padding: '3px 8px', borderColor: 'color-mix(in srgb, var(--theme-primary) 40%, transparent)', color: T.gold, flexShrink: 0 }}
                        >
                          + Register
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>

          {/* Replay + Live + Offline */}
          <div style={{ width: 300, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
                Replay & Execute
              </span>
              <HelpTip width={290} position="right" text="Replay runs enabled strategies against historical closes. Start Live polls the market every 15s and places orders in your browser session. Run Offline schedules server-side jobs that trade automatically even when this page is closed. It uses the params set per strategy above." />
            </div>

            {/* Ticker / date / qty */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input value={replayTicker} onChange={e => setReplayTicker(e.target.value.toUpperCase())}
                placeholder="Ticker" style={{ ...inp, width: 70 }} />
              <input value={replayStart} onChange={e => setReplayStart(e.target.value)}
                type="date" style={{ ...inp, flex: 1 }} />
              <input value={execQty} onChange={e => setExecQty(e.target.value)}
                placeholder="Qty" style={{ ...inp, width: 46 }} />
            </div>

            {/* Replay */}
            <button
              onClick={() => replayMut.mutate()}
              disabled={replayMut.isPending || strategies.filter(s => s.enabled).length === 0}
              style={{ ...btn, width: '100%', marginBottom: 6 }}
            >
              {replayMut.isPending ? 'Running…' : '▶ Run Replay'}
            </button>

            {replayResult && (
              <>
                <div style={{ fontSize: 9, fontFamily: T.mono, marginBottom: 6 }}>
                  <div style={{ color: T.muted, marginBottom: 4 }}>
                    {replayResult.ticker} · {replayResult.bars_processed} bars
                  </div>
                  {Object.entries(replayResult.summary).map(([name, counts]) => (
                    <div key={name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                      <span style={{ color: T.gold, flex: 1 }}>{name}</span>
                      <span style={{ color: T.pos }}>B:{counts.BUY}</span>
                      <span style={{ color: T.neg }}>S:{counts.SELL}</span>
                      <span style={{ color: T.muted }}>H:{counts.HOLD}</span>
                    </div>
                  ))}
                  {replayResult.events.length === 0 && (
                    <div style={{ color: T.dim }}>No BUY/SELL signals.</div>
                  )}
                </div>
                {replayResult.events.length > 0 && (
                  <button
                    onClick={executeSignals}
                    style={{ ...btn, width: '100%', marginBottom: 4,
                      borderColor: 'color-mix(in srgb, var(--theme-primary) 60%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 14%, transparent)' }}
                  >
                    Execute {replayResult.events.filter(e => e.signal !== 'HOLD').length} Signal Orders
                  </button>
                )}
                {execStatus && (
                  <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{execStatus}</div>
                )}
              </>
            )}

            {/* Live + Offline buttons */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4 }}>
              <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, marginBottom: 6, textTransform: 'uppercase' }}>
                Live & Offline
                <HelpTip width={270} position="top" text="Start Live: polls price every 15s (3s for EMA Micro-Scalp) in this browser tab. Stops when you close the page. Run Offline: registers server-side jobs that run every 60s (3s for EMA Micro-Scalp) during market hours using the params configured per strategy above, even with the browser closed." />
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {!liveActive ? (
                  <button
                    onClick={startLive}
                    disabled={strategies.filter(s => s.enabled).length === 0}
                    style={{ ...btn, flex: 1, borderColor: 'color-mix(in srgb, var(--theme-positive) 40%, transparent)', color: T.pos }}
                  >● Start Live</button>
                ) : (
                  <button onClick={stopLive}
                    style={{ ...btn, flex: 1, borderColor: 'color-mix(in srgb, var(--theme-negative) 40%, transparent)', color: T.neg }}>■ Stop Live</button>
                )}
                <button
                  onClick={runOffline}
                  disabled={strategies.filter(s => s.enabled).length === 0}
                  style={{ ...btn, flex: 1, borderColor: 'rgba(96,165,250,0.4)', color: '#60a5fa' }}
                >Run Offline</button>
              </div>

              {liveStatus && (
                <div style={{ fontSize: 9, color: liveActive ? T.pos : T.muted, fontFamily: T.mono, wordBreak: 'break-all', marginBottom: 4 }}>
                  {liveStatus}
                </div>
              )}
              {offlineStatus && (
                <div style={{ fontSize: 9, color: '#60a5fa', fontFamily: T.mono, wordBreak: 'break-all', marginBottom: 6 }}>
                  {offlineStatus}
                </div>
              )}

              {/* Scheduler status pills */}
              {schedulerStatus && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 8, padding: '1px 5px', fontFamily: T.mono,
                    border: `1px solid ${schedulerStatus.scheduler_running ? 'color-mix(in srgb, var(--theme-positive) 40%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 40%, transparent)'}`,
                    color: schedulerStatus.scheduler_running ? T.pos : T.neg,
                    background: schedulerStatus.scheduler_running ? 'color-mix(in srgb, var(--theme-positive) 6%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 6%, transparent)',
                  }}>
                    {schedulerStatus.scheduler_running ? '● RUNNING' : '○ STOPPED'}
                  </span>
                  <span style={{
                    fontSize: 8, padding: '1px 5px', fontFamily: T.mono,
                    border: `1px solid ${schedulerStatus.market_open ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : T.border}`,
                    color: schedulerStatus.market_open ? T.gold : T.muted,
                  }}>
                    {schedulerStatus.market_open ? 'MARKET OPEN' : 'CLOSED'}
                  </span>
                  {schedulerStatus.active_jobs > 0 && (
                    <span style={{ fontSize: 8, padding: '1px 5px', fontFamily: T.mono, color: T.muted, border: `1px solid ${T.border}` }}>
                      {schedulerStatus.active_jobs} job{schedulerStatus.active_jobs !== 1 ? 's' : ''} active
                    </span>
                  )}
                </div>
              )}

              {/* All scheduler jobs grouped by ticker */}
              {schedulerJobs.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', marginBottom: 4 }}>
                    Active Jobs — All Tickers
                  </div>
                  {allTickers.map(ticker => {
                    const jobs = schedulerJobs.filter(j => j.ticker === ticker)
                    return (
                      <div key={ticker} style={{ marginBottom: 6 }}>
                        <div style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
                          color: ticker === replayTicker.toUpperCase() ? T.gold : T.muted,
                          fontFamily: T.mono, marginBottom: 3, paddingLeft: 2,
                        }}>
                          {ticker}
                          {ticker === replayTicker.toUpperCase() && (
                            <span style={{ fontWeight: 400, color: T.dim, marginLeft: 5 }}>selected</span>
                          )}
                        </div>
                        {jobs.map(job => (
                          <div key={job.id} style={{
                            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
                            padding: '4px 7px',
                            border: `1px solid ${job.enabled ? 'color-mix(in srgb, var(--theme-primary) 20%, transparent)' : T.border}`,
                            background: job.enabled ? 'color-mix(in srgb, var(--theme-primary) 3%, transparent)' : 'transparent',
                          }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, fontFamily: T.mono, color: T.text, fontWeight: 600 }}>
                                {BUILTIN_STRATEGY_INFO[job.strategy_name]?.label ?? job.strategy_name}
                              </div>
                              {job.last_signal ? (
                                <div style={{ fontSize: 8, fontFamily: T.mono, color: sigColor(job.last_signal) }}>
                                  {job.last_signal} @ ${job.last_price?.toFixed(2)}
                                  {job.warmed_up
                                    ? <span style={{ color: T.dim }}> · ready</span>
                                    : <span style={{ color: T.dim }}> · warming</span>
                                  }
                                </div>
                              ) : (
                                <div style={{ fontSize: 8, fontFamily: T.mono, color: T.dim }}>
                                  {job.warmed_up ? 'ready · no signal yet' : 'warming up…'}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => toggleJobMut.mutate({ id: job.id, enabled: !job.enabled })}
                              style={{
                                padding: '1px 6px', fontSize: 8, fontFamily: T.mono, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                                borderColor: job.enabled ? 'color-mix(in srgb, var(--theme-positive) 50%, transparent)' : T.border,
                                background: job.enabled ? 'color-mix(in srgb, var(--theme-positive) 10%, transparent)' : 'transparent',
                                color: job.enabled ? T.pos : T.muted, flexShrink: 0,
                              }}
                            >{job.enabled ? 'ON' : 'OFF'}</button>
                            <button
                              onClick={() => deleteJobMut.mutate(job.id)}
                              style={{ background: 'none', border: 'none', color: T.neg, cursor: 'pointer', fontSize: 13, padding: '0 2px', flexShrink: 0 }}
                            >×</button>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Recent activity — all tickers */}
              {schedulerLog.length > 0 && (
                <div>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', marginBottom: 3 }}>
                    Recent Activity
                  </div>
                  {schedulerLog.slice(0, 10).map(e => (
                    <div key={e.id} style={{ display: 'flex', gap: 5, alignItems: 'baseline',
                      padding: '2px 0', borderBottom: `1px solid ${T.border}` }}>
                      <span style={{ fontSize: 7, color: T.dim, fontFamily: T.mono, whiteSpace: 'nowrap' }}>
                        {new Date(e.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ fontSize: 8, fontWeight: 700, color: sigColor(e.signal), fontFamily: T.mono }}>{e.signal}</span>
                      <span style={{ fontSize: 8, color: T.gold, fontFamily: T.mono, fontWeight: 700 }}>{e.ticker}</span>
                      <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>${e.price.toFixed(2)}</span>
                      <span style={{ fontSize: 7, color: T.dim, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.strategy_name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Signal chart — replay or live */}
        {(chartData.length > 0 || liveChart.length > 0) && (
          <StrategySignalChart
            data={liveActive ? liveChart : chartData}
            ticker={replayTicker}
            mode={liveActive ? 'live' : 'replay'}
            intervalMs={liveIntervalMs}
          />
        )}
        </div>
      )}

      <CustomStrategyModal
        open={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        onSave={handleCustomSave}
      />
    </div>
  )
}
