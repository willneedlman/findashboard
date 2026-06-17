// Single source of truth for ticker logos. Custom overrides win over the
// default provider so a symbol shows the right brand everywhere (sidebar,
// dashboards, scans, holdings). Keyed by uppercased symbol; values are public paths.
export const LOGO_OVERRIDES: Record<string, string> = {
  RVI: '/logos/rvi.png',
}

export function tickerLogoUrl(ticker: string, format: 'svg' | 'png' = 'svg'): string {
  return LOGO_OVERRIDES[ticker.toUpperCase()] ?? `https://assets.parqet.com/logos/symbol/${ticker}?format=${format}`
}
