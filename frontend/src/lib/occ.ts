// OCC option symbol helpers, shared by the Paper Trading page and the dashboard
// paper-trade widget. Format: <UNDERLYING><YYMMDD><C|P><strike*1000, 8 digits>.
export function buildOCC(underlying: string, expDate: string, strike: string, callPut: 'C' | 'P'): string {
  if (!underlying || !expDate || !strike || isNaN(parseFloat(strike))) return ''
  const d = new Date(expDate + 'T00:00:00')
  const yy = String(d.getFullYear()).slice(2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const strikeInt = Math.round(parseFloat(strike) * 1000)
  return `${underlying.toUpperCase()}${yy}${mm}${dd}${callPut}${String(strikeInt).padStart(8, '0')}`
}

// True only for a full OCC contract symbol (e.g. SPY250620C00580000).
export function isOCC(s: string): boolean {
  return /^[A-Z.]+\d{6}[CP]\d{8}$/.test((s || '').trim().toUpperCase())
}

// Underlying ticker from an OCC symbol, else '' (avoids prefix-match leakage).
export function occUnderlying(s: string): string {
  return ((s || '').trim().toUpperCase().match(/^([A-Z.]+)\d{6}[CP]\d{8}$/)?.[1]) || ''
}

export function parseOCC(occ: string): { expDate: string; strike: string; callPut: 'C' | 'P' } | null {
  const m = occ.trim().toUpperCase().match(/[A-Z]+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
  if (!m) return null
  const [, yy, mm, dd, cp, strike] = m
  return { expDate: `20${yy}-${mm}-${dd}`, strike: String(parseInt(strike, 10) / 1000), callPut: cp as 'C' | 'P' }
}
