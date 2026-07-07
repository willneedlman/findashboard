import { useState, useRef, useEffect } from 'react'
import { Link2, Link2Off } from 'lucide-react'
import { useTickerLink, setLinkOn, setLinkedTicker, TICKER_SYM_RE } from '../lib/tickerLink'

// Sidebar chip for linked-ticker mode. ON: gold, shows the shared symbol every
// linked tool inherits, and the symbol is click-to-edit so you can retarget the
// link without hunting through the command palette. OFF: muted toggle only.
export default function TickerLinkChip({ collapsed }: { collapsed: boolean }) {
  const { on, sym } = useTickerLink()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const GOLD = 'var(--theme-primary, #c9a84c)'
  const SEC = 'var(--theme-secondary, #8099b0)'
  const BG = 'var(--theme-bg, #101c2e)'

  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])
  // Leaving link mode closes an open editor so it can't reopen on re-link.
  useEffect(() => { if (!on) setEditing(false) }, [on])

  const startEdit = () => { setDraft(sym); setEditing(true) }
  const commit = () => {
    const s = draft.trim().toUpperCase()
    if (TICKER_SYM_RE.test(s)) setLinkedTicker(s)
    setEditing(false)
  }

  return (
    <div style={{
      margin: '6px 8px 0', boxSizing: 'border-box',
      display: 'flex', alignItems: 'stretch',
      justifyContent: collapsed ? 'center' : 'space-between', gap: 6,
      padding: collapsed ? '6px 0' : '5px 8px',
      background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : BG,
      border: `1px solid ${on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)' : 'var(--theme-border, rgba(255,255,255,0.1))'}`,
      color: on ? GOLD : SEC, fontFamily: 'var(--theme-sans)',
    }}>
      {/* Toggle: icon + label */}
      <button
        onClick={() => setLinkOn(!on)}
        title={on
          ? `Linked ticker mode on${sym ? `. Tools open with ${sym}` : ''}. Click to unlink.`
          : 'Link tools to one ticker: any symbol you open follows you across tools.'}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
          padding: 0, font: 'inherit',
        }}>
        {on ? <Link2 size={13} /> : <Link2Off size={13} />}
        {!collapsed && (
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            {on ? 'Linked' : 'Link ticker'}
          </span>
        )}
      </button>

      {/* Symbol — click to retarget the linked ticker */}
      {!collapsed && on && (editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value.toUpperCase())}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
          placeholder="TICKER"
          maxLength={10}
          style={{
            width: 66, minWidth: 0, textAlign: 'right',
            background: BG, border: `1px solid ${GOLD}`, color: 'var(--theme-text, #d7e3fc)',
            fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700,
            padding: '1px 5px', outline: 'none',
          }}
        />
      ) : (
        <button
          onClick={startEdit}
          title="Change linked ticker"
          style={{
            background: 'none', cursor: 'pointer', color: 'inherit',
            fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700,
            padding: '1px 6px', letterSpacing: sym ? 0 : '0.1em',
            border: `1px solid ${sym ? 'transparent' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)'}`,
            borderStyle: sym ? 'solid' : 'dashed',
            transition: 'border-color 0.12s, background 0.12s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)'
            e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = sym ? 'transparent' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)'
            e.currentTarget.style.background = 'none'
          }}>
          {sym || 'SET'}
        </button>
      ))}
    </div>
  )
}
