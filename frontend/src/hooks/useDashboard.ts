import { useState, useCallback, useEffect } from 'react'
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
  | 'macro-calendar'
  | 'global-macro'
  | 'credit-spreads'
  | 'yield-curve'

export interface WidgetConfig {
  id: string
  type: WidgetType
  title?: string
  ticker?: string
  tickers?: string[]
  period?: '1mo' | '3mo' | '6mo' | '1y'
  color?: string
  weights?: number[]
  categories?: string[]    // global-macro: selected category keys
  lookback?: number        // credit-spreads: days of history
  chartMode?: 'cumulative' | 'beta'         // portfolio-summary
  periodDays?: number                      // correlation-matrix
  visibleCols?: string[]                   // watchlist
  newsExpand?: 'first' | 'all' | 'none'    // news-feed
  visibleItems?: string[]                  // options-snapshot
  targetDelta?: number                     // delta-target
  expDays?: number                         // delta-target, options-pricer
  optionType?: 'call' | 'put'              // delta-target, options-pricer
  strike?: number                          // options-pricer
  vol?: number                             // options-pricer
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
  'macro-calendar':      { w: 5, h: 9 },
  'global-macro':        { w: 3, h: 9 },
  'credit-spreads':      { w: 4, h: 7 },
  'yield-curve':         { w: 4, h: 7 },
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
  'macro-calendar':      'Macro Calendar',
  'global-macro':        'Global Macro',
  'credit-spreads':      'Credit Spreads',
  'yield-curve':         'Yield Curve',
}

export const WIDGET_DESCRIPTIONS: Record<WidgetType, string> = {
  'price-card':          'Full TradingView candlestick chart with toolbar, drawing tools & indicators.',
  'mini-chart':          'Compact price area chart over a configurable lookback period.',
  'news-feed':           'Multi-ticker news wire with collapsible sections per ticker.',
  'watchlist':           'Live price table — price, day change, market cap, P/E, implied move, rating.',
  'macro-strip':         'Configurable macro dashboard: Fed Funds, Treasury yields, curve spreads.',
  'earnings-calendar':   'Upcoming earnings dates with implied move % and analyst consensus.',
  'options-snapshot':    'ATM IV, implied move, D50 call/put, P/C ratio, vol cone, probability dist.',
  'portfolio-summary':   'Backtest summary: CAGR, alpha, Sharpe, Sortino, max drawdown, rolling beta.',
  'options-pricer':      'Live Black-Scholes pricer: price, delta, gamma, theta, vega.',
  'delta-target':        'Reverse Black-Scholes: find the strike price for a target delta.',
  'tradingview-chart':   'Full-screen TradingView chart: candlesticks, indicators, drawing tools.',
  'correlation-matrix':  'Return correlation heatmap for a custom ticker basket.',
  'macro-calendar':      'Upcoming macro events: FOMC, CPI, NFP, GDP, PPI, Retail Sales — next 90 days.',
  'global-macro':        'Live FX, commodities, bond yields, equity indices and VIX — refreshed every 5 minutes.',
  'credit-spreads':      'BofA ICE IG & HY OAS spreads vs VIX — 90-day sparkline with 1Y change.',
  'yield-curve':         'US Treasury yield curve with 1M/3M/1Y comparisons, key spreads, and 3M/10Y inversion history.',
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
  'macro-calendar':      'CAL',
  'global-macro':        'FX',
  'credit-spreads':      'CR',
  'yield-curve':         'YC',
}

// ── Default layout — all 16 widget types, one each ───────────────────────────
//
// 12-col grid, rowHeight=60px:
//
//  y=0   [══════════════════ MACRO STRIP (12×2) ═══════════════════════════]
//  y=2   [ TV CHART NVDA (8×9)              ][ WATCHLIST (4×5)            ]
//        [                                  ][ NEWS FEED  (4×4)           ]
//  y=11  [ GLOBAL MACRO (3×9) ][ MACRO CAL (5×9) ][ CREDIT SPREADS (4×9) ]
//  y=20  [ CORR MATRIX (4×6)  ][ MINI CHART (4×6)][ EARNINGS CAL  (4×6)  ]
//  y=26  [ YIELD CURVE (4×7)  ][ OPT SNAP   (4×7)][ PRICE CARD    (4×7)  ]
//  y=33  [ PORTFOLIO   (4×5)  ][ OPT PRICER (4×5)][ DELTA TARGET  (4×5)  ]

export const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'w1',  type: 'macro-strip' },
  { id: 'w2',  type: 'tradingview-chart',  ticker: 'NVDA' },
  { id: 'w3',  type: 'watchlist',          tickers: ['SPY','NVDA','AAPL','MSFT','AMZN','META','TSLA','GOOGL'] },
  { id: 'w4',  type: 'news-feed',          tickers: ['NVDA','SPY','AAPL'] },
  { id: 'w5',  type: 'global-macro' },
  { id: 'w6',  type: 'credit-spreads' },
  { id: 'w7',  type: 'options-snapshot',   ticker: 'SPY' },
  { id: 'w8',  type: 'portfolio-summary',  tickers: ['SPY','QQQ','TLT','GLD'], weights: [0.4, 0.3, 0.2, 0.1] },
  { id: 'w9',  type: 'earnings-calendar',  tickers: ['NVDA','AAPL','MSFT','AMZN','META','GOOGL'] },
  { id: 'w10', type: 'correlation-matrix', tickers: ['SPY','QQQ','TLT','GLD','BTC-USD'] },
  { id: 'w11', type: 'macro-calendar' },
  { id: 'w12', type: 'mini-chart',         ticker: 'SPY', period: '1y' },
  { id: 'w13', type: 'options-pricer',     ticker: 'SPY' },
  { id: 'w14', type: 'delta-target',       ticker: 'SPY' },
  { id: 'w15', type: 'price-card',         ticker: 'NVDA' },
  { id: 'w16', type: 'yield-curve' },
]

export const DEFAULT_LAYOUTS: Layout[] = [
  // Row A — full-width macro strip
  { i: 'w1',  x: 0, y: 0,  w: 12, h: 2 },

  // Row B — hero chart + watchlist/news sidebar
  { i: 'w2',  x: 0, y: 2,  w: 8,  h: 9,  minH: 6, minW: 3 },
  { i: 'w3',  x: 8, y: 2,  w: 4,  h: 5 },
  { i: 'w4',  x: 8, y: 7,  w: 4,  h: 4 },

  // Row C — macro / rates intel (all 9 rows tall)
  { i: 'w5',  x: 0, y: 11, w: 3,  h: 9 },
  { i: 'w11', x: 3, y: 11, w: 5,  h: 9 },
  { i: 'w6',  x: 8, y: 11, w: 4,  h: 9 },

  // Row D — analytics trio
  { i: 'w10', x: 0, y: 20, w: 4,  h: 6 },
  { i: 'w12', x: 4, y: 20, w: 4,  h: 6,  minH: 4 },
  { i: 'w9',  x: 8, y: 20, w: 4,  h: 6 },

  // Row E — rates tools + price card
  { i: 'w16', x: 0, y: 26, w: 4,  h: 7 },
  { i: 'w7',  x: 4, y: 26, w: 4,  h: 7,  minH: 4, minW: 3 },
  { i: 'w15', x: 8, y: 26, w: 4,  h: 7,  minH: 6, minW: 3 },

  // Row F — options tools + portfolio
  { i: 'w8',  x: 0, y: 33, w: 4,  h: 5 },
  { i: 'w13', x: 4, y: 33, w: 4,  h: 5 },
  { i: 'w14', x: 8, y: 33, w: 4,  h: 5 },
]

// ── Size constraints ──────────────────────────────────────────────────────────

const WIDGET_MIN_SIZES: Partial<Record<WidgetType, { minW: number; minH: number }>> = {
  'tradingview-chart': { minW: 3, minH: 6 },
  'price-card':        { minW: 3, minH: 6 },
  'options-snapshot':  { minW: 3, minH: 4 },
}

function applyConstraints(widgets: WidgetConfig[], layouts: Layout[]): Layout[] {
  return layouts.map(item => {
    const widget = widgets.find(w => w.id === item.i)
    if (!widget) return item
    const mins = WIDGET_MIN_SIZES[widget.type]
    if (!mins) return item
    return {
      ...item,
      minH: mins.minH, minW: mins.minW,
      h: Math.max(item.h, mins.minH),
      w: Math.max(item.w, mins.minW),
    }
  })
}

// ── Storage — per-user when a userId is provided ──────────────────────────────

const BASE_KEY = 'finance-terminal-dashboard-v3'

function storageKey(userId?: string | null) {
  return userId ? `${BASE_KEY}-user-${userId}` : BASE_KEY
}

function load(userId?: string | null): StoredDashboard {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw) as StoredDashboard
      if (parsed.version === 1 && parsed.widgets && parsed.layouts) {
        return { ...parsed, layouts: applyConstraints(parsed.widgets, parsed.layouts) }
      }
    }
  } catch { /* ignore */ }
  return { version: 1, widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS }
}

function save(d: StoredDashboard, userId?: string | null) {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(d)) } catch { /* ignore */ }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboard(userId?: string | null) {
  const [state, setState] = useState<StoredDashboard>(() => load(userId))

  // When user changes (login / logout), reload that user's dashboard
  useEffect(() => {
    setState(load(userId))
  }, [userId])

  const persist = useCallback((next: StoredDashboard) => {
    setState(next)
    save(next, userId)
  }, [userId])

  const addWidget = useCallback((type: WidgetType, config: Partial<WidgetConfig> = {}) => {
    const id = `w${Date.now()}`
    const def = WIDGET_DEFAULT_SIZE[type]
    const newWidget: WidgetConfig = { id, type, ...config }
    const newLayout: Layout = { i: id, x: 0, y: Infinity, w: def.w, h: def.h }
    const nextWidgets = [...state.widgets, newWidget]
    persist({ version: 1, widgets: nextWidgets, layouts: applyConstraints(nextWidgets, [...state.layouts, newLayout]) })
  }, [state, persist])

  const removeWidget = useCallback((id: string) => {
    persist({ version: 1, widgets: state.widgets.filter(w => w.id !== id), layouts: state.layouts.filter(l => l.i !== id) })
  }, [state, persist])

  const updateWidget = useCallback((id: string, patch: Partial<WidgetConfig>) => {
    persist({ version: 1, widgets: state.widgets.map(w => w.id === id ? { ...w, ...patch } : w), layouts: state.layouts })
  }, [state, persist])

  const updateLayouts = useCallback((layouts: readonly Layout[]) => {
    persist({ version: 1, widgets: state.widgets, layouts: applyConstraints(state.widgets, [...layouts]) })
  }, [state, persist])

  const resetDashboard = useCallback(() => {
    persist({ version: 1, widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS })
  }, [persist])

  return { widgets: state.widgets, layouts: state.layouts, addWidget, removeWidget, updateWidget, updateLayouts, resetDashboard }
}
