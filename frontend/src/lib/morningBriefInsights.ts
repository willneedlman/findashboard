// Pure insight engine for the Home morning brief.
// Turns priced holdings + benchmark into book-specific takeaways Home does not surface.

export interface BriefPosition {
  ticker: string
  shares: number
  value: number
  cost: number
  pnl: number
  pnlPct: number
  dayPnl: number
  pct1d: number
  price: number
}

export interface DayAttr {
  ticker: string
  dayPnl: number
  pct1d: number
  value: number
  weight: number
  /** Share of absolute day P&L explained by this name (0–1). */
  impactShare: number
}

export interface WeightRow {
  ticker: string
  weight: number
  value: number
  /** Dollar book move if this name moves 5%. */
  move5pct: number
}

export interface UnderwaterRow {
  ticker: string
  pnl: number
  pnlPct: number
  value: number
  /** % rise needed to get back to cost. */
  recoveryPct: number
}

export interface BookInsights {
  equityValue: number
  totalValue: number
  cash: number
  cashWeight: number
  dayPnl: number
  dayPct: number
  breadth: { up: number; down: number; flat: number }
  dayAttribution: DayAttr[]
  concentration: WeightRow[]
  underwater: UnderwaterRow[]
  vsSpy: { bookPct: number; spyPct: number; alphaPct: number } | null
  /** Single lead sentence. */
  headline: string
  /** Short supporting points unique to this book. */
  takeaways: string[]
}

const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`
const pct = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
const pp = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}pp`

export function buildBookInsights(
  positions: BriefPosition[],
  cash: number,
  spyPct1d: number | null | undefined,
): BookInsights {
  const priced = positions.filter(p => p.value > 0 || p.shares > 0)
  const equityValue = priced.reduce((s, p) => s + p.value, 0)
  const totalValue = equityValue + Math.max(0, cash)
  const dayPnl = priced.reduce((s, p) => s + p.dayPnl, 0)
  const dayPct = equityValue - dayPnl > 0 ? (dayPnl / (equityValue - dayPnl)) * 100 : 0
  const cashWeight = totalValue > 0 ? cash / totalValue : 0

  let up = 0, down = 0, flat = 0
  for (const p of priced) {
    if (p.pct1d > 0.05) up++
    else if (p.pct1d < -0.05) down++
    else flat++
  }

  const absDay = priced.reduce((s, p) => s + Math.abs(p.dayPnl), 0) || 1
  const dayAttribution: DayAttr[] = [...priced]
    .map(p => ({
      ticker: p.ticker,
      dayPnl: p.dayPnl,
      pct1d: p.pct1d,
      value: p.value,
      weight: equityValue > 0 ? p.value / equityValue : 0,
      impactShare: Math.abs(p.dayPnl) / absDay,
    }))
    .sort((a, b) => Math.abs(b.dayPnl) - Math.abs(a.dayPnl))

  const concentration: WeightRow[] = [...priced]
    .map(p => ({
      ticker: p.ticker,
      weight: equityValue > 0 ? p.value / equityValue : 0,
      value: p.value,
      move5pct: p.value * 0.05,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)

  const underwater: UnderwaterRow[] = priced
    .filter(p => p.pnl < -1 && p.cost > 0)
    .map(p => ({
      ticker: p.ticker,
      pnl: p.pnl,
      pnlPct: p.pnlPct * 100,
      value: p.value,
      recoveryPct: p.price > 0 ? ((p.cost / p.shares) / p.price - 1) * 100 : 0,
    }))
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 4)

  const vsSpy = spyPct1d != null && Number.isFinite(spyPct1d)
    ? { bookPct: dayPct, spyPct: spyPct1d, alphaPct: dayPct - spyPct1d }
    : null

  const { headline, takeaways } = synthesize(priced, {
    dayPnl, dayPct, cashWeight, totalValue, equityValue,
    dayAttribution, concentration, underwater, vsSpy, up, down,
  })

  return {
    equityValue,
    totalValue,
    cash,
    cashWeight,
    dayPnl,
    dayPct,
    breadth: { up, down, flat },
    dayAttribution,
    concentration,
    underwater,
    vsSpy,
    headline,
    takeaways,
  }
}

function synthesize(
  priced: BriefPosition[],
  x: {
    dayPnl: number
    dayPct: number
    cashWeight: number
    totalValue: number
    equityValue: number
    dayAttribution: DayAttr[]
    concentration: WeightRow[]
    underwater: UnderwaterRow[]
    vsSpy: { bookPct: number; spyPct: number; alphaPct: number } | null
    up: number
    down: number
  },
): { headline: string; takeaways: string[] } {
  if (!priced.length) {
    return {
      headline: 'No positions loaded yet.',
      takeaways: [
        'Add holdings in Portfolio Manager to get a book-specific morning read.',
        'Day attribution, concentration, and held-name earnings only work once the book is live.',
      ],
    }
  }

  const top = x.dayAttribution[0]
  const topW = x.concentration[0]
  const takeaways: string[] = []

  // Headline: one plain sentence. Exact % / $ live in the KPI strip and lines below.
  let headline: string
  if (top && top.impactShare >= 0.4 && Math.abs(top.dayPnl) >= 5) {
    if (top.dayPnl < 0 && x.dayPnl < 0) {
      headline = `${top.ticker} did most of the damage today.`
    } else if (top.dayPnl >= 0 && x.dayPnl >= 0) {
      headline = `${top.ticker} carried most of today's gain.`
    } else {
      headline = `${top.ticker} dominated today's P&L.`
    }
  } else if (x.vsSpy && Math.abs(x.vsSpy.alphaPct) >= 0.25) {
    if (x.dayPct >= 0 && x.vsSpy.alphaPct >= 0) {
      headline = 'Up on the day, and ahead of the market.'
    } else if (x.dayPct < 0 && x.vsSpy.alphaPct >= 0) {
      headline = 'Down on the day, but still ahead of SPY.'
    } else if (x.dayPct >= 0 && x.vsSpy.alphaPct < 0) {
      headline = 'Up on the day, but lagging SPY.'
    } else {
      headline = 'Down on the day, and lagging SPY.'
    }
  } else if (Math.abs(x.dayPct) < 0.2) {
    headline = 'Quiet day — little net move in the book.'
  } else if (x.dayPct >= 0) {
    headline = 'Book finished higher today.'
  } else {
    headline = 'Book finished lower today.'
  }

  // Exact numbers as supporting lines (not jammed into the headline).
  takeaways.push(
    `Net day P&L ${money(x.dayPnl)} (${pct(x.dayPct, 2)}) across ${priced.length} names · ${x.up} up, ${x.down} down.`,
  )

  if (top && Math.abs(top.dayPnl) >= 1) {
    const second = x.dayAttribution[1]
    let line = `${top.ticker} moved the book ${money(top.dayPnl)} on a ${pct(top.pct1d)} day.`
    if (second && Math.abs(second.dayPnl) >= 1) {
      line += ` ${second.ticker} was next at ${money(second.dayPnl)}.`
    }
    takeaways.push(line)
  }

  if (x.vsSpy && Math.abs(x.vsSpy.alphaPct) >= 0.15) {
    const beat = x.vsSpy.alphaPct >= 0
    takeaways.push(
      beat
        ? `Relative to SPY (${pct(x.vsSpy.spyPct, 2)}), the book is ahead by ${Math.abs(x.vsSpy.alphaPct).toFixed(2)} percentage points.`
        : `Relative to SPY (${pct(x.vsSpy.spyPct, 2)}), the book is behind by ${Math.abs(x.vsSpy.alphaPct).toFixed(2)} percentage points.`,
    )
  }

  if (topW && topW.weight >= 0.18) {
    takeaways.push(
      `${topW.ticker} is ${Math.round(topW.weight * 100)}% of equity — a 5% move is about ${money(topW.move5pct)} of book value.`,
    )
  } else if (topW && x.concentration.length >= 3) {
    const top3 = x.concentration.slice(0, 3)
    const top3W = top3.reduce((s, r) => s + r.weight, 0)
    if (top3W >= 0.55) {
      takeaways.push(
        `${top3.map(r => r.ticker).join(', ')} make up ${Math.round(top3W * 100)}% of equity — risk is concentrated in a few names.`,
      )
    }
  }

  if (x.underwater.length) {
    const u = x.underwater[0]
    const more = x.underwater.length > 1
      ? ` ${x.underwater.length - 1} other name${x.underwater.length > 2 ? 's are' : ' is'} also below cost.`
      : ''
    takeaways.push(
      `${u.ticker} sits ${money(Math.abs(u.pnl))} under cost (${pct(u.pnlPct)}); it needs roughly ${pct(u.recoveryPct)} to get back to even.${more}`,
    )
  }

  if (x.cashWeight >= 0.08 && x.totalValue > 0) {
    takeaways.push(
      `Cash is ${Math.round(x.cashWeight * 100)}% of the book (${money(x.cashWeight * x.totalValue)}), which softens day moves and beta vs SPY.`,
    )
  }

  if (priced.length >= 3 && x.up + x.down >= 3) {
    if (x.down >= x.up * 2 && x.dayPct > -0.15) {
      takeaways.push(`Breadth is soft: ${x.down} names down vs ${x.up} up, even with a modest headline move.`)
    } else if (x.up >= x.down * 2 && x.dayPct < 0.15) {
      takeaways.push(`Breadth is firm: ${x.up} names up vs ${x.down} down under a quiet headline.`)
    }
  }

  return { headline, takeaways: takeaways.slice(0, 5) }
}

export function daysUntil(dateStr: string, from = new Date()): number {
  // Both anchors pinned to local noon (not midnight) so the diff rounds to a
  // clean whole-day count — midnight-vs-noon skewed every result up by one,
  // reading today's earnings as "tomorrow" and yesterday's as "today".
  const a = new Date(from); a.setHours(12, 0, 0, 0)
  const b = new Date(dateStr + 'T12:00:00')
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}
