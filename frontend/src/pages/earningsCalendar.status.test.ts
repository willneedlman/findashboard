/**
 * Result-column state machine for the earnings scanner.
 *
 * Regression guard for the false "resched. NOV 6" labels: yfinance's nextDate is
 * its nearest FUTURE earnings date, so the day after a company reports it rolls to
 * the NEXT QUARTER. Reading that as a reschedule of the row's own date claimed
 * reports that had already come out were moved months later.
 *
 * The fixtures are the real API values captured 2026-08-06 for the tickers on the
 * screenshot Will reported.
 */
import { describe, it, expect } from 'vitest'
import { calendarMismatchDate, hasReportedFigures, sourceHasGapAt, type Enriched } from './earningsCalendarStatus'

const TODAY = '2026-08-06'
const ROW = '2026-08-05'

// Captured from /api/earnings/enrich on 2026-08-06. Every one of these reported on
// Aug 5, yet Yahoo still showed the PREVIOUS quarter as the last report and the
// NEXT quarter as upcoming.
const GAPPED: Record<string, Enriched> = {
  SNDK: { priorReportDate: '2026-04-30', reportedEps: 23.41, surprisePct: 59.67, nextDate: '2026-11-06' },
  SHOP: { priorReportDate: '2026-05-05', reportedEps: 0.36, surprisePct: 8.56, nextDate: '2026-11-03' },
  UBER: { priorReportDate: '2026-05-06', reportedEps: 0.13, surprisePct: -81.74, nextDate: '2026-11-03' },
  CVS: { priorReportDate: '2026-05-06', reportedEps: 2.57, surprisePct: 16.48, nextDate: '2026-10-28' },
  DIS: { priorReportDate: '2026-05-06', reportedEps: 1.57, surprisePct: 4.98, nextDate: '2026-11-12' },
  LLY: { priorReportDate: '2026-04-30', reportedEps: 8.55, surprisePct: 25.9, nextDate: '2026-10-29' },
}

describe('a past report sitting in a yfinance schedule gap', () => {
  it('is never labelled rescheduled', () => {
    for (const [sym, e] of Object.entries(GAPPED)) {
      expect(calendarMismatchDate(e, ROW, TODAY), `${sym} must not claim a reschedule`).toBeNull()
    }
  })

  it('is recognised as reported with figures pending', () => {
    for (const [sym, e] of Object.entries(GAPPED)) {
      expect(sourceHasGapAt(e, ROW, TODAY), `${sym} should read as awaiting figures`).toBe(true)
    }
  })
})

describe('calendarMismatchDate', () => {
  it('still flags a genuine future reschedule', () => {
    // Row is next week, yfinance says the report is a week later than that.
    const e: Enriched = { priorReportDate: '2026-05-06', nextDate: '2026-08-20' }
    expect(calendarMismatchDate(e, '2026-08-13', TODAY)).toBe('2026-08-20')
  })

  it('still flags a calendar date that a confirmed nearby past report contradicts', () => {
    // No future date at all, but yfinance confirms it reported 2 days off the
    // calendar's date — the calendar source simply had the wrong day.
    const e: Enriched = { priorReportDate: '2026-08-03', reportedEps: 1.2, surprisePct: 4 }
    expect(calendarMismatchDate(e, '2026-08-05', TODAY)).toBe('2026-08-03')
  })

  it('does not flag a row whose date matches the confirmed report', () => {
    const e: Enriched = { priorReportDate: ROW, reportedEps: 1.2, surprisePct: 4, nextDate: '2026-11-05' }
    expect(calendarMismatchDate(e, ROW, TODAY)).toBeNull()
  })

  it('returns null when there is nothing to compare against', () => {
    expect(calendarMismatchDate(undefined, ROW, TODAY)).toBeNull()
    expect(calendarMismatchDate({}, ROW, TODAY)).toBeNull()
  })
})

describe('sourceHasGapAt', () => {
  it('is false for a future row, which simply has not reported yet', () => {
    const e: Enriched = { priorReportDate: '2026-05-06', nextDate: '2026-11-12' }
    expect(sourceHasGapAt(e, '2026-08-20', TODAY)).toBe(false)
  })

  it('is false once yfinance fills the row in', () => {
    const e: Enriched = { priorReportDate: ROW, reportedEps: 2.0, surprisePct: 5, nextDate: '2026-11-05' }
    expect(sourceHasGapAt(e, ROW, TODAY)).toBe(false)
  })

  it('is false when the last confirmed report is AFTER the row date', () => {
    // Here yfinance genuinely disagrees with the calendar, which the mismatch
    // path explains instead.
    const e: Enriched = { priorReportDate: '2026-08-06', reportedEps: 1, surprisePct: 1 }
    expect(sourceHasGapAt(e, '2026-08-04', TODAY)).toBe(false)
  })

  it('is false with no enrichment at all', () => {
    expect(sourceHasGapAt(undefined, ROW, TODAY)).toBe(false)
  })
})

describe('hasReportedFigures', () => {
  it('accepts either a reported EPS or a surprise percentage', () => {
    expect(hasReportedFigures({ reportedEps: 1.5 })).toBe(true)
    expect(hasReportedFigures({ surprisePct: -3 })).toBe(true)
  })

  it('rejects a row with neither, so it reads as figures-pending not a result', () => {
    expect(hasReportedFigures({ priorReportDate: ROW })).toBe(false)
    expect(hasReportedFigures(undefined)).toBe(false)
  })

  it('treats a zero surprise as a real figure, not a missing one', () => {
    expect(hasReportedFigures({ surprisePct: 0 })).toBe(true)
    expect(hasReportedFigures({ reportedEps: 0 })).toBe(true)
  })
})
