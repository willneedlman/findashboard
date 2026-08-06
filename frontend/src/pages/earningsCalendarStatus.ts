// Result-column state machine for the earnings scanner, split out from
// EarningsCalendar.tsx so the date reasoning is unit-testable without rendering.
//
// Only the fields these helpers actually read are declared, so the page's fuller
// Enriched type satisfies this structurally.
export interface Enriched {
  priorReportDate?: string | null
  reportedEps?: number | null
  surprisePct?: number | null
  nextDate?: string | null
}

// Fallback used only when a row's calendar date never resolves to a real Result:
// checks whether yfinance's own confirmed schedule agrees at all. Prefers nextDate
// (a real future mismatch, e.g. the calendar says today but yfinance's next date is
// a week out) over a merely-recent past report (within 5 days — a company that
// reported a few days ago on a date the calendar mislabeled), since the former is
// the more direct answer to "when does this actually report".
//
// CRITICAL: nextDate is yfinance's nearest FUTURE date, so the day after a company
// reports it rolls to NEXT QUARTER. Reading that as a reschedule of the row's own
// date produced claims like "SNDK resched. NOV 6" about a report that had already
// come out on AUG 5. A date in the past cannot be moved to the future — it either
// reported, or it did not.
export function calendarMismatchDate(
  e: Enriched | undefined, rowDate: string, todayIso: string,
): string | null {
  const rowIsPast = rowDate < todayIso
  if (e?.nextDate && e.nextDate !== rowDate && !(rowIsPast && e.nextDate > rowDate)) return e.nextDate
  if (e?.reportedEps != null && e?.priorReportDate && e.priorReportDate !== rowDate) {
    const days = Math.abs(
      (new Date(rowDate + 'T00:00:00').getTime() - new Date(e.priorReportDate + 'T00:00:00').getTime()) / 86400000,
    )
    if (days <= 5) return e.priorReportDate
  }
  return null
}

// Yahoo's actuals routinely lag the report itself by hours or days. When its own
// schedule already places the row's date in the past as the ticker's most recent
// report, the company HAS reported — the figures just are not backfilled yet.
// Saying so beats a bare dash that reads identically to "never reported".
export function hasReportedFigures(e: Enriched | undefined): boolean {
  return e?.reportedEps != null || e?.surprisePct != null
}

// The row's date falls in a HOLE in yfinance's schedule: its last confirmed report
// predates this row and its next scheduled one comes after it. For a date already
// in the past that means the report happened and Yahoo has not published the row
// yet (a 1-3 day lag), which is why this must not be read as a reschedule.
// Verified 2026-08-06: DIS jumped from 2026-05-06 to 2026-11-12 with the Aug 5
// report missing, while every name that reported a week earlier was fully
// populated.
export function sourceHasGapAt(
  e: Enriched | undefined, rowDate: string, todayIso: string,
): boolean {
  if (rowDate >= todayIso) return false
  if (!e?.priorReportDate || e.priorReportDate >= rowDate) return false
  return !e.nextDate || e.nextDate > rowDate
}
