import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { PanelRight, UserRound, Users, Calculator, ChevronDown } from 'lucide-react'
import { T } from '../lib/theme'
import { setLinkedTicker, TICKER_SYM_RE, TICKER_TOOLS } from '../lib/tickerLink'

// One clickable ticker for every surface: click the symbol to open a small menu
// with the four canonical destinations. Three navigate; "Overview" fires the
// same 'ft:ticker-drawer' window event the command palette uses, so the slide-
// over opens without leaving the current tool. No Redux/Context: the drawer's
// open state is ephemeral session UI, owned by TickerDrawerHost in App.tsx.
//
// Drop-in for a bare `{symbol}`: it renders only the symbol text and inherits
// the cell's font, so callers keep their own TickerLogo and typography.

const DRAWER_EVENT = 'ft:ticker-drawer'
const Z_MENU = 980   // page chrome sits below; the drawer (990) opens after this closes

interface Action {
  key: string
  label: string
  icon: typeof UserRound
  run: (sym: string, nav: ReturnType<typeof useNavigate>) => void
}

const go = (url: string) => (sym: string, nav: ReturnType<typeof useNavigate>) => {
  setLinkedTicker(sym)
  nav(`${url}?ticker=${encodeURIComponent(sym)}`)
}

// A deliberately short hover menu, not the full hand-off list. The routes are
// looked up in TICKER_TOOLS rather than written out again: this was a fourth
// hand-copied list under a comment claiming it mirrored that one, which is
// exactly how /skew survived here after it stopped existing.
const routeFor = (route: string) => {
  const tool = TICKER_TOOLS.find(t => t.route === route)
  if (!tool) throw new Error(`TickerLink action points at ${route}, which no tool claims a ticker for`)
  return tool.route
}

const ACTIONS: Action[] = [
  { key: 'profile',  label: 'Company Profile', icon: UserRound, run: go(routeFor('/company-profile')) },
  { key: 'peers',    label: 'Peers',           icon: Users,     run: go(routeFor('/peer-comparison')) },
  { key: 'overview', label: 'Overview',        icon: PanelRight,
    run: sym => { setLinkedTicker(sym); window.dispatchEvent(new CustomEvent(DRAWER_EVENT, { detail: sym })) } },
  { key: 'dcf',      label: 'DCF Valuation',   icon: Calculator, run: go(routeFor('/dcf')) },
]

interface Props {
  ticker: string
  /** Merged onto the trigger; pass the cell's font/color so it reads as the symbol. */
  style?: React.CSSProperties
  className?: string
  /** Suppress the hover caret when space is tight (dense tables). */
  caret?: boolean
}

export default function TickerLink({ ticker, style, className, caret = true }: Props) {
  const sym = (ticker || '').trim().toUpperCase()
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const navigate = useNavigate()

  // Bad symbols (blank / non-conforming) render as inert text, never a control.
  if (!sym || !TICKER_SYM_RE.test(sym)) return <span className={className} style={style}>{ticker}</span>

  const openMenu = () => setOpen(true)
  const close = () => setOpen(false)
  const run = (a: Action) => { close(); a.run(sym, navigate) }

  // Caller's color is the resting color; hover/open always wins with gold, so
  // spreading `style` must not clobber the active color (RelativeValuation
  // passes color:'inherit' and still needs the highlight).
  const { color: restColor, ...restStyle } = style ?? {}
  const active = hover || open

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        className={className}
        onClick={e => { e.stopPropagation(); openMenu() }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu() }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          cursor: 'pointer',
          borderBottom: `1px solid ${active ? T.goldTint(55) : 'transparent'}`,
          transition: 'color 0.12s, border-color 0.12s',
          whiteSpace: 'nowrap',
          ...restStyle,
          color: active ? T.gold : restColor,
        }}
      >
        {sym}
        {caret && (
          <ChevronDown aria-hidden size={11} style={{
            marginLeft: 2, verticalAlign: 'middle', display: 'inline',
            opacity: active ? 0.85 : 0, transition: 'opacity 0.12s',
          }} />
        )}
      </span>
      <TickerMenu open={open} sym={sym} anchor={triggerRef} onClose={close} onRun={run} />
    </>
  )
}

function TickerMenu({ open, sym, anchor, onClose, onRun }: {
  open: boolean; sym: string; anchor: React.RefObject<HTMLSpanElement>
  onClose: () => void; onRun: (a: Action) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Position against the trigger's viewport rect (fixed), flipping near edges so
  // the menu is never clipped by a table's overflow — it lives in a body portal.
  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const r = anchor.current.getBoundingClientRect()
    const W = 208, H = 30 /* symbol header */ + 4 * 34 + 12
    let left = r.left
    let top = r.bottom + 4
    if (left + W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - W - 8)
    if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 4)
    setPos({ top, left })
  }, [open, anchor])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // A detached menu after scroll reads as a bug; close instead of tracking.
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && pos && (
        <motion.div
          ref={menuRef}
          role="menu"
          aria-label={`${sym} actions`}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: 208, zIndex: Z_MENU,
            background: T.surface, border: `1px solid ${T.goldTint(30)}`,
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)', padding: '5px 0',
          }}
        >
          <div style={{
            padding: '4px 12px 6px', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            letterSpacing: '0.08em', color: T.gold, borderBottom: `1px solid ${T.border}`,
            marginBottom: 4,
          }}>{sym}</div>
          {ACTIONS.map(a => {
            const Icon = a.icon
            return (
              <button
                key={a.key}
                role="menuitem"
                onClick={() => onRun(a)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                  padding: '7px 12px', color: T.text, fontFamily: T.label, fontSize: 12.5,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = T.goldTint(12); e.currentTarget.style.color = T.gold }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = T.text }}
              >
                <Icon size={14} style={{ flexShrink: 0, opacity: 0.85 }} />
                {a.label}
              </button>
            )
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
