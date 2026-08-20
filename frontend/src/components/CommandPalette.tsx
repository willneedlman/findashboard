import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import { HUBS } from '../lib/hubs'
import { resolveIntents, extractTicker, intentUrl } from '../lib/searchIntent'
import { setLinkedTicker, TICKER_TOOLS, tickerToolUrl } from '../lib/tickerLink'

interface Cmd { label: string; route?: string; group: string; desc?: string; alias?: string; action?: () => void }

// Retired tool names still resolve to the tool that absorbed them, so existing
// search habits ("skew", "portfolio earnings") keep working after a merge.
const ALIASES: Record<string, string> = {
  '/earnings': 'earnings summarizer portfolio earnings earnings scanner earnings calendar corporate hub filings transcripts',
  '/volatility-scanner': 'iv rank iv tracker vol skew volatility skew implied volatility smile term structure',
  '/trade-history': 'trade analyzer trade history broker import fidelity robinhood account performance',
}

// Same idea for the hubs retired in the 9-hub split, so old habits still land.
const HUB_ALIASES: Record<string, string> = {
  companies: 'research screening single name issuer fundamentals',
  markets: 'research tape board live what is moving',
  charts: 'charting statistics plotting overlay',
  portfolio: 'trading book risk holdings',
  desk: 'trading execution simulator market maker',
  'trade-routes': 'logistics geo-logistics physical trade supply chain freight shipping chokepoint',
}

const ALL_ROUTE_DESC: Record<string, string> = Object.fromEntries(
  HUBS.flatMap(h => h.tools).map(t => [t.route.split('?')[0], t.desc]),
)

const WORKSPACE: Cmd[] = [
  { label: 'Home', route: '/app', group: 'Workspace' },
  { label: 'My Dashboard', route: '/dashboard', group: 'Workspace' },
  { label: 'Portfolio Manager', route: '/portfolio-manager', group: 'Workspace' },
]

const _RAW: Cmd[] = [
  ...WORKSPACE,
  ...HUBS.flatMap(h => [
    { label: `${h.label} Hub`, route: `/hub/${h.slug}`, group: 'Hubs', desc: h.tagline, alias: HUB_ALIASES[h.slug] },
    ...h.tools.map(t => ({ label: t.title, route: t.route, group: h.label, desc: t.desc, alias: ALIASES[t.route] })),
  ]),
]
// Dedupe by route (e.g. Portfolio Manager lives in both Workspace and a hub) so
// there are no duplicate React keys / phantom rows.
const COMMANDS: Cmd[] = _RAW.filter((c, i) => _RAW.findIndex(x => x.route === c.route) === i)

// All query tokens must appear; rank prefers prefix/label matches.
function score(q: string, c: Cmd): number {
  const ql = q.toLowerCase().trim()
  if (!ql) return 0
  const label = c.label.toLowerCase()
  const hay = `${label} ${c.group.toLowerCase()} ${(c.desc ?? '').toLowerCase()} ${(c.alias ?? '').toLowerCase()}`
  let s = 0
  for (const tok of ql.split(/\s+/)) {
    if (!hay.includes(tok)) return -1
    const li = label.indexOf(tok)
    s += li === 0 ? 0 : li > 0 ? 2 : 5
  }
  return s
}


const GOLD = 'var(--theme-primary, #c9a84c)'
const SURFACE = 'var(--theme-surface, #0d1826)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.1))'
const TEXT = 'var(--theme-text, #d7e3fc)'
const SEC = 'var(--theme-secondary, #8099b0)'
const MONO = 'var(--theme-mono, monospace)'
const SANS = 'var(--theme-sans, sans-serif)'

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // Company-name resolution, the way Home's search already does it: "apple"
  // should reach AAPL. Without it the palette treated the word as a symbol and
  // built a shortcut wall for a listing that does not exist.
  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q.trim()), 180)
    return () => clearTimeout(id)
  }, [q])
  const companyQuery = useQuery<{ results: { ticker: string; name: string }[] }>({
    queryKey: ['cmdk-company-search', debouncedQ],
    queryFn: () => axios.get(`/api/corporate/search?q=${encodeURIComponent(debouncedQ)}`).then(r => r.data),
    enabled: debouncedQ.length >= 2,
    staleTime: 300_000,
    retry: 1,
  })
  const companies = companyQuery.data?.results ?? []
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const results = useMemo(() => {
    const trimmed = q.trim()
    if (!trimmed) return COMMANDS
    const toolMatches = COMMANDS.map(c => ({ c, s: score(q, c) })).filter(x => x.s >= 0)
      .sort((a, b) => a.s - b.s).map(x => x.c).slice(0, 40)

    // Plain-language routing. A phrase nobody would type as a tool name
    // ("what is it worth", "why is it dropping") still lands somewhere, and the
    // symbol rides along to tools that read one.
    //
    // When a phrase and a tool label resolve to the SAME route, keep one row and
    // let the intent own it. Dropping the intent instead was the asymmetry Will
    // hit: the identical query showed a "Go to" row on Home and a plain hub row
    // here, which reads as the routing not running at all.
    const matched = resolveIntents(trimmed)
    const intents: Cmd[] = matched.map(m => ({
      label: m.ticker ? `${m.title} · ${m.ticker}` : m.title,
      route: intentUrl(m),
      group: 'Go to',
      desc: ALL_ROUTE_DESC[m.route],
    }))
    const intentRoutes = new Set(matched.map(m => m.route))
    const tools = toolMatches.filter(c => !intentRoutes.has((c.route ?? '').split('?')[0]))

    // Only a query that IS a symbol gets the "open SYMBOL in ..." wall. It used
    // to be any 1-5 letter token, so typing "vol" or "chart" buried the tool
    // being reached for under a screen of ticker shortcuts.
    const guess = trimmed.split(/\s+/).length === 1 ? extractTicker(trimmed) : null
    // A confident company-name match beats a bare symbol guess, so "apple"
    // resolves to AAPL instead of opening a drawer on a listing that is not
    // real. A query that IS a listed ticker keeps it.
    const listed = companies.some(c => c.ticker === guess)
    // A company match may only stand in for the symbol on a lookup-shaped query.
    // Letting it win on a phrase would drop a wall of ticker shortcuts under
    // "apple earnings date" when the phrase already named the destination.
    const nameLookup = !matched.length
    const sym = listed ? guess : ((nameLookup ? companies[0]?.ticker : null) ?? guess)

    const companyCmds: Cmd[] = companies
      .filter(c => c.ticker !== sym)
      .slice(0, 4)
      .map(c => ({
        label: `${c.name} · ${c.ticker}`, group: 'Company',
        action: () => { setLinkedTicker(c.ticker); window.dispatchEvent(new CustomEvent('ft:ticker-drawer', { detail: c.ticker })) },
      }))

    if (!sym) {
      const rest = [...intents, ...tools, ...companyCmds]
      return rest.length ? rest : tools
    }
    const overview: Cmd = {
      label: `${sym} Overview`, group: 'Ticker', desc: 'Quote, vol, gamma, earnings, news',
      action: () => { setLinkedTicker(sym); window.dispatchEvent(new CustomEvent('ft:ticker-drawer', { detail: sym })) },
    }
    const targets: Cmd[] = TICKER_TOOLS.map((t): Cmd => ({
      label: `${sym} → ${t.label}`, group: 'Open ticker',
      action: () => { setLinkedTicker(sym); navigate(tickerToolUrl(t, sym)) },
    }))
    const base = tools.length
      ? [...tools, overview, ...companyCmds, ...targets]
      : [overview, ...companyCmds, ...targets]
    return intents.length ? [...intents, ...base] : base
  }, [q, navigate, companies])

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('cmdk:open', onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('cmdk:open', onOpen) }
  }, [])

  useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0) }
  }, [open])

  useEffect(() => { setSel(0) }, [q])

  if (!open) return null

  const go = (c?: Cmd) => {
    if (!c) return
    if (c.action) c.action()
    else if (c.route) navigate(c.route)
    setOpen(false)
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[sel]) }
  }

  return (
    <div onClick={() => setOpen(false)} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(3,8,16,0.62)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(580px, 92vw)', background: SURFACE, border: `1px solid ${BORDER}`,
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', maxHeight: '70vh',
      }}>
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onInputKey}
          placeholder="Jump to a tool..."
          style={{ background: 'transparent', border: 'none', borderBottom: `1px solid ${BORDER}`, outline: 'none',
            color: TEXT, fontFamily: SANS, fontSize: 15, padding: '14px 16px', width: '100%', boxSizing: 'border-box' }} />
        <div style={{ overflowY: 'auto', padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: '18px 12px', color: SEC, fontFamily: MONO, fontSize: 12, textAlign: 'center' }}>No matches</div>
          )}
          {results.map((c, i) => (
            <div key={`${c.group}:${c.label}`} onClick={() => go(c)} onMouseEnter={() => setSel(i)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 11px', cursor: 'pointer',
                background: i === sel ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                borderLeft: `2px solid ${i === sel ? GOLD : 'transparent'}` }}>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: i === sel ? GOLD : TEXT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</span>
                {c.desc && <span style={{ fontFamily: SANS, fontSize: 10, color: SEC, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.desc}</span>}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: SEC, flexShrink: 0 }}>{c.group}</span>
            </div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${BORDER}`, padding: '7px 12px', display: 'flex', gap: 14, fontFamily: MONO, fontSize: 9, color: SEC, letterSpacing: '0.06em' }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
          <span style={{ marginLeft: 'auto' }}>{results.length} result{results.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  )
}
