import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { HUBS } from '../lib/hubs'

interface Cmd { label: string; route: string; group: string; desc?: string }

const WORKSPACE: Cmd[] = [
  { label: 'Home', route: '/app', group: 'Workspace' },
  { label: 'My Dashboard', route: '/dashboard', group: 'Workspace' },
  { label: 'Portfolio Manager', route: '/portfolio-manager', group: 'Workspace' },
]

const COMMANDS: Cmd[] = [
  ...WORKSPACE,
  ...HUBS.flatMap(h => [
    { label: `${h.label} Hub`, route: `/hub/${h.slug}`, group: 'Hubs', desc: h.tagline },
    ...h.tools.map(t => ({ label: t.title, route: t.route, group: h.label, desc: t.desc })),
  ]),
]

// All query tokens must appear; rank prefers prefix/label matches.
function score(q: string, c: Cmd): number {
  const ql = q.toLowerCase().trim()
  if (!ql) return 0
  const label = c.label.toLowerCase()
  const hay = `${label} ${c.group.toLowerCase()} ${(c.desc ?? '').toLowerCase()}`
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
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const results = useMemo(() => {
    if (!q.trim()) return COMMANDS
    return COMMANDS.map(c => ({ c, s: score(q, c) })).filter(x => x.s >= 0)
      .sort((a, b) => a.s - b.s).map(x => x.c).slice(0, 40)
  }, [q])

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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0) }
  }, [open])

  useEffect(() => { setSel(0) }, [q])

  if (!open) return null

  const go = (c?: Cmd) => {
    if (!c) return
    navigate(c.route)
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
          placeholder="Jump to a tool…"
          style={{ background: 'transparent', border: 'none', borderBottom: `1px solid ${BORDER}`, outline: 'none',
            color: TEXT, fontFamily: SANS, fontSize: 15, padding: '14px 16px', width: '100%', boxSizing: 'border-box' }} />
        <div style={{ overflowY: 'auto', padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: '18px 12px', color: SEC, fontFamily: MONO, fontSize: 12, textAlign: 'center' }}>No matches</div>
          )}
          {results.map((c, i) => (
            <div key={c.route + c.label} onClick={() => go(c)} onMouseEnter={() => setSel(i)}
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
