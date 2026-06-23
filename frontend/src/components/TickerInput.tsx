import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

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
  placeholder?: string
  style?: React.CSSProperties
  autoFocus?: boolean
  disabled?: boolean
  'aria-label'?: string
}

const TICKER_RE = /^[A-Za-z]{1,5}(\.[A-Za-z])?$/

export default function TickerInput({
  value, onChange, onEnter, placeholder = 'Ticker or company',
  style, autoFocus, disabled, 'aria-label': ariaLabel,
}: Props) {
  const [text, setText] = useState(value)
  const [matches, setMatches] = useState<Match[]>([])
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
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

  const pick = (m: Match) => {
    setText(m.ticker); onChange(m.ticker)
    setOpen(false); setMatches([])
    onEnter?.()
  }

  const onType = (v: string) => {
    setText(v); setOpen(true)
    // A direct ticker keeps the old live-update behavior so nothing regresses.
    if (TICKER_RE.test(v.trim())) onChange(v.trim().toUpperCase())
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(i + 1, matches.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Escape') { setOpen(false); return }
    }
    if (e.key === 'Enter') {
      if (open && matches.length && !TICKER_RE.test(text.trim())) { e.preventDefault(); pick(matches[hi]); return }
      setOpen(false); onEnter?.()
    }
  }

  const showMenu = open && matches.length > 0
  return (
    <div style={{ position: 'relative', flex: style?.flex }}>
      <input
        value={text}
        onChange={e => onType(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120) }}
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
    </div>
  )
}
