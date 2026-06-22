import { useState, useMemo, useEffect } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../../components/PageWrapper'
import SidebarLayout from '../../components/SidebarLayout'
import ExpirySelect from '../../components/ExpirySelect'
import axios from 'axios'
import { TOOLTIP_STYLE, TICK, RailSection } from '../valuationShared'

export interface Leg {
  option_type: 'call' | 'put'
  action:      'buy' | 'sell'
  K: number; premium: number; quantity: number
  ticker: string
  expiry: string
}

export interface GreekPos {
  ticker: string; strike: number; expiry: string; dte: number; spot: number
  option_type: string; position_type: string; qty: number
  delta: number; gamma: number; theta: number; vega: number
  scaled_delta: number; scaled_gamma: number; scaled_theta: number; scaled_vega: number
}
export interface GreekResult {
  positions: GreekPos[]
  net: { delta: number; gamma: number; theta: number; vega: number }
}

export const DEFAULT_TICKER  = 'SPY'
export const DEFAULT_EXPIRY  = (() => {
  const d = new Date(); d.setMonth(d.getMonth() + 2); return d.toISOString().slice(0, 10)
})()
export const mk = (type: Leg['option_type'], action: Leg['action'], K: number, premium: number, qty = 1): Leg =>
  ({ option_type: type, action, K, premium, quantity: qty, ticker: DEFAULT_TICKER, expiry: DEFAULT_EXPIRY })

// Round to nearest options strike increment based on spot price
export function roundToStrike(k: number, spot: number): number {
  const inc = spot >= 500 ? 5 : spot >= 100 ? 2.5 : spot >= 20 ? 1 : 0.5
  return Math.round(k / inc) * inc
}

// Scale PRESET strikes (authored around spot=100) to actual spot
export function scalePreset(legs: Leg[], spot: number): Leg[] {
  if (!spot || spot <= 0) return legs
  return legs.map(l => ({ ...l, K: roundToStrike((l.K / 100) * spot, spot) }))
}

export const GREEK_COLORS: Record<string, string> = {
  delta: 'var(--theme-tertiary)', gamma: 'var(--theme-positive)', theta: 'var(--theme-negative)', vega: '#a78bfa',
}

export const PRESETS: Record<string, Leg[]> = {
  // Single Leg
  'Long Call':          [mk('call', 'buy',  100, 3)],
  'Long Put':           [mk('put',  'buy',  100, 3)],
  'Short Put':          [mk('put',  'sell',  95, 2)],
  'Short Call':         [mk('call', 'sell', 105, 2)],
  // Vertical Spreads
  'Bull Call Spread':   [mk('call', 'buy',  95, 6),  mk('call', 'sell', 105, 2)],
  'Bear Put Spread':    [mk('put',  'buy', 105, 6),  mk('put',  'sell',  95, 2)],
  'Bull Put Spread':    [mk('put',  'sell', 100, 4), mk('put',  'buy',   90, 1.5)],
  'Bear Call Spread':   [mk('call', 'sell', 100, 4), mk('call', 'buy',  110, 1.5)],
  // Volatility
  'Long Straddle':      [mk('call', 'buy',  100, 3), mk('put',  'buy',  100, 3)],
  'Long Strangle':      [mk('put',  'buy',   90, 1.5), mk('call', 'buy', 110, 1.5)],
  'Short Straddle':     [mk('call', 'sell', 100, 3), mk('put',  'sell', 100, 3)],
  'Short Strangle':     [mk('put',  'sell',  90, 1.5), mk('call', 'sell', 110, 1.5)],
  // Butterfly
  'Call Butterfly':     [mk('call', 'buy',   90, 8), mk('call', 'sell', 100, 3, 2), mk('call', 'buy',  110, 1)],
  'Put Butterfly':      [mk('put',  'buy',  110, 8), mk('put',  'sell', 100, 3, 2), mk('put',  'buy',   90, 1)],
  'Iron Butterfly':     [mk('put',  'buy',   85, 0.5), mk('put',  'sell', 100, 3), mk('call', 'sell', 100, 3), mk('call', 'buy',  115, 0.5)],
  // Condor
  'Iron Condor':        [mk('put',  'buy',   85, 1), mk('put',  'sell',  90, 2), mk('call', 'sell', 110, 2), mk('call', 'buy',  115, 1)],
  'Long Condor':        [mk('call', 'buy',   90, 8), mk('call', 'sell',  95, 5), mk('call', 'sell', 105, 2), mk('call', 'buy',  110, 1)],
  'Rev. Iron Condor':   [mk('put',  'sell',  85, 1), mk('put',  'buy',   90, 2), mk('call', 'buy',  110, 2), mk('call', 'sell', 115, 1)],
  // Ratio / Advanced
  'Call Ratio 1x2':     [mk('call', 'buy',  100, 3), mk('call', 'sell', 110, 1.5, 2)],
  'Risk Reversal':      [mk('put',  'sell',  95, 2), mk('call', 'buy',  105, 2)],
  'Jade Lizard':        [mk('put',  'sell',  90, 1.5), mk('call', 'sell', 110, 1.5), mk('call', 'buy', 115, 0.75)],
  'Synthetic Long':     [mk('call', 'buy',  100, 3), mk('put',  'sell', 100, 3)],
}

export const PRESET_DESC: Record<string, string> = {
  'Long Call':         'Bullish. Unlimited upside, capped loss at premium paid.',
  'Long Put':          'Bearish. Profit as price falls, max loss is premium.',
  'Short Put':         'Bullish/neutral. Collect premium; obligated to buy at strike if assigned.',
  'Short Call':        'Bearish/neutral. Collect premium; unlimited risk if price rises.',
  'Bull Call Spread':  'Debit spread. Capped bull play — lower cost, lower max gain.',
  'Bear Put Spread':   'Debit spread. Profit from decline; cost and gain are capped.',
  'Bull Put Spread':   'Credit spread. Keep premium if stock stays above short strike.',
  'Bear Call Spread':  'Credit spread. Keep premium if stock stays below short strike.',
  'Long Straddle':     'Profit from big move either direction. Needs volatility.',
  'Long Strangle':     'Cheaper straddle. Needs larger move; lower premium at risk.',
  'Short Straddle':    'Sell ATM call + put. Max income if price pins at strike.',
  'Short Strangle':    'Sell OTM call + put. Wider profit zone than short straddle.',
  'Call Butterfly':    'Profit if price pins near middle strike. Low cost, capped.',
  'Put Butterfly':     'Same payoff as call butterfly but constructed with puts.',
  'Iron Butterfly':    'Short straddle with wings. Defined risk version of short straddle.',
  'Iron Condor':       'Range-bound income. Max profit if price stays between short strikes.',
  'Long Condor':       'Profit if price lands in middle zone. Lower cost than butterfly.',
  'Rev. Iron Condor':  'Long strangle with short wings. Profit from large move, defined risk.',
  'Call Ratio 1x2':    'Mildly bullish. Profit window above long strike; risk if underlying surges.',
  'Risk Reversal':     'Synthetic long exposure. Bullish with minimal net premium.',
  'Jade Lizard':       'Short OTM put + short call spread. No upside loss; income in range.',
  'Synthetic Long':    'Replicates long stock. Unlimited upside and downside from ATM.',
}

export const PRESET_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Single Leg',        keys: ['Long Call', 'Long Put', 'Short Put', 'Short Call'] },
  { label: 'Vertical Spreads',  keys: ['Bull Call Spread', 'Bear Put Spread', 'Bull Put Spread', 'Bear Call Spread'] },
  { label: 'Volatility',        keys: ['Long Straddle', 'Long Strangle', 'Short Straddle', 'Short Strangle'] },
  { label: 'Butterfly',         keys: ['Call Butterfly', 'Put Butterfly', 'Iron Butterfly'] },
  { label: 'Condor',            keys: ['Iron Condor', 'Long Condor', 'Rev. Iron Condor'] },
  { label: 'Ratio / Advanced',  keys: ['Call Ratio 1x2', 'Risk Reversal', 'Jade Lizard', 'Synthetic Long'] },
]

export const LEG_COLORS = ['#1f5673', '#7b5ea7', '#d97736', '#2f6b4b', '#8c2e36']

export const LS_KEY = 'ft_pending_option_strategy'

export function toOCC(ticker: string, expiry: string, type: 'call' | 'put', strike: number): string {
  const d = new Date(expiry + 'T12:00:00')
  const yy = String(d.getFullYear()).slice(2).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const cp = type === 'call' ? 'C' : 'P'
  const stk = String(Math.round(strike * 1000)).padStart(8, '0')
  return `${ticker.toUpperCase()}${yy}${mm}${dd}${cp}${stk}`
}

export interface PendingOptionStrategy {
  name: string
  underlying: string
  orderType: 'debit' | 'credit' | 'market'
  legs: { occ: string; side: 'buy_to_open' | 'sell_to_open'; qty: string; hint: string }[]
  savedAt: number
}
export const INPUT:  React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '4px 7px', outline: 'none' }
export const SELECT: React.CSSProperties = { ...INPUT, cursor: 'pointer' }

export interface LegChain {
  expiries:       string[]
  selectedExpiry: string
  calls:          any[]
  puts:           any[]
  spot:           number | null
  loading:        boolean
}

export function fmtExpiry(exp: string): string {
  const d = new Date(exp + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Pure intrinsic payoff at expiry — no Black-Scholes needed
export function intrinsic(S: number, leg: Leg): number {
  const val = leg.option_type === 'call' ? Math.max(S - leg.K, 0) : Math.max(leg.K - S, 0)
  const sign = leg.action === 'buy' ? 1 : -1
  return sign * (val - leg.premium) * leg.quantity * 100
}
