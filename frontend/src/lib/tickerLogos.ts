// Single source of truth for ticker logos. Custom overrides win over the
// default providers so a symbol shows the right brand everywhere (sidebar,
// dashboards, scans, holdings). Keyed by uppercased symbol; values are public paths.
export const LOGO_OVERRIDES: Record<string, string> = {
  RVI: '/logos/rvi.png',
  // Symbol CDNs return a valid but wrong-brand image for SPCX (Parqet serves an
  // unrelated "AXS" mark), so onError never fires and the fallback can't kick in.
  // A local override wins ahead of the CDNs. Add more here when a name shows the
  // wrong logo everywhere.
  SPCX: '/logos/spcx.svg',
}

const LOGO_VISUAL_SCALE: Record<string, number> = {
  MCD: 0.78,
  QSR: 0.86,
  WEN: 0.94,
  YUM: 1,
}

// Ordered logo candidates: override, then Parqet (clean SVGs for major listings),
// then FMP's image CDN (broad coverage incl. ADRs/OTC like SMPNY that Parqet
// lacks). TickerLogo walks this list and falls back to a monogram if all 404.
export function tickerLogoSources(ticker: string): string[] {
  const t = ticker.toUpperCase()
  const sources: string[] = []
  if (LOGO_OVERRIDES[t]) sources.push(LOGO_OVERRIDES[t])
  sources.push(`https://assets.parqet.com/logos/symbol/${ticker}?format=svg`)
  sources.push(`https://images.financialmodelingprep.com/symbol/${t}.png`)
  return sources
}

export function tickerLogoUrl(ticker: string, format: 'svg' | 'png' = 'svg'): string {
  return LOGO_OVERRIDES[ticker.toUpperCase()] ?? `https://assets.parqet.com/logos/symbol/${ticker}?format=${format}`
}

const RESERVED_TICKER_TOKENS = new Set([
  'MARKET', 'MACRO', 'GLOBAL', 'PORTFOLIO', 'PAIR', 'PEERS', 'SECTOR', 'RATES',
])

function validTickerToken(value: string): string | null {
  const ticker = value.trim().toUpperCase().replace('/', '.')
  return /^[A-Z][A-Z0-9.-]{0,7}$/.test(ticker) && !RESERVED_TICKER_TOKENS.has(ticker)
    ? ticker
    : null
}

export function parseTickerSymbols(value: string): string[] {
  const symbols: string[] = []
  for (const token of value.split(/[\s,;|]+/)) {
    const ticker = validTickerToken(token)
    if (ticker && !symbols.includes(ticker)) symbols.push(ticker)
  }
  return symbols
}

export function reportTickerSymbols(
  scopeSymbols: string,
  researchKeys: Array<string | undefined>,
  max = 4,
): string[] {
  const symbols = parseTickerSymbols(scopeSymbols)
  if (symbols.length) return symbols.slice(0, max)
  for (const key of researchKeys) {
    const prefix = key?.split(':', 1)[0] ?? ''
    const ticker = validTickerToken(prefix)
    if (ticker && !symbols.includes(ticker)) symbols.push(ticker)
    if (symbols.length >= max) break
  }
  return symbols.slice(0, max)
}

export function isTickerSymbol(value: string): boolean {
  return validTickerToken(value) != null
}

export function tickerLogoVisualScale(ticker: string): number {
  return LOGO_VISUAL_SCALE[ticker.toUpperCase()] ?? 0.9
}
