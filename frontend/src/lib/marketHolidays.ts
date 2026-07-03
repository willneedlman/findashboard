// Exchange holiday calendars for the market clock.
//
// Two sources of truth:
//  - RULE-GENERATED (any year): US equities, CME, LSE, XETRA, ASX — their
//    holidays are fixed dates, nth-weekday rules, or Easter-derived, all
//    computable forever.
//  - STATIC TABLES (verified against published exchange calendars): TSE, HKEX,
//    SSE, KRX, NSE run on lunar/solar-term dates that cannot be computed.
//    Coverage is listed per table; outside coverage the clock falls back to
//    the plain weekly schedule (the pre-holiday-support behavior).
//    Refresh path: append the next year's table when each exchange publishes
//    its calendar (usually Q4 of the prior year).
//
// earlyClose is minutes into the exchange's LOCAL day; absent = full closure.

export interface Holiday { name: string; earlyClose?: number }
type Table = Record<string, Holiday>          // 'YYYY-MM-DD' -> Holiday

const key = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()

// nth <weekday> of a month (n >= 1), e.g. nthWeekday(2026, 1, 1, 3) = 3rd Monday of Jan.
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = dow(y, m, 1)
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7
}

function lastWeekday(y: number, m: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return lastDay - ((dow(y, m, lastDay) - weekday + 7) % 7)
}

// Anonymous Gregorian computus -> [month, day] of Easter Sunday.
function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mo = Math.floor((h + l - 7 * m + 114) / 31)
  return [mo, ((h + l - 7 * m + 114) % 31) + 1]
}

// Calendar-date shift that survives month/year edges.
function shift(y: number, m: number, d: number, days: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}

const put = (t: Table, y: number, m: number, d: number, h: Holiday) => { t[key(y, m, d)] = h }

// US-style observance: Sat -> preceding Fri, Sun -> following Mon.
function putObservedUS(t: Table, y: number, m: number, d: number, name: string, skipSat = false) {
  const w = dow(y, m, d)
  if (w === 6) { if (!skipSat) put(t, ...shift(y, m, d, -1), { name: `${name} (observed)` }) }
  else if (w === 0) put(t, ...shift(y, m, d, 1), { name: `${name} (observed)` })
  else put(t, y, m, d, { name })
}

// UK/AU-style observance: weekend -> next available weekday (skipping `taken`).
function putObservedNext(t: Table, y: number, m: number, d: number, name: string) {
  let [yy, mm, dd] = [y, m, d]
  while (dow(yy, mm, dd) === 0 || dow(yy, mm, dd) === 6 || t[key(yy, mm, dd)]) {
    [yy, mm, dd] = shift(yy, mm, dd, 1)
  }
  put(t, yy, mm, dd, { name: dd === d && mm === m ? name : `${name} (observed)` })
}

function usEquityTable(y: number): Table {
  const t: Table = {}
  // NYSE does not close the prior Dec 31 when Jan 1 falls on Saturday.
  putObservedUS(t, y, 1, 1, "New Year's Day", true)
  put(t, y, 1, nthWeekday(y, 1, 1, 3), { name: 'Martin Luther King Jr. Day' })
  put(t, y, 2, nthWeekday(y, 2, 1, 3), { name: "Presidents' Day" })
  const [em, ed] = easter(y)
  put(t, ...shift(y, em, ed, -2), { name: 'Good Friday' })
  put(t, y, 5, lastWeekday(y, 5, 1), { name: 'Memorial Day' })
  putObservedUS(t, y, 6, 19, 'Juneteenth')
  putObservedUS(t, y, 7, 4, 'Independence Day')
  put(t, y, 9, nthWeekday(y, 9, 1, 1), { name: 'Labor Day' })
  const tg = nthWeekday(y, 11, 4, 4)
  put(t, y, 11, tg, { name: 'Thanksgiving' })
  putObservedUS(t, y, 12, 25, 'Christmas Day')
  // 13:00 ET early closes; never override a full closure already on the date.
  const early = (m: number, d: number, name: string) => {
    const w = dow(y, m, d)
    if (w >= 1 && w <= 5 && !t[key(y, m, d)]) put(t, y, m, d, { name, earlyClose: 13 * 60 })
  }
  early(7, 3, 'Independence Day eve')
  early(11, tg + 1, 'Day after Thanksgiving')
  early(12, 24, 'Christmas Eve')
  return t
}

// CME equity futures: Good Friday is a full close; on other US holidays Globex
// trades a shortened session (modeled as a 13:00 ET early close for the day).
function cmeTable(y: number): Table {
  const us = usEquityTable(y)
  const t: Table = {}
  for (const [k, h] of Object.entries(us)) {
    t[k] = h.name === 'Good Friday' ? h : { name: h.name, earlyClose: h.earlyClose ?? 13 * 60 }
  }
  return t
}

function lseTable(y: number): Table {
  const t: Table = {}
  putObservedNext(t, y, 1, 1, "New Year's Day")
  const [em, ed] = easter(y)
  put(t, ...shift(y, em, ed, -2), { name: 'Good Friday' })
  put(t, ...shift(y, em, ed, 1), { name: 'Easter Monday' })
  put(t, y, 5, nthWeekday(y, 5, 1, 1), { name: 'Early May Bank Holiday' })
  put(t, y, 5, lastWeekday(y, 5, 1), { name: 'Spring Bank Holiday' })
  put(t, y, 8, lastWeekday(y, 8, 1), { name: 'Summer Bank Holiday' })
  putObservedNext(t, y, 12, 25, 'Christmas Day')
  putObservedNext(t, y, 12, 26, 'Boxing Day')
  // 12:30 early closes on the eves when they are trading days.
  for (const [m, d, name] of [[12, 24, 'Christmas Eve'], [12, 31, "New Year's Eve"]] as const) {
    const w = dow(y, m, d)
    if (w >= 1 && w <= 5 && !t[key(y, m, d)]) put(t, y, m, d, { name, earlyClose: 12 * 60 + 30 })
  }
  return t
}

function xetraTable(y: number): Table {
  const t: Table = {}
  put(t, y, 1, 1, { name: "New Year's Day" })
  const [em, ed] = easter(y)
  put(t, ...shift(y, em, ed, -2), { name: 'Good Friday' })
  put(t, ...shift(y, em, ed, 1), { name: 'Easter Monday' })
  put(t, y, 5, 1, { name: 'Labour Day' })
  put(t, y, 12, 24, { name: 'Christmas Eve' })
  put(t, y, 12, 25, { name: 'Christmas Day' })
  put(t, y, 12, 26, { name: 'Boxing Day' })
  put(t, y, 12, 31, { name: "New Year's Eve" })
  return t
}

function asxTable(y: number): Table {
  const t: Table = {}
  putObservedNext(t, y, 1, 1, "New Year's Day")
  putObservedNext(t, y, 1, 26, 'Australia Day')
  const [em, ed] = easter(y)
  put(t, ...shift(y, em, ed, -2), { name: 'Good Friday' })
  put(t, ...shift(y, em, ed, 1), { name: 'Easter Monday' })
  const anzac = dow(y, 4, 25)
  if (anzac >= 1 && anzac <= 5) put(t, y, 4, 25, { name: 'Anzac Day' })
  put(t, y, 6, nthWeekday(y, 6, 1, 2), { name: "King's Birthday" })
  putObservedNext(t, y, 12, 25, 'Christmas Day')
  putObservedNext(t, y, 12, 26, 'Boxing Day')
  // 14:10 early closes on trading eves.
  for (const [m, d, name] of [[12, 24, 'Christmas Eve'], [12, 31, "New Year's Eve"]] as const) {
    const w = dow(y, m, d)
    if (w >= 1 && w <= 5 && !t[key(y, m, d)]) put(t, y, m, d, { name, earlyClose: 14 * 60 + 10 })
  }
  return t
}

// ── Static tables (verified against published 2026 exchange calendars) ───────

const TSE_STATIC: Table = {
  '2026-01-01': { name: "New Year's Day" }, '2026-01-02': { name: 'Market Holiday' },
  '2026-01-12': { name: 'Coming of Age Day' }, '2026-02-11': { name: 'National Foundation Day' },
  '2026-02-23': { name: "Emperor's Birthday" }, '2026-03-20': { name: 'Vernal Equinox Day' },
  '2026-04-29': { name: 'Showa Day' }, '2026-05-04': { name: 'Greenery Day' },
  '2026-05-05': { name: "Children's Day" }, '2026-05-06': { name: 'Constitution Day (observed)' },
  '2026-07-20': { name: 'Marine Day' }, '2026-08-11': { name: 'Mountain Day' },
  '2026-09-21': { name: 'Respect for the Aged Day' }, '2026-09-22': { name: 'Bridge Holiday' },
  '2026-09-23': { name: 'Autumnal Equinox Day' }, '2026-10-12': { name: 'Sports Day' },
  '2026-11-03': { name: 'Culture Day' }, '2026-11-23': { name: 'Labor Thanksgiving Day' },
  '2026-12-31': { name: 'Year-End Holiday' },
}

const HKEX_STATIC: Table = {
  '2026-01-01': { name: "New Year's Day" },
  '2026-02-16': { name: 'Lunar New Year Eve', earlyClose: 12 * 60 },
  '2026-02-17': { name: 'Lunar New Year' }, '2026-02-18': { name: 'Lunar New Year' },
  '2026-02-19': { name: 'Lunar New Year' }, '2026-04-03': { name: 'Good Friday' },
  '2026-04-06': { name: 'Ching Ming Festival (observed)' }, '2026-04-07': { name: 'Easter Monday (observed)' },
  '2026-05-01': { name: 'Labour Day' }, '2026-05-25': { name: "Buddha's Birthday (observed)" },
  '2026-06-19': { name: 'Tuen Ng Festival' }, '2026-07-01': { name: 'HKSAR Establishment Day' },
  '2026-10-01': { name: 'National Day' }, '2026-10-19': { name: 'Chung Yeung Festival (observed)' },
  '2026-12-24': { name: 'Christmas Eve', earlyClose: 12 * 60 },
  '2026-12-25': { name: 'Christmas Day' },
  '2026-12-31': { name: "New Year's Eve", earlyClose: 12 * 60 },
}

const SSE_STATIC: Table = (() => {
  const t: Table = {
    '2026-01-01': { name: "New Year's Day" }, '2026-01-02': { name: "New Year's Day" },
    '2026-04-06': { name: 'Qingming Festival' }, '2026-06-19': { name: 'Dragon Boat Festival' },
    '2026-09-25': { name: 'Mid-Autumn Festival' },
  }
  for (let d = 16; d <= 23; d++) t[key(2026, 2, d)] = { name: 'Spring Festival' }
  for (let d = 1; d <= 5; d++) t[key(2026, 5, d)] = { name: 'Labour Day' }
  for (let d = 1; d <= 7; d++) t[key(2026, 10, d)] = { name: 'National Day' }
  return t
})()

const KRX_STATIC: Table = {
  '2026-01-01': { name: "New Year's Day" },
  '2026-02-16': { name: 'Seollal' }, '2026-02-17': { name: 'Seollal' }, '2026-02-18': { name: 'Seollal' },
  '2026-03-02': { name: 'Independence Movement Day (observed)' },
  '2026-05-01': { name: 'Labor Day' }, '2026-05-05': { name: "Children's Day" },
  '2026-05-25': { name: "Buddha's Birthday (observed)" },
  '2026-06-03': { name: 'Local Elections' },
  '2026-07-17': { name: 'Constitution Day' },
  '2026-08-17': { name: 'Liberation Day (observed)' },
  '2026-09-24': { name: 'Chuseok' }, '2026-09-25': { name: 'Chuseok' },
  '2026-10-05': { name: 'National Foundation Day (observed)' },
  '2026-10-09': { name: 'Hangul Day' },
  '2026-12-25': { name: 'Christmas Day' }, '2026-12-31': { name: 'Year-End Holiday' },
}

const NSE_STATIC: Table = {
  '2026-01-26': { name: 'Republic Day' }, '2026-02-16': { name: 'Mahashivratri' },
  '2026-03-04': { name: 'Holi' }, '2026-03-20': { name: 'Id-ul-Fitr' },
  '2026-03-27': { name: 'Ram Navami' }, '2026-04-02': { name: 'Mahavir Jayanti' },
  '2026-04-03': { name: 'Good Friday' }, '2026-05-01': { name: 'Maharashtra Day' },
  '2026-05-27': { name: 'Id-ul-Zuha' }, '2026-07-27': { name: 'Moharram' },
  '2026-08-26': { name: "Id-E-Milad" }, '2026-10-02': { name: 'Gandhi Jayanti' },
  '2026-11-09': { name: 'Diwali (Muhurat session only)' }, '2026-11-10': { name: 'Diwali Balipratipada' },
  '2026-11-24': { name: 'Guru Nanak Jayanti' }, '2026-12-25': { name: 'Christmas Day' },
}

// Years the static tables cover; outside this range those markets fall back to
// the weekly schedule only.
export const STATIC_COVERAGE = [2026]

const ruleGen: Record<string, (y: number) => Table> = {
  nyse: usEquityTable, nasdaq: usEquityTable, cme: cmeTable,
  lse: lseTable, xetra: xetraTable, asx: asxTable,
}
const staticTables: Record<string, Table> = {
  tse: TSE_STATIC, hkex: HKEX_STATIC, sse: SSE_STATIC, krx: KRX_STATIC, nse: NSE_STATIC,
}

const genCache = new Map<string, Table>()

export function holidayFor(marketId: string, y: number, m: number, d: number): Holiday | null {
  const gen = ruleGen[marketId]
  if (gen) {
    const ck = `${marketId}:${y}`
    let t = genCache.get(ck)
    if (!t) { t = gen(y); genCache.set(ck, t) }
    return t[key(y, m, d)] ?? null
  }
  return staticTables[marketId]?.[key(y, m, d)] ?? null
}
