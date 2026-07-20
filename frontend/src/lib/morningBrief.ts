// Morning brief is a Home-only daily surface — not a hub tool.
// Once the user opens or dismisses it for the local calendar day, it stays
// quiet until the next day.

const STORAGE_KEY = 'ft-morning-brief-seen-day'

/** Local calendar day as YYYY-MM-DD (en-CA is ISO-ish and stable). */
export function localDayKey(d = new Date()): string {
  return d.toLocaleDateString('en-CA')
}

export function hasSeenMorningBriefToday(d = new Date()): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === localDayKey(d)
  } catch {
    return false
  }
}

export function markMorningBriefSeenToday(d = new Date()): void {
  try {
    localStorage.setItem(STORAGE_KEY, localDayKey(d))
  } catch {
    // private mode / blocked storage — notification may reappear
  }
}
