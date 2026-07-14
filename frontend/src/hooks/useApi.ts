import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 25_000 })

export const fetchMarketHistory = (ticker: string, start?: string, end?: string) =>
  api.get('/market/history', { params: { ticker, start, end } }).then(r => r.data)

// Computed CAPM/Scholes-Williams beta + FF3/FF4 style loadings + IVOL/TVOL,
// regressed against Ken French factors — real regression, not vendor beta.
export const fetchBetaSuite = (ticker: string, start?: string, end?: string, model: 'ff3' | 'ff4' = 'ff3') =>
  api.get('/market/beta-suite', { params: { ticker, start, end, model } }).then(r => r.data)

// Chokepoint Exposure: live chokepoint stress mapped to exposed equities.
export const fetchChokepointExposure = () =>
  api.get('/maritime/exposure').then(r => r.data)

// UN Comtrade bilateral trade flows.
export const fetchTradeFlows = (params: object) =>
  api.get('/comtrade/flows', { params }).then(r => r.data)

// BCC Research market sizing (public MCP semantic search).
export const fetchMarketSize = (query: string, count = 5) =>
  api.get('/bcc/market-size', { params: { query, count } }).then(r => r.data)

// Factor decomposition: regress a book's returns on market/rates/credit/oil/dollar.
export const fetchFactorDecomposition = (body: object) =>
  api.post('/portfolio/factor-decomposition', body).then(r => r.data)

// Pairs trader: cointegration, half-life, z-score backtest for a pair.
export const fetchPairsAnalysis = (params: object) =>
  api.get('/regression/pairs', { params }).then(r => r.data)

// Ticker-overview drawer sources.
export const fetchTickerHub = (ticker: string) =>
  api.get('/corporate/hub', { params: { ticker } }).then(r => r.data)

export const fetchImpliedMove = (ticker: string): Promise<number | null> =>
  api.get('/corporate/hub/implied', { params: { tickers: ticker } })
    .then(r => r.data?.implied?.[ticker.toUpperCase()] ?? null)

export const fetchSnapshotSeries = (kind: 'iv30' | 'gex', ticker: string, compute = true) =>
  api.get('/snapshots/series', { params: { kind, ticker, compute } }).then(r => r.data)

export const priceOption = (body: object) =>
  api.post('/options/price', body).then(r => r.data)

export const optionSurface = (body: object) =>
  api.post('/options/surface', body).then(r => r.data)

export const optionPayoff = (body: object) =>
  api.post('/options/payoff', body).then(r => r.data)

export const optionMultiLeg = (body: object) =>
  api.post('/options/multi-leg', body).then(r => r.data)

export const fetchOptionsChain = (ticker: string, expiry?: string) =>
  api.get('/options/chain', { params: { ticker, ...(expiry ? { expiry } : {}) } }).then(r => r.data)

// Risk-free rate as a decimal. With `days`, returns the Treasury curve
// interpolated at that tenor; without it, the 3-month T-bill default.
export const fetchRiskFreeRate = (days?: number): Promise<{ rate: number; tenor_years?: number }> =>
  api.get('/rates/risk-free', { params: days ? { days } : {} }).then(r => r.data)

export const fetchGEX = (ticker: string, expiry?: string) =>
  api.get('/options/gex', { params: { ticker, ...(expiry ? { expiry } : {}) } }).then(r => r.data)

export const fetchBondAnalytics = (body: object) =>
  api.post('/bond/analytics', body).then(r => r.data)

export const fetchBondByCusip = (cusip: string) =>
  api.get(`/bond/cusip/${encodeURIComponent(cusip)}`).then(r => r.data)

export const searchBondsByIssuer = (q: string) =>
  api.get('/bond/search', { params: { q } }).then(r => r.data)

export const resolveCusipBatch = (cusips: string[]) =>
  api.post('/bond/cusip/batch', { cusips }).then(r => r.data)

export const fetchNAVProxy = (body: object) =>
  api.post('/nav/proxy', body).then(r => r.data)

export interface NavPreset {
  ticker: string; name: string; category: string
  asset: string; asset_label: string; live: string
}
export const fetchNAVRegistry = (): Promise<NavPreset[]> =>
  api.get('/nav/registry').then(r => r.data)

export const fetchYieldCurve = () =>
  api.get('/rates/yield-curve').then(r => r.data)

export const fetchFedProjections = () =>
  api.get('/rates/fed-projections').then(r => r.data)

export const fetchSepDots = () =>
  api.get('/rates/sep-dots').then(r => r.data)

export const fetchCurveSpreads = () =>
  api.get('/rates/curve-spreads').then(r => r.data)

export const fetchCorrelation = (body: object) =>
  api.post('/correlation/matrix', body).then(r => r.data)

