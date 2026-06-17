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
  | 'sector-rotation'
  | 'dealer-gex'
  | 'vol-skew'
  | 'sentiment-gauge'
  | 'screener'
  | 'pm-portfolios'
  | 'paper-trade'
  | 'index-tape'
  | 'analyst-ratings'
  | 'valuation'
  | 'insider-activity'
  | 'risk-metrics'
  | 'pnl-attribution'
  | 'exposure-map'
  | 'time-and-sales'
  | 'unusual-flow'
  | 'heatmap'
  | 'trade-blotter'
  | 'position-sizer'
  // Not a real tile: selecting it in the palette surfaces the top-bar ticker
  // selector instead of inserting a widget. Present here only so it can carry a
  // palette label/icon/description.
  | 'ticker-control'

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
  expiry?: string                          // dealer-gex, vol-skew: option expiry YYYY-MM-DD
  timeframeHours?: number                  // sentiment-gauge: lookback window
  sectorPeriod?: string                    // sector-rotation: 1W | 1M | 3M | 6M | YTD | 1Y
  riskPct?: number                         // position-sizer
  entry?: number                           // position-sizer
  stop?: number                            // position-sizer
  accountValue?: number                    // position-sizer
  portfolioId?: string                     // risk-metrics, pnl-attribution, exposure-map: which saved portfolio
}

// Widget types that key off config.ticker — the dashboard-wide ticker control
// broadcasts to all of these at once, and WidgetFrame uses the same list to
// decide which widgets get a ticker title + per-widget ticker gear.
// position-sizer is intentionally absent: its ticker is a cosmetic label over a
// manual entry/stop calculator, so broadcasting to it would mislabel without
// changing its inputs.
export const TICKER_WIDGET_TYPES: WidgetType[] = [
  'price-card', 'mini-chart', 'options-snapshot', 'options-pricer', 'delta-target',
  'tradingview-chart', 'dealer-gex', 'vol-skew', 'analyst-ratings', 'valuation',
  'insider-activity', 'time-and-sales', 'unusual-flow',
]

export interface Dashboard {
  id: string
  name: string
  widgets: WidgetConfig[]
  layouts: Layout[]
  showTicker?: boolean   // surface the top-bar ticker selector on this dashboard
}

export interface StoredWorkspace {
  version: 2
  dashboards: Dashboard[]
  activeId: string
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
  'sector-rotation':     { w: 4, h: 7 },
  'dealer-gex':          { w: 4, h: 6 },
  'vol-skew':            { w: 4, h: 6 },
  'sentiment-gauge':     { w: 3, h: 5 },
  'screener':            { w: 5, h: 6 },
  'pm-portfolios':       { w: 4, h: 6 },
  'paper-trade':         { w: 6, h: 8 },
  'index-tape':          { w: 12, h: 1 },
  'analyst-ratings':     { w: 4, h: 6 },
  'valuation':           { w: 5, h: 5 },
  'insider-activity':    { w: 3, h: 6 },
  'risk-metrics':        { w: 4, h: 9 },
  'pnl-attribution':     { w: 6, h: 6 },
  'exposure-map':        { w: 4, h: 9 },
  'time-and-sales':      { w: 3, h: 9 },
  'unusual-flow':        { w: 6, h: 7 },
  'heatmap':             { w: 8, h: 8 },
  'trade-blotter':       { w: 6, h: 6 },
  'position-sizer':      { w: 4, h: 6 },
  'ticker-control':      { w: 3, h: 2 },   // unused — never placed as a tile
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
  'sector-rotation':     'Sector Rotation',
  'dealer-gex':          'Dealer GEX',
  'vol-skew':            'Vol Skew',
  'sentiment-gauge':     'Market Sentiment',
  'screener':            'Screener',
  'pm-portfolios':       'Portfolios',
  'paper-trade':         'Paper Trade',
  'index-tape':          'Index Tape',
  'analyst-ratings':     'Analyst Consensus',
  'valuation':           'Valuation',
  'insider-activity':    'Insider Activity',
  'risk-metrics':        'Risk Metrics',
  'pnl-attribution':     'P/L Attribution',
  'exposure-map':        'Exposure',
  'time-and-sales':      'Time & Sales',
  'unusual-flow':        'Unusual Options Flow',
  'heatmap':             'Market Heatmap',
  'trade-blotter':       'Trade Blotter',
  'position-sizer':      'Position Sizer',
  'ticker-control':      'Ticker Control',
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
  'sector-rotation':     '11 GICS sectors ranked by relative strength — 1-month return heatmap, leaders to laggards.',
  'dealer-gex':          'Net dealer gamma by strike for a ticker, with spot, total net GEX, and the gamma-flip level.',
  'vol-skew':            'ATM IV, 25-delta put skew, term-structure slope, and the front-expiry IV smile for a ticker.',
  'sentiment-gauge':     'Market-wide AI news sentiment: composite score, bull/neutral/bear split over the last 4 hours.',
  'screener':            'Quick stock screens — biggest names, top gainers/losers, and volume leaders.',
  'pm-portfolios':       'Your Portfolio Manager books with live value and unrealized P&L per holding.',
  'paper-trade':         'Trade a ticker on your paper account from a chart — market, limit, and stop orders.',
  'index-tape':          'Scrolling price strip for any tickers or a loaded portfolio — live price and day change.',
  'analyst-ratings':     'Analyst consensus: rating, buy/hold/sell distribution, mean/high/low targets, implied upside.',
  'valuation':           'P/E, Fwd P/E, P/S, EV/EBITDA, PEG, Div Yield with rich/cheap vs sector peers.',
  'insider-activity':    'Institutional/retail/insider ownership split and the latest insider buy/sell transactions.',
  'risk-metrics':        'Portfolio VaR, beta, Sharpe, vol, drawdown, and top-holding concentration.',
  'pnl-attribution':     'Waterfall of P/L by position (day or open) from your portfolio.',
  'exposure-map':        'Gross/net/long/short and per-position exposure as % of NAV.',
  'time-and-sales':      'Intraday prints from 1-minute bars — time, price, size, uptick/downtick.',
  'unusual-flow':        'Largest options flow by premium — strike, expiry, volume, vol/OI, IV.',
  'heatmap':             'S&P treemap by sector & market cap, colored by daily % change.',
  'trade-blotter':       'Order & fill history — side, qty, avg price, and fill status.',
  'position-sizer':      'Risk-based share sizing from account %, entry, and stop.',
  'ticker-control':      'Shows the dashboard-wide ticker selector in the top bar (not a tile).',
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
  'sector-rotation':     'SR',
  'dealer-gex':          'GEX',
  'vol-skew':            'σ',
  'sentiment-gauge':     'S',
  'screener':            'SCR',
  'pm-portfolios':       'PF',
  'paper-trade':         'TR',
  'index-tape':          'IDX',
  'analyst-ratings':     'AN',
  'valuation':           'VAL',
  'insider-activity':    'INS',
  'risk-metrics':        'RSK',
  'pnl-attribution':     'PNL',
  'exposure-map':        'EXP',
  'time-and-sales':      'T&S',
  'unusual-flow':        'FLOW',
  'heatmap':             'HM',
  'trade-blotter':       'BLT',
  'position-sizer':      'SIZ',
  'ticker-control':      'TKR',
}

// ── Default layout — all 20 widget types, one each ───────────────────────────
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
  { id: 'w17', type: 'sector-rotation' },
  { id: 'w18', type: 'dealer-gex',         ticker: 'SPY' },
  { id: 'w19', type: 'vol-skew',           ticker: 'SPY' },
  { id: 'w20', type: 'sentiment-gauge' },
  { id: 'w21', type: 'screener' },
  { id: 'w22', type: 'pm-portfolios' },
  { id: 'w23', type: 'paper-trade', ticker: 'SPY' },
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

  // Row G — vol surface + sector + sentiment
  { i: 'w17', x: 0, y: 38, w: 4,  h: 7 },
  { i: 'w18', x: 4, y: 38, w: 4,  h: 6 },
  { i: 'w19', x: 8, y: 38, w: 4,  h: 6 },
  { i: 'w20', x: 0, y: 45, w: 3,  h: 5 },
  { i: 'w21', x: 3, y: 45, w: 5,  h: 6 },
  { i: 'w22', x: 8, y: 45, w: 4,  h: 6 },
  { i: 'w23', x: 0, y: 51, w: 6,  h: 8 },
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

// ── Presets ───────────────────────────────────────────────────────────────────

let _seq = 0
const newId = () => `w${Date.now()}_${_seq++}`
const newDashId = () => `d${Date.now()}_${_seq++}`

export type PresetKey = 'main' | 'cockpit' | 'research' | 'screening' | 'market-overview' | 'options' | 'risk' | 'blank'

export const PRESET_LABELS: Record<PresetKey, string> = {
  main: 'Everything', cockpit: 'Trading Portal', research: 'Research', screening: 'Screening', 'market-overview': 'Market Overview', options: 'Options Desk', risk: 'Risk Desk', blank: 'Custom (blank)',
}

// A preset is a hand-placed list of tiles (12-col grid, 60px rows) so each
// layout reads as a deliberate workspace rather than an auto-packed grid.
type PItem = { type: WidgetType; config?: Partial<WidgetConfig>; x: number; y: number; w: number; h: number }

function fromItems(items: PItem[]): { widgets: WidgetConfig[]; layouts: Layout[] } {
  const widgets = items.map(it => ({ id: newId(), type: it.type, ...it.config }))
  const layouts: Layout[] = items.map((it, i) => ({ i: widgets[i].id, x: it.x, y: it.y, w: it.w, h: it.h }))
  return { widgets, layouts: applyConstraints(widgets, layouts) }
}

const W_LIST = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META']
const EARN = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL']

function buildPreset(key: PresetKey): { widgets: WidgetConfig[]; layouts: Layout[] } {
  if (key === 'main') return { widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS }
  if (key === 'blank') return { widgets: [], layouts: [] }

  // Research — screener + analyst + sentiment / valuation + portfolios + insider /
  // sector + correlation + earnings / full-width news (Trading Portal design).
  if (key === 'research') return fromItems([
    { type: 'screener',                                                 x: 0, y: 0,  w: 5, h: 7 },
    { type: 'analyst-ratings',    config: { ticker: 'AAPL' },           x: 5, y: 0,  w: 4, h: 7 },
    { type: 'sentiment-gauge',                                          x: 9, y: 0,  w: 3, h: 7 },
    { type: 'valuation',          config: { ticker: 'AAPL' },           x: 0, y: 7,  w: 5, h: 6 },
    { type: 'pm-portfolios',                                            x: 5, y: 7,  w: 4, h: 6 },
    { type: 'insider-activity',   config: { ticker: 'AAPL' },           x: 9, y: 7,  w: 3, h: 6 },
    { type: 'sector-rotation',                                          x: 0, y: 13, w: 4, h: 7 },
    { type: 'correlation-matrix', config: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'] }, x: 4, y: 13, w: 4, h: 7 },
    { type: 'earnings-calendar',  config: { tickers: EARN },           x: 8, y: 13, w: 4, h: 7 },
    { type: 'news-feed',          config: { tickers: ['SPY', 'AAPL', 'NVDA'] }, x: 0, y: 20, w: 12, h: 4 },
  ])

  // Screening — large screener + watchlist + mini chart / sector + earnings /
  // full-width market heatmap (Trading Portal design).
  if (key === 'screening') return fromItems([
    { type: 'screener',                                                 x: 0, y: 0,  w: 7, h: 9 },
    { type: 'watchlist',          config: { tickers: W_LIST },          x: 7, y: 0,  w: 5, h: 6 },
    { type: 'mini-chart',         config: { ticker: 'SPY', period: '1y' }, x: 7, y: 6, w: 5, h: 3 },
    { type: 'sector-rotation',                                          x: 0, y: 9,  w: 6, h: 7 },
    { type: 'earnings-calendar',  config: { tickers: EARN },           x: 6, y: 9,  w: 6, h: 7 },
    { type: 'heatmap',                                                 x: 0, y: 16, w: 12, h: 8 },
  ])

  // Market Overview — index tape / global macro + yield curve + credit spreads /
  // sector + news + sentiment / full-width market heatmap (Trading Portal design).
  if (key === 'market-overview') return fromItems([
    { type: 'index-tape',   config: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] }, x: 0, y: 0, w: 12, h: 1 },
    { type: 'global-macro',                                             x: 0, y: 1,  w: 3, h: 9 },
    { type: 'yield-curve',                                              x: 3, y: 1,  w: 5, h: 9 },
    { type: 'credit-spreads',                                           x: 8, y: 1,  w: 4, h: 9 },
    { type: 'sector-rotation',                                          x: 0, y: 10, w: 4, h: 7 },
    { type: 'news-feed',          config: { tickers: ['SPY', 'AAPL', 'NVDA'] }, x: 4, y: 10, w: 5, h: 7 },
    { type: 'sentiment-gauge',                                          x: 9, y: 10, w: 3, h: 7 },
    { type: 'heatmap',                                                 x: 0, y: 17, w: 12, h: 8 },
  ])

  // Risk Desk — risk metrics + exposure + position sizer / P/L attribution /
  // correlation + portfolios + trade blotter.
  if (key === 'risk') return fromItems([
    { type: 'risk-metrics',                                              x: 0, y: 0,  w: 4, h: 9 },
    { type: 'exposure-map',                                             x: 4, y: 0,  w: 4, h: 9 },
    { type: 'global-macro',                                            x: 8, y: 0,  w: 2, h: 9 },
    { type: 'news-feed',      config: { tickers: ['SPY', 'AAPL', 'NVDA'] }, x: 10, y: 0, w: 2, h: 9 },
    { type: 'pnl-attribution',                                         x: 0, y: 9,  w: 12, h: 6 },
    { type: 'correlation-matrix', config: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'] }, x: 0, y: 15, w: 4, h: 7 },
    { type: 'pm-portfolios',                                           x: 4, y: 15, w: 4, h: 7 },
    { type: 'trade-blotter',                                           x: 8, y: 15, w: 4, h: 7 },
  ])

  // Options Desk — snapshot + pricer + delta-target / dealer GEX + vol skew +
  // sentiment / full-width unusual options flow (Trading Portal design).
  if (key === 'options') return fromItems([
    { type: 'options-snapshot', config: { ticker: 'AAPL' },             x: 0, y: 0,  w: 7, h: 9 },
    { type: 'options-pricer',   config: { ticker: 'AAPL' },             x: 7, y: 0,  w: 5, h: 5 },
    { type: 'delta-target',     config: { ticker: 'AAPL' },             x: 7, y: 5,  w: 5, h: 6 },
    { type: 'dealer-gex',       config: { ticker: 'AAPL' },             x: 0, y: 9,  w: 4, h: 7 },
    { type: 'vol-skew',         config: { ticker: 'AAPL' },             x: 4, y: 9,  w: 3, h: 7 },
    { type: 'sentiment-gauge',                                          x: 7, y: 11, w: 5, h: 5 },
    { type: 'unusual-flow',     config: { ticker: 'AAPL' },             x: 0, y: 16, w: 12, h: 6 },
  ])

  if (key === 'cockpit') return fromItems([
    // Trading Portal "cockpit": ticker-tape strip; position sizer left of a wide
    // chart + order ticket, time & sales to its right; the watchlist and
    // positions ledger side by side underneath.
    { type: 'index-tape',    config: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] }, x: 0, y: 0, w: 12, h: 1 },
    { type: 'position-sizer', config: { ticker: 'AAPL' },              x: 0, y: 1,  w: 2,  h: 9 },
    { type: 'paper-trade',   config: { ticker: 'AAPL' },                x: 2, y: 1,  w: 8,  h: 9 },
    { type: 'time-and-sales', config: { ticker: 'AAPL' },              x: 10, y: 1, w: 2,  h: 9 },
    { type: 'watchlist',     config: { tickers: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'SPY', 'AMD', 'META'] }, x: 0, y: 10, w: 4, h: 6 },
    { type: 'pm-portfolios',                                            x: 4, y: 10, w: 8, h: 6 },
  ])

  // Every PresetKey is handled above; fall back to the default workspace.
  return { widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS }
}

// ── Storage (v2: multiple named dashboards, per-user when a userId is given) ─────

const BASE_KEY = 'finance-terminal-dashboard-v3'

function storageKey(userId?: string | null) {
  return userId ? `${BASE_KEY}-user-${userId}` : BASE_KEY
}

function defaultWorkspace(): StoredWorkspace {
  const id = newDashId()
  // New users land on the Trading Portal cockpit as the default dashboard.
  const p = buildPreset('cockpit')
  return { version: 2, dashboards: [{ id, name: 'Trading Portal', widgets: p.widgets, layouts: p.layouts }], activeId: id }
}

function load(userId?: string | null): StoredWorkspace {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.version === 2 && Array.isArray(parsed.dashboards) && parsed.dashboards.length) {
        const dashboards: Dashboard[] = parsed.dashboards.map((d: Dashboard) => ({ ...d, layouts: applyConstraints(d.widgets, d.layouts) }))
        const activeId = dashboards.some(d => d.id === parsed.activeId) ? parsed.activeId : dashboards[0].id
        return { version: 2, dashboards, activeId }
      }
      // Migrate a v1 single dashboard into the new workspace shape.
      if (parsed?.version === 1 && parsed.widgets && parsed.layouts) {
        const id = newDashId()
        return { version: 2, dashboards: [{ id, name: 'Main', widgets: parsed.widgets, layouts: applyConstraints(parsed.widgets, parsed.layouts) }], activeId: id }
      }
    }
  } catch { /* ignore */ }
  return defaultWorkspace()
}

function save(w: StoredWorkspace, userId?: string | null) {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(w)) } catch { /* ignore */ }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboard(userId?: string | null) {
  const [ws, setWs] = useState<StoredWorkspace>(() => load(userId))

  // When user changes (login / logout), reload that user's workspace
  useEffect(() => { setWs(load(userId)) }, [userId])

  const persist = useCallback((next: StoredWorkspace) => {
    setWs(next)
    save(next, userId)
  }, [userId])

  const active = ws.dashboards.find(d => d.id === ws.activeId) ?? ws.dashboards[0]

  const patchActive = useCallback((fn: (d: Dashboard) => Dashboard) => {
    persist({ ...ws, dashboards: ws.dashboards.map(d => d.id === ws.activeId ? fn(d) : d) })
  }, [ws, persist])

  const addWidget = useCallback((type: WidgetType, config: Partial<WidgetConfig> = {}) => {
    const id = newId()
    const def = WIDGET_DEFAULT_SIZE[type]
    const nw: WidgetConfig = { id, type, ...config }
    const nl: Layout = { i: id, x: 0, y: Infinity, w: def.w, h: def.h }
    patchActive(d => {
      const widgets = [...d.widgets, nw]
      return { ...d, widgets, layouts: applyConstraints(widgets, [...d.layouts, nl]) }
    })
  }, [patchActive])

  const removeWidget = useCallback((id: string) => {
    patchActive(d => ({ ...d, widgets: d.widgets.filter(w => w.id !== id), layouts: d.layouts.filter(l => l.i !== id) }))
  }, [patchActive])

  const updateWidget = useCallback((id: string, patch: Partial<WidgetConfig>) => {
    patchActive(d => ({ ...d, widgets: d.widgets.map(w => w.id === id ? { ...w, ...patch } : w) }))
  }, [patchActive])

  const updateLayouts = useCallback((layouts: readonly Layout[]) => {
    patchActive(d => ({ ...d, layouts: applyConstraints(d.widgets, [...layouts]) }))
  }, [patchActive])

  // Retarget every ticker-driven widget in one pass — looping updateWidget would
  // race on the captured workspace snapshot (last write wins).
  const setShowTicker = useCallback((show: boolean) => {
    patchActive(d => ({ ...d, showTicker: show }))
  }, [patchActive])

  const setAllTickers = useCallback((ticker: string) => {
    // Clear any per-widget expiry too: expiries are ticker-specific, so a stale
    // one (e.g. dealer-gex / vol-skew) would point at a chain the new ticker may
    // not have. Empty expiry makes those widgets re-aggregate / auto-select.
    patchActive(d => ({ ...d, widgets: d.widgets.map(w => TICKER_WIDGET_TYPES.includes(w.type) ? { ...w, ticker, expiry: '' } : w) }))
  }, [patchActive])

  const resetDashboard = useCallback(() => {
    const p = buildPreset('cockpit')
    patchActive(d => ({ ...d, widgets: p.widgets, layouts: p.layouts }))
  }, [patchActive])

  const switchDashboard = useCallback((id: string) => {
    if (ws.dashboards.some(d => d.id === id)) persist({ ...ws, activeId: id })
  }, [ws, persist])

  const createDashboard = useCallback((preset: PresetKey) => {
    const p = buildPreset(preset)
    const id = newDashId()
    persist({ ...ws, dashboards: [...ws.dashboards, { id, name: PRESET_LABELS[preset], widgets: p.widgets, layouts: p.layouts }], activeId: id })
  }, [ws, persist])

  const renameDashboard = useCallback((id: string, name: string) => {
    persist({ ...ws, dashboards: ws.dashboards.map(d => d.id === id ? { ...d, name } : d) })
  }, [ws, persist])

  const deleteDashboard = useCallback((id: string) => {
    if (ws.dashboards.length <= 1) return
    const dashboards = ws.dashboards.filter(d => d.id !== id)
    persist({ ...ws, dashboards, activeId: ws.activeId === id ? dashboards[0].id : ws.activeId })
  }, [ws, persist])

  return {
    widgets: active.widgets, layouts: active.layouts,
    addWidget, removeWidget, updateWidget, updateLayouts, resetDashboard, setAllTickers,
    showTicker: active.showTicker ?? false, setShowTicker,
    dashboards: ws.dashboards.map(d => ({ id: d.id, name: d.name })),
    activeId: ws.activeId,
    switchDashboard, createDashboard, renameDashboard, deleteDashboard,
  }
}
