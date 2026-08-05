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

// Single source for every surface that deep-links a symbol into a tool: the
// palette's "open SYMBOL in <tool>" commands, the drawer's Open In grid, and
// linked-route injection. `param` marks pages that read ?tickers= (comma list)
// instead of ?ticker= — those take deep links but are excluded from injection.
// /alerts reads ?ticker= too but only prefills the create-alert form, so it is
// deliberately absent.
export interface TickerTool { label: string; short: string; route: string; param?: 'tickers' }
export const TICKER_TOOLS: TickerTool[] = [
  { label: 'Company Profile',     short: 'Profile',  route: '/company-profile' },
  { label: 'Chain Scanner',       short: 'Chain',    route: '/chain' },
  { label: 'Volatility Skew',     short: 'Skew',     route: '/skew' },
  { label: 'Dealer GEX',          short: 'GEX',      route: '/gex' },
  { label: 'Implied Probability', short: 'Prob',     route: '/probability' },
  { label: 'DCF Valuation',       short: 'DCF',      route: '/dcf' },
  { label: 'Master Valuation',    short: 'Master',   route: '/master-valuation' },
  { label: 'Relative Valuation',  short: 'Rel Val',  route: '/relative-valuation' },
  { label: 'Portfolio Earnings',  short: 'Earnings', route: '/corporate', param: 'tickers' },
]

export const tickerToolUrl = (t: TickerTool, sym: string) =>
  `${t.route}?${t.param ?? 'ticker'}=${sym}`

export const LINKED_ROUTES = new Set(TICKER_TOOLS.filter(t => !t.param).map(t => t.route))

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
