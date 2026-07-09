// Pure helpers for the Release Tape: surprise derivation, reaction short codes,
// sparkline geometry, countdowns, sort comparators. No React, no side effects.
import type { MacroEvent, MarketReaction } from '../../data/mockEventsData'

export type Tone = 'pos' | 'neg' | 'muted'
export interface Surprise { label: string; value: string; tone: Tone }

const MINUS = /−/g   // unicode minus used in some copy

export function parseNum(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.replace(MINUS, '-').match(/-?\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

function unitOf(s: string): '' | 'K' | 'bp' | '%' {
  if (/K/.test(s)) return 'K'
  if (/bp/i.test(s)) return 'bp'
  if (/%/.test(s)) return '%'
  return ''
}

const sign = (n: number) => (n >= 0 ? '+' : '−')

// Surprise vs the number the market anchored to (consensus if present, else the
// prior print). Direction is read for risk assets: cooler inflation and stronger
// growth/jobs are the "good" side. Rate decisions read as as-priced.
export function deriveSurprise(e: MacroEvent): Surprise | null {
  if (e.status !== 'released' || !e.actual) return null
  // Rate decisions with a real level read as as-priced; scheduled events with no
  // number (e.g. FOMC Minutes shows "Released") carry no surprise.
  if (e.category === 'Central Bank') return parseNum(e.actual) == null ? null : { label: 'AS PRICED', value: '', tone: 'muted' }
  const baseline = e.expected ?? e.previous
  const a = parseNum(e.actual)
  const b = parseNum(baseline)
  if (a == null || b == null) return null
  const unit = unitOf(e.actual)
  const eps = unit === 'K' ? 0.5 : 0.05
  const d = a - b
  if (Math.abs(d) < eps) return { label: 'IN LINE', value: '', tone: 'muted' }
  const inflation = e.category === 'Inflation'
  // Inflation and jobless claims and unemployment: lower is the "good" surprise.
  const good = inflation ? d < 0 : /Unemployment|Claims/i.test(e.name) ? d < 0 : d > 0
  const label = inflation ? (d < 0 ? 'COOLER' : 'HOTTER') : good ? 'BEAT' : 'MISS'
  const value = unit === 'K'
    ? `${sign(d)}${Math.abs(Math.round(d))}K`
    : `${sign(d)}${Math.abs(d).toFixed(1)}`
  return { label, value, tone: good ? 'pos' : 'neg' }
}

const CODE: Record<string, string> = {
  'S&P 500': 'SPX', 'DXY': 'DXY', 'US 10Y': '10Y', 'EuroStoxx 50': 'SX5E',
  'EUR/USD': 'EUR', 'Bund 10Y': 'BUND', 'Nikkei 225': 'NKY', 'USD/JPY': 'JPY', 'JGB 10Y': 'JGB',
}
export function reactionCode(asset: string): string {
  return CODE[asset] ?? asset.split(/[\s/]/)[0].toUpperCase().slice(0, 4)
}
export function reactionValue(r: MarketReaction): string {
  const mag = Math.abs(r.change)
  const s = r.change >= 0 ? '+' : '−'
  return r.unit === 'bp' ? `${s}${mag.toFixed(0)}bp` : `${s}${mag.toFixed(2)}`
}

// Polyline points for a sparkline fitted to [pad, w-pad] x [pad, h-pad].
export function sparkPoints(history: number[] | undefined, w = 56, h = 18, pad = 3): string {
  const s = history && history.length >= 2 ? history : [1, 1]
  const min = Math.min(...s), max = Math.max(...s), span = max - min || 1
  const n = s.length
  return s.map((v, i) => {
    const x = pad + (w - 2 * pad) * (n === 1 ? 0.5 : i / (n - 1))
    const y = pad + (h - 2 * pad) * (1 - (v - min) / span)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

// Bar chart geometry (last N prints) fitted to a 300x48 box, 40px bars.
export function historyBars(history: number[], count = 6, w = 300, h = 48, bw = 40): { x: number; y: number; height: number }[] {
  const s = history.slice(-count)
  if (!s.length) return []
  const min = Math.min(...s, 0), max = Math.max(...s), span = max - min || 1
  const gap = s.length > 1 ? (w - bw) / (s.length - 1) : 0
  return s.map((v, i) => {
    const bh = Math.max(2, (h - 2) * (v - min) / span)
    return { x: i * gap, y: h - bh, height: bh }
  })
}

function parts(ms: number) {
  const d = Math.floor(ms / 86_400_000)
  const hrs = Math.floor((ms % 86_400_000) / 3_600_000)
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  return { d, hrs, mins }
}
export function countdownShort(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'due'
  const { d, hrs, mins } = parts(ms)
  if (d >= 1) return `in ${d}d ${hrs}h`
  return `in ${hrs}h ${mins}m`
}
export function countdownLong(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'T−0'
  const { d, hrs, mins } = parts(ms)
  return d >= 1 ? `T−${d}d ${hrs}h ${mins}m` : `T−${hrs}h ${mins}m`
}

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
export function dayKey(iso: string): string { return iso.slice(0, 10) }
export function dayLabel(iso: string): string {
  const d = new Date(iso)
  return `${DOW[d.getDay()]} · ${MON[d.getMonth()]} ${d.getDate()}`
}
export function shortDate(iso: string): string {
  const d = new Date(iso)
  return `${MON[d.getMonth()]} ${d.getDate()}`
}

export type SortCol = 'time' | 'date' | 'event' | 'region' | 'actual' | 'consensus' | 'previous' | 'surprise' | 'reaction' | 'history'

// Columns that can be empty and are therefore filterable "has a value here".
export type FilterCol = 'actual' | 'consensus' | 'surprise' | 'reaction'
export function hasColData(e: MacroEvent, col: FilterCol): boolean {
  switch (col) {
    case 'actual': return e.actual != null && e.actual !== ''
    case 'consensus': return e.expected != null && e.expected !== ''
    case 'surprise': return deriveSurprise(e) != null
    case 'reaction': return e.reactions.length > 0
  }
}
export function sortValue(e: MacroEvent, col: SortCol): number | string {
  switch (col) {
    case 'time':
    case 'date': return new Date(e.datetime).getTime()
    case 'event': return e.name.toLowerCase()
    case 'region': return e.region
    case 'actual': return parseNum(e.actual) ?? -Infinity
    case 'consensus': return parseNum(e.expected) ?? -Infinity
    case 'previous': return parseNum(e.previous) ?? -Infinity
    case 'surprise': { const s = deriveSurprise(e); return s ? (parseNum(s.value) ?? 0) : -Infinity }
    case 'reaction': return e.reactions[0]?.change ?? -Infinity
    case 'history': return e.history && e.history.length ? e.history[e.history.length - 1] : -Infinity
  }
}
