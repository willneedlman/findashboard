// Linked-ticker mode: one symbol follows the user across tools, Bloomberg
// panel-linking style. When ON, TerminalChrome injects ?ticker= into any
// ticker-prefill route opened without one, and every explicit ?ticker=
// navigation updates the shared symbol. Local to the device (not synced):
// it is session context, not saved data.

import { useEffect, useState } from 'react'

const SYM_KEY = 'ft_linked_ticker'
const ON_KEY  = 'ft_link_on'
const EVT     = 'ft:ticker-link'

export const TICKER_SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/

// Routes whose pages read ?ticker= and auto-load it. /alerts also reads it but
// only prefills the create-alert form, so injecting there would be surprising.
export const LINKED_ROUTES = new Set([
  '/supply-chain', '/chain', '/skew', '/dcf', '/relative-valuation', '/gex', '/probability',
])

function emit() { window.dispatchEvent(new Event(EVT)) }

export function getLinkedTicker(): string {
  try { return localStorage.getItem(SYM_KEY) ?? '' } catch { return '' }
}

export function setLinkedTicker(sym: string) {
  const s = sym.trim().toUpperCase()
  if (!TICKER_SYM_RE.test(s) || s === getLinkedTicker()) return
  try { localStorage.setItem(SYM_KEY, s) } catch { /* quota */ }
  emit()
}

export function isLinkOn(): boolean {
  try { return localStorage.getItem(ON_KEY) === '1' } catch { return false }
}

export function setLinkOn(on: boolean) {
  try { localStorage.setItem(ON_KEY, on ? '1' : '0') } catch { /* quota */ }
  emit()
}

/** Reactive view of the link state for chrome components. */
export function useTickerLink(): { on: boolean; sym: string } {
  const [state, setState] = useState(() => ({ on: isLinkOn(), sym: getLinkedTicker() }))
  useEffect(() => {
    const read = () => setState({ on: isLinkOn(), sym: getLinkedTicker() })
    window.addEventListener(EVT, read)
    window.addEventListener('storage', read)   // other tabs
    return () => { window.removeEventListener(EVT, read); window.removeEventListener('storage', read) }
  }, [])
  return state
}
