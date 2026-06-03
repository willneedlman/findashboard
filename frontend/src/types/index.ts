export interface MetricData {
  label: string
  value: string | number
  delta?: string
  positive?: boolean
}

export interface ChartPoint {
  date: string
  value: number
}

export interface MarketHistoryResponse {
  ticker: string
  metrics: {
    total_return: number
    max_drawdown: number
    ann_volatility: number
    current_price: number
  }
  price: ChartPoint[]
  volatility: ChartPoint[]
  drawdown: ChartPoint[]
}

export interface OptionPriceResponse {
  price: number
  greeks: { delta: number; gamma: number; theta: number; vega: number }
  vanna: number
  charm: number
}

export interface BondAnalyticsResponse {
  bond_type: string
  ytm: number
  mod_duration: number
  mac_duration: number
  convexity: number
  coupon_payment: number
  cash_flows: { year: number; nominal: number; pv: number }[]
  sensitivity: { shift: number; price: number }[]
}

export interface BacktestResponse {
  metrics: {
    port_cagr: number
    bench_cagr: number
    port_sharpe: number
    port_vol: number
    max_drawdown: number
    sortino: number
    calmar: number
    beta: number
  }
  cumulative: { date: string; portfolio: number; benchmark: number }[]
  daily_returns: ChartPoint[]
  rolling_beta: ChartPoint[]
}

export interface MonteCarloResponse {
  S0: number
  mu: number
  sigma: number
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }
  var_95: number
  cvar_95: number
  sample_paths: number[][]
  histogram: number[]
}
