export interface MarketSession { key: string; label: string; color: string }

const GREEN = '#22c55e', BLUE = '#60a5fa', AMBER = '#f59e0b', GREY = '#5e768f'

// Current trading session for a symbol, in America/New_York. The asset class is
// inferred from the symbol so a 24/7 crypto pair never reads "overnight" and
// futures/FX follow their own near-24h sessions. Holidays are not modeled.
export function marketSession(d: Date = new Date(), ticker = ''): MarketSession {
  const sym = ticker.toUpperCase()
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()                 // 0 Sun .. 6 Sat
  const mins = et.getHours() * 60 + et.getMinutes()
  const H17 = 17 * 60, H18 = 18 * 60      // 5pm / 6pm ET

  // Crypto — trades 24/7
  if (/-USD$/.test(sym) || /^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC|BNB|AVAX|DOT|MATIC)$/.test(sym))
    return { key: 'crypto', label: 'Crypto · 24/7', color: GREEN }

  // Futures — Globex, ~Sun 18:00 → Fri 17:00 ET with a daily 17:00-18:00 break
  if (/=F$/.test(sym)) {
    const closed = day === 6 || (day === 0 && mins < H18) || (day === 5 && mins >= H17) || (mins >= H17 && mins < H18)
    return closed ? { key: 'fut-closed', label: 'Futures · Closed', color: GREY }
                  : { key: 'fut', label: 'Futures · Open', color: GREEN }
  }

  // FX — 24/5, ~Sun 17:00 → Fri 17:00 ET
  if (/=X$/.test(sym)) {
    const closed = day === 6 || (day === 0 && mins < H17) || (day === 5 && mins >= H17)
    return closed ? { key: 'fx-closed', label: 'FX · Closed', color: GREY }
                  : { key: 'fx', label: 'FX · 24/5', color: GREEN }
  }

  // US equities / ETFs / indices
  if (day === 0 || day === 6) return { key: 'weekend', label: 'Weekend · Closed', color: GREY }
  if (mins >= 240 && mins < 570)  return { key: 'pre',       label: 'Pre-market',        color: BLUE }
  if (mins >= 570 && mins < 960)  return { key: 'open',      label: 'Market Open',       color: GREEN }
  if (mins >= 960 && mins < 1200) return { key: 'after',     label: 'After-hours',       color: AMBER }
  return { key: 'overnight', label: 'Overnight · Closed', color: GREY }
}
