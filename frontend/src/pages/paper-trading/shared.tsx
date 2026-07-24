// Shared declarations for the Paper Trading page: types, theme tokens,
// formatting helpers and static catalogues extracted from PaperTrading.tsx so
// the page module carries components and orchestration, not boilerplate.
import * as React from 'react'
import { useTheme } from '../../contexts/ThemeContext'

// Per-user auth for the paper engine: the current account id + session-token
// headers. Paper trading is now each user's own book, so every call is owner-gated.
export function useAuth() {
  const { user } = useTheme()
  const token = typeof window !== 'undefined' ? (localStorage.getItem('ft-session-token') || '') : ''
  return {
    uid: user?.id || '',
    authed: !!user?.id && !!token,
    headers: { headers: { Authorization: `Bearer ${token}`, 'x-session-token': token } },
  }
}

// Adapt the per-user engine's account response to the shape this page renders.
export function adaptAccount(d: any): AccountData {
  const positions = [
    ...(d?.positions ?? []).map((p: any) => ({ symbol: p.symbol, quantity: p.quantity, cost_basis: p.avg_cost * p.quantity, date_acquired: '', multiplier: p.multiplier, margin: p.margin })),
    ...(d?.option_positions ?? []).map((p: any) => ({ symbol: p.option_symbol, quantity: p.quantity, cost_basis: p.avg_cost * p.quantity, date_acquired: '' })),
  ]
  const orders = (d?.orders ?? []).map((o: any) => ({
    id: o.id, type: o.order_type, symbol: o.option_symbol || o.symbol, side: o.side,
    quantity: o.quantity, status: o.status, price: o.limit_price ?? o.stop_price ?? undefined,
    avg_fill_price: o.fill_price ?? undefined, create_date: o.created_at ? new Date(o.created_at * 1000).toISOString() : '',
  }))
  return {
    balances: { cash: d?.cash ?? 0, market_value: (d?.equity ?? 0) - (d?.cash ?? 0), equity: d?.equity ?? 0,
                buying_power: d?.buying_power ?? 0, total_equity: d?.equity ?? 0, day_change: 0 },
    positions, orders,
  }
}

// ─── Theme tokens ────────────────────────────────────────────────────────────
export const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #142032)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  pos:     'var(--theme-positive)',
  neg:     'var(--theme-negative)',
  warn:    'var(--theme-warn)',
  dim:     'var(--theme-text-muted, var(--theme-text-muted, rgba(215,227,252,0.35)))',
}

// ─── Shared element styles ────────────────────────────────────────────────────
export const inp: React.CSSProperties = {
  background: T.bg,
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: T.text,
  fontFamily: T.mono,
  fontSize: 12,
  padding: '6px 9px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

export const sel: React.CSSProperties = {
  ...inp,
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235e768f'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 8px center',
  paddingRight: 26,
}

export const lbl: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.13em',
  textTransform: 'uppercase' as const,
  color: T.muted,
  display: 'block',
  marginBottom: 4,
  fontFamily: T.mono,
}

export const PT_LS_KEY = 'ft_pending_option_strategy'

export interface PendingOptionStrategy {
  name: string; underlying: string; orderType: 'debit' | 'credit' | 'market'
  legs: { occ: string; side: 'buy_to_open' | 'sell_to_open'; qty: string; hint: string }[]
  savedAt: number
}

export const sectionHeader = (label: string, badge?: string | number): React.ReactNode => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px',
    borderBottom: `1px solid ${T.border}`,
    background: T.surface,
  }}>
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: T.gold, fontFamily: T.mono }}>
      {label}
    </span>
    {badge !== undefined && (
      <span style={{
        fontSize: 9, fontWeight: 700, padding: '1px 6px',
        background: 'color-mix(in srgb, var(--theme-primary) 15%, transparent)', color: T.gold,
        border: `1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)`,
        fontFamily: T.mono,
      }}>
        {badge}
      </span>
    )}
  </div>
)

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Balances {
  cash: number
  market_value: number
  equity: number
  buying_power: number
  total_equity: number
  day_change: number
}

export interface Position {
  symbol: string
  quantity: number
  cost_basis: number
  date_acquired: string
  multiplier?: number   // futures contract multiplier (USD per 1.0 price move); absent for equities
  margin?: number       // futures posted margin; P&L % is return on this (leveraged)
}

export interface Order {
  id: string
  type: string
  symbol: string
  side: string
  quantity: number
  status: string
  price?: number
  avg_fill_price?: number
  create_date: string
}

export interface AccountData {
  balances: Balances
  positions: Position[]
  orders: Order[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function fmt$(v: number | null | undefined) {
  if (v == null || isNaN(v as number)) return '—'
  return (v as number).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}

export function fmtDate(s: string) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) }
  catch { return s }
}

export function statusColor(status: string) {
  switch (status?.toLowerCase()) {
    case 'filled':    return T.pos
    case 'pending':
    case 'open':
    case 'partially_filled': return T.gold
    case 'canceled':
    case 'cancelled':
    case 'expired':   return T.dim
    case 'rejected':  return T.neg
    default:          return T.muted
  }
}
// ─── Builtin strategy metadata catalogue (mirrors backend builtins) ──────────
export const BUILTIN_STRATEGY_INFO: Record<string, {
  label: string; help: string; usedIn: ('backtester' | 'montecarlo')[]
  backtesterKey?: string; montecarloKey?: string
}> = {
  rsi_mean_reversion: {
    label: 'RSI Mean Reversion',
    help: 'Computes RSI(14). Buys when RSI crosses above the oversold threshold (30), signalling a potential bounce. Sells when RSI crosses below the overbought threshold (70). Best in range-bound, mean-reverting markets. Also used in the Backtester and Monte Carlo drift-adjustment overlay.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'RSI Mean Reversion (14)', montecarloKey: 'RSI Mean Reversion (14)',
  },
  sma_trend_following: {
    label: 'SMA Trend Following',
    help: 'Golden Cross / Death Cross strategy. Buys when the 50-day SMA crosses above the 200-day SMA and price is above both (confirmed uptrend). Sells when both conditions reverse. Trend-following. Performs best in strongly trending markets. Whipsaws in choppy conditions. Also used in Backtester and Monte Carlo as drift adjustment.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'SMA Trend Following (50/200)', montecarloKey: 'SMA Trend Following (50/200)',
  },
  bollinger_breakout: {
    label: 'Bollinger Breakout',
    help: 'Computes a 20-period Bollinger Band (±2σ). Enters long when price closes above the upper band (volatility breakout). Exits when price falls below the lower band. Targets breakout moves. Works well on trending assets. Prone to false signals during consolidation.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'bollinger_breakout', montecarloKey: 'Bollinger Breakout (20,2)',
  },
  momentum: {
    label: '6-Month Momentum',
    help: 'Computes the 126-day (≈6-month) price return. Buys when positive momentum (price higher than 6 months ago), sells when it turns negative. One of the most robust documented equity anomalies. Tends to underperform after sudden market reversals. Also used in Backtester and Monte Carlo.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'momentum', montecarloKey: '6-Month Price Momentum',
  },
  macd_crossover: {
    label: 'MACD Crossover',
    help: 'Moving Average Convergence Divergence. Computes EMA(12) − EMA(26) = MACD line, and EMA(9) of it = signal line. Buys when MACD crosses above the signal line (bullish momentum shift). Sells on cross below. Combines trend and momentum. Lags at turning points. Strong in trending environments.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'macd_crossover', montecarloKey: 'MACD Crossover (12,26,9)',
  },
  value_pe: {
    label: 'Value P/E',
    help: 'Fundamental value strategy. Fetches trailing P/E at session start. Buys when P/E < fair-value threshold (stock is cheap), sells when P/E exceeds the expensive threshold. Holds neutral in between. Note: P/E is static per session. This strategy emits a sustained BUY or SELL signal rather than reacting to price ticks.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'value_pe', montecarloKey: 'Value — Trailing P/E',
  },
  earnings_growth: {
    label: 'Earnings Growth',
    help: 'Fundamental earnings momentum. Fetches quarterly EPS growth at session start. Buys when EPS growth is positive (company is growing earnings), exits when growth falls below the exit threshold. Like Value P/E, this is a session-level signal. Set the ticker param to match your position.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'earnings_momentum', montecarloKey: 'Earnings Growth Momentum',
  },
  gamma_scalping: {
    label: 'Gamma Scalping',
    help: 'IV/RV regime proxy using the short-term (5-day) vs long-term (20-day) realized volatility ratio. Buys when recent volatility expands above the long-term baseline (vol expansion = long gamma regime). Exits when vol compresses below the threshold. Repurposed from the Gamma Scalping simulator. Captures convexity-driven moves without requiring live options data.',
    usedIn: [],
  },
  micro_scalp: {
    label: 'EMA Micro-Scalp (3/8)',
    help: 'Very short-term EMA crossover scalp. Enters when EMA(3) crosses above EMA(8), a fast micro-trend burst. Exits on the reverse cross. Optional ATR filter skips signals when the market is too quiet. Generates frequent round trips. Best on volatile, trending assets.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'micro_scalp', montecarloKey: 'EMA Micro-Scalp (3/8)',
  },
}

// ─── Paper strategy param definitions (mirrors backend initialize() defaults) ─

export const PAPER_DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  rsi_mean_reversion:  { period: 14, oversold: 30, overbought: 70 },
  sma_trend_following: { sma_fast: 50, sma_slow: 200 },
  bollinger_breakout:  { period: 20, std_dev: 2.0 },
  momentum:            { lookback_days: 126, threshold_pct: 0 },
  macd_crossover:      { ema_fast: 12, ema_slow: 26, signal_period: 9 },
  value_pe:            { pe_deep_value: 12, pe_fair_value: 20, pe_expensive: 35, pe_very_expensive: 50 },
  earnings_growth:     { exit_threshold_pct: -5 },
  gamma_scalping:      { short_window: 5, long_window: 20, entry_ratio: 1.3, exit_ratio: 0.8 },
  micro_scalp:         { ema_fast: 3, ema_slow: 8, atr_period: 5, atr_mult: 0.3 },
}

export const PAPER_PARAM_LABELS: Record<string, Record<string, string>> = {
  rsi_mean_reversion:  { period: 'Period', oversold: 'Oversold', overbought: 'Overbought' },
  sma_trend_following: { sma_fast: 'Fast SMA', sma_slow: 'Slow SMA' },
  bollinger_breakout:  { period: 'Period', std_dev: 'Std Dev' },
  momentum:            { lookback_days: 'Lookback', threshold_pct: 'Threshold %' },
  macd_crossover:      { ema_fast: 'Fast EMA', ema_slow: 'Slow EMA', signal_period: 'Signal' },
  value_pe:            { pe_deep_value: 'Deep Value P/E', pe_fair_value: 'Fair Value P/E', pe_expensive: 'Exit P/E', pe_very_expensive: 'Very Exp P/E' },
  earnings_growth:     { exit_threshold_pct: 'Exit EPS %' },
  gamma_scalping:      { short_window: 'Short Window', long_window: 'Long Window', entry_ratio: 'Entry Ratio', exit_ratio: 'Exit Ratio' },
  micro_scalp:         { ema_fast: 'Fast EMA', ema_slow: 'Slow EMA', atr_period: 'ATR Period', atr_mult: 'Min ATR %' },
}

// ─── Strategy Signal Chart ───────────────────────────────────────────────────

export interface ChartPoint { date: string; price: number; buy?: number; sell?: number }

export function computeReplayStats(data: ChartPoint[]) {
  const trades: { entry: number; exit: number }[] = []
  let entryPrice: number | null = null
  for (const pt of data) {
    if (pt.buy != null && entryPrice === null) entryPrice = pt.price
    if (pt.sell != null && entryPrice !== null) {
      trades.push({ entry: entryPrice, exit: pt.price })
      entryPrice = null
    }
  }
  if (trades.length === 0) return null
  const wins = trades.filter(t => t.exit > t.entry).length
  const totalPnlPct = trades.reduce((s, t) => s + (t.exit / t.entry - 1) * 100, 0)
  return {
    pnl: totalPnlPct,
    winRate: (wins / trades.length) * 100,
    trades: trades.length,
  }
}
export const btn: React.CSSProperties = {
  padding: '5px 10px', fontSize: 9, fontFamily: 'var(--theme-mono)', fontWeight: 700,
  letterSpacing: '0.08em', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-primary) 8%, transparent)',
  border: '1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)', color: 'var(--theme-primary, #c9a84c)',
  transition: 'background 0.15s',
}

export const STRATEGY_TEMPLATE = `from strategies.base import Strategy, MarketDataPoint, Signal, StrategyMetadata
from collections import deque
from typing import Any

class MyStrategy(Strategy):
    def initialize(self, params: dict[str, Any]) -> None:
        self._period = int(params.get("period", 14))
        self._prices: deque = deque(maxlen=self._period + 1)

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._prices.append(dp.price)
        if len(self._prices) < self._period + 1:
            return Signal.HOLD
        # ── your logic here ──
        avg = sum(self._prices) / len(self._prices)
        if dp.price > avg * 1.02:
            return Signal.BUY
        if dp.price < avg * 0.98:
            return Signal.SELL
        return Signal.HOLD

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="my_strategy", version="1.0.0",
            author="you", description="Price vs MA crossover",
            parameters={"period": {"type":"int","default":14}},
        )`

export interface StrategyEntry {
  name: string; version: string; author: string; description: string
  parameters: Record<string, unknown>; enabled: boolean; side?: string
}
export interface ReplayEvent { strategy_name: string; timestamp: number; symbol: string; signal: string; price: number }
export interface ReplayResult {
  ticker: string; bars_processed: number
  events: ReplayEvent[]
  summary: Record<string, { BUY: number; SELL: number; HOLD: number }>
}

export interface RiskConfig {
  stop_loss: string
  take_profit: string
  trailing_stop: string
  max_hold: string
}
export const RISK_DEFAULTS: RiskConfig = { stop_loss: '', take_profit: '', trailing_stop: '', max_hold: '' }

export function applyRiskToChart(
  events: ReplayEvent[],
  riskByStrategy: Record<string, RiskConfig>,
  prices: { date: string; value: number }[],
): { date: string; price: number; buy?: number; sell?: number }[] {
  const strategyNames = [...new Set(events.map(e => e.strategy_name))]
  const finalSig: Record<string, 'BUY' | 'SELL'> = {}

  for (const name of strategyNames) {
    const risk = riskByStrategy[name] ?? RISK_DEFAULTS
    const sl   = risk.stop_loss     ? parseFloat(risk.stop_loss)     : null
    const tp   = risk.take_profit   ? parseFloat(risk.take_profit)   : null
    const ts   = risk.trailing_stop ? parseFloat(risk.trailing_stop) : null
    const mh   = risk.max_hold      ? parseInt(risk.max_hold)        : null

    const rawByDate: Record<string, 'BUY' | 'SELL'> = {}
    for (const ev of events.filter(e => e.strategy_name === name)) {
      rawByDate[new Date(ev.timestamp * 1000).toISOString().slice(0, 10)] = ev.signal as 'BUY' | 'SELL'
    }

    let inTrade = false, entryPrice = 0, peak = 0, bars = 0
    for (const bar of prices) {
      const raw = rawByDate[bar.date]
      if (!inTrade) {
        if (raw === 'BUY') {
          inTrade = true; entryPrice = bar.value; peak = bar.value; bars = 0
          finalSig[bar.date] = 'BUY'
        }
      } else {
        bars++; peak = Math.max(peak, bar.value)
        const stopHit  = sl && bar.value <= entryPrice * (1 - sl / 100)
        const tpHit    = tp && bar.value >= entryPrice * (1 + tp / 100)
        const trailHit = ts && bar.value <= peak * (1 - ts / 100)
        const timeHit  = mh && bars >= mh
        if (stopHit || tpHit || trailHit || timeHit || raw === 'SELL') {
          inTrade = false
          finalSig[bar.date] = 'SELL'
        }
      }
    }
  }

  return prices.map(p => ({
    date: p.date, price: p.value,
    buy:  finalSig[p.date] === 'BUY'  ? p.value : undefined,
    sell: finalSig[p.date] === 'SELL' ? p.value : undefined,
  }))
}
// ─── Scheduler interfaces (used by StrategyPanel) ─────────────────────────────

export interface SchedulerStatus {
  scheduler_running: boolean
  market_open: boolean
  poll_interval_s: number
  total_jobs: number
  active_jobs: number
  log_entries: number
}

export interface SchedulerJob {
  id: string
  ticker: string
  strategy_name: string
  params: Record<string, unknown>
  qty: number
  enabled: boolean
  warmed_up: boolean
  last_signal: string | null
  last_price: number | null
  last_run_ts: number | null
  created_at: number
}

export interface SchedulerLogEntry {
  id: string
  job_id: string
  ticker: string
  strategy_name: string
  signal: string
  price: number
  timestamp: number
  order_id: string | null
  notes: string | null
}
