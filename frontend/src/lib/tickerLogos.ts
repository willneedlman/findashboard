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
