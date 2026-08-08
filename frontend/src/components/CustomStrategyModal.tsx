import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import axios from 'axios'
import useIsMobile from '../hooks/useIsMobile'
import StrategyCodePanel from './StrategyCodePanel'

// ── Types ─────────────────────────────────────────────────────────────────────

export type IndicatorType =
  | 'PRICE' | 'RSI' | 'SMA' | 'EMA'
  | 'MACD_LINE' | 'MACD_SIGNAL'
  | 'BB_UPPER' | 'BB_MID' | 'BB_LOWER'
  | 'ATR' | 'MOMENTUM' | 'PCT_CHANGE' | 'PCT_BELOW_HIGH' | 'PCT_ABOVE_LOW'
  | 'OPT_HV' | 'OPT_IVRANK'
  | 'FUND_PE' | 'FUND_PEG' | 'FUND_EPSGROWTH' | 'FUND_NETMARGIN' | 'FUND_GROSSMARGIN'
  | 'FUND_DEBTEQUITY' | 'FUND_DIVYIELD' | 'FUND_PB' | 'FUND_CURRENTRATIO' | 'FUND_BETA'
  | 'VOL_RELATIVE' | 'VOL_DOLLAR'
  | 'FLOW_HORMUZ' | 'FLOW_SUEZ' | 'FLOW_PANAMA' | 'FLOW_MALACCA'

// Fundamental / liquidity / flow metrics resolve from a point-in-time context
// (see backend market_context) as a per-bar array already aligned to the price
// series — a pre-resolved lookup, not resampled from price, so unlike every
// other indicator here they always run at the base cadence (no timeframe
// selector). Options-derived signals that can't be made point-in-time at all
// (implied vol, put/call ratio, implied move, greeks) aren't offered — no
// historical options-chain data source exists anywhere in this app.
export const NO_TIMEFRAME_TYPES: IndicatorType[] = [
  'FUND_PE', 'FUND_PEG', 'FUND_EPSGROWTH', 'FUND_NETMARGIN', 'FUND_GROSSMARGIN',
  'FUND_DEBTEQUITY', 'FUND_DIVYIELD', 'FUND_PB', 'FUND_CURRENTRATIO', 'FUND_BETA',
  'VOL_RELATIVE', 'VOL_DOLLAR',
  'FLOW_HORMUZ', 'FLOW_SUEZ', 'FLOW_PANAMA', 'FLOW_MALACCA',
]

// Bar size the indicator runs on. Defaults to the backtest's own step. A frame
// COARSER than the backtest timeframe resamples up (weekly/monthly, or e.g. 1H
// while trading 5m); a same/finer frame just runs on the base bars. Intraday
// frames require an intraday backtest timeframe + an Alpaca-served equity.
export type Timeframe = '5m' | '15m' | '30m' | '1h' | 'daily' | 'weekly' | 'monthly'

export interface IndicatorRef {
  type: IndicatorType
  period?: number
  fast?: number
  slow?: number
  signal_period?: number
  std?: number
  ticker?: string   // optional cross-ticker reference; blank = the strategy's primary symbol
  timeframe?: Timeframe   // optional; absent = daily
}

const TF_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '30m', label: '30m' },
  { value: '1h', label: '1H' },
  { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

// IV Rank's lookback: how far back the current realized-vol reading is ranked
// against (trading days). Shorter windows warm up faster and react to a
// recent vol regime; longer windows (the 1y/annual default) match the
// standard "IV Rank" convention but need much more history before they
// produce a value at all — see backend warmup_bars(OPT_IVRANK).
const IV_RANK_WINDOWS: { value: number; label: string }[] = [
  { value: 5, label: 'Weekly' }, { value: 21, label: 'Monthly' },
  { value: 63, label: 'Quarterly' }, { value: 252, label: 'Annually' },
]

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
// 0 means "off" for each control; sizingPct defaults to fully invested,
// leverage defaults to 1x (unlevered) — unlike the other controls, 0 is not
// a valid "off" value for leverage, since it would mean no position at all.
export interface StrategyRisk {
  sizingPct: number        // % of capital per position
  stopLossPct: number      // exit if price drops X% from entry (0 = off)
  takeProfitPct: number    // exit if price rises X% from entry (0 = off)
  trailingStopPct: number  // exit if price drops X% from peak since entry (0 = off)
  maxHoldBars: number      // exit after N bars (0 = off)
  exitPct: number          // % of the open position the EXIT rule closes each time it fires (100 = all of it)
  deltaExit: number        // options/combo only: close once |net delta| reaches this, 0-1 scale (0 = off)
  gammaExit: number        // options/combo only: close once |net gamma| reaches this (0 = off)
  leverage: number         // gross-notional multiplier on sizingPct, 1x = unlevered
  effectiveAnnualRate: number  // EAR charged on notional borrowed beyond 100% of capital (0 = off)
}

export const DEFAULT_RISK: StrategyRisk = {
  sizingPct: 100, stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0, maxHoldBars: 0,
  exitPct: 100, deltaExit: 0, gammaExit: 0, leverage: 1, effectiveAnnualRate: 0,
}

// A per-ticker override: its own complete buy/sell signal that replaces the
// strategy's default rules whenever a position trades this exact ticker.
export interface TickerRuleSet {
  id: string
  ticker: string
  buy: RuleBlock
  sell: RuleBlock
}

/** One leg of an option combo. Mirrors AlgoStrategyBuilder's ComboLeg; declared
 *  here so the strategy type does not import from the page that renders it. */
export interface StrategyComboLeg { type: 'call' | 'put'; side: 'buy' | 'sell'; moneyness: number; qty: number }

export interface StrategyPosition {
  id: string; strategy: string; ticker: string
  instMode: 'underlying' | 'option' | 'combo'; optType: 'call' | 'put'; otmPct: number; dte: number
  comboLegs: StrategyComboLeg[]; comboDte: number
  side: 'long' | 'short'; tradeSize?: number
}

/**
 * Everything the builder needs besides the rules: what to trade, as what
 * instrument, over what window.
 *
 * This used to live only as page state, so selecting a saved strategy restored
 * its rules and left you on whatever ticker and instrument happened to be
 * loaded — the strategy remembered HOW to trade but not WHAT. Saving it here
 * makes a strategy a complete, reproducible setup.
 *
 * Every field is optional: an older strategy has no setup and keeps whatever is
 * on screen, exactly as before.
 */
export interface StrategySetup {
  mode?: 'single' | 'portfolio'
  ticker?: string
  side?: 'long' | 'short'
  timeframe?: string
  start?: string
  end?: string
  instMode?: 'underlying' | 'option' | 'combo'
  optType?: 'call' | 'put'
  otmPct?: number
  dte?: number
  comboLegs?: StrategyComboLeg[]
  comboDte?: number
  positions?: StrategyPosition[]
  portfolioTradeSize?: number
  portfolioMaxOpenPositions?: number
  portfolioLeverage?: number
}

export interface CustomStrategyDef {
  name: string
  buy: RuleBlock
  sell: RuleBlock
  /** Ticker, instrument and window this strategy was built for. */
  setup?: StrategySetup
  /** Python `signal(c)` written in the Build with Code tab. Saved with the
   *  strategy, so a code strategy survives a reload like any other. */
  code?: string
  /** When true the backtest runs `code` instead of the buy/sell blocks. The
   *  blocks are kept either way — they still describe the strategy in the
   *  trade-marker tooltips, and turning this off restores them exactly. */
  useCode?: boolean
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
  PCT_BELOW_HIGH: '% below N-day high', PCT_ABOVE_LOW: '% above N-day low',
  OPT_HV: 'Realized vol % (N-day)', OPT_IVRANK: 'IV Rank %',
  FUND_PE: 'P/E ratio', FUND_PEG: 'PEG ratio', FUND_EPSGROWTH: 'EPS growth % (YoY)',
  FUND_NETMARGIN: 'Net margin %', FUND_GROSSMARGIN: 'Gross margin %',
  FUND_DEBTEQUITY: 'Debt / equity', FUND_DIVYIELD: 'Dividend yield %',
  FUND_PB: 'P/B ratio', FUND_CURRENTRATIO: 'Current ratio', FUND_BETA: 'Beta (60d rolling)',
  VOL_RELATIVE: 'Relative volume', VOL_DOLLAR: 'Dollar volume ($M)',
  FLOW_HORMUZ: 'Hormuz transits', FLOW_SUEZ: 'Suez transits',
  FLOW_PANAMA: 'Panama transits', FLOW_MALACCA: 'Malacca transits',
}

const IND_GROUPS: { label: string; types: IndicatorType[] }[] = [
  { label: 'Technical', types: ['PRICE', 'RSI', 'SMA', 'EMA', 'MACD_LINE', 'MACD_SIGNAL', 'BB_UPPER', 'BB_MID', 'BB_LOWER', 'ATR', 'MOMENTUM', 'PCT_CHANGE', 'PCT_BELOW_HIGH', 'PCT_ABOVE_LOW'] },
  { label: 'Volatility', types: ['OPT_HV', 'OPT_IVRANK'] },
  { label: 'Fundamental', types: ['FUND_PE', 'FUND_PEG', 'FUND_EPSGROWTH', 'FUND_NETMARGIN', 'FUND_GROSSMARGIN', 'FUND_DEBTEQUITY', 'FUND_DIVYIELD', 'FUND_PB', 'FUND_CURRENTRATIO', 'FUND_BETA'] },
  { label: 'Liquidity', types: ['VOL_RELATIVE', 'VOL_DOLLAR'] },
  { label: 'Energy flow', types: ['FLOW_HORMUZ', 'FLOW_SUEZ', 'FLOW_PANAMA', 'FLOW_MALACCA'] },
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
  PCT_BELOW_HIGH: { type: 'PCT_BELOW_HIGH', period: 20 },
  PCT_ABOVE_LOW:  { type: 'PCT_ABOVE_LOW', period: 20 },
  OPT_HV: { type: 'OPT_HV', period: 21 }, OPT_IVRANK: { type: 'OPT_IVRANK', period: 252 },
  FUND_PE:     { type: 'FUND_PE' }, FUND_PEG: { type: 'FUND_PEG' },
  FUND_EPSGROWTH: { type: 'FUND_EPSGROWTH' }, FUND_NETMARGIN: { type: 'FUND_NETMARGIN' },
  FUND_GROSSMARGIN: { type: 'FUND_GROSSMARGIN' }, FUND_DEBTEQUITY: { type: 'FUND_DEBTEQUITY' },
  FUND_DIVYIELD: { type: 'FUND_DIVYIELD' }, FUND_PB: { type: 'FUND_PB' },
  FUND_CURRENTRATIO: { type: 'FUND_CURRENTRATIO' }, FUND_BETA: { type: 'FUND_BETA' },
  VOL_RELATIVE: { type: 'VOL_RELATIVE' }, VOL_DOLLAR: { type: 'VOL_DOLLAR' },
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
        title={t === 'PCT_CHANGE' ? 'Uses percentage points: enter -20 for a 20% drop, not -0.2.' : undefined}
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
      {!NO_TIMEFRAME_TYPES.includes(t) && (
        <select value={value.timeframe ?? 'daily'}
          onChange={e => onChange({ ...value, timeframe: e.target.value === 'daily' ? undefined : e.target.value as Timeframe })}
          title="Bar size this indicator runs on. A frame coarser than the backtest timeframe resamples up (e.g. 1H trend while trading 5m); a same/finer frame runs on the backtest's own bars. Intraday frames need an intraday backtest timeframe on a US equity."
          style={{ ...sel, width: 84, flexShrink: 0 }}>
          {TF_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {NO_TIMEFRAME_TYPES.includes(t) && (
        <span title="Resolved from a point-in-time context (fundamentals/liquidity/flow) aligned to the backtest's own daily bars — always runs at the base cadence, no timeframe to pick."
          style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, border: `1px solid ${T.border}`, padding: '1px 4px', letterSpacing: '0.06em' }}>
          DAILY
        </span>
      )}
      {(t === 'RSI' || t === 'SMA' || t === 'EMA' || t === 'ATR' || t === 'MOMENTUM' || t === 'PCT_CHANGE' ||
        t === 'PCT_BELOW_HIGH' || t === 'PCT_ABOVE_LOW' || t === 'OPT_HV' ||
        t === 'BB_UPPER' || t === 'BB_MID' || t === 'BB_LOWER') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>period</span>
          <input type="number" value={value.period ?? 14} min={1} max={500}
            onChange={e => set('period', +e.target.value || 1)}
            style={{ ...inp, width: 46 }} />
        </div>
      )}
      {t === 'OPT_IVRANK' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>window</span>
          <select value={value.period ?? 252}
            onChange={e => set('period', +e.target.value)}
            title="How far back current realized vol is ranked against. Shorter windows need less warmup history but rank against a smaller, noisier sample; Annually is the standard 1-year IV Rank convention."
            style={{ ...sel, width: 92 }}>
            {IV_RANK_WINDOWS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
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

function RuleBlockEditor({ label, block, onChange, accentColor, isBuy }: {
  label: string
  block: RuleBlock
  onChange: (b: RuleBlock) => void
  accentColor: string
  isBuy: boolean
}) {
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

// ── Describe-in-English chat ─────────────────────────────────────────────────
// Converts an English description into the same buy/sell/risk shape the manual
// editor above produces, via a multi-turn chat (backend/routers/ai.py's
// /strategy-chat asks clarifying questions before it's confident enough to
// draft). The LLM's JSON never carries row/group ids and isn't guaranteed to
// stay inside the IndicatorType union, so every accepted draft is hydrated —
// same purpose as cloneBlock() below, but rebuilding from an untrusted shape
// rather than copying a trusted one.

const ALL_INDICATOR_TYPES = new Set<IndicatorType>(Object.keys(IND_LABELS) as IndicatorType[])
const ALL_OPS = new Set<OpType>(Object.keys(OP_LABELS) as OpType[])

function hydrateIndicatorRef(raw: any): IndicatorRef {
  const type: IndicatorType = raw && ALL_INDICATOR_TYPES.has(raw.type) ? raw.type : 'PRICE'
  const base = DEFAULT_IND[type]
  const ref: IndicatorRef = { type }
  if (base.period !== undefined) ref.period = Number(raw?.period ?? base.period) || base.period
  if (base.fast !== undefined) ref.fast = Number(raw?.fast ?? base.fast) || base.fast
  if (base.slow !== undefined) ref.slow = Number(raw?.slow ?? base.slow) || base.slow
  if (base.signal_period !== undefined) ref.signal_period = Number(raw?.signal_period ?? base.signal_period) || base.signal_period
  if (base.std !== undefined) ref.std = Number(raw?.std ?? base.std) || base.std
  if (raw?.ticker && typeof raw.ticker === 'string') {
    const ticker = raw.ticker.toUpperCase().replace(/[^A-Z0-9.\-]/g, '')
    if (!['TICKER', 'SYMBOL', 'SELF'].includes(ticker)) ref.ticker = ticker || undefined
  }
  if (!NO_TIMEFRAME_TYPES.includes(type) && raw?.timeframe && raw.timeframe !== 'daily') ref.timeframe = raw.timeframe as Timeframe
  return ref
}

function hydrateCondition(raw: any): ConditionRow {
  const rhs_type: 'number' | 'indicator' = raw?.rhs_type === 'indicator' ? 'indicator' : 'number'
  return {
    id: uid(),
    lhs: hydrateIndicatorRef(raw?.lhs),
    op: raw && ALL_OPS.has(raw.op) ? raw.op : 'gt',
    rhs_type,
    rhs_num: typeof raw?.rhs_num === 'number' && isFinite(raw.rhs_num) ? raw.rhs_num : 0,
    rhs_ind: hydrateIndicatorRef(raw?.rhs_ind),
  }
}

function hydrateGroup(raw: any): ConditionGroup {
  return {
    id: uid(),
    logic: raw?.logic === 'OR' ? 'OR' : 'AND',
    conditions: Array.isArray(raw?.conditions) ? raw.conditions.map(hydrateCondition) : [],
  }
}

function hydrateRuleBlock(raw: any): RuleBlock {
  const groups = Array.isArray(raw?.groups) ? raw.groups.map(hydrateGroup) : []
  return { logic: raw?.logic === 'OR' ? 'OR' : 'AND', groups: groups.length ? groups : [{ id: uid(), logic: 'AND', conditions: [] }] }
}

function hydrateRisk(raw: any): StrategyRisk {
  const n = (v: any, fallback: number, min = 0) => typeof v === 'number' && isFinite(v) && v >= min ? v : fallback
  return {
    sizingPct: n(raw?.sizingPct, 100), stopLossPct: n(raw?.stopLossPct, 0), takeProfitPct: n(raw?.takeProfitPct, 0),
    trailingStopPct: n(raw?.trailingStopPct, 0), maxHoldBars: n(raw?.maxHoldBars, 0),
    exitPct: n(raw?.exitPct, 100, 1),
    deltaExit: n(raw?.deltaExit, 0), gammaExit: n(raw?.gammaExit, 0),
    leverage: n(raw?.leverage, 1, 1), effectiveAnnualRate: n(raw?.effectiveAnnualRate, 0),
  }
}

// Plain-English rendering of a built rule tree — used for the draft preview so
// the user can sanity-check what the AI built without switching to the manual
// editor's interactive controls first.
function describeIndicator(ref: IndicatorRef): string {
  const label = IND_LABELS[ref.type] ?? ref.type
  let param = ''
  if (ref.type === 'MACD_LINE' || ref.type === 'MACD_SIGNAL') param = `${ref.fast ?? 12}/${ref.slow ?? 26}/${ref.signal_period ?? 9}`
  else if (ref.type === 'BB_UPPER' || ref.type === 'BB_MID' || ref.type === 'BB_LOWER') param = `${ref.period ?? 20}, ${ref.std ?? 2}σ`
  else if (ref.period != null) param = String(ref.period)
  let s = param ? `${label}(${param})` : label
  if (ref.ticker) s += ` [${ref.ticker}]`
  if (ref.timeframe && ref.timeframe !== 'daily') s += ` @${ref.timeframe}`
  return s
}
function describeCondition(c: ConditionRow): string {
  const rhs = c.rhs_type === 'number' ? String(c.rhs_num) : describeIndicator(c.rhs_ind)
  return `${describeIndicator(c.lhs)} ${OP_LABELS[c.op]} ${rhs}`
}
function describeGroup(g: ConditionGroup, wrap: boolean): string {
  if (!g.conditions.length) return '(no conditions)'
  const body = g.conditions.map(describeCondition).join(g.logic === 'AND' ? ' and ' : ' or ')
  return wrap && g.conditions.length > 1 ? `(${body})` : body
}
function describeRuleBlock(b: RuleBlock): string {
  const groups = b.groups.filter(g => g.conditions.length)
  if (!groups.length) return '(no rule conditions — exits only via risk controls, if any)'
  return groups.map(g => describeGroup(g, groups.length > 1)).join(b.logic === 'AND' ? ' AND ' : ' OR ')
}

interface ChatMsg { role: 'user' | 'assistant'; content: string }
export interface StrategyDraft { buy: RuleBlock; sell: RuleBlock; risk: StrategyRisk; summary: string }

function AiStrategyChat({ onAccept }: { onAccept: (draft: StrategyDraft) => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<StrategyDraft | null>(null)

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, pending])

  const send = async () => {
    const text = input.trim()
    if (!text || pending) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setError('')
    setPending(true)
    try {
      const { data } = await axios.post('/api/ai/strategy-chat', { messages: next })
      if (data?.type === 'draft') {
        const hydrated: StrategyDraft = {
          buy: hydrateRuleBlock(data.buy), sell: hydrateRuleBlock(data.sell), risk: hydrateRisk(data.risk),
          summary: typeof data.summary === 'string' && data.summary ? data.summary : 'Strategy drafted — review below.',
        }
        setDraft(hydrated)
        setMessages(m => [...m, { role: 'assistant', content: hydrated.summary }])
      } else {
        setDraft(null)
        setMessages(m => [...m, { role: 'assistant', content: data?.text || "Could you say a bit more about that?" }])
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Request failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: 1.6 }}>
        Describe a strategy in plain English. The assistant asks clarifying questions, then drafts buy/sell rules you can review, edit, and save like any other strategy.
      </div>

      <div ref={listRef} style={{
        display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto',
        padding: messages.length ? 10 : 0, background: messages.length ? T.surface : 'transparent',
        border: messages.length ? `1px solid ${T.border}` : 'none',
      }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono, lineHeight: 1.6, fontStyle: 'italic' }}>
            e.g. "Buy when RSI drops below 30 and price is above the 200-day SMA. Sell on RSI above 70 or a 10% trailing stop."
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{
              fontSize: 8, color: T.dim, fontFamily: T.mono, marginBottom: 2, letterSpacing: '0.08em',
              textTransform: 'uppercase', textAlign: m.role === 'user' ? 'right' : 'left',
            }}>{m.role === 'user' ? 'You' : 'Assistant'}</div>
            <div style={{
              fontSize: 11, fontFamily: T.mono, lineHeight: 1.5, padding: '7px 10px', whiteSpace: 'pre-wrap',
              color: T.text, background: m.role === 'user' ? `${T.gold}14` : T.bg,
              border: `1px solid ${m.role === 'user' ? `${T.gold}40` : T.border}`,
            }}>{m.content}</div>
          </div>
        ))}
        {pending && <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono, fontStyle: 'italic' }}>Thinking…</div>}
      </div>

      {draft && (
        <div style={{ border: `1px solid ${T.gold}40`, background: `${T.gold}08`, padding: '10px 12px' }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, fontFamily: T.mono, marginBottom: 8 }}>
            Draft ready
          </div>
          <div style={{ fontSize: 10, fontFamily: T.mono, color: T.text, marginBottom: 5, lineHeight: 1.5 }}>
            <span style={{ color: T.pos, fontWeight: 700 }}>ENTER </span>{describeRuleBlock(draft.buy)}
          </div>
          <div style={{ fontSize: 10, fontFamily: T.mono, color: T.text, marginBottom: 8, lineHeight: 1.5 }}>
            <span style={{ color: T.neg, fontWeight: 700 }}>EXIT </span>{describeRuleBlock(draft.sell)}
          </div>
          {(draft.risk.stopLossPct > 0 || draft.risk.takeProfitPct > 0 || draft.risk.trailingStopPct > 0 || draft.risk.maxHoldBars > 0 || draft.risk.sizingPct !== 100 || draft.risk.leverage > 1) && (
            <div style={{ fontSize: 9, fontFamily: T.mono, color: T.muted, marginBottom: 8 }}>
              Risk — size {draft.risk.sizingPct}%
              {draft.risk.leverage > 1 ? ` · ${draft.risk.leverage}x leverage` : ''}
              {draft.risk.leverage > 1 && draft.risk.effectiveAnnualRate > 0 ? ` · ${draft.risk.effectiveAnnualRate}% EAR` : ''}
              {draft.risk.stopLossPct > 0 ? ` · SL ${draft.risk.stopLossPct}%` : ''}
              {draft.risk.takeProfitPct > 0 ? ` · TP ${draft.risk.takeProfitPct}%` : ''}
              {draft.risk.trailingStopPct > 0 ? ` · trail ${draft.risk.trailingStopPct}%` : ''}
              {draft.risk.maxHoldBars > 0 ? ` · max ${draft.risk.maxHoldBars} bars` : ''}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => onAccept(draft)}
              style={{ ...btn, background: T.gold, border: 'none', color: T.surface, fontWeight: 700, letterSpacing: '0.08em' }}>
              Use This Draft
            </button>
            <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>or keep chatting below to refine it</span>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 9, color: T.neg, fontFamily: T.mono }}>{error}</div>}

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={messages.length ? 'Reply…' : 'Describe your strategy…'}
          disabled={pending}
          style={{ ...inp, fontSize: 12, padding: '8px 10px', flex: 1 }} />
        <button onClick={send} disabled={pending || !input.trim()}
          style={{ ...btn, padding: '6px 16px', fontWeight: 700, opacity: (pending || !input.trim()) ? 0.5 : 1, cursor: (pending || !input.trim()) ? 'default' : 'pointer' }}>
          Send
        </button>
      </div>
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
  allowAiAssist?: boolean
  aiAssistant?: ReactNode
  initialTab?: 'manual' | 'describe' | 'code'
}

export default function CustomStrategyModal({ open, onClose, onSave, initialDef, allowAiAssist = true, aiAssistant, initialTab = 'manual' }: Props) {
  const [def, setDef] = useState<CustomStrategyDef>(() => initialDef ?? { ...DEFAULTS, buy: { ...DEFAULTS.buy }, sell: { ...DEFAULTS.sell }, name: '' })
  const [nameError, setNameError] = useState('')
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<'manual' | 'describe' | 'code'>(initialTab)
  const aiAssistantOwnsSave = Boolean(aiAssistant) && tab === 'describe'

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

  // Replaces the default buy/sell/risk with the accepted draft (name and any
  // per-ticker overrides are untouched) and drops back to the manual editor so
  // the user reviews/edits the generated rules with the same controls as a
  // hand-built strategy, rather than saving straight out of the chat.
  const acceptDraft = (draft: StrategyDraft) => {
    u({ buy: draft.buy, sell: draft.sell, risk: draft.risk })
    setTab('manual')
  }

  const handleSave = () => {
    if (!def.name.trim()) { setNameError('Strategy name is required.'); return }
    const perTicker = def.perTicker ?? []
    // Every per-ticker rule set needs a symbol, else its rules would be lost.
    if (perTicker.some(r => !r.ticker.trim())) {
      setNameError('Give every ticker-specific rule set a ticker symbol, or remove it.'); return
    }
    const anyPerTicker = perTicker.some(r => hasConditions(r.buy) || hasConditions(r.sell))
    // A code strategy carries its logic in def.code, so it can legitimately have
    // empty rule blocks — the condition requirement would make it unsaveable.
    const codeStrategy = Boolean(def.useCode && (def.code || '').trim())
    if (!codeStrategy && !hasConditions(def.buy) && !hasConditions(def.sell) && !anyPerTicker) {
      setNameError('Add at least one Enter or Exit condition, or write one in Build with Code.'); return
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
          {!aiAssistantOwnsSave && <>
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
          </>}

          {(allowAiAssist || aiAssistant) && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              {(['manual', 'describe', 'code'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '6px 14px', fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
                  background: tab === t ? `${T.gold}1a` : 'transparent',
                  border: `1px solid ${tab === t ? T.gold : T.border}`,
                  color: tab === t ? T.gold : T.muted,
                }}>
                  {t === 'manual' ? 'Manual'
                    : t === 'code' ? 'Build with Code'
                    : aiAssistant ? 'AI Assistant' : 'Describe (AI)'}
                  {t === 'code' && def.useCode && (
                    <span style={{ marginLeft: 6, color: T.gold }}>●</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {(allowAiAssist || aiAssistant) && (
            <div style={{ display: tab === 'describe' ? 'block' : 'none', marginBottom: 16 }}>
              {aiAssistant ?? <AiStrategyChat onAccept={acceptDraft} />}
            </div>
          )}

          {/* Build with Code — the rule blocks as editable Python, plus the
              copilot. Mounted only while selected: it compiles on mount and
              there is no reason to pay for that from the Manual tab. */}
          {tab === 'code' && (
            <div style={{ marginBottom: 16 }}>
              <StrategyCodePanel
                rules={{ buy: def.buy, sell: def.sell }}
                name={def.name || 'strategy'}
                code={def.code}
                useCode={def.useCode}
                setup={def.setup}
                onChange={(patch: { code?: string; useCode?: boolean; setup?: StrategySetup }) => u(patch)} />
            </div>
          )}

          <div style={{ display: tab === 'manual' ? 'block' : 'none' }}>

          {/* Logic legend — make the ALL/ANY nesting explicit */}
          <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 14 }}>
            Each <span style={{ color: T.muted }}>group</span> matches <span style={{ color: T.muted }}>ALL</span> or <span style={{ color: T.muted }}>ANY</span> of its conditions; a block fires when <span style={{ color: T.muted }}>ALL</span> or <span style={{ color: T.muted }}>ANY</span> of its groups match. Add a second group to combine signals with different logic.
          </div>

          {/* Default rules label */}
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, fontFamily: T.mono, marginBottom: 8 }}>
            Default rules{(def.perTicker?.length ?? 0) > 0 ? ' (tickers without their own rules below)' : ''}
          </div>

          {/* ENTER block */}
          <RuleBlockEditor
            label="Enter"
            block={def.buy}
            onChange={buy => u({ buy })}
            accentColor={T.pos}
            isBuy
          />

          {/* EXIT block — closes the position; it never picks a direction.
              Long/short is set separately wherever this strategy is run
              (backtester/paper trading each have their own side control). */}
          <RuleBlockEditor
            label="Exit"
            block={def.sell}
            onChange={sell => u({ sell })}
            accentColor={T.neg}
            isBuy={false}
          />
          <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginTop: -8, marginBottom: 16, lineHeight: 1.5 }}>
            Checked in order: Stop-Loss → Take-Profit → Trailing Stop → Max Hold → Exit rule. The first one to trigger
            closes the position (Exit % below controls how much of it). Direction (long/short) is set separately,
            outside this builder — Enter opens more in that direction, Exit always reduces it.
          </div>

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
                <RuleBlockEditor label="Enter" block={entry.buy} onChange={buy => updateTickerRule(entry.id, { buy })} accentColor={T.pos} isBuy />
                <RuleBlockEditor label="Exit" block={entry.sell} onChange={sell => updateTickerRule(entry.id, { sell })} accentColor={T.neg} isBuy={false} />
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
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)', gap: 8 }}>
              {([
                ['Position Size %', 'sizingPct', 5, 0, Infinity],
                ['Stop-Loss %', 'stopLossPct', 0.5, 0, Infinity],
                ['Take-Profit %', 'takeProfitPct', 0.5, 0, Infinity],
                ['Trailing Stop %', 'trailingStopPct', 0.5, 0, Infinity],
                ['Max Hold (bars)', 'maxHoldBars', 1, 0, Infinity],
                ['Exit closes %', 'exitPct', 5, 1, 100],
                ['Delta Exit', 'deltaExit', 0.05, 0, 1],
                ['Gamma Exit', 'gammaExit', 0.005, 0, 1],
                ['Leverage (x)', 'leverage', 0.5, 1, Infinity],
                ['Borrowing EAR %', 'effectiveAnnualRate', 0.5, 0, 100],
              ] as [string, keyof StrategyRisk, number, number, number][]).map(([label, key, step, min, max]) => (
                <div key={key}>
                  <label style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, display: 'block', marginBottom: 3, fontFamily: T.mono }}>{label}</label>
                  <input type="number" min={min} max={max === Infinity ? undefined : max} step={step} value={(def.risk ?? DEFAULT_RISK)[key]}
                    onChange={e => u({ risk: { ...(def.risk ?? DEFAULT_RISK), [key]: Math.min(max, Math.max(min, +e.target.value)) } })}
                    style={{ width: '100%', boxSizing: 'border-box', background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 11, padding: '5px 6px', outline: 'none' }} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginTop: 5 }}>
              0 disables a control. Position size caps the % of capital committed per trade. Exit closes % is how much of the position the Exit rule closes each time it fires — 100 (default) closes all of it; a lower value trims it instead, and a still-true Exit rule keeps trimming the remainder. Delta Exit / Gamma Exit apply only to option/combo instruments — they close a lot in full once its net delta/gamma (0-1 scale, direction-agnostic — how far ITM or how fast it's curving) reaches the threshold, using the same modeled Black-Scholes pricing already used for P&L. Stop-Loss/Take-Profit/Trailing Stop/Max Hold/Delta/Gamma always close the position in full regardless of the Exit closes % setting. Leverage (1x minimum, no ceiling) multiplies that notional; borrowing EAR charges daily-compounded interest on the portion above 100% of capital. Uncapped leverage means a modest adverse move can wipe the position out entirely — see the tooltip on the leverage field.
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
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          padding: '12px 18px', borderTop: `1px solid ${T.border}`,
          background: T.surface, flexShrink: 0,
        }}>
          {aiAssistantOwnsSave ? <>
            <span style={{ marginRight: 'auto', alignSelf: 'center', color: T.dim, fontSize: 8, fontFamily: T.mono }}>
              Use the gold Apply button in the AI draft to update the strategy.
            </span>
            <button onClick={() => { reset(); onClose() }} style={{ ...btn, padding: '6px 16px' }}>
              Close
            </button>
          </> : <>
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
          </>}
        </div>
      </div>
    </div>
  )
}
