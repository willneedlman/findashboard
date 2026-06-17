export interface MarketSession { key: string; label: string; color: string }

// Current US-equity trading session in America/New_York. Holidays are not
// modeled (they read as the weekday session). Boundaries in ET:
//   pre-market 4:00–9:30 · open 9:30–16:00 · after-hours 16:00–20:00 ·
//   overnight 20:00–4:00 (closed) · weekends closed.
export function marketSession(d: Date = new Date()): MarketSession {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()
  const mins = et.getHours() * 60 + et.getMinutes()
  if (day === 0 || day === 6) return { key: 'weekend', label: 'Weekend · Closed', color: '#5e768f' }
  if (mins >= 240 && mins < 570)  return { key: 'pre',       label: 'Pre-market',        color: '#60a5fa' }
  if (mins >= 570 && mins < 960)  return { key: 'open',      label: 'Market Open',       color: '#22c55e' }
  if (mins >= 960 && mins < 1200) return { key: 'after',     label: 'After-hours',       color: '#f59e0b' }
  return { key: 'overnight', label: 'Overnight · Closed', color: '#5e768f' }
}
