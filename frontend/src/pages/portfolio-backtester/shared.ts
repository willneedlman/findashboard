import { useState, useMemo, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from 'recharts'
import PageWrapper from '../../components/PageWrapper'
import MetricCard from '../../components/MetricCard'
import { useChartColors } from '../../hooks/useChartColors'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../../components/StrategySelector'
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
import { weightTotal, normalizeTo100 } from '../../components/portfolio/weights'
import HelpTip from '../../components/HelpTip'

// ── Shared ──────────────────────────────────────────────────────────────────

export const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  background: 'var(--theme-surface, #0d1826)',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
  marginBottom: 0,
  flexShrink: 0,
}

export const TAB_BASE: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '10px 20px',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  borderBottom: '2px solid transparent',
  transition: 'color 0.15s, border-color 0.15s',
}

export type Tab = 'portfolio' | 'strategy'

// ── Portfolio tab types & constants ─────────────────────────────────────────

export type Asset = {
  ticker: string
  weight: number
  strategy: string
  stratParams: StrategyParams
  // Multi-leg options combo instead of the plain equity position (Custom Rule
  // strategy only — the combo's own entry/exit is driven by the same rules,
  // so it replaces rather than layers on top of the sl/tp/trail overlay).
  instMode?: 'underlying' | 'combo'
  comboPreset?: string
  comboDte?: number
}

export const makeAsset = (ticker: string, weight: number): Asset => ({
  ticker, weight, strategy: STRATEGIES[0], stratParams: {},
  instMode: 'underlying', comboPreset: 'Short Straddle', comboDte: 30,
})

export const PORT_DEFAULTS: Asset[] = [
  makeAsset('MSFT', 40),
  makeAsset('AAPL', 30),
  makeAsset('GOOGL', 20),
  makeAsset('AMZN', 10),
]

export const PORT_INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}

export const PORT_LABEL: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)',
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}

export const PORT_TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

// ── Strategy tab types & constants ───────────────────────────────────────────

export const ALGO_STRATEGIES = [
  { value: 'rsi_mean_reversion',  label: 'RSI Mean Reversion' },
  { value: 'ma_crossover',        label: 'MA Crossover' },
  { value: 'bollinger_breakout',  label: 'Bollinger Breakout' },
  { value: 'momentum',            label: 'Momentum' },
  { value: 'macd_crossover',      label: 'MACD Crossover' },
  { value: 'value_pe',            label: 'Value — P/E' },
  { value: 'earnings_momentum',   label: 'Earnings Growth' },
  { value: 'micro_scalp',         label: 'EMA Micro-Scalp (3/8)' },
]

export const ALGO_DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  rsi_mean_reversion:  { period: 14, oversold: 30, overbought: 70 },
  ma_crossover:        { fast: 20, slow: 50 },
  bollinger_breakout:  { period: 20, std_dev: 2.0 },
  momentum:            { lookback: 20 },
  macd_crossover:      { fast: 12, slow: 26, signal: 9 },
  value_pe:            { pe_in_threshold: 35 },
  earnings_momentum:   { exit_threshold_pct: -5 },
  micro_scalp:         { ema_fast: 3, ema_slow: 8, atr_period: 5, atr_mult: 0.3 },
}

export const ALGO_PARAM_LABELS: Record<string, Record<string, string>> = {
  rsi_mean_reversion:  { period: 'Period', oversold: 'Oversold', overbought: 'Overbought' },
  ma_crossover:        { fast: 'Fast MA', slow: 'Slow MA' },
  bollinger_breakout:  { period: 'Period', std_dev: 'Std Dev' },
  momentum:            { lookback: 'Lookback Days' },
  macd_crossover:      { fast: 'Fast EMA', slow: 'Slow EMA', signal: 'Signal EMA' },
  value_pe:            { pe_in_threshold: 'P/E Exit Threshold' },
  earnings_momentum:   { exit_threshold_pct: 'EPS Exit %' },
  micro_scalp:         { ema_fast: 'Fast EMA', ema_slow: 'Slow EMA', atr_period: 'ATR Period', atr_mult: 'Min ATR %' },
}

export const ALGO_INPUT: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)',
  fontSize: 12,
  padding: '5px 8px',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
}

export const ALGO_LABEL: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--theme-secondary, #5e768f)',
  marginBottom: 4,
  display: 'block',
}

export const ALGO_TICK = { fontSize: 9, fill: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-mono)' }

export const ALGO_SECTION_DIVIDER: React.CSSProperties = {
  borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))',
  marginTop: 14,
  paddingTop: 14,
}

export type BacktestResult = {
  equity_curve: { date: string; strategy: number; benchmark: number }[]
  metrics: {
    total_return: number
    ann_return: number
    max_drawdown: number
    sharpe: number
    num_trades: number
    win_rate: number
    initial_capital: number
    final_capital: number
    total_pnl: number
  }
  trades: { date: string; action: string; price: number }[]
}

export type SignalResult = {
  signal: 'BUY' | 'SELL' | 'HOLD'
  value: number
  description: string
}
