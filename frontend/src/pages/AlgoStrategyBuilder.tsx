import { useState, useEffect } from 'react'
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
import CustomStrategyModal, { type CustomStrategyDef, DEFAULT_RISK, rulesForTicker, usesNonDailyTimeframe } from '../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy, deleteCustomStrategy } from '../utils/customStrategies'
import { PRESETS, PRESET_GROUPS, type Leg } from './strategy-builder/shared'
import { ReturnsScatter, quickRegression } from './regressionShared'

// Backend combo-instrument leg shape (mirrors strategy-builder's Leg but strike
// is a moneyness ratio — spot-relative, not a dollar strike — since the combo
// engine re-derives strikes from the spot at each historical entry).
export type ComboLeg = { type: 'call' | 'put'; side: 'buy' | 'sell'; moneyness: number; qty: number }
export const legsToCombo = (legs: Leg[]): ComboLeg[] =>
  legs.map(l => ({ type: l.option_type, side: l.action, moneyness: l.K / 100, qty: l.quantity }))
export const mkComboLeg = (): ComboLeg => ({ type: 'call', side: 'buy', moneyness: 1, qty: 1 })
// paper_engine.place_multileg_order only accepts 2-4 legs — capping here keeps a
// backtested combo executable live instead of silently failing to open.
export const MAX_COMBO_LEGS = 4

// One leg per card (type/side row, then strike%/qty row) rather than cramming
// five fields into one row — the combo editor lives in narrow rails/cards
// (as narrow as 166px) where a single-row grid truncates every field's text.
// Shared by the Algo Strategy Builder (single + portfolio mode) and the
// Portfolio Backtester's combo holdings.
export function ComboLegEditor({ legs, onUpdate, onRemove, onAdd }: {
  legs: ComboLeg[]
  onUpdate: (i: number, patch: Partial<ComboLeg>) => void
  onRemove: (i: number) => void
  onAdd: () => void
}) {
  const sel: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 10, padding: '4px 5px', outline: 'none', cursor: 'pointer', width: '100%', boxSizing: 'border-box' }
  const num: React.CSSProperties = { ...sel, cursor: 'text' }
  const fieldLabel: React.CSSProperties = { fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', marginBottom: 2 }
  const atCap = legs.length >= MAX_COMBO_LEGS
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>Legs ({legs.length})</span>
        <button type="button" onClick={onAdd} disabled={atCap}
          title={atCap ? `Live paper trading supports at most ${MAX_COMBO_LEGS} legs` : undefined}
          style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: atCap ? 'var(--theme-text-faint, rgba(255,255,255,0.3))' : 'var(--theme-primary, #c9a84c)', background: 'none', border: 'none', cursor: atCap ? 'default' : 'pointer' }}>+ ADD</button>
      </div>
      {legs.map((leg, i) => (
        <div key={i} style={{ background: 'var(--theme-bg, #0a1628)', border: `1px solid ${leg.side === 'sell' ? 'var(--theme-negative)' : 'var(--theme-positive)'}44`, padding: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: leg.side === 'sell' ? 'var(--theme-negative)' : 'var(--theme-positive)', textTransform: 'uppercase' }}>Leg {i + 1}</span>
            <button type="button" onClick={() => onRemove(i)} disabled={legs.length <= 1} title="Remove leg"
              style={{ background: 'none', border: 'none', fontSize: 13, lineHeight: 1, cursor: legs.length <= 1 ? 'default' : 'pointer', color: legs.length <= 1 ? 'var(--theme-text-faint, rgba(255,255,255,0.2))' : 'var(--theme-negative)' }}>×</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            <select value={leg.type} onChange={e => onUpdate(i, { type: e.target.value as ComboLeg['type'] })} style={sel}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
            <select value={leg.side} onChange={e => onUpdate(i, { side: e.target.value as ComboLeg['side'] })} style={sel}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            <div>
              <div style={fieldLabel}>Strike %</div>
              <input type="number" value={Math.round(leg.moneyness * 100)} step={1} min={1}
                title="Strike as % of spot (100 = at the money)"
                onChange={e => onUpdate(i, { moneyness: Math.max(0.01, (e.target.value === '' ? 100 : +e.target.value) / 100) })}
                style={num} />
            </div>
            <div>
              <div style={fieldLabel}>Qty</div>
              <input type="number" value={leg.qty} step={1} min={1}
                onChange={e => onUpdate(i, { qty: Math.max(1, Math.round(+e.target.value || 1)) })}
                style={num} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

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
  trades: { date: string; action: string; price: number; leg?: string }[]
  instrument?: { kind: string; type?: string; moneyness?: number; dte: number; iv: number; direction?: string; modeled: boolean; legs?: ComboLeg[] }
  bars?: number
  span?: { start: string; end: string }
}

// A portfolio is a book of positions, each pairing a saved rule-set with its own
// ticker, instrument, side, and capital weight. Composition persists locally.
interface PortfolioPos {
  id: string; strategy: string; ticker: string
  instMode: 'underlying' | 'option' | 'combo'; optType: 'call' | 'put'; otmPct: number; dte: number
  comboLegs: ComboLeg[]; comboDte: number
  side: 'long' | 'short'; weight: number
}
interface PortfolioResult {
  equity_curve: { date: string; strategy: number; benchmark: number }[]
  metrics: BacktestResult['metrics']
  positions: { ticker: string; side: string; instrument: string; opt_type?: string | null; weight_pct: number; return_pct: number; pnl: number; num_trades: number }[]
  bars?: number
  span?: { start: string; end: string }
}
const PF_KEY = 'fdb_algo_portfolio'
const rid = () => Math.random().toString(36).slice(2, 8)

// Surface the backend's real reason (FastAPI `detail`) instead of axios's generic
// "Request failed with status code NNN".
function errMsg(e: unknown, fallback = 'Request failed'): string {
  const d = (e as { response?: { data?: { detail?: unknown } }; message?: string })?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map((x: { msg?: string }) => x?.msg ?? String(x)).join(' · ') || fallback
  return (e as { message?: string })?.message ?? fallback
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
  const [timeframe, setTimeframe] = useState('1d')   // base bar size; intraday via Alpaca (equities)
  // Instrument: trade the underlying (default), a modeled single call/put, or a
  // modeled multi-leg combo (straddle/strangle/spread/condor/... — same preset
  // table as the Options Strategy Builder).
  const [instMode, setInstMode] = useState<'underlying' | 'option' | 'combo'>('underlying')
  const [optType, setOptType] = useState<'call' | 'put'>('call')
  // Strike entered as % out-of-the-money (negative = in-the-money); converted to
  // the backend's moneyness multiplier per the option side. Call OTM = strike
  // above spot; put OTM = strike below spot.
  const [otmPct, setOtmPct] = useState(0)
  const optMoneyness = optType === 'call' ? 1 + otmPct / 100 : 1 - otmPct / 100
  const [dte, setDte] = useState(30)
  // Combo legs start from a preset but are then freely editable — add/remove/
  // retype/reweight any leg, same as the Options Strategy Builder.
  const [comboLegs, setComboLegs] = useState<ComboLeg[]>(() => legsToCombo(PRESETS['Short Straddle']))
  const [comboDte, setComboDte] = useState(30)
  const comboInstrument = () => ({ kind: 'combo', dte: comboDte, legs: comboLegs })
  const loadComboPreset = (name: string) => setComboLegs(legsToCombo(PRESETS[name] ?? []))
  const addComboLeg = () => setComboLegs(l => l.length >= MAX_COMBO_LEGS ? l : [...l, mkComboLeg()])
  const removeComboLeg = (i: number) => setComboLegs(l => l.length > 1 ? l.filter((_, j) => j !== i) : l)
  const updateComboLeg = (i: number, patch: Partial<ComboLeg>) => setComboLegs(l => l.map((leg, j) => j === i ? { ...leg, ...patch } : leg))
  // Direction the BUY signal opens (single mode): long buys, short sells/writes.
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [paramsOpen, setParamsOpen] = useState(true)
  const [saved, setSaved] = useState<CustomStrategyDef[]>(() => loadCustomStrategies())
  const [activeName, setActiveName] = useState<string>(() => loadCustomStrategies()[0]?.name ?? '')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CustomStrategyDef | null>(null)
  const [mode, setMode] = useState<'single' | 'portfolio'>('single')
  const [positions, setPositions] = useState<PortfolioPos[]>(() => {
    try {
      const raw: any[] = JSON.parse(localStorage.getItem(PF_KEY) || '[]')
      // Migrate positions saved before combo legs became editable — they only
      // have a `comboPreset` name, not a legs array. Drop that name once migrated;
      // nothing reads it anymore.
      return raw.map(({ comboPreset, ...p }) => ({
        ...p,
        comboLegs: Array.isArray(p.comboLegs) && p.comboLegs.length ? p.comboLegs : legsToCombo(PRESETS[comboPreset ?? 'Short Straddle'] ?? PRESETS['Short Straddle']),
      }))
    } catch { return [] }
  })
  // Debounced: combo-leg edits call setPositions on every keystroke, and writing
  // the whole array to localStorage on each one is wasted work mid-typing.
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(PF_KEY, JSON.stringify(positions)), 400)
    return () => clearTimeout(t)
  }, [positions])
  const addPosition = () => setPositions(p => [...p, {
    id: rid(), strategy: loadCustomStrategies()[0]?.name ?? '', ticker: 'AAPL',
    instMode: 'underlying', optType: 'call', otmPct: 0, dte: 30,
    comboLegs: legsToCombo(PRESETS['Short Straddle']), comboDte: 30, side: 'long', weight: 25,
  }])
  const patchPosition = (id: string, patch: Partial<PortfolioPos>) =>
    setPositions(p => p.map(x => x.id === id ? { ...x, ...patch } : x))
  const removePosition = (id: string) => setPositions(p => p.filter(x => x.id !== id))
  const patchComboLeg = (posId: string, i: number, patch: Partial<ComboLeg>) =>
    setPositions(p => p.map(x => x.id !== posId ? x : { ...x, comboLegs: x.comboLegs.map((l, j) => j === i ? { ...l, ...patch } : l) }))
  const addComboLegToPosition = (posId: string) =>
    setPositions(p => p.map(x => x.id !== posId || x.comboLegs.length >= MAX_COMBO_LEGS ? x : { ...x, comboLegs: [...x.comboLegs, mkComboLeg()] }))
  const removeComboLegFromPosition = (posId: string, i: number) =>
    setPositions(p => p.map(x => x.id !== posId || x.comboLegs.length <= 1 ? x : { ...x, comboLegs: x.comboLegs.filter((_, j) => j !== i) }))

  const posToPayload = (p: PortfolioPos) => {
    const def = saved.find(s => s.name === p.strategy)
    if (!def) throw new Error(`Strategy "${p.strategy}" not found`)
    const money = p.optType === 'call' ? 1 + p.otmPct / 100 : 1 - p.otmPct / 100
    const r = def.risk
    const rules = rulesForTicker(def, p.ticker)   // per-ticker override, else default
    const instrument = p.instMode === 'option' ? { kind: 'option', type: p.optType, moneyness: money, dte: p.dte }
      : p.instMode === 'combo' ? { kind: 'combo', dte: p.comboDte ?? 30, legs: p.comboLegs?.length ? p.comboLegs : legsToCombo(PRESETS['Short Straddle']) }
      : undefined
    return {
      ticker: p.ticker, side: p.side, weight: p.weight,
      rules: { buy: rules.buy, sell: rules.sell },
      instrument,
      position_size: r?.sizingPct || 100,
      stop_loss: r?.stopLossPct || undefined, take_profit: r?.takeProfitPct || undefined,
      trailing_stop: r?.trailingStopPct || undefined, max_hold_bars: r?.maxHoldBars || undefined,
    }
  }

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
      const rules = rulesForTicker(activeDef, ticker)   // per-ticker override, else default
      const { data } = await axios.post('/api/strategy/custom-backtest', {
        ticker, start, end: end || undefined, side, timeframe,
        rules: { buy: rules.buy, sell: rules.sell },
        position_size: r.sizingPct || 100,
        stop_loss: r.stopLossPct || undefined,
        take_profit: r.takeProfitPct || undefined,
        trailing_stop: r.trailingStopPct || undefined,
        max_hold_bars: r.maxHoldBars || undefined,
        instrument: instMode === 'option'
          ? { kind: 'option', type: optType, moneyness: optMoneyness, dte }
          : instMode === 'combo' ? comboInstrument()
          : undefined,
      })
      return data
    },
  })

  const sendToPaper = useMutation<{ name: string }, Error>({
    mutationFn: async () => {
      if (!activeDef) throw new Error('Select a strategy first.')
      const rules = rulesForTicker(activeDef, ticker)   // resolve for the current ticker
      const { data } = await axios.post('/api/paper/strategies/custom', {
        name: activeDef.name, side,
        rules: { buy: rules.buy, sell: rules.sell },
        bull_drift: activeDef.bull_drift ?? 0,
        bear_drift: activeDef.bear_drift ?? 0,
        instrument: instMode === 'option'
          ? { kind: 'option', type: optType, moneyness: optMoneyness, dte }
          : instMode === 'combo' ? comboInstrument()
          : undefined,
      })
      return data
    },
  })

  const runPortfolio = useMutation<PortfolioResult, Error>({
    mutationFn: async () => {
      if (positions.length === 0) throw new Error('Add at least one position.')
      const { data } = await axios.post('/api/strategy/portfolio-backtest', {
        positions: positions.map(posToPayload), start, end: end || undefined, timeframe, initial_capital: 10000,
      })
      return data
    },
  })

  const sendPortfolioToPaper = useMutation<{ created: number }, Error>({
    mutationFn: async () => {
      if (positions.length === 0) throw new Error('Add at least one position.')
      const { data } = await axios.post('/api/paper/strategies/portfolio', {
        name: 'portfolio', positions: positions.map(posToPayload),
      })
      return data
    },
  })

  const m = data?.metrics
  const pf = runPortfolio.data
  const R = mode === 'portfolio' ? pf : data          // active result for the current mode
  const mR = R?.metrics
  // Regression dotplot: daily strategy vs benchmark returns derived straight from
  // the equity curve already on screen, no extra backend round-trip.
  const reg = R ? quickRegression(R.equity_curve.map(pt => ({ x: pt.benchmark, y: pt.strategy }))) : null

  return (
    <SidebarLayout sidebarWidth={230} sidebarTitle="" sidebar={<>
      <div style={{ padding: '10px 12px 0', display: 'flex', gap: 4 }}>
        {(['single', 'portfolio'] as const).map(md => (
          <button key={md} onClick={() => setMode(md)} style={{
            flex: 1, padding: '6px 0', fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
            background: mode === md ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
            border: `1px solid ${mode === md ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
            color: mode === md ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
          }}>{md === 'single' ? '1 Position' : 'Portfolio'}</button>
        ))}
      </div>
      <RailSection title="Backtest Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {mode === 'single' && (
          <div>
            <label style={LABEL}>Ticker</label>
            <TickerInput value={ticker} onChange={setTicker} onEnter={() => activeDef && runBacktest()} style={INPUT} placeholder="Ticker or company" />
            {activeDef?.perTicker?.length ? (
              <div style={{ fontSize: 8, marginTop: 3, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: activeDef.perTicker.some(r => r.ticker.toUpperCase().trim() === ticker.toUpperCase().trim()) ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
                {activeDef.perTicker.some(r => r.ticker.toUpperCase().trim() === ticker.toUpperCase().trim()) ? `${ticker.toUpperCase()}-specific signal` : 'default signal (no rule for this ticker)'}
              </div>
            ) : null}
          </div>
          )}
          <div>
            <label style={LABEL}>Start</label>
            <input type="date" value={start} onChange={e => setStart(e.target.value)} style={INPUT} />
          </div>
          <div>
            <label style={LABEL}>End</label>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={INPUT} />
          </div>
          <div>
            <label style={LABEL}>Timeframe</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['1d', '1h', '30m', '15m', '5m'] as const).map(tf => (
                <button key={tf} onClick={() => setTimeframe(tf)}
                  title={tf === '1d' ? 'Daily bars (full history)' : 'Intraday bars — US equities/ETFs, recent window'}
                  style={{ flex: '1 0 auto', fontFamily: 'var(--theme-mono)', fontSize: 9.5, fontWeight: 700, padding: '5px 0', cursor: 'pointer',
                    border: timeframe === tf ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
                    background: timeframe === tf ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                    color: timeframe === tf ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)' }}>
                  {tf.toUpperCase()}
                </button>
              ))}
            </div>
            {timeframe !== '1d' && (
              <div style={{ fontSize: 8, marginTop: 3, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
                Intraday: US equities/ETFs, recent window (start date is clamped).
              </div>
            )}
          </div>

          {/* Direction: what the BUY signal opens (single-position mode only; a
              combo's direction is per-leg, baked into the preset, so this doesn't apply). */}
          {mode === 'single' && instMode !== 'combo' && (
          <div>
            <label style={LABEL}>On BUY signal, open</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['long', 'Buy / Long'], ['short', 'Sell / Short']] as const).map(([sd, lbl]) => (
                <button key={sd} onClick={() => setSide(sd)}
                  title={sd === 'long' ? 'BUY signal opens a long; SELL signal closes it.' : 'BUY signal opens a short (sell/write); SELL signal covers it.'}
                  style={{
                    flex: 1, padding: '5px 0', fontFamily: 'inherit', fontSize: 9, fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                    background: side === sd ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                    border: `1px solid ${side === sd ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
                    color: side === sd ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                  }}>{lbl}</button>
              ))}
            </div>
          </div>
          )}

          {/* Instrument: underlying vs modeled option vs modeled multi-leg combo (single-position mode only) */}
          {mode === 'single' && (
          <div>
            <label style={LABEL}>Instrument</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['underlying', 'option', 'combo'] as const).map(im => (
                <button key={im} onClick={() => setInstMode(im)} style={{
                  flex: 1, padding: '5px 0', fontFamily: 'inherit', fontSize: 9, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                  background: instMode === im ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                  border: `1px solid ${instMode === im ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
                  color: instMode === im ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                }}>{im === 'underlying' ? 'Shares' : im === 'option' ? 'Option' : 'Combo'}</button>
              ))}
            </div>
          </div>
          )}

          {mode === 'single' && instMode === 'combo' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 4%, transparent)' }}>
              <div>
                <label style={{ ...LABEL, fontSize: 8 }}>Load preset</label>
                <select value="" onChange={e => e.target.value && loadComboPreset(e.target.value)} style={{ ...INPUT, cursor: 'pointer' }}>
                  <option value="">— pick a starting structure —</option>
                  {PRESET_GROUPS.map(g => (
                    <optgroup key={g.label} label={g.label}>
                      {g.keys.map(k => <option key={k} value={k}>{k}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <ComboLegEditor legs={comboLegs} onUpdate={updateComboLeg} onRemove={removeComboLeg} onAdd={addComboLeg} />
              <div>
                <label style={{ ...LABEL, fontSize: 8 }}>DTE (days)</label>
                <input type="number" value={comboDte} step={1} min={1} max={365}
                  onChange={e => setComboDte(Math.max(1, +e.target.value || 30))} style={INPUT} />
              </div>
              <div style={{ fontSize: 8, lineHeight: '12px', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
                Modeled P&L: every leg priced with Black-Scholes on the historical underlying at today's IV (no historical option prices). Approximate, not a real options backtest. The BUY signal opens all legs together; the SELL signal (or shared DTE expiry) closes them together.
              </div>
            </div>
          )}

          {mode === 'single' && instMode === 'option' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 4%, transparent)' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['call', 'put'] as const).map(ot => (
                  <button key={ot} onClick={() => setOptType(ot)} style={{
                    flex: 1, padding: '5px 0', fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                    background: optType === ot ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                    border: `1px solid ${optType === ot ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
                    color: optType === ot ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                  }}>{ot}</button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <div>
                  <label style={{ ...LABEL, fontSize: 8 }}>% OTM</label>
                  <input type="number" value={otmPct} step={1} min={-50} max={50}
                    title="Strike distance from spot. Positive = out of the money, negative = in the money, 0 = at the money."
                    onChange={e => setOtmPct(Math.max(-50, Math.min(50, Math.round(+e.target.value || 0))))} style={INPUT} />
                </div>
                <div>
                  <label style={{ ...LABEL, fontSize: 8 }}>DTE (days)</label>
                  <input type="number" value={dte} step={1} min={1} max={365}
                    onChange={e => setDte(Math.max(1, +e.target.value || 30))} style={INPUT} />
                </div>
              </div>
              <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em' }}>
                {otmPct === 0 ? 'At the money' : otmPct > 0 ? `${otmPct}% out of the money` : `${-otmPct}% in the money`} {optType} · strike ≈ {(optMoneyness * 100).toFixed(0)}% of spot
              </div>
              <div style={{ fontSize: 8, lineHeight: '12px', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
                Modeled P&L: Black-Scholes on the historical underlying at today's IV (no historical option prices). Approximate, not a real options backtest.
              </div>
            </div>
          )}
        </div>
      </RailSection>

      {mode === 'portfolio' && (
        <RailSection title={`Positions · ${positions.length}`} open onToggle={() => {}}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {positions.length === 0 && (
              <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.45))', lineHeight: '14px' }}>
                Each position pairs a saved strategy (its rules) with a ticker, weight, and the trade its BUY signal opens: buy/long or sell/short, in shares, calls, or puts. Build rule-sets below, then add positions.
              </div>
            )}
            {positions.map(p => {
              const btn = (on: boolean): React.CSSProperties => ({
                flex: 1, padding: '4px 0', fontFamily: 'inherit', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
                background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                border: `1px solid ${on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
                color: on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
              })
              return (
                <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 7, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', background: 'var(--theme-bg, #0a1628)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 46px 18px', gap: 4, alignItems: 'center' }}>
                    <input value={p.ticker} placeholder="TICKER"
                      onChange={e => patchPosition(p.id, { ticker: e.target.value.toUpperCase() })}
                      style={{ ...INPUT, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }} />
                    <input type="number" value={p.weight} min={0} max={100} title="Capital weight %"
                      onChange={e => patchPosition(p.id, { weight: Math.max(0, +e.target.value || 0) })}
                      style={{ ...INPUT, fontSize: 11 }} />
                    <button onClick={() => removePosition(p.id)} title="Remove"
                      style={{ background: 'none', border: 'none', color: 'var(--theme-negative)', cursor: 'pointer', fontSize: 14 }}>×</button>
                  </div>
                  <select value={p.strategy} onChange={e => patchPosition(p.id, { strategy: e.target.value })}
                    style={{ ...INPUT, fontSize: 10, cursor: 'pointer' }}>
                    {saved.length === 0 && <option value="">— build a strategy first —</option>}
                    {saved.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </select>
                  {(() => {
                    const def = saved.find(s => s.name === p.strategy)
                    if (!def?.perTicker?.length) return null
                    const hit = def.perTicker.some(r => r.ticker.toUpperCase().trim() === p.ticker.toUpperCase().trim())
                    return (
                      <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: hit ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
                        {hit ? `${p.ticker.toUpperCase()}-specific signal` : 'default signal (no rule for this ticker)'}
                      </div>
                    )
                  })()}
                  {p.instMode !== 'combo' && (
                  <div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 3 }}>On BUY signal, open</div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {([['long', 'Buy / Long'], ['short', 'Sell / Short']] as const).map(([sd, lbl]) => (
                        <button key={sd} title={sd === 'long' ? 'BUY signal opens a long; SELL signal closes it.' : 'BUY signal opens a short; SELL signal covers it.'}
                          onClick={() => patchPosition(p.id, { side: sd })} style={btn(p.side === sd)}>{lbl}</button>
                      ))}
                    </div>
                  </div>
                  )}
                  <div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 3 }}>Instrument</div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {([['shares', 'Shares'], ['call', 'Call'], ['put', 'Put'], ['combo', 'Combo']] as const).map(([kind, lbl]) => {
                        const on = kind === 'shares' ? p.instMode === 'underlying' : kind === 'combo' ? p.instMode === 'combo' : p.instMode === 'option' && p.optType === kind
                        return (
                          <button key={kind} onClick={() => patchPosition(p.id, kind === 'shares' ? { instMode: 'underlying' }
                            // Seed comboLegs/comboDte here, not just at read sites — a position
                            // saved before this feature existed has neither field, and toggling
                            // to Combo without seeding them would silently drop the position
                            // from the backtest.
                            : kind === 'combo' ? { instMode: 'combo', comboLegs: p.comboLegs?.length ? p.comboLegs : legsToCombo(PRESETS['Short Straddle']), comboDte: p.comboDte ?? 30 }
                            : { instMode: 'option', optType: kind })} style={btn(on)}>{lbl}</button>
                        )
                      })}
                    </div>
                  </div>
                  {p.instMode === 'option' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                      <div>
                        <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>% OTM (neg = ITM)</div>
                        <input type="number" value={p.otmPct} min={-50} max={50}
                          onChange={e => patchPosition(p.id, { otmPct: Math.max(-50, Math.min(50, Math.round(+e.target.value || 0))) })}
                          style={{ ...INPUT, fontSize: 10 }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>DTE (days)</div>
                        <input type="number" value={p.dte} min={1} max={365}
                          onChange={e => patchPosition(p.id, { dte: Math.max(1, +e.target.value || 30) })}
                          style={{ ...INPUT, fontSize: 10 }} />
                      </div>
                    </div>
                  )}
                  {p.instMode === 'combo' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <select value="" onChange={e => e.target.value && patchPosition(p.id, { comboLegs: legsToCombo(PRESETS[e.target.value] ?? []) })}
                        style={{ ...INPUT, fontSize: 10, cursor: 'pointer' }}>
                        <option value="">Load preset…</option>
                        {PRESET_GROUPS.map(g => (
                          <optgroup key={g.label} label={g.label}>
                            {g.keys.map(k => <option key={k} value={k}>{k}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      <ComboLegEditor legs={p.comboLegs} onUpdate={(i, patch) => patchComboLeg(p.id, i, patch)}
                        onRemove={i => removeComboLegFromPosition(p.id, i)} onAdd={() => addComboLegToPosition(p.id)} />
                      <div>
                        <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>DTE (days)</div>
                        <input type="number" value={p.comboDte} min={1} max={365}
                          onChange={e => patchPosition(p.id, { comboDte: Math.max(1, +e.target.value || 30) })}
                          style={{ ...INPUT, fontSize: 10 }} />
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: p.instMode === 'combo' ? 'var(--theme-primary, #c9a84c)' : p.side === 'short' ? NEG : POS }}>
                    {p.instMode === 'combo' ? `${p.comboLegs.length}-leg combo · ${p.comboDte ?? 30}d`
                      : p.instMode === 'option'
                      ? `${p.side === 'short' ? 'Short' : 'Long'} ${p.otmPct === 0 ? 'ATM' : p.otmPct > 0 ? `${p.otmPct}% OTM` : `${-p.otmPct}% ITM`} ${p.optType} · ${p.dte}d`
                      : `${p.side === 'short' ? 'Short' : 'Long'} shares`}
                    {p.instMode === 'option' && p.side === 'short' && <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}> · written</span>}
                  </div>
                </div>
              )
            })}
            <button onClick={addPosition} style={{
              width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
              border: '1px dashed var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '6px 0', cursor: 'pointer',
            }}>+ Add Position</button>
          </div>
        </RailSection>
      )}

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
                  BUY {c.buy} · SELL {c.sell}{def.perTicker?.length ? ` · ${def.perTicker.length} ticker${def.perTicker.length === 1 ? '' : 's'}` : ''}
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
        {mode === 'single' ? (<>
        <button onClick={() => runBacktest()} disabled={!activeDef || isPending} style={{
          width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: activeDef ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)',
          fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '8px 0',
          cursor: (!activeDef || isPending) ? 'default' : 'pointer', opacity: (!activeDef || isPending) ? 0.6 : 1,
        }}>{isPending ? 'Running…' : 'Run Backtest'}</button>
        {isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{errMsg(error, 'Backtest failed')}</div>}

        <button onClick={() => sendToPaper.mutate()} disabled={!activeDef || sendToPaper.isPending} style={{
          width: '100%', background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: activeDef ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
          fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '7px 0',
          cursor: (!activeDef || sendToPaper.isPending) ? 'default' : 'pointer', opacity: (!activeDef || sendToPaper.isPending) ? 0.6 : 1,
        }}>{sendToPaper.isPending ? 'Sending…' : '→ Send to Paper Trader'}</button>
        {activeDef && usesNonDailyTimeframe(activeDef) && (
          <div style={{ fontSize: 8, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', lineHeight: '12px', textAlign: 'center' }}>
            Uses non-daily timeframes. Live paper runs indicators on daily bars. Timeframes apply to backtests only.
          </div>
        )}
        {sendToPaper.isSuccess && <div style={{ fontSize: 9, color: 'var(--theme-positive)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>Imported · enable it in Paper Trading</div>}
        {sendToPaper.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{errMsg(sendToPaper.error, 'Import failed')}</div>}
        </>) : (<>
        <button onClick={() => runPortfolio.mutate()} disabled={positions.length === 0 || runPortfolio.isPending} style={{
          width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: positions.length ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)',
          fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '8px 0',
          cursor: (positions.length === 0 || runPortfolio.isPending) ? 'default' : 'pointer', opacity: (positions.length === 0 || runPortfolio.isPending) ? 0.6 : 1,
        }}>{runPortfolio.isPending ? 'Running…' : 'Run Portfolio'}</button>
        {runPortfolio.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{errMsg(runPortfolio.error, 'Backtest failed')}</div>}

        <button onClick={() => sendPortfolioToPaper.mutate()} disabled={positions.length === 0 || sendPortfolioToPaper.isPending} style={{
          width: '100%', background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: positions.length ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
          fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '7px 0',
          cursor: (positions.length === 0 || sendPortfolioToPaper.isPending) ? 'default' : 'pointer', opacity: (positions.length === 0 || sendPortfolioToPaper.isPending) ? 0.6 : 1,
        }}>{sendPortfolioToPaper.isPending ? 'Sending…' : '→ Send Portfolio to Paper'}</button>
        {positions.some(p => { const d = saved.find(s => s.name === p.strategy); return !!d && usesNonDailyTimeframe(d) }) && (
          <div style={{ fontSize: 8, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', lineHeight: '12px', textAlign: 'center' }}>
            Some strategies use non-daily timeframes. Live paper runs indicators on daily bars. Timeframes apply to backtests only.
          </div>
        )}
        {sendPortfolioToPaper.isSuccess && <div style={{ fontSize: 9, color: 'var(--theme-positive)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>Created {sendPortfolioToPaper.data?.created} job{sendPortfolioToPaper.data?.created === 1 ? '' : 's'} · enable in Paper Trading</div>}
        {sendPortfolioToPaper.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{errMsg(sendPortfolioToPaper.error, 'Import failed')}</div>}
        </>)}

        <div style={{ fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', lineHeight: '13px', marginTop: 2 }}>
          Saved strategies also appear under "Custom Rule Strategy" in Monte Carlo and the Backtester.
        </div>
      </div>
    </>}>

      {!R && (
        <EmptyState title="Algorithmic Strategy Builder"
          hint={mode === 'portfolio'
            ? 'Add positions (each = a saved rule-set + ticker + weight + the trade its BUY signal opens), then Run Portfolio. Long/short shares and long/short modeled options aggregate into one book.'
            : 'Build a strategy from entry/exit rules, pick a ticker, then Run Backtest. Saved strategies import into Monte Carlo and the Backtester.'}
          action={mode === 'portfolio' ? 'Run Portfolio' : 'Run Backtest'} />
      )}

      {R && mR && (
        <>
          <div style={STRIP}>
            <KpiCell grow minWidth={150} label="Total Return" value={`${mR.total_return > 0 ? '+' : ''}${mR.total_return.toFixed(2)}%`} valueSize={16} color={mR.total_return >= 0 ? POS : NEG} sub={mode === 'portfolio' ? `${pf?.positions.length ?? 0} positions` : activeDef?.name} />
            <KpiCell grow label="Ann. Return" value={`${mR.ann_return > 0 ? '+' : ''}${mR.ann_return.toFixed(2)}%`} color={mR.ann_return >= 0 ? POS : NEG} />
            <KpiCell grow label="Max Drawdown" value={`${mR.max_drawdown.toFixed(2)}%`} color={NEG} />
            <KpiCell grow label="Sharpe" value={mR.sharpe.toFixed(3)} color={mR.sharpe >= 1 ? POS : undefined} />
            <KpiCell grow label="Trades" value={String(mR.num_trades)} />
            <KpiCell grow label="Win Rate" value={`${mR.win_rate.toFixed(1)}%`} color={mR.win_rate >= 50 ? POS : NEG} />
            <KpiCell grow label="Final Capital" value={fmtCap(mR.final_capital)} />
            <KpiCell grow label="P&L" value={`${mR.total_pnl >= 0 ? '+' : ''}${fmtCap(mR.total_pnl)}`} color={mR.total_pnl >= 0 ? POS : NEG} />
          </div>

          {R.bars && R.span && (
            <div style={{ fontSize: 9, color: 'var(--theme-text-faint, #5e768f)', fontFamily: 'var(--theme-sans)', marginTop: 6, letterSpacing: '0.04em' }}>
              Window used: {R.span.start} → {R.span.end} · {R.bars.toLocaleString()} daily bars{R.bars < 250 ? ' — short history; indicators needing a long lookback (e.g. SMA200) warm up slowly here' : ''}
            </div>
          )}

          {mR.num_trades === 0 && (() => {
            const usesTickerRule = mode === 'single' && !!activeDef?.perTicker?.some(r => r.ticker.toUpperCase().trim() === ticker.toUpperCase().trim())
            const ruleNote = mode === 'single' && activeDef?.perTicker?.length
              ? ` This ticker uses ${usesTickerRule ? 'its ticker-specific rules' : 'the default rules'}.`
              : ''
            return (
              <div style={{ fontSize: 11, fontFamily: 'var(--theme-mono)', lineHeight: 1.55, color: 'var(--theme-text, #d7e3fc)',
                border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
                background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)', padding: '9px 12px' }}>
                <span style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.06em' }}>NO TRADES.</span>{' '}
                {mode === 'single'
                  ? `"${activeDef?.name}" never entered on ${ticker.toUpperCase()} over this range, so it stayed in cash.`
                  : 'No position entered over this range, so the book stayed in cash.'}
                {' '}The metrics are zero because nothing traded (not a load error). On the chart the flat filled line is the strategy at its starting capital; the dashed line is Buy &amp; Hold. Check the buy rules, ticker, and date range.{ruleNote}
              </div>
            )
          })()}

          {mode === 'portfolio' && pf && (
            <div style={{ ...STRIP, flexWrap: 'wrap' }}>
              {pf.positions.map((p, i) => (
                <div key={i} style={{ flex: '1 1 140px', minWidth: 140, padding: '6px 10px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                  <div style={{ fontSize: 10, fontFamily: 'var(--theme-mono)', fontWeight: 700, color: 'var(--theme-text, #d7e3fc)' }}>
                    {p.ticker} <span style={{ fontSize: 8, color: p.side === 'short' ? NEG : POS, letterSpacing: '0.06em' }}>{p.side.toUpperCase()} {p.instrument === 'option' ? (p.opt_type ? p.opt_type.toUpperCase() : 'OPT') : p.instrument === 'combo' ? 'COMBO' : 'SHR'}</span>
                  </div>
                  <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #8099b0)', marginTop: 2 }}>
                    w {p.weight_pct}% · <span style={{ color: p.return_pct >= 0 ? POS : NEG }}>{p.return_pct >= 0 ? '+' : ''}{p.return_pct}%</span> · {p.num_trades} trades
                  </div>
                </div>
              ))}
            </div>
          )}

          {mode === 'single' && data?.instrument?.modeled && data.instrument.kind === 'combo' && (() => {
            const im = data!.instrument!
            return (
            <div style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', border: '1px solid var(--theme-primary, #c9a84c)', padding: '1px 5px' }}>MODELED COMBO</span>
                {(im.legs ?? comboLegs).length}-leg combo · {im.dte} DTE · IV {im.iv}% (Black-Scholes per leg on underlying, not real option prices)
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 9 }}>
                {(im.legs ?? []).map((l, i) => (
                  <span key={i} style={{ color: l.side === 'sell' ? NEG : POS }}>
                    {l.side === 'sell' ? 'SHORT' : 'LONG'} {l.qty}x {l.type} @ {(l.moneyness * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
            </div>
            )
          })()}
          {mode === 'single' && data?.instrument?.modeled && data.instrument.kind !== 'combo' && (() => {
            const im = data!.instrument!
            const otm = Math.round((im.type === 'call' ? im.moneyness! - 1 : 1 - im.moneyness!) * 100)
            const strikeLbl = otm === 0 ? 'ATM' : otm > 0 ? `${otm}% OTM` : `${-otm}% ITM`
            return (
            <div style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', border: '1px solid var(--theme-primary, #c9a84c)', padding: '1px 5px' }}>MODELED</span>
              <span style={{ color: im.direction === 'short' ? NEG : POS, fontWeight: 700 }}>{im.direction === 'short' ? 'SHORT' : 'LONG'}</span>
              {im.type!.toUpperCase()} · {strikeLbl} · {im.dte} DTE · IV {im.iv}% (Black-Scholes on underlying, not real option prices)
              {im.direction === 'short' && <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>· written, mirror of the long leg</span>}
            </div>
            )
          })()}
          {mode === 'single' && instMode === 'underlying' && (
            <div style={{ fontSize: 10, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: side === 'short' ? NEG : POS }}>
              {side === 'short' ? 'Short' : 'Long'} {ticker.toUpperCase()} shares
            </div>
          )}
          {mode === 'single' && activeDef?.risk && (() => {
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
                <AreaChart data={R.equity_curve}>
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

          {reg && reg.x.length > 1 && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative', marginTop: 12 }}>
              <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, #142032)', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
                Regression — Strategy vs Buy &amp; Hold Daily Returns
              </div>
              <div style={{ paddingTop: 30, paddingLeft: 8, paddingRight: 8, paddingBottom: 8 }}>
                <ReturnsScatter x={reg.x} y={reg.y} line={reg.line} xLabel="Buy & Hold" height={280} />
                <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', textAlign: 'center', marginTop: 6 }}>
                  Beta {reg.beta.toFixed(2)} · daily alpha {reg.alpha >= 0 ? '+' : ''}{(reg.alpha * 100).toFixed(3)}%
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {modalOpen && (
        <CustomStrategyModal open onClose={() => setModalOpen(false)} onSave={onModalSave} initialDef={editing} />
      )}
    </SidebarLayout>
  )
}

export default function AlgoStrategyBuilder() {
  return <PageWrapper title="Algorithmic Strategy Builder"><AlgoStrategyBuilderContent /></PageWrapper>
}
