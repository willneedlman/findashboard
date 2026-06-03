import { useState, useCallback } from 'react'
import type { Layout } from 'react-grid-layout'

// ── Widget types ─────────────────────────────────────────────────────────────

export type WidgetType =
  | 'price-card'
  | 'mini-chart'
  | 'news-feed'
  | 'watchlist'
  | 'macro-strip'
  | 'earnings-calendar'
  | 'options-snapshot'
  | 'portfolio-summary'
  | 'options-pricer'
  | 'delta-target'
  | 'tradingview-chart'
  | 'correlation-matrix'

export interface WidgetConfig {
  id: string
  type: WidgetType
  title?: string
  // type-specific config
  ticker?: string
  tickers?: string[]
  period?: '1mo' | '3mo' | '6mo' | '1y'
  color?: string
  weights?: number[]
}

export interface StoredDashboard {
  version: 1
  widgets: WidgetConfig[]
  layouts: Layout[]
}

// ── Default sizes per widget type ────────────────────────────────────────────

export const WIDGET_DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  'price-card':          { w: 3, h: 7 },
  'mini-chart':          { w: 5, h: 4 },
  'news-feed':           { w: 4, h: 5 },
  'watchlist':           { w: 5, h: 5 },
  'macro-strip':         { w: 12, h: 2 },
  'earnings-calendar':   { w: 4, h: 5 },
  'options-snapshot':    { w: 4, h: 4 },
  'portfolio-summary':   { w: 6, h: 3 },
  'options-pricer':      { w: 4, h: 5 },
  'delta-target':        { w: 4, h: 5 },
  'tradingview-chart':   { w: 8, h: 8 },
  'correlation-matrix':  { w: 5, h: 6 },
}

export const WIDGET_LABELS: Record<WidgetType, string> = {
  'price-card':          'Price Card',
  'mini-chart':          'Mini Chart',
  'news-feed':           'News Feed',
  'watchlist':           'Watchlist',
  'macro-strip':         'Macro Strip',
  'earnings-calendar':   'Earnings Calendar',
  'options-snapshot':    'Options Snapshot',
  'portfolio-summary':   'Portfolio Summary',
  'options-pricer':      'Options Pricer',
  'delta-target':        'Delta Price Target',
  'tradingview-chart':   'TradingView Chart',
  'correlation-matrix':  'Correlation Matrix',
}

export const WIDGET_DESCRIPTIONS: Record<WidgetType, string> = {
  'price-card':          'Full TradingView candlestick chart with toolbar, drawing tools & indicators. Shows live price, day change, annualised volatility and max drawdown in the header.',
  'mini-chart':          'Compact price area chart over a configurable lookback period (1 mo – 1 yr) with tooltip and right-side price axis.',
  'news-feed':           'Multi-ticker news wire. Each ticker gets its own collapsible section — open/close individually or all at once.',
  'watchlist':           'Live price table for a custom list of tickers — shows price, day change % and volume at a glance.',
  'macro-strip':         'Configurable macro dashboard: pick any combination of Fed Funds, Treasury yields (1Y–30Y), 2/10 and 5/30 curve spreads.',
  'earnings-calendar':   'Upcoming earnings dates with implied move %, analyst consensus rating, and horizon badge for each ticker.',
  'options-snapshot':    'IV rank, IV percentile and put/call ratio for a single ticker — key inputs for options strategy selection.',
  'portfolio-summary':   'Backtest summary for a custom basket: enter tickers + weights to see cumulative return, Sharpe, and max drawdown.',
  'options-pricer':      'Live Black-Scholes pricer: calculates theoretical price, delta, gamma, theta, vega and rho in real time.',
  'delta-target':        'Reverse Black-Scholes solver — enter a target delta to find the corresponding strike price.',
  'tradingview-chart':   'Full-screen TradingView advanced chart: candlesticks, 100+ built-in indicators, drawing tools, multi-timeframe (1 m – 1 W), symbol search.',
  'correlation-matrix':  'Rolling return correlation heatmap for a custom basket — instantly spots diversification gaps and cluster risk across up to 12 tickers.',
}

export const WIDGET_ICONS: Record<WidgetType, string> = {
  'price-card':          '$',
  'mini-chart':          '~',
  'news-feed':           'N',
  'watchlist':           'W',
  'macro-strip':         '%',
  'earnings-calendar':   'E',
  'options-snapshot':    'O',
  'portfolio-summary':   'P',
  'options-pricer':      'BS',
  'delta-target':        'D',
  'tradingview-chart':   'TV',
  'correlation-matrix':  'ρ',
}

// ── Default widgets ───────────────────────────────────────────────────────────
//
// Layout (12-col grid, rowHeight=60, margin=10):
//
//  y=0  [============ MACRO STRIP (12×2) ============]
//  y=2  [ TV CHART — NVDA (8×9)  ] [ WATCHLIST (4×5) ]
//  y=7  [                        ] [ NEWS — NVDA (4×4)]
//  y=11 [ SPY (3×6) ][ NVDA (3×6) ][ BTC (3×6) ][ EARNINGS (3×6) ]

const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'w1', type: 'macro-strip' },
  { id: 'w2', type: 'tradingview-chart', ticker: 'NVDA' },
  { id: 'w3', type: 'watchlist',   tickers: ['NVDA','AAPL','MSFT','AMZN','META','GOOGL','TSLA'] },
  { id: 'w4', type: 'news-feed',   tickers: ['NVDA', 'SPY', 'AAPL'] },
  { id: 'w5', type: 'price-card',  ticker: 'SPY' },
  { id: 'w6', type: 'price-card',  ticker: 'NVDA' },
  { id: 'w7', type: 'price-card',  ticker: 'BTC-USD' },
  { id: 'w8', type: 'earnings-calendar', tickers: ['NVDA','AAPL','MSFT','AMZN','META','GOOGL'] },
]

const DEFAULT_LAYOUTS: Layout[] = [
  { i: 'w1', x: 0, y: 0,  w: 12, h: 2 },
  { i: 'w2', x: 0, y: 2,  w: 8,  h: 9, minH: 6, minW: 3 },
  { i: 'w3', x: 8, y: 2,  w: 4,  h: 5 },
  { i: 'w4', x: 8, y: 7,  w: 4,  h: 4 },
  { i: 'w5', x: 0, y: 11, w: 3,  h: 6, minH: 6, minW: 3 },
  { i: 'w6', x: 3, y: 11, w: 3,  h: 6, minH: 6, minW: 3 },
  { i: 'w7', x: 6, y: 11, w: 3,  h: 6, minH: 6, minW: 3 },
  { i: 'w8', x: 9, y: 11, w: 3,  h: 6 },
]

// ── Size constraints ─────────────────────────────────────────────────────────
// TradingView embed needs ≥400px. rowHeight=60, margin=10 → height = 70h-10.
// minH=6 → 410px. minW=3 → prevents the toolbar from collapsing to unusable.

const TV_TYPES: WidgetType[] = ['tradingview-chart', 'price-card']
const TV_MIN_H = 6
const TV_MIN_W = 3

function applyConstraints(widgets: WidgetConfig[], layouts: Layout[]): Layout[] {
  return layouts.map(item => {
    const widget = widgets.find(w => w.id === item.i)
    if (!widget || !TV_TYPES.includes(widget.type)) return item
    return {
      ...item,
      minH: TV_MIN_H,
      minW: TV_MIN_W,
      h: Math.max(item.h, TV_MIN_H),
      w: Math.max(item.w, TV_MIN_W),
    }
  })
}

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'finance-terminal-dashboard-v2'

function load(): StoredDashboard {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StoredDashboard
      if (parsed.version === 1 && parsed.widgets && parsed.layouts) {
        return {
          ...parsed,
          layouts: applyConstraints(parsed.widgets, parsed.layouts),
        }
      }
    }
  } catch { /* ignore */ }
  return { version: 1, widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS }
}

function save(d: StoredDashboard) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)) } catch { /* ignore */ }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboard() {
  const [state, setState] = useState<StoredDashboard>(load)

  const persist = useCallback((next: StoredDashboard) => {
    setState(next)
    save(next)
  }, [])

  const addWidget = useCallback((type: WidgetType, config: Partial<WidgetConfig> = {}) => {
    const id = `w${Date.now()}`
    const def = WIDGET_DEFAULT_SIZE[type]
    const newWidget: WidgetConfig = { id, type, ...config }
    const newLayout: Layout = { i: id, x: 0, y: Infinity, w: def.w, h: def.h }
    const nextWidgets = [...state.widgets, newWidget]
    persist({
      version: 1,
      widgets: nextWidgets,
      layouts: applyConstraints(nextWidgets, [...state.layouts, newLayout]),
    })
  }, [state, persist])

  const removeWidget = useCallback((id: string) => {
    persist({
      version: 1,
      widgets: state.widgets.filter(w => w.id !== id),
      layouts: state.layouts.filter(l => l.i !== id),
    })
  }, [state, persist])

  const updateWidget = useCallback((id: string, patch: Partial<WidgetConfig>) => {
    persist({
      version: 1,
      widgets: state.widgets.map(w => w.id === id ? { ...w, ...patch } : w),
      layouts: state.layouts,
    })
  }, [state, persist])

  const updateLayouts = useCallback((layouts: readonly Layout[]) => {
    persist({ version: 1, widgets: state.widgets, layouts: applyConstraints(state.widgets, [...layouts]) })
  }, [state, persist])

  const resetDashboard = useCallback(() => {
    persist({ version: 1, widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS })
  }, [persist])

  return { widgets: state.widgets, layouts: state.layouts, addWidget, removeWidget, updateWidget, updateLayouts, resetDashboard }
}
