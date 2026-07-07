import { useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export type IndicatorType =
  | 'PRICE' | 'RSI' | 'SMA' | 'EMA'
  | 'MACD_LINE' | 'MACD_SIGNAL'
  | 'BB_UPPER' | 'BB_MID' | 'BB_LOWER'
  | 'ATR' | 'MOMENTUM' | 'PCT_CHANGE'
  | 'FUND_PE' | 'FUND_PEG' | 'FUND_EPSGROWTH' | 'FUND_NETMARGIN' | 'FUND_GROSSMARGIN'
  | 'FUND_DEBTEQUITY' | 'FUND_DIVYIELD' | 'FUND_PB' | 'FUND_CURRENTRATIO' | 'FUND_BETA'
  | 'VOL_RELATIVE' | 'VOL_DOLLAR'
  | 'OPT_IV' | 'OPT_HV' | 'OPT_IVHV' | 'OPT_PUTCALL' | 'OPT_IMPLIEDMOVE'
  | 'OPT_DELTA' | 'OPT_GAMMA' | 'OPT_THETA' | 'OPT_VEGA'
  | 'FLOW_HORMUZ' | 'FLOW_SUEZ' | 'FLOW_PANAMA' | 'FLOW_MALACCA'

// Fundamental / liquidity / options / flow metrics resolve from a current
// snapshot (live signal), held constant through a historical backtest. See
// backend market_context.
export const LIVE_TYPES: IndicatorType[] = [
  'FUND_PE', 'FUND_PEG', 'FUND_EPSGROWTH', 'FUND_NETMARGIN', 'FUND_GROSSMARGIN',
  'FUND_DEBTEQUITY', 'FUND_DIVYIELD', 'FUND_PB', 'FUND_CURRENTRATIO', 'FUND_BETA',
  'VOL_RELATIVE', 'VOL_DOLLAR',
  'OPT_IV', 'OPT_HV', 'OPT_IVHV', 'OPT_PUTCALL', 'OPT_IMPLIEDMOVE',
  'OPT_DELTA', 'OPT_GAMMA', 'OPT_THETA', 'OPT_VEGA',
  'FLOW_HORMUZ', 'FLOW_SUEZ', 'FLOW_PANAMA', 'FLOW_MALACCA',
]

// Bar size the indicator runs on. Daily is the default (and the backtest's own
// step). Coarser bars resample the daily close; finer bars fetch intraday data
// (history-limited: 1h ~2yr, 15m/5m ~60d), mapped back onto the daily backtest.
export type Timeframe = 'daily' | 'weekly' | 'monthly' | 'hourly' | '15min' | '5min'

export interface IndicatorRef {
  type: IndicatorType
  period?: number
  fast?: number
  slow?: number
  signal_period?: number
  std?: number
  ticker?: string   // optional cross-ticker reference; blank = the strategy's primary symbol
  timeframe?: Timeframe   // optional; absent = daily
  level?: number    // greeks: strike as a multiple of spot (1.0 = ATM, 1.05 = 5% OTM call)
  opt_type?: 'call' | 'put'   // greeks: which side the greek is measured on
}

const TF_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }, { value: 'hourly', label: '1-Hour' },
  { value: '15min', label: '15-Min' }, { value: '5min', label: '5-Min' },
]
const TF_INTRADAY: Timeframe[] = ['hourly', '15min', '5min']

export type OpType = 'gt' | 'lt' | 'gte' | 'lte' | 'crosses_above' | 'crosses_below'

export interface ConditionRow {
  id: string
  lhs: IndicatorRef
  op: OpType
  rhs_type: 'number' | 'indicator'
  rhs_num: number
  rhs_ind: IndicatorRef
}

export interface ConditionGroup {
  id: string
  logic: 'AND' | 'OR'
  conditions: ConditionRow[]
}

export interface RuleBlock {
  logic: 'AND' | 'OR'   // how groups combine at block level
  groups: ConditionGroup[]
}

// Risk management — travels with the strategy so backtest/import apply it.
// 0 means "off" for each control; sizingPct defaults to fully invested.
export interface StrategyRisk {
  sizingPct: number        // % of capital per position
  stopLossPct: number      // exit if price drops X% from entry (0 = off)
  takeProfitPct: number    // exit if price rises X% from entry (0 = off)
  trailingStopPct: number  // exit if price drops X% from peak since entry (0 = off)
  maxHoldBars: number      // exit after N bars (0 = off)
}

export const DEFAULT_RISK: StrategyRisk = {
  sizingPct: 100, stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0, maxHoldBars: 0,
}

// A per-ticker override: its own complete buy/sell signal that replaces the
// strategy's default rules whenever a position trades this exact ticker.
export interface TickerRuleSet {
  id: string
  ticker: string
  buy: RuleBlock
  sell: RuleBlock
}

export interface CustomStrategyDef {
  name: string
  buy: RuleBlock
  sell: RuleBlock
  perTicker?: TickerRuleSet[]   // ticker-specific signals; default buy/sell is the fallback
  bull_drift: number
  bear_drift: number
  risk?: StrategyRisk
}

// Resolve the concrete buy/sell blocks for a traded ticker: an exact (case-
// insensitive) per-ticker override wins, otherwise the strategy's default rules.
export function rulesForTicker(def: CustomStrategyDef, ticker: string): { buy: RuleBlock; sell: RuleBlock } {
  const t = (ticker || '').toUpperCase().trim()
  const hit = t ? def.perTicker?.find(r => (r.ticker || '').toUpperCase().trim() === t) : undefined
  return hit ? { buy: hit.buy, sell: hit.sell } : { buy: def.buy, sell: def.sell }
}

// True if any condition runs on a non-daily bar. Backtests honor timeframes; the
// live paper scheduler runs indicators on daily bars, so callers warn on this.
export function usesNonDailyTimeframe(def: CustomStrategyDef): boolean {
  const blocks: RuleBlock[] = [def.buy, def.sell, ...(def.perTicker?.flatMap(p => [p.buy, p.sell]) ?? [])]
  const nonDaily = (r?: IndicatorRef) => !!r?.timeframe && r.timeframe !== 'daily'
  return blocks.some(b => b.groups.some(g => g.conditions.some(c =>
    nonDaily(c.lhs) || (c.rhs_type === 'indicator' && nonDaily(c.rhs_ind)))))
}

// ── Constants ─────────────────────────────────────────────────────────────────

const IND_LABELS: Record<IndicatorType, string> = {
  PRICE: 'Price', RSI: 'RSI', SMA: 'SMA', EMA: 'EMA',
  MACD_LINE: 'MACD Line', MACD_SIGNAL: 'MACD Signal',
  BB_UPPER: 'BB Upper', BB_MID: 'BB Mid', BB_LOWER: 'BB Lower',
  ATR: 'ATR', MOMENTUM: 'Momentum', PCT_CHANGE: '% change (N-day)',
  FUND_PE: 'P/E ratio', FUND_PEG: 'PEG ratio', FUND_EPSGROWTH: 'EPS growth %',
  FUND_NETMARGIN: 'Net margin %', FUND_GROSSMARGIN: 'Gross margin %',
  FUND_DEBTEQUITY: 'Debt / equity', FUND_DIVYIELD: 'Dividend yield %',
  FUND_PB: 'P/B ratio', FUND_CURRENTRATIO: 'Current ratio', FUND_BETA: 'Beta',
  VOL_RELATIVE: 'Relative volume', VOL_DOLLAR: 'Dollar volume ($M)',
  OPT_IV: 'Implied vol % (ATM)', OPT_HV: 'Hist vol % (30d)', OPT_IVHV: 'IV / HV ratio',
  OPT_PUTCALL: 'Put/call ratio', OPT_IMPLIEDMOVE: 'Implied move %',
  OPT_DELTA: 'Delta', OPT_GAMMA: 'Gamma', OPT_THETA: 'Theta', OPT_VEGA: 'Vega',
  FLOW_HORMUZ: 'Hormuz transits', FLOW_SUEZ: 'Suez transits',
  FLOW_PANAMA: 'Panama transits', FLOW_MALACCA: 'Malacca transits',
}

const IND_GROUPS: { label: string; types: IndicatorType[] }[] = [
  { label: 'Technical', types: ['PRICE', 'RSI', 'SMA', 'EMA', 'MACD_LINE', 'MACD_SIGNAL', 'BB_UPPER', 'BB_MID', 'BB_LOWER', 'ATR', 'MOMENTUM', 'PCT_CHANGE'] },
  { label: 'Fundamental (live)', types: ['FUND_PE', 'FUND_PEG', 'FUND_EPSGROWTH', 'FUND_NETMARGIN', 'FUND_GROSSMARGIN', 'FUND_DEBTEQUITY', 'FUND_DIVYIELD', 'FUND_PB', 'FUND_CURRENTRATIO', 'FUND_BETA'] },
  { label: 'Liquidity (live)', types: ['VOL_RELATIVE', 'VOL_DOLLAR'] },
  { label: 'Options (live)', types: ['OPT_IV', 'OPT_HV', 'OPT_IVHV', 'OPT_PUTCALL', 'OPT_IMPLIEDMOVE'] },
  { label: 'Greeks (live)', types: ['OPT_DELTA', 'OPT_GAMMA', 'OPT_THETA', 'OPT_VEGA'] },
  { label: 'Energy flow (live)', types: ['FLOW_HORMUZ', 'FLOW_SUEZ', 'FLOW_PANAMA', 'FLOW_MALACCA'] },
]

const OP_LABELS: Record<OpType, string> = {
  gt: '> above', lt: '< below', gte: '≥ at or above', lte: '≤ at or below',
  crosses_above: '↑ crosses above', crosses_below: '↓ crosses below',
}

const DEFAULT_IND: Record<IndicatorType, IndicatorRef> = {
  PRICE:       { type: 'PRICE' },
  RSI:         { type: 'RSI', period: 14 },
  SMA:         { type: 'SMA', period: 50 },
  EMA:         { type: 'EMA', period: 20 },
  MACD_LINE:   { type: 'MACD_LINE', fast: 12, slow: 26, signal_period: 9 },
  MACD_SIGNAL: { type: 'MACD_SIGNAL', fast: 12, slow: 26, signal_period: 9 },
  BB_UPPER:    { type: 'BB_UPPER', period: 20, std: 2.0 },
  BB_MID:      { type: 'BB_MID', period: 20, std: 2.0 },
  BB_LOWER:    { type: 'BB_LOWER', period: 20, std: 2.0 },
  ATR:         { type: 'ATR', period: 14 },
  MOMENTUM:    { type: 'MOMENTUM', period: 126 },
  PCT_CHANGE:  { type: 'PCT_CHANGE', period: 20 },
  FUND_PE:     { type: 'FUND_PE' }, FUND_PEG: { type: 'FUND_PEG' },
  FUND_EPSGROWTH: { type: 'FUND_EPSGROWTH' }, FUND_NETMARGIN: { type: 'FUND_NETMARGIN' },
  FUND_GROSSMARGIN: { type: 'FUND_GROSSMARGIN' }, FUND_DEBTEQUITY: { type: 'FUND_DEBTEQUITY' },
  FUND_DIVYIELD: { type: 'FUND_DIVYIELD' }, FUND_PB: { type: 'FUND_PB' },
  FUND_CURRENTRATIO: { type: 'FUND_CURRENTRATIO' }, FUND_BETA: { type: 'FUND_BETA' },
  VOL_RELATIVE: { type: 'VOL_RELATIVE' }, VOL_DOLLAR: { type: 'VOL_DOLLAR' },
  OPT_IV: { type: 'OPT_IV' }, OPT_HV: { type: 'OPT_HV' }, OPT_IVHV: { type: 'OPT_IVHV' },
  OPT_PUTCALL: { type: 'OPT_PUTCALL' }, OPT_IMPLIEDMOVE: { type: 'OPT_IMPLIEDMOVE' },
  OPT_DELTA: { type: 'OPT_DELTA', level: 1.0, opt_type: 'call' },
  OPT_GAMMA: { type: 'OPT_GAMMA', level: 1.0, opt_type: 'call' },
  OPT_THETA: { type: 'OPT_THETA', level: 1.0, opt_type: 'call' },
  OPT_VEGA:  { type: 'OPT_VEGA',  level: 1.0, opt_type: 'call' },
  FLOW_HORMUZ: { type: 'FLOW_HORMUZ' }, FLOW_SUEZ: { type: 'FLOW_SUEZ' },
  FLOW_PANAMA: { type: 'FLOW_PANAMA' }, FLOW_MALACCA: { type: 'FLOW_MALACCA' },
}

// ── Theme tokens — all use CSS variables so they track the active colour preset ──

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.10))',
  text:    'var(--theme-text, #d7e3fc)',
  muted:   'var(--theme-secondary, #99907e)',
  dim:     'var(--theme-text-faint, rgba(255,255,255,0.28))',
  gold:    'var(--theme-primary, #c9a84c)',
  pos:     'var(--theme-pos, #4caf7d)',
  neg:     'var(--theme-neg, #e05c6e)',
  blue:    '#60a5fa',
  mono:    'var(--theme-mono, ui-monospace, monospace)',
}

const inp: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`,
  color: T.text, fontFamily: T.mono, fontSize: 11,
  padding: '4px 6px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

const sel: React.CSSProperties = {
  ...inp, cursor: 'pointer', appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath fill='%2399907e' d='M0 0l4 5 4-5z'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center',
  paddingRight: 22,
}

const btn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`,
  color: T.muted, fontFamily: T.mono, fontSize: 9,
  padding: '4px 10px', cursor: 'pointer', letterSpacing: '0.08em',
}

function uid() { return Math.random().toString(36).slice(2, 9) }

// ── IndicatorSelector ─────────────────────────────────────────────────────────

function IndicatorSelector({ value, onChange }: {
  value: IndicatorRef
  onChange: (v: IndicatorRef) => void
}) {
  const t = value.type

  const setType = (type: IndicatorType) => onChange({ ...DEFAULT_IND[type], ticker: value.ticker })
  const set = (field: keyof IndicatorRef, v: number) =>
    onChange({ ...value, [field]: v })

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={t} onChange={e => setType(e.target.value as IndicatorType)}
        style={{ ...sel, width: 130, flexShrink: 0 }}>
        {IND_GROUPS.map(g => (
          <optgroup key={g.label} label={g.label}>
            {g.types.map(it => <option key={it} value={it}>{IND_LABELS[it]}</option>)}
          </optgroup>
        ))}
      </select>
      <input
        value={value.ticker ?? ''}
        onChange={e => onChange({ ...value, ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, '') || undefined })}
        placeholder="sym"
        title="Cross-ticker reference — evaluate this indicator on another symbol. Blank = the strategy's primary ticker."
        style={{ ...inp, width: 52, flexShrink: 0, textTransform: 'uppercase' }} />
      {!LIVE_TYPES.includes(t) && (
        <>
          <select value={value.timeframe ?? 'daily'}
            onChange={e => onChange({ ...value, timeframe: e.target.value === 'daily' ? undefined : e.target.value as Timeframe })}
            title="Bar size this indicator runs on. Coarser bars resample the daily close. Intraday bars fetch that interval (history limited: 1h ~2yr, 15m/5m ~60d), so older bars have no signal."
            style={{ ...sel, width: 84, flexShrink: 0 }}>
            {TF_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {TF_INTRADAY.includes(value.timeframe as Timeframe) && (
            <span title="Intraday history is limited, so bars older than the window carry no signal."
              style={{ fontSize: 8, color: T.gold, fontFamily: T.mono, border: `1px solid ${T.gold}55`, padding: '1px 4px', letterSpacing: '0.04em', flexShrink: 0 }}>
              {value.timeframe === 'hourly' ? '~2yr' : '~60d'}
            </span>
          )}
        </>
      )}
      {LIVE_TYPES.includes(t) && (
        <span title="Current-snapshot value (live signal). Held constant through a historical backtest, so it is not point-in-time."
          style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, border: `1px solid ${T.border}`, padding: '1px 4px', letterSpacing: '0.06em' }}>
          LIVE
        </span>
      )}
      {(t === 'RSI' || t === 'SMA' || t === 'EMA' || t === 'ATR' || t === 'MOMENTUM' || t === 'PCT_CHANGE' ||
        t === 'BB_UPPER' || t === 'BB_MID' || t === 'BB_LOWER') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>period</span>
          <input type="number" value={value.period ?? 14} min={1} max={500}
            onChange={e => set('period', +e.target.value || 1)}
            style={{ ...inp, width: 46 }} />
        </div>
      )}
      {(t === 'BB_UPPER' || t === 'BB_MID' || t === 'BB_LOWER') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>std</span>
          <input type="number" value={value.std ?? 2.0} min={0.1} max={5} step={0.1}
            onChange={e => set('std', +e.target.value || 2)}
            style={{ ...inp, width: 40 }} />
        </div>
      )}
      {(t === 'MACD_LINE' || t === 'MACD_SIGNAL') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>fast</span>
            <input type="number" value={value.fast ?? 12} min={1} max={100}
              onChange={e => set('fast', +e.target.value || 12)}
              style={{ ...inp, width: 40 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>slow</span>
            <input type="number" value={value.slow ?? 26} min={1} max={200}
              onChange={e => set('slow', +e.target.value || 26)}
              style={{ ...inp, width: 40 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>sig</span>
            <input type="number" value={value.signal_period ?? 9} min={1} max={50}
              onChange={e => set('signal_period', +e.target.value || 9)}
              style={{ ...inp, width: 40 }} />
          </div>
        </>
      )}
      {(t === 'OPT_DELTA' || t === 'OPT_GAMMA' || t === 'OPT_THETA' || t === 'OPT_VEGA') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}
              title="Strike as a multiple of spot: 1.00 = ATM, 1.05 = 5% OTM call, 0.95 = 5% below spot">strike ×</span>
            <input type="number" value={value.level ?? 1.0} min={0.5} max={1.5} step={0.05}
              onChange={e => set('level', +e.target.value || 1)}
              style={{ ...inp, width: 48 }} />
          </div>
          <select value={value.opt_type ?? 'call'}
            onChange={e => onChange({ ...value, opt_type: e.target.value as 'call' | 'put' })}
            style={{ ...sel, width: 58 }}>
            <option value="call">call</option>
            <option value="put">put</option>
          </select>
        </>
      )}
    </div>
  )
}

// ── ConditionRowEditor ────────────────────────────────────────────────────────

function ConditionRowEditor({ cond, onChange, onRemove, index }: {
  cond: ConditionRow
  onChange: (c: ConditionRow) => void
  onRemove: () => void
  index: number
}) {
  const u = (patch: Partial<ConditionRow>) => onChange({ ...cond, ...patch })
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap',
      padding: '7px 10px',
      background: index % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent',
      border: `1px solid ${T.border}`,
      marginBottom: 4,
    }}>
      {/* LHS */}
      <div style={{ flex: '1 1 200px', minWidth: 200 }}>
        <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, marginBottom: 3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          When
        </div>
        <IndicatorSelector value={cond.lhs} onChange={lhs => u({ lhs })} />
      </div>

      {/* Operator */}
      <div style={{ flexShrink: 0, paddingTop: 17 }}>
        <select value={cond.op} onChange={e => u({ op: e.target.value as OpType })}
          style={{ ...sel, width: 140 }}>
          {(Object.entries(OP_LABELS) as [OpType, string][]).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* RHS */}
      <div style={{ flex: '1 1 180px', minWidth: 160 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
          <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Value
          </span>
          <button
            onClick={() => u({ rhs_type: cond.rhs_type === 'number' ? 'indicator' : 'number' })}
            style={{ ...btn, padding: '1px 5px', fontSize: 8,
              color: cond.rhs_type === 'indicator' ? T.blue : T.gold,
              borderColor: cond.rhs_type === 'indicator' ? 'rgba(96,165,250,0.4)' : 'color-mix(in srgb, var(--theme-primary) 40%, transparent)',
            }}
          >{cond.rhs_type === 'number' ? '# literal' : '≈ indicator'}</button>
        </div>
        {cond.rhs_type === 'number' ? (
          <input type="number" value={cond.rhs_num} step={0.1}
            onChange={e => u({ rhs_num: parseFloat(e.target.value) || 0 })}
            style={{ ...inp }} />
        ) : (
          <IndicatorSelector value={cond.rhs_ind}
            onChange={rhs_ind => u({ rhs_ind })} />
        )}
      </div>

      {/* Remove */}
      <button onClick={onRemove}
        style={{ background: 'none', border: 'none', color: T.neg, cursor: 'pointer', fontSize: 16, padding: '14px 4px 0', flexShrink: 0 }}>
        ×
      </button>
    </div>
  )
}

// ── ConditionGroupEditor ──────────────────────────────────────────────────────

function ConditionGroupEditor({ group, onChange, onRemove, canRemove, isBuy, accentColor }: {
  group: ConditionGroup
  onChange: (g: ConditionGroup) => void
  onRemove: () => void
  canRemove: boolean
  isBuy: boolean
  accentColor: string
}) {
  const addCond = () => {
    const c: ConditionRow = {
      id: uid(),
      lhs: DEFAULT_IND['RSI'],
      op: isBuy ? 'lt' : 'gt',
      rhs_type: 'number',
      rhs_num: isBuy ? 30 : 70,
      rhs_ind: DEFAULT_IND['PRICE'],
    }
    onChange({ ...group, conditions: [...group.conditions, c] })
  }

  const updateCond = (i: number, c: ConditionRow) => {
    const next = [...group.conditions]; next[i] = c
    onChange({ ...group, conditions: next })
  }

  const removeCond = (i: number) =>
    onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) })

  return (
    <div style={{
      border: `1px solid ${accentColor}30`,
      background: `${accentColor}05`,
      padding: '8px 10px',
      marginBottom: 8,
    }}>
      {/* Group header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>match</span>
        <select value={group.logic}
          onChange={e => onChange({ ...group, logic: e.target.value as 'AND' | 'OR' })}
          style={{ ...sel, width: 60 }}>
          <option value="AND">ALL</option>
          <option value="OR">ANY</option>
        </select>
        <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>of these conditions</span>
        <button onClick={addCond}
          style={{ ...btn, marginLeft: 'auto', fontSize: 8, borderColor: `${accentColor}50`, color: accentColor }}>
          + Add Condition
        </button>
        {canRemove && (
          <button onClick={onRemove}
            style={{ background: 'none', border: `1px solid ${T.neg}40`, color: T.neg, fontFamily: T.mono,
              fontSize: 8, padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.06em' }}>
            ÷ Remove Group
          </button>
        )}
      </div>

      {group.conditions.length === 0 && (
        <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, padding: '6px 8px',
          border: `1px dashed ${T.border}`, textAlign: 'center' }}>
          No conditions — click "+ Add Condition"
        </div>
      )}

      {group.conditions.map((c, i) => (
        <ConditionRowEditor
          key={c.id}
          index={i}
          cond={c}
          onChange={nc => updateCond(i, nc)}
          onRemove={() => removeCond(i)}
        />
      ))}
    </div>
  )
}

// ── RuleBlockEditor ───────────────────────────────────────────────────────────

function RuleBlockEditor({ label, block, onChange, accentColor }: {
  label: string
  block: RuleBlock
  onChange: (b: RuleBlock) => void
  accentColor: string
}) {
  const isBuy = label === 'BUY'

  const addGroup = () => {
    const g: ConditionGroup = { id: uid(), logic: 'AND', conditions: [] }
    onChange({ ...block, groups: [...block.groups, g] })
  }

  const updateGroup = (i: number, g: ConditionGroup) => {
    const next = [...block.groups]; next[i] = g
    onChange({ ...block, groups: next })
  }

  const removeGroup = (i: number) =>
    onChange({ ...block, groups: block.groups.filter((_, j) => j !== i) })

  const totalConditions = block.groups.reduce((s, g) => s + g.conditions.length, 0)

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Block header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
          color: accentColor, fontFamily: T.mono, padding: '2px 8px',
          border: `1px solid ${accentColor}44`, background: `${accentColor}0d`,
        }}>
          {label}
        </span>
        {block.groups.length > 1 && (
          <>
            <span style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>when</span>
            <select value={block.logic}
              onChange={e => onChange({ ...block, logic: e.target.value as 'AND' | 'OR' })}
              style={{ ...sel, width: 60 }}>
              <option value="AND">ALL</option>
              <option value="OR">ANY</option>
            </select>
            <span style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>of these groups are met</span>
          </>
        )}
        <button onClick={addGroup}
          style={{ ...btn, marginLeft: 'auto', borderColor: `${accentColor}60`, color: accentColor }}>
          + Add Group
        </button>
      </div>

      {totalConditions === 0 && (
        <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono, padding: '8px 10px',
          border: `1px dashed ${T.border}`, textAlign: 'center', marginBottom: 8 }}>
          No conditions — add a group and define conditions
        </div>
      )}

      {block.groups.map((g, i) => (
        <ConditionGroupEditor
          key={g.id}
          group={g}
          onChange={ng => updateGroup(i, ng)}
          onRemove={() => removeGroup(i)}
          canRemove={block.groups.length > 1}
          isBuy={isBuy}
          accentColor={accentColor}
        />
      ))}
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

const EMPTY_BLOCK = (): RuleBlock => ({
  logic: 'AND',
  groups: [{ id: uid(), logic: 'AND', conditions: [] }],
})

// Deep-clone a rule block with fresh ids so a per-ticker override starts from a
// copy of the default rather than sharing its group/condition objects.
const cloneBlock = (b: RuleBlock): RuleBlock => ({
  logic: b.logic,
  groups: b.groups.map(g => ({
    id: uid(), logic: g.logic,
    conditions: g.conditions.map(c => ({ ...c, id: uid(), lhs: { ...c.lhs }, rhs_ind: { ...c.rhs_ind } })),
  })),
})

const DEFAULTS: CustomStrategyDef = {
  name: '',
  buy: {
    logic: 'AND',
    groups: [{
      id: uid(), logic: 'AND',
      conditions: [{
        id: uid(),
        lhs: { type: 'RSI', period: 14 },
        op: 'lt',
        rhs_type: 'number',
        rhs_num: 30,
        rhs_ind: DEFAULT_IND['PRICE'],
      }],
    }],
  },
  sell: {
    logic: 'OR',
    groups: [{
      id: uid(), logic: 'OR',
      conditions: [{
        id: uid(),
        lhs: { type: 'RSI', period: 14 },
        op: 'gt',
        rhs_type: 'number',
        rhs_num: 70,
        rhs_ind: DEFAULT_IND['PRICE'],
      }],
    }],
  },
  bull_drift: 0.0,
  bear_drift: 0.0,
  risk: { ...DEFAULT_RISK },
}

interface Props {
  open: boolean
  onClose: () => void
  onSave: (def: CustomStrategyDef) => void
  initialDef?: CustomStrategyDef | null
}

export default function CustomStrategyModal({ open, onClose, onSave, initialDef }: Props) {
  const [def, setDef] = useState<CustomStrategyDef>(() => initialDef ?? { ...DEFAULTS, buy: { ...DEFAULTS.buy }, sell: { ...DEFAULTS.sell }, name: '' })
  const [nameError, setNameError] = useState('')

  const reset = useCallback(() => {
    setDef(initialDef ?? { ...DEFAULTS, buy: { ...DEFAULTS.buy }, sell: { ...DEFAULTS.sell }, name: '' })
    setNameError('')
  }, [initialDef])

  if (!open) return null

  const u = (patch: Partial<CustomStrategyDef>) => setDef(d => ({ ...d, ...patch }))

  const hasConditions = (block: RuleBlock) =>
    block.groups.some(g => g.conditions.length > 0)

  // Per-ticker overrides. A new one is seeded from the current default rules so
  // the user starts from what already works and edits just the differences.
  const addTickerRule = () => u({
    perTicker: [...(def.perTicker ?? []), {
      id: uid(), ticker: '', buy: cloneBlock(def.buy), sell: cloneBlock(def.sell),
    }],
  })
  const updateTickerRule = (id: string, patch: Partial<TickerRuleSet>) =>
    u({ perTicker: (def.perTicker ?? []).map(r => r.id === id ? { ...r, ...patch } : r) })
  const removeTickerRule = (id: string) =>
    u({ perTicker: (def.perTicker ?? []).filter(r => r.id !== id) })

  const handleSave = () => {
    if (!def.name.trim()) { setNameError('Strategy name is required.'); return }
    const perTicker = def.perTicker ?? []
    // Every per-ticker rule set needs a symbol, else its rules would be lost.
    if (perTicker.some(r => !r.ticker.trim())) {
      setNameError('Give every ticker-specific rule set a ticker symbol, or remove it.'); return
    }
    const anyPerTicker = perTicker.some(r => hasConditions(r.buy) || hasConditions(r.sell))
    if (!hasConditions(def.buy) && !hasConditions(def.sell) && !anyPerTicker) {
      setNameError('Add at least one BUY or SELL condition.'); return
    }
    const dupe = perTicker.map(r => r.ticker.toUpperCase().trim())
      .find((t, i, a) => a.indexOf(t) !== i)
    if (dupe) { setNameError(`Ticker "${dupe}" has more than one rule set.`); return }
    onSave({ ...def, name: def.name.trim(), perTicker: perTicker.length ? perTicker : undefined })
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
    }}>
      {/* Backdrop */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }}
        onClick={onClose} />

      {/* Drawer */}
      <div style={{
        position: 'relative', zIndex: 1,
        width: 'min(820px, 96vw)', height: '100dvh',
        background: T.bg, borderLeft: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column',
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px', borderBottom: `1px solid ${T.border}`,
          background: T.surface, flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: T.gold, fontFamily: T.mono, textTransform: 'uppercase' }}>
            Custom Strategy Builder
          </span>
          <span style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, flex: 1 }}>
            Define buy & sell rules from technical indicators
          </span>
          <button onClick={() => { reset(); onClose() }}
            style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' }}>
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px', flex: 1 }}>
          {/* Strategy name */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase', marginBottom: 5, fontFamily: T.mono }}>
              Strategy Name
            </div>
            <input
              value={def.name}
              onChange={e => { u({ name: e.target.value }); setNameError('') }}
              placeholder="e.g. RSI Oversold + SMA Trend"
              style={{ ...inp, fontSize: 13, padding: '7px 10px' }}
            />
            {nameError && (
              <div style={{ fontSize: 9, color: T.neg, fontFamily: T.mono, marginTop: 4 }}>{nameError}</div>
            )}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: T.border, marginBottom: 12 }} />

          {/* Logic legend — make the ALL/ANY nesting explicit */}
          <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 14 }}>
            Each <span style={{ color: T.muted }}>group</span> matches <span style={{ color: T.muted }}>ALL</span> or <span style={{ color: T.muted }}>ANY</span> of its conditions; a block fires when <span style={{ color: T.muted }}>ALL</span> or <span style={{ color: T.muted }}>ANY</span> of its groups match. Add a second group to combine signals with different logic.
          </div>

          {/* Default rules label */}
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, fontFamily: T.mono, marginBottom: 8 }}>
            Default rules{(def.perTicker?.length ?? 0) > 0 ? ' (tickers without their own rules below)' : ''}
          </div>

          {/* BUY block */}
          <RuleBlockEditor
            label="BUY"
            block={def.buy}
            onChange={buy => u({ buy })}
            accentColor={T.pos}
          />

          {/* SELL block */}
          <RuleBlockEditor
            label="SELL"
            block={def.sell}
            onChange={sell => u({ sell })}
            accentColor={T.neg}
          />

          {/* Per-ticker signal overrides */}
          <div style={{ marginTop: 4, marginBottom: 16 }}>
            <div style={{ height: 1, background: T.border, marginBottom: 12 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.gold, fontFamily: T.mono }}>Ticker-specific signals</span>
              <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>optional</span>
              <button onClick={addTickerRule} style={{ ...btn, marginLeft: 'auto', borderColor: `${T.gold}60`, color: T.gold }}>+ Add ticker</button>
            </div>
            <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 10 }}>
              Give a ticker its own buy and sell rules. A position trading that ticker uses these instead of the rules above; every other ticker falls back to the default.
            </div>
            {(def.perTicker ?? []).map(entry => (
              <div key={entry.id} style={{ border: `1px solid ${T.gold}30`, background: `${T.gold}05`, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Ticker</span>
                  <input value={entry.ticker}
                    onChange={e => updateTickerRule(entry.id, { ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, '') })}
                    placeholder="e.g. NVDA"
                    style={{ ...inp, width: 120, textTransform: 'uppercase', fontWeight: 700 }} />
                  <button onClick={() => removeTickerRule(entry.id)}
                    style={{ marginLeft: 'auto', background: 'none', border: `1px solid ${T.neg}40`, color: T.neg, fontFamily: T.mono, fontSize: 8, padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.06em' }}>Remove ticker</button>
                </div>
                <RuleBlockEditor label="BUY" block={entry.buy} onChange={buy => updateTickerRule(entry.id, { buy })} accentColor={T.pos} />
                <RuleBlockEditor label="SELL" block={entry.sell} onChange={sell => updateTickerRule(entry.id, { sell })} accentColor={T.neg} />
              </div>
            ))}
            {(def.perTicker ?? []).length === 0 && (
              <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, padding: '8px 10px', border: `1px dashed ${T.border}`, textAlign: 'center' }}>
                No ticker-specific signals. The default rules above apply to every ticker.
              </div>
            )}
          </div>

          {/* Risk management */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase', marginBottom: 8, fontFamily: T.mono }}>
              Risk Management
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              {([
                ['Position Size %', 'sizingPct', 5],
                ['Stop-Loss %', 'stopLossPct', 0.5],
                ['Take-Profit %', 'takeProfitPct', 0.5],
                ['Trailing Stop %', 'trailingStopPct', 0.5],
                ['Max Hold (bars)', 'maxHoldBars', 1],
              ] as [string, keyof StrategyRisk, number][]).map(([label, key, step]) => (
                <div key={key}>
                  <label style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, display: 'block', marginBottom: 3, fontFamily: T.mono }}>{label}</label>
                  <input type="number" min={0} step={step} value={(def.risk ?? DEFAULT_RISK)[key]}
                    onChange={e => u({ risk: { ...(def.risk ?? DEFAULT_RISK), [key]: Math.max(0, +e.target.value) } })}
                    style={{ width: '100%', boxSizing: 'border-box', background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 11, padding: '5px 6px', outline: 'none' }} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginTop: 5 }}>
              0 disables a control. Position size caps the % of capital committed per trade.
            </div>
          </div>

          {/* Reference guide */}
          <div style={{ marginTop: 16, padding: '10px 12px', background: T.surface, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: T.muted, textTransform: 'uppercase', marginBottom: 6, fontFamily: T.mono }}>
              Indicator Reference
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px' }}>
              {([
                ['Price', 'Raw closing price'],
                ['RSI(n)', 'Relative strength index, n-period'],
                ['SMA(n)', 'Simple moving average, n-period'],
                ['EMA(n)', 'Exponential moving average'],
                ['MACD Line', 'EMA(fast) − EMA(slow)'],
                ['MACD Signal', 'EMA(sig) of MACD line'],
                ['BB Upper/Mid/Lower', 'Bollinger bands: mid ± std×σ'],
                ['ATR(n)', 'Average true range (close-to-close proxy)'],
                ['Momentum(n)', 'Price[i] / Price[i-n] − 1'],
              ] as [string, string][]).map(([name, desc]) => (
                <div key={name} style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                  <span style={{ color: T.text }}>{name}</span>
                  <span style={{ color: T.dim }}> — {desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          padding: '12px 18px', borderTop: `1px solid ${T.border}`,
          background: T.surface, flexShrink: 0,
        }}>
          <button onClick={() => { reset(); onClose() }} style={{ ...btn, padding: '6px 16px' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{ ...btn, padding: '6px 20px', fontWeight: 700,
              background: T.gold, border: 'none', color: T.surface, letterSpacing: '0.1em' }}
          >
            Save Strategy
          </button>
        </div>
      </div>
    </div>
  )
}
