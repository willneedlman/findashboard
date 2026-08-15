import { describe, expect, it } from 'vitest'
import { holidayFor } from './marketHolidays'
import { marketStatus, MARKETS } from './marketHours'

// Seoul was reported as counting down a day late: 67h on a Friday night, when
// the next weekday open looks like it should be 43h away. It is not a bug.
// 2026-08-15 is a Saturday, so Korea observes Liberation Day on Monday the
// 17th and the next session really is Tuesday. Every other Asian exchange
// checked out that evening because none of them had a holiday that Monday.
//
// Pinned so a future edit to the holiday table cannot quietly turn the correct
// answer into the one that looks right.
describe('KRX next open', () => {
  it('observes Liberation Day on the Monday when the 15th is a Saturday', () => {
    expect(new Date(Date.UTC(2026, 7, 15)).getUTCDay()).toBe(6)
    expect(new Date(Date.UTC(2026, 7, 17)).getUTCDay()).toBe(1)
    expect(holidayFor('krx', 2026, 8, 17)?.name).toContain('Liberation')
  })

  it('counts down to Tuesday 09:00 KST, not Monday', () => {
    const krx = MARKETS.find(m => m.id === 'krx')!
    // Fri 2026-08-14 23:52 CDT is Sat 2026-08-15 04:52 UTC.
    const status = marketStatus(krx, new Date('2026-08-15T04:52:00Z'))

    expect(status.open).toBe(false)
    const hours = status.msToNext! / 3_600_000
    expect(hours).toBeGreaterThan(67)
    expect(hours).toBeLessThan(68)
    // Tuesday 2026-08-18 09:00 KST is 2026-08-18 00:00 UTC.
    const next = new Date(new Date('2026-08-15T04:52:00Z').getTime() + status.msToNext!)
    expect(next.toISOString()).toBe('2026-08-18T00:00:00.000Z')
  })
})
