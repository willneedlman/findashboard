import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { getRecentTickers, recordRecentTicker } from '../lib/recentTickers'

// Drop-in replacement for a plain ticker <input> that also accepts a company
// name. Typing a symbol behaves exactly as before (value updates live, upper-
// cased); typing a name shows a dropdown of matches from /corporate/search and
// resolves to the chosen ticker on click or Enter. The page only ever receives
// a ticker through onChange, so existing symbol-based logic is unaffected.

interface Match { ticker: string; name: string }

interface Props {
  value: string
  onChange: (symbol: string) => void
  onEnter?: () => void
  onSelect?: (symbol: string) => void
  placeholder?: string
  style?: React.CSSProperties
  autoFocus?: boolean
  disabled?: boolean
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void
  'aria-label'?: string
}

// A bare symbol the page can use directly: an equity (AAPL, BRK.B), an index
// (^GSPC), or a future (ES=F, 6E=F). Anything else is treated as a name search.
const TICKER_RE = /^(\^?[A-Za-z]{1,5}(\.[A-Za-z])?|[A-Za-z0-9]{1,4}=F)$/

export default function TickerInput({
  value, onChange, onEnter, onSelect, placeholder = 'Ticker or company',
  style, autoFocus, disabled, onFocus, onBlur, 'aria-label': ariaLabel,
}: Props) {
  const [text, setText] = useState(value)
  const [matches, setMatches] = useState<Match[]>([])
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [recents, setRecents] = useState<string[]>([])
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Keep the field in sync when the page changes the symbol itself (URL param,
  // preset, peer click) without the user typing.
  useEffect(() => { setText(prev => (prev.toUpperCase() === value.toUpperCase() ? prev : value)) }, [value])

  // Debounced company lookup; a bare ticker doesn't need the dropdown.
  useEffect(() => {
    const term = text.trim()
    if (term.length < 2) { setMatches([]); return }
    const t = setTimeout(() => {
      axios.get(`/api/corporate/search?q=${encodeURIComponent(term)}`)
        .then(r => { setMatches(r.data?.results ?? []); setHi(0) })
        .catch(() => setMatches([]))
    }, 200)
    return () => clearTimeout(t)
  }, [text])

  // Picking a company resolves the symbol into the field, exactly as if the user
  // had typed the ticker. We deliberately do NOT auto-run onEnter here: the page's
  // run handlers read the symbol from their own state, which has not committed yet
  // inside this click, so firing now would act on the previous symbol. The user
  // runs it with the existing button or a second Enter, once state has settled.
  const pick = (m: Match) => {
    setText(m.ticker); onChange(m.ticker); recordRecentTicker(m.ticker)
    setOpen(false); setMatches([])
    onSelect?.(m.ticker)
  }

  // Quick-pick a remembered symbol — same effect as typing it and pressing Enter.
  const pickRecent = (sym: string) => {
    setText(sym); onChange(sym); recordRecentTicker(sym)
    setOpen(false); setMatches([]); onEnter?.()
  }

  const onType = (v: string) => {
    const isTicker = TICKER_RE.test(v.trim())
    // A direct ticker uppercases live and updates the page, exactly as before.
    setText(isTicker ? v.toUpperCase() : v); setOpen(true)
    if (isTicker) onChange(v.trim().toUpperCase())
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(i + 1, matches.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Escape') { setOpen(false); return }
    }
    if (e.key === 'Enter') {
      // Resolve to the highlighted match unless the text already IS that ticker
      // (so a bare 5-letter name like "tesla" resolves to TSLA, while "AAPL" runs
      // immediately). A second Enter then runs the now-resolved symbol.
      const live = (e.currentTarget as HTMLInputElement).value.trim()
      const top = open && matches.length ? matches[hi] : undefined
      if (top && top.ticker.toUpperCase() !== live.toUpperCase()) { e.preventDefault(); pick(top); return }
      if (TICKER_RE.test(live)) recordRecentTicker(live.toUpperCase())
      setOpen(false); onEnter?.()
    }
  }

  const showMenu = open && matches.length > 0
  // With an empty field and nothing matched, offer recently viewed symbols.
  const showRecents = open && matches.length === 0 && text.trim() === '' && recents.length > 0
  return (
    <div style={{ position: 'relative', minWidth: 0, flex: style?.flex }}>
      <input
        className="ft-control"
        value={text}
        onChange={e => onType(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={e => { setOpen(true); setRecents(getRecentTickers()); onFocus?.(e) }}
        onBlur={e => { blurTimer.current = setTimeout(() => setOpen(false), 120); onBlur?.(e) }}
        placeholder={placeholder}
        style={style}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
      />
      {showMenu && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
          maxHeight: 260, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
          onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current) }}>
          {matches.map((m, i) => (
            <button key={m.ticker} type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(m)}
              style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
                width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none',
                padding: '8px 11px', background: i === hi ? 'rgba(201,168,76,0.12)' : 'transparent',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: 'var(--theme-text, #d7e3fc)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700,
                color: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }}>{m.ticker}</span>
            </button>
          ))}
        </div>
      )}
      {showRecents && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
          maxHeight: 260, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
          onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current) }}>
          <div style={{ padding: '6px 11px', fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text-faint, rgba(255,255,255,0.3))' }}>
            Recent
          </div>
          {recents.map(sym => (
            <button key={sym} type="button" onClick={() => pickRecent(sym)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                cursor: 'pointer', border: 'none', padding: '8px 11px', background: 'transparent',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(201,168,76,0.12)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)' }}>{sym}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
