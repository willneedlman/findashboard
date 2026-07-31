/** Resolving a planner directive into an actual tool setup.
 *
 * The planner writes its per-tool instruction as prose ("chart it against SPY
 * with 50 and 200 day moving averages and RSI"), which is flexible but not
 * something a collector can act on directly. Everything the tools can actually
 * do is a closed set, so the directive is matched against that set rather than
 * trusted: a phrase that resolves to nothing leaves the default view alone.
 * Nothing here asks a model anything — the same sentence always resolves the
 * same way.
 */

export type IndicatorKind = 'sma' | 'ema' | 'rsi' | 'bollinger' | 'vwap' | 'macd' | 'hv'

export interface IndicatorSpec {
  kind: IndicatorKind
  period: number
  label: string
}

export interface ChartDirective {
  indicators: IndicatorSpec[]
  overlays: string[]
  /** true when the directive asks for series indexed to a common base. */
  indexed: boolean
}

const DEFAULT_PERIOD: Record<IndicatorKind, number> = {
  sma: 50, ema: 50, rsi: 14, bollinger: 20, vwap: 0, macd: 0, hv: 30,
}

// Longest phrasings first so "exponential moving average" is not consumed by the
// bare "moving average" rule.
const INDICATOR_PATTERNS: { kind: IndicatorKind; re: RegExp }[] = [
  { kind: 'ema', re: /\b(?:(\d{1,3})[\s-]*(?:day|d|period)?[\s-]*)?(?:exponential moving average|ema)\b/gi },
  { kind: 'bollinger', re: /\b(?:(\d{1,3})[\s-]*(?:day|d|period)?[\s-]*)?bollinger(?:\s*bands?)?\b/gi },
  { kind: 'macd', re: /\bmacd\b/gi },
  { kind: 'vwap', re: /\bvwap\b/gi },
  { kind: 'hv', re: /\b(?:(\d{1,3})[\s-]*(?:day|d|period)?[\s-]*)?(?:historical|realized)\s*vol(?:atility)?\b/gi },
  { kind: 'rsi', re: /\b(?:(\d{1,3})[\s-]*(?:day|d|period)?[\s-]*)?rsi\b/gi },
  { kind: 'sma', re: /\b(?:(\d{1,3})[\s-]*(?:day|d|period)?[\s-]*)?(?:simple moving average|moving average|sma|ma)\b/gi },
]

// "50 and 200 day moving averages" names two periods but only one indicator
// phrase, so the numbers in front of it are swept up together. The phrase itself
// is captured rather than looked ahead at, because whether it says "exponential"
// decides the kind. Plurals matter: "SMAs" must match as readily as "SMA".
const LEADING_PERIODS =
  /((?:\d{1,3}\s*(?:,|and|&|\/)\s*)*\d{1,3})\s*(?:day|d|period)?[\s-]*(exponential moving averages?|emas?|simple moving averages?|moving averages?|smas?|mas?)\b/gi

const STOPWORDS = new Set([
  'AND', 'THE', 'WITH', 'VS', 'VERSUS', 'AGAINST', 'CHART', 'PLOT', 'SHOW', 'ADD', 'OVERLAY',
  'DAY', 'DAYS', 'RSI', 'SMA', 'EMA', 'MA', 'MACD', 'VWAP', 'IT', 'ITS', 'TO', 'A', 'AN',
  'OF', 'ON', 'FOR', 'IN', 'AT', 'BY', 'USE', 'USING', 'MOVING', 'AVERAGE', 'AVERAGES',
  'BOLLINGER', 'BANDS', 'BAND', 'PRICE', 'HISTORY', 'INDEX', 'INDEXED', 'ALL', 'NAMES',
  'START', 'LOOKBACK', 'WINDOW', 'ROLLING', 'BENCHMARK', 'AGAINST', 'COMPARE', 'RELATIVE',
])

const clampPeriod = (n: number, kind: IndicatorKind) =>
  Number.isFinite(n) && n >= 2 && n <= 400 ? Math.trunc(n) : DEFAULT_PERIOD[kind]

function labelFor(kind: IndicatorKind, period: number): string {
  switch (kind) {
    case 'sma': return `SMA ${period}`
    case 'ema': return `EMA ${period}`
    case 'rsi': return `RSI ${period}`
    case 'bollinger': return `Bollinger ${period}`
    case 'hv': return `HV ${period}`
    case 'vwap': return 'VWAP'
    case 'macd': return 'MACD'
  }
}

/** Tickers the directive names as overlays. `known` (the report's own subjects)
 * is excluded so "chart NVDA against SPY" does not overlay NVDA on itself. */
export function parseOverlays(directive: string, known: string[] = []): string[] {
  const exclude = new Set(known.map(t => t.toUpperCase()))
  const out: string[] = []
  // Match the text as written, not an uppercased copy: a ticker is capitalised in
  // the directive, ordinary prose is not. Uppercasing first turned every word in
  // "make it look really compelling" into a candidate symbol.
  for (const raw of directive.match(/\b[A-Z][A-Z0-9.-]{1,5}\b/g) ?? []) {
    const sym = raw.replace(/[.-]$/, '')
    if (sym.length < 2 || STOPWORDS.has(sym) || exclude.has(sym) || out.includes(sym)) continue
    out.push(sym)
  }
  return out.slice(0, 3)
}

export function parseChartDirective(directive?: string, subjects: string[] = []): ChartDirective {
  const empty: ChartDirective = { indicators: [], overlays: [], indexed: false }
  if (!directive || !directive.trim()) return empty
  const text = directive.trim()

  const specs: IndicatorSpec[] = []
  const push = (kind: IndicatorKind, period: number) => {
    const p = clampPeriod(period, kind)
    if (!specs.some(s => s.kind === kind && s.period === p)) {
      specs.push({ kind, period: p, label: labelFor(kind, p) })
    }
  }

  // Multiple periods sharing one phrase: "50 and 200 day moving averages".
  // The spans consumed here are recorded, because the generic rules below would
  // otherwise re-read "moving average" out of "exponential moving average" and
  // add a phantom default-period SMA next to the EMA that was actually asked for.
  const consumed: [number, number][] = []
  for (const match of text.matchAll(LEADING_PERIODS)) {
    const kind: IndicatorKind = /exponential|ema/i.test(match[2]) ? 'ema' : 'sma'
    for (const n of (match[1].match(/\d{1,3}/g) ?? [])) push(kind, Number(n))
    consumed.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
  }
  const overlaps = (at: number, len: number) =>
    consumed.some(([start, end]) => at < end && at + len > start)

  for (const { kind, re } of INDICATOR_PATTERNS) {
    for (const match of text.matchAll(re)) {
      if (overlaps(match.index ?? 0, match[0].length)) continue
      push(kind, match[1] ? Number(match[1]) : DEFAULT_PERIOD[kind])
    }
  }

  return {
    indicators: specs.slice(0, 6),
    overlays: parseOverlays(text, subjects),
    indexed: /\bindex(?:ed)?\b|\bnormali[sz]e/i.test(text),
  }
}

/** Rolling window in days, for the tools that take one. */
export function parseWindow(directive?: string, fallback = 90): number {
  if (!directive) return fallback
  const m = directive.match(/\b(\d{1,3})[\s-]*(?:day|d)\b/i)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n >= 5 && n <= 365 ? Math.trunc(n) : fallback
}
