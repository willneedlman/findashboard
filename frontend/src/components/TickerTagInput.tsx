import { useState, useRef, useCallback } from 'react'
import { X } from 'lucide-react'

interface Props {
  tickers: string[]
  onChange: (tickers: string[]) => void
  placeholder?: string
  maxTags?: number
  allowMarketSymbols?: boolean
}

const S = {
  bg:         'var(--theme-surface, #0a1628)',
  border:     'var(--theme-border, rgba(255,255,255,0.10))',
  borderActive: 'var(--theme-primary, #c9a84c)',
  gold:       'var(--theme-primary, #c9a84c)',
  text:       'var(--theme-text, #d7e3fc)',
  muted:      'var(--theme-secondary, #8099b0)',
  neg:        'var(--theme-negative, #ef4444)',
  chip:       'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, var(--theme-surface, #0a1628))',
  chipBorder: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 25%, transparent)',
  mono:       'var(--theme-mono)',
  label:      'var(--theme-sans)',
}

/**
 * Chip-based ticker input. Type a symbol and press Enter, Tab, Space or comma
 * to add it as a tag. Click × on a chip to remove it.
 */
export default function TickerTagInput({ tickers, onChange, placeholder = 'Add ticker...', maxTags, allowMarketSymbols = false }: Props) {
  const [input, setInput]     = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addTicker = useCallback((raw: string) => {
    const val = raw.trim().toUpperCase().replace(allowMarketSymbols ? /[^A-Z0-9.\-^=:]/g : /[^A-Z0-9.\-]/g, '')
    if (!val) return
    if (maxTags && tickers.length >= maxTags) return
    if (!tickers.includes(val)) onChange([...tickers, val])
    setInput('')
  }, [tickers, onChange, maxTags, allowMarketSymbols])

  const removeTicker = useCallback((t: string) => {
    onChange(tickers.filter(x => x !== t))
  }, [tickers, onChange])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', 'Tab', ',', ' '].includes(e.key)) {
      e.preventDefault()
      addTicker(input)
    } else if (e.key === 'Backspace' && input === '' && tickers.length > 0) {
      onChange(tickers.slice(0, -1))
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const parts = e.clipboardData.getData('text').split(/[,\s]+/).filter(Boolean)
    const newTags = parts
      .map(p => p.trim().toUpperCase().replace(allowMarketSymbols ? /[^A-Z0-9.\-^=:]/g : /[^A-Z0-9.\-]/g, ''))
      .filter(v => v && !tickers.includes(v))
    if (newTags.length > 0) onChange([...tickers, ...newTags])
    setInput('')
  }

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px 5px', alignItems: 'center',
        background: S.bg,
        border: `1px solid ${focused ? S.borderActive : S.border}`,
        padding: '5px 7px', cursor: 'text', minHeight: 34,
        transition: 'border-color 0.12s',
      }}
    >
      {tickers.map(t => (
        <span
          key={t}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: S.chip, border: `1px solid ${S.chipBorder}`,
            padding: '1px 6px 1px 7px', borderRadius: 2,
            fontFamily: S.mono, fontSize: 10, fontWeight: 700,
            color: S.gold, letterSpacing: '0.06em', lineHeight: 1.6,
            userSelect: 'none', flexShrink: 0,
          }}
        >
          {t}
          <button
            onClick={e => { e.stopPropagation(); removeTicker(t) }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 0, display: 'flex', color: S.muted, lineHeight: 0,
            }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = S.neg)}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = S.muted)}
          >
            <X size={9} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={e => setInput(e.target.value.toUpperCase())}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); if (input) addTicker(input) }}
        placeholder={tickers.length === 0 ? placeholder : ''}
        style={{
          background: 'none', border: 'none', outline: 'none',
          fontFamily: S.mono, fontSize: 11, color: S.text,
          width: Math.max(80, input.length * 9 + 20),
          minWidth: 60, padding: 0, letterSpacing: '0.06em',
        }}
      />
    </div>
  )
}
