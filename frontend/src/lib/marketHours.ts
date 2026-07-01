// Deterministic global market-session clock. Sessions are computed purely from
// each market's timezone and weekly schedule (no API, no rate limits). Regular
// holidays are NOT modeled — a market shown "open" on a holiday is the known
// caveat. All times are derived from the live Date via Intl timezone parts.

export type Phase = 'closed' | 'overnight' | 'pre' | 'regular' | 'after' | 'break'
export type Region = 'Futures' | 'Americas' | 'Europe' | 'Asia-Pacific'

const DAY = 1440          // minutes per day
const WEEK = DAY * 7

interface Segment { start: number; end: number; phase: Phase }   // week-minutes, [start,end)

export interface MarketDef {
  id: string
  name: string
  short: string
  region: Region
  tz: string
  segments: Segment[]
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const seg = (day: number, start: string, end: string, phase: Phase): Segment => ({
  start: day * DAY + toMin(start),
  end:   day * DAY + (end === '24:00' ? DAY : toMin(end)),
  phase,
})

// Same window(s) every weekday (Mon-Fri).
function weekdays(windows: [string, string, Phase][]): Segment[] {
  const out: Segment[] = []
  for (let d = 1; d <= 5; d++) for (const [s, e, p] of windows) out.push(seg(d, s, e, p))
  return out
}

// US equities: pre / regular / after each weekday, plus overnight sessions that
// run Sun-Thu evenings into the next morning (no Fri-night session).
function usEquity(): Segment[] {
  const out: Segment[] = []
  for (let d = 1; d <= 5; d++) {
    out.push(seg(d, '04:00', '09:30', 'pre'))
    out.push(seg(d, '09:30', '16:00', 'regular'))
    out.push(seg(d, '16:00', '20:00', 'after'))
  }
  for (const d of [0, 1, 2, 3, 4]) {       // Sun..Thu evening -> next morning
    out.push(seg(d, '20:00', '24:00', 'overnight'))
    out.push(seg((d + 1) % 7, '00:00', '04:00', 'overnight'))
  }
  return out
}

// CME Globex equity futures: Sun 18:00 -> Fri 17:00 ET, 17:00-18:00 daily halt.
function cmeFutures(): Segment[] {
  const out: Segment[] = [seg(0, '18:00', '24:00', 'regular')]
  for (let d = 1; d <= 4; d++) {           // Mon-Thu, halt 17:00-18:00
    out.push(seg(d, '00:00', '17:00', 'regular'))
    out.push(seg(d, '18:00', '24:00', 'regular'))
  }
  out.push(seg(5, '00:00', '17:00', 'regular'))   // Fri close 17:00
  return out
}

export const MARKETS: MarketDef[] = [
  { id: 'cme',   name: 'CME E-mini (S&P 500)', short: 'ES',    region: 'Futures',      tz: 'America/New_York', segments: cmeFutures() },
  { id: 'nyse',  name: 'NYSE',                 short: 'NYSE',  region: 'Americas',     tz: 'America/New_York', segments: usEquity() },
  { id: 'nasdaq',name: 'Nasdaq',               short: 'NDAQ',  region: 'Americas',     tz: 'America/New_York', segments: usEquity() },
  { id: 'lse',   name: 'London (LSE)',         short: 'LON',   region: 'Europe',       tz: 'Europe/London',    segments: weekdays([['08:00', '16:30', 'regular']]) },
  { id: 'xetra', name: 'Frankfurt (XETRA)',    short: 'FRA',   region: 'Europe',       tz: 'Europe/Berlin',    segments: weekdays([['09:00', '17:30', 'regular']]) },
  { id: 'tse',   name: 'Tokyo (TSE)',          short: 'TYO',   region: 'Asia-Pacific', tz: 'Asia/Tokyo',       segments: weekdays([['09:00', '11:30', 'regular'], ['11:30', '12:30', 'break'], ['12:30', '15:00', 'regular']]) },
  { id: 'hkex',  name: 'Hong Kong (HKEX)',     short: 'HKG',   region: 'Asia-Pacific', tz: 'Asia/Hong_Kong',   segments: weekdays([['09:30', '12:00', 'regular'], ['12:00', '13:00', 'break'], ['13:00', '16:00', 'regular']]) },
  { id: 'sse',   name: 'Shanghai (SSE)',       short: 'SHA',   region: 'Asia-Pacific', tz: 'Asia/Shanghai',    segments: weekdays([['09:30', '11:30', 'regular'], ['11:30', '13:00', 'break'], ['13:00', '15:00', 'regular']]) },
  { id: 'krx',   name: 'Seoul (KRX)',          short: 'SEO',   region: 'Asia-Pacific', tz: 'Asia/Seoul',       segments: weekdays([['09:00', '15:30', 'regular']]) },
  { id: 'asx',   name: 'Sydney (ASX)',         short: 'SYD',   region: 'Asia-Pacific', tz: 'Australia/Sydney', segments: weekdays([['10:00', '16:00', 'regular']]) },
  { id: 'nse',   name: 'Mumbai (NSE)',         short: 'BOM',   region: 'Asia-Pacific', tz: 'Asia/Kolkata',     segments: weekdays([['09:15', '15:30', 'regular']]) },
]

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

interface LocalParts { weekday: number; hour: number; minute: number; second: number; wkMin: number; timeStr: string }

function localParts(tz: string, now: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce<Record<string, string>>((a, p) => { a[p.type] = p.value; return a }, {})
  const weekday = WD[parts.weekday] ?? 0
  let hour = parseInt(parts.hour, 10); if (hour === 24) hour = 0
  const minute = parseInt(parts.minute, 10)
  const second = parseInt(parts.second, 10)
  const wkMin = weekday * DAY + hour * 60 + minute + second / 60
  return { weekday, hour, minute, second, wkMin, timeStr: `${String(hour).padStart(2, '0')}:${parts.minute}:${parts.second}` }
}

const phaseAt = (segs: Segment[], wkMin: number): Phase => {
  for (const s of segs) if (wkMin >= s.start && wkMin < s.end) return s.phase
  return 'closed'
}

export interface MarketStatus {
  phase: Phase
  open: boolean              // tradeable now (any non-closed/break phase that's regular/pre/after/overnight)
  localTime: string
  weekday: number
  msToNext: number           // until the next phase boundary
  nextPhase: Phase
}

export function marketStatus(m: MarketDef, now: Date): MarketStatus {
  const lp = localParts(m.tz, now)
  const phase = phaseAt(m.segments, lp.wkMin)
  // Next boundary: smallest segment start/end strictly after wkMin, wrapping the week.
  let best = Infinity
  for (const s of m.segments) {
    for (const b of [s.start, s.end]) {
      let d = b - lp.wkMin
      if (d <= 1e-6) d += WEEK
      if (d < best) best = d
    }
  }
  if (!isFinite(best)) best = WEEK
  const nextWk = (lp.wkMin + best) % WEEK
  const nextPhase = phaseAt(m.segments, nextWk + 1e-6)
  return {
    phase,
    open: phase === 'regular' || phase === 'pre' || phase === 'after' || phase === 'overnight',
    localTime: lp.timeStr,
    weekday: lp.weekday,
    msToNext: best * 60000,
    nextPhase,
  }
}

// Session segments clipped to a single weekday [0..1440), for a 24h timeline bar
// drawn in the market's own local time.
export function daySegments(m: MarketDef, weekday: number): { start: number; end: number; phase: Phase }[] {
  const lo = weekday * DAY, hi = lo + DAY
  return m.segments
    .filter(s => s.start < hi && s.end > lo)
    .map(s => ({ start: Math.max(s.start, lo) - lo, end: Math.min(s.end, hi) - lo, phase: s.phase }))
    .sort((a, b) => a.start - b.start)
}

export const PHASE_LABEL: Record<Phase, string> = {
  closed: 'Closed', overnight: 'Overnight', pre: 'Pre-market', regular: 'Open', after: 'After-hours', break: 'Lunch break',
}

export const PHASE_COLOR: Record<Phase, string> = {
  regular:   'var(--theme-positive, #22c55e)',
  pre:       'var(--theme-primary, #c9a84c)',
  after:     'var(--theme-primary, #c9a84c)',
  overnight: 'var(--theme-tertiary, #60a5fa)',
  break:     'var(--theme-secondary, #8099b0)',
  closed:    'var(--theme-text-faint, rgba(255,255,255,0.25))',
}

export function countdown(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}
