// Shared number formatters so widgets render the same value identically.

import { formatLocalTime } from './time'

const SCALE_SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }

export function parseScaledNumber(input: string): number | null {
  const s = input.trim().replace(/,/g, '')
  if (!s) return null
  const m = s.match(/^([+-]?\d*\.?\d+)\s*([kmbt])?$/i)
  if (!m) {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  return n * (m[2] ? SCALE_SUFFIX[m[2].toLowerCase()] : 1)
}

const SCREENER_PERCENT_FIELDS = new Set([
  'priceChange', 'change52wHiPct', 'revenueGrowth', 'epsGrowth',
  'grossMargin', 'operatingMargin', 'netMargin', 'roe', 'roa', 'roic',
  'dividendYield', 'payoutRatio', 'smaDist50', 'smaDist200', 'vol30',
])

export function screenerFilterToApi(field: string, raw: string): number | null {
  const s = raw.trim().replace(/,/g, '')
  if (!s) return null
  const m = s.match(/^([+-]?\d*\.?\d+)\s*([kmbt])?$/i)
  if (!m) {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  if (field === 'marketCap') {
    return m[2] ? (n * SCALE_SUFFIX[m[2].toLowerCase()]) / 1e9 : n
  }
  if (field === 'volume' || field === 'avgVolume') {
    return m[2] ? n * SCALE_SUFFIX[m[2].toLowerCase()] : n
  }
  if (m[2]) return null
  return n
}

export function formatScreenerFilterDisplay(field: string, raw: string): string {
  if (!raw.trim()) return '·'
  const n = screenerFilterToApi(field, raw)
  if (n == null) return raw
  if (field === 'marketCap') {
    const abs = Math.abs(n)
    if (abs >= 1000) return `$${(n / 1000).toFixed(1)}T`
    if (abs >= 1) return `$${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)}B`
    return `$${(n * 1000).toFixed(0)}M`
  }
  if (field === 'volume' || field === 'avgVolume') {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n)
  }
  if (field === 'price') return `$${n}`
  if (SCREENER_PERCENT_FIELDS.has(field)) {
    return `${Number.isInteger(n) ? n.toFixed(0) : n}%`
  }
  return String(n)
}

// Screener price sources that describe the current session. Anything else on the
// board is a stored copy, and the header has to say how old it is instead of
// printing the browser clock over a month-old bundled snapshot.
const CURRENT_PRICE_SOURCES = new Set(['live', 'fmp', 'yfinance'])

export function screenerAsOfLabel(
  asOf: string | null | undefined,
  sources: Record<string, number> | undefined,
  now: Date = new Date(),
): string {
  const when = asOf ? new Date(asOf) : null
  if (!when || Number.isNaN(when.getTime())) return 'AS-OF UNKNOWN'
  const stored = Object.entries(sources ?? {}).reduce((n, [k, v]) => CURRENT_PRICE_SOURCES.has(k) ? n : n + v, 0)
  const storedSuffix = stored > 0 ? ` · ${stored} STORED` : ''
  const ageDays = Math.floor((now.getTime() - when.getTime()) / 86_400_000)
  if (ageDays >= 1) {
    const day = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
    return `PRICES AS OF ${day} · ${ageDays}D OLD${storedSuffix}`
  }
  return `PRICES ${formatLocalTime(when)}${storedSuffix}`
}

export function screenerFilterPlaceholder(field: string): string {
  if (field === 'marketCap') return 'e.g. 10B'
  if (field === 'volume' || field === 'avgVolume') return 'e.g. 300M'
  if (field === 'price') return 'e.g. 50'
  if (SCREENER_PERCENT_FIELDS.has(field)) return 'e.g. 25'
  return 'Value'
}

// Abbreviated market cap: $1.23T / $45.6B / $789M.
export function fmtMarketCap(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toLocaleString()}`
}

// Fixed-decimal number with an em-dash placeholder. The typeof guard also
// rejects non-number shapes from loosely-typed API responses.
export function fmtNum(v: unknown, digits = 2, suffix = ''): string {
  return typeof v !== 'number' || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}${suffix}`
}

// VaR and CVaR leave the backend loss-positive: +20 means the tail loses 20%,
// and a tail that still finishes ahead is legitimately negative. Rendering the
// raw number printed those gains as losses, so every surface flips them into a
// signed return here instead of formatting them by hand.
export function fmtTailReturn(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const ret = -v
  return `${ret > 0 ? '+' : ''}${ret.toFixed(digits)}%`
}

export function isTailLoss(v: number | null | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}
