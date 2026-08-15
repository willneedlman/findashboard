import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { TICKER_SYM_RE, setLinkedTicker } from '../lib/tickerLink'

// One way to read ?ticker= off the URL.
//
// Pages hand-rolled this or skipped it, so a deep link could land on a page
// still showing its hardcoded default with nothing on screen saying the symbol
// had been dropped. You would click through with NVDA in hand and be looking at
// AAPL's skew.
//
// `apply` runs once per distinct symbol rather than on every render, so a page
// that lets you type over the seeded symbol does not get yanked back.
// `ready` is for pages that cannot apply a symbol until something else has
// loaded (a preset registry, say). Without it the one-shot guard would burn the
// only attempt on the render where the page was not yet able to use it.
export function useTickerParam(
  apply: (sym: string) => void,
  key: 'ticker' | 'tickers' = 'ticker',
  ready = true,
) {
  const [params] = useSearchParams()
  const raw = params.get(key) ?? ''
  const applied = useRef<string | null>(null)
  const handler = useRef(apply)
  handler.current = apply

  useEffect(() => {
    if (!ready) return
    const sym = raw.trim().toUpperCase()
    if (!sym || sym === applied.current) return
    if (key === 'ticker' && !TICKER_SYM_RE.test(sym)) return
    applied.current = sym
    handler.current(sym)
    if (key === 'ticker') setLinkedTicker(sym)
  }, [raw, key, ready])
}

// Comma list form, for the pages that take a basket rather than one symbol.
export function useTickerListParam(apply: (syms: string[]) => void) {
  useTickerParam(raw => {
    const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(s => TICKER_SYM_RE.test(s))
    if (syms.length) apply(syms)
  }, 'tickers')
}
