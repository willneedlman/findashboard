import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 25_000 })

export const fetchMarketHistory = (ticker: string, start?: string, end?: string) =>
  api.get('/market/history', { params: { ticker, start, end } }).then(r => r.data)

export const priceOption = (body: object) =>
  api.post('/options/price', body).then(r => r.data)

export const optionSurface = (body: object) =>
  api.post('/options/surface', body).then(r => r.data)

export const optionPayoff = (body: object) =>
  api.post('/options/payoff', body).then(r => r.data)

export const fetchOptionsChain = (ticker: string, expiry?: string) =>
  api.get('/options/chain', { params: { ticker, ...(expiry ? { expiry } : {}) } }).then(r => r.data)

// 3-month T-bill, the standard risk-free proxy. Returns { rate } as a decimal.
export const fetchRiskFreeRate = (): Promise<{ rate: number }> =>
  api.get('/rates/risk-free').then(r => r.data)

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

export const fetchCorrelation = (body: object) =>
  api.post('/correlation/matrix', body).then(r => r.data)
