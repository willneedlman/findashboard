// Pure helpers for the global search (unit-tested in search.test.ts).

// Word-prefix match: every query term must hit the START of a word in the text,
// so a 2-letter ticker like "GS" no longer matches inside "earnings"/"holdings".
export const wordMatch = (text: string, query: string): boolean =>
  query.toLowerCase().split(/\s+/).filter(Boolean).every(term =>
    text.toLowerCase().split(/[^a-z0-9]+/).some(w => w.startsWith(term)))

// A query is treated as a ticker when it's 1-5 letters with an optional .X class
// suffix (e.g. BRK.B). Returns the upper-cased symbol, or null if not a ticker.
const TICKER_RE = /^[A-Za-z]{1,5}(\.[A-Za-z])?$/
export const tickerFromQuery = (q: string): string | null => {
  const raw = q.trim()
  return TICKER_RE.test(raw) ? raw.toUpperCase() : null
}
