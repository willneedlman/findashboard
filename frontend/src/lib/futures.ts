// Curated futures contracts with CME/ICE multipliers. The multiplier is chosen so
// that  yfinance_price × multiplier × contracts = USD notional, which also drives
// per-point P&L. Single source of truth — reused by the Portfolio Manager
// (positions) and the analytics tools (discoverability pickers).
export interface FutureSpec {
  sym:        string   // yfinance continuous symbol, e.g. 'ES=F'
  label:      string
  group:      string
  multiplier: number   // USD per 1.0 of price move, per contract
}

export const FUTURES: FutureSpec[] = [
  // Equity Index
  { sym: 'ES=F',  label: 'E-mini S&P 500',     group: 'Equity Index', multiplier: 50 },
  { sym: 'NQ=F',  label: 'E-mini Nasdaq 100',  group: 'Equity Index', multiplier: 20 },
  { sym: 'YM=F',  label: 'E-mini Dow',         group: 'Equity Index', multiplier: 5 },
  { sym: 'RTY=F', label: 'E-mini Russell 2000', group: 'Equity Index', multiplier: 50 },
  { sym: 'MES=F', label: 'Micro E-mini S&P',   group: 'Equity Index', multiplier: 5 },
  { sym: 'MNQ=F', label: 'Micro E-mini Nasdaq', group: 'Equity Index', multiplier: 2 },
  // Energy
  { sym: 'CL=F',  label: 'Crude Oil (WTI)',    group: 'Energy', multiplier: 1000 },
  { sym: 'NG=F',  label: 'Natural Gas',        group: 'Energy', multiplier: 10000 },
  { sym: 'RB=F',  label: 'RBOB Gasoline',      group: 'Energy', multiplier: 42000 },
  { sym: 'HO=F',  label: 'Heating Oil',        group: 'Energy', multiplier: 42000 },
  // Metals
  { sym: 'GC=F',  label: 'Gold',               group: 'Metals', multiplier: 100 },
  { sym: 'SI=F',  label: 'Silver',             group: 'Metals', multiplier: 5000 },
  { sym: 'HG=F',  label: 'Copper',             group: 'Metals', multiplier: 25000 },
  { sym: 'PL=F',  label: 'Platinum',           group: 'Metals', multiplier: 50 },
  // Rates
  { sym: 'ZB=F',  label: '30Y T-Bond',         group: 'Rates', multiplier: 1000 },
  { sym: 'ZN=F',  label: '10Y T-Note',         group: 'Rates', multiplier: 1000 },
  { sym: 'ZF=F',  label: '5Y T-Note',          group: 'Rates', multiplier: 1000 },
  // FX
  { sym: '6E=F',  label: 'Euro FX',            group: 'FX', multiplier: 125000 },
  { sym: '6J=F',  label: 'Japanese Yen',       group: 'FX', multiplier: 12500000 },
  { sym: '6B=F',  label: 'British Pound',      group: 'FX', multiplier: 62500 },
  // Agriculture
  { sym: 'ZC=F',  label: 'Corn',               group: 'Agriculture', multiplier: 50 },
  { sym: 'ZS=F',  label: 'Soybeans',           group: 'Agriculture', multiplier: 50 },
  { sym: 'ZW=F',  label: 'Wheat',              group: 'Agriculture', multiplier: 50 },
]

export const futuresSpec = (sym: string): FutureSpec | undefined =>
  FUTURES.find(f => f.sym === sym.toUpperCase())

// Symbols grouped for rendering pickers
export const FUTURES_BY_GROUP: { group: string; items: FutureSpec[] }[] =
  Array.from(new Set(FUTURES.map(f => f.group))).map(group => ({
    group, items: FUTURES.filter(f => f.group === group),
  }))
