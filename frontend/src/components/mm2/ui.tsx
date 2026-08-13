/*
 * Options MM 2 — shared terminal primitives.
 *
 * Everything here is built for density: 9-11px type, tabular figures so prices
 * never shift horizontally as they tick, and hairline borders instead of cards.
 */

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { T, alpha } from '../../lib/theme'

export const MONO: CSSProperties = { fontFamily: 'var(--theme-mono)', fontVariantNumeric: 'tabular-nums' }
export const LABEL: CSSProperties = {
  fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700,
  letterSpacing: '0.16em', textTransform: 'uppercase', color: T.muted,
}

export const GOOD = T.pos
export const BAD = T.neg
export const WARN = T.warn
export const pnlColor = (v: number) => (Math.abs(v) < 0.5 ? T.muted : v > 0 ? GOOD : BAD)

// ── Panel ─────────────────────────────────────────────────────────────────────

export function Panel({ title, right, children, style, bodyStyle, scroll = false }: {
  title?: string; right?: ReactNode; children: ReactNode
  style?: CSSProperties; bodyStyle?: CSSProperties; scroll?: boolean
}) {
  return (
    <section style={{
      display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0,
      background: T.bg, border: `1px solid ${T.border}`, ...style,
    }}>
      {title && (
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '4px 7px', borderBottom: `1px solid ${T.borderFaint}`, flexShrink: 0,
          background: alpha(T.gold, 4),
        }}>
          <span style={{ ...LABEL, color: alpha(T.gold, 70) }}>{title}</span>
          {right}
        </header>
      )}
      <div style={{
        flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
        overflowY: scroll ? 'auto' : 'hidden', overflowX: 'hidden', ...bodyStyle,
      }}>
        {children}
      </div>
    </section>
  )
}

/** Collapsible group inside the control columns. */
export function Group({ title, children, defaultOpen = true, note }: {
  title: string; children: ReactNode; defaultOpen?: boolean; note?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderBottom: `1px solid ${T.borderFaint}` }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 6, padding: '5px 7px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
      }}>
        <span style={{ ...LABEL, fontSize: 9, color: open ? alpha(T.gold, 78) : T.muted }}>{title}</span>
        <span style={{ ...MONO, fontSize: 9, color: T.muted }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={{ padding: '2px 7px 7px' }}>
          {note && <p style={{ ...MONO, fontSize: 9, color: T.muted, margin: '0 0 5px', lineHeight: 1.45 }}>{note}</p>}
          {children}
        </div>
      )}
    </div>
  )
}

// ── Controls ──────────────────────────────────────────────────────────────────

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label title={hint} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 6, padding: '2px 0', minHeight: 20,
    }}>
      <span style={{ ...MONO, fontSize: 10, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {children}
    </label>
  )
}

export function Num({ value, onChange, step = 1, min, max, dp = 0, suffix, width = 62 }: {
  value: number; onChange: (v: number) => void
  step?: number; min?: number; max?: number; dp?: number; suffix?: string; width?: number
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string) => {
    const n = parseFloat(raw)
    setDraft(null)
    if (!Number.isFinite(n)) return
    onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)))
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      <input
        value={draft ?? value.toFixed(dp)}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur() }
          if (e.key === 'ArrowUp') { e.preventDefault(); onChange(Math.min(max ?? Infinity, value + step)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(min ?? -Infinity, value - step)) }
        }}
        style={{
          ...MONO, width, fontSize: 10, textAlign: 'right', padding: '1px 4px',
          color: T.text, background: T.surface, border: `1px solid ${T.border}`, outline: 'none',
        }}
      />
      {suffix && <span style={{ ...MONO, fontSize: 9, color: T.muted, width: 22 }}>{suffix}</span>}
    </span>
  )
}

export function Seg<V extends string | number>({ options, value, onChange, size = 10 }: {
  options: { label: string; value: V; hint?: string }[]
  value: V; onChange: (v: V) => void; size?: number
}) {
  return (
    <span style={{ display: 'inline-flex', border: `1px solid ${T.border}`, flexShrink: 0 }}>
      {options.map(o => {
        const on = o.value === value
        return (
          <button key={String(o.value)} onClick={() => onChange(o.value)} title={o.hint} style={{
            ...MONO, fontSize: size, padding: '1px 6px', cursor: 'pointer', border: 'none',
            background: on ? alpha(T.gold, 18) : 'transparent',
            color: on ? T.gold : T.muted, fontWeight: on ? 700 : 400,
          }}>{o.label}</button>
        )
      })}
    </span>
  )
}

export function Toggle({ value, onChange, on = 'ON', off = 'OFF' }: {
  value: boolean; onChange: (v: boolean) => void; on?: string; off?: string
}) {
  return (
    <button onClick={() => onChange(!value)} style={{
      ...MONO, fontSize: 10, padding: '1px 8px', cursor: 'pointer', minWidth: 44,
      border: `1px solid ${value ? alpha(GOOD, 55) : T.border}`,
      background: value ? alpha(GOOD, 15) : 'transparent',
      color: value ? GOOD : T.muted, fontWeight: 700,
    }}>{value ? on : off}</button>
  )
}

export function Btn({ children, onClick, tone = 'plain', wide, disabled, title }: {
  children: ReactNode; onClick: () => void
  tone?: 'plain' | 'gold' | 'bad' | 'good'; wide?: boolean; disabled?: boolean; title?: string
}) {
  const c = tone === 'gold' ? T.gold : tone === 'bad' ? BAD : tone === 'good' ? GOOD : T.muted
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      ...MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      padding: '3px 9px', cursor: disabled ? 'not-allowed' : 'pointer',
      border: `1px solid ${alpha(c, disabled ? 20 : 45)}`,
      background: tone === 'plain' ? 'transparent' : alpha(c, 12),
      color: disabled ? alpha(c, 40) : c, width: wide ? '100%' : undefined,
      whiteSpace: 'nowrap',
    }}>{children}</button>
  )
}

// ── Readouts ──────────────────────────────────────────────────────────────────

export function Stat({ label, value, color, sub, size = 13, align = 'left', onClick, active, title }: {
  label: string; value: string; color?: string; sub?: string; size?: number
  align?: 'left' | 'right' | 'center'; onClick?: () => void; active?: boolean; title?: string
}) {
  return (
    <div onClick={onClick} title={title} style={{
      display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, textAlign: align,
      cursor: onClick ? 'pointer' : undefined, padding: onClick ? '2px 4px' : undefined,
      background: active ? alpha(T.gold, 12) : undefined,
      borderLeft: onClick ? `2px solid ${active ? T.gold : 'transparent'}` : undefined,
    }}>
      <span style={{ ...LABEL, fontSize: 8.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ ...MONO, fontSize: size, fontWeight: 600, color: color ?? T.text, lineHeight: 1.15 }}>{value}</span>
      {sub && <span style={{ ...MONO, fontSize: 9, color: T.muted, whiteSpace: 'nowrap' }}>{sub}</span>}
    </div>
  )
}

/** Greek card with soft/hard limit rails and live usage. */
export function LimitCard({ label, value, soft, hard, unit, fmt, delta1m, onClick, active }: {
  label: string; value: number; soft: number; hard: number; unit: string
  fmt: (v: number) => string; delta1m?: number; onClick?: () => void; active?: boolean
}) {
  const use = Math.abs(value) / Math.max(hard, 1e-9)
  const breach = Math.abs(value) > hard
  const warn = !breach && Math.abs(value) > soft
  const tone = breach ? BAD : warn ? WARN : T.text
  return (
    <div onClick={onClick} style={{
      padding: '4px 6px', cursor: onClick ? 'pointer' : undefined,
      background: breach ? alpha(BAD, 14) : active ? alpha(T.gold, 10) : 'transparent',
      borderLeft: `2px solid ${active ? T.gold : breach ? BAD : warn ? WARN : 'transparent'}`,
      borderBottom: `1px solid ${T.borderFaint}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ ...LABEL, fontSize: 8.5 }}>{label}</span>
        <span style={{ ...MONO, fontSize: 8.5, color: T.muted }}>{unit}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ ...MONO, fontSize: 13, fontWeight: 700, color: tone }}>{fmt(value)}</span>
        {delta1m !== undefined && (
          <span style={{ ...MONO, fontSize: 9, color: pnlColor(delta1m) }}>
            {delta1m >= 0 ? '↑' : '↓'}{fmt(Math.abs(delta1m))}
          </span>
        )}
      </div>
      <div style={{ position: 'relative', height: 3, background: alpha(T.muted, 18), marginTop: 3 }}>
        <div style={{
          position: 'absolute', inset: 0, width: `${Math.min(100, use * 100)}%`,
          background: breach ? BAD : warn ? WARN : alpha(T.gold, 65),
        }} />
        <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${Math.min(100, (soft / Math.max(hard, 1e-9)) * 100)}%`, width: 1, background: alpha(T.text, 55) }} />
      </div>
      <div style={{ ...MONO, fontSize: 8.5, color: T.muted, marginTop: 1 }}>
        {(use * 100).toFixed(0)}% of hard {fmt(hard)}
      </div>
    </div>
  )
}

// ── Tabs and overlay ──────────────────────────────────────────────────────────

export function Tabs<K extends string>({ tabs, value, onChange, right }: {
  tabs: { key: K; label: string }[]; value: K; onChange: (k: K) => void; right?: ReactNode
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0,
      borderBottom: `1px solid ${T.border}`, background: alpha(T.gold, 4),
    }}>
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{
          ...LABEL, fontSize: 8.5, padding: '5px 11px', cursor: 'pointer', border: 'none',
          borderBottom: `2px solid ${value === t.key ? T.gold : 'transparent'}`,
          background: 'transparent', color: value === t.key ? T.gold : T.muted, whiteSpace: 'nowrap',
        }}>{t.label}</button>
      ))}
      {right && <div style={{ marginLeft: 'auto', paddingRight: 7 }}>{right}</div>}
    </div>
  )
}

/** Full-screen overlay for the settings that are read once and then left alone. */
export function Overlay({ title, onClose, children, width = 880 }: {
  title: string; onClose: () => void; children: ReactNode; width?: number
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24,
      background: 'rgba(4, 10, 20, 0.72)', backdropFilter: 'blur(2px)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width, maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
        background: T.bg, border: `1px solid ${alpha(T.gold, 30)}`, boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 11px', borderBottom: `1px solid ${T.border}`, background: alpha(T.gold, 7), flexShrink: 0,
        }}>
          <span style={{ ...LABEL, fontSize: 10, color: T.gold }}>{title}</span>
          <button onClick={onClose} style={{
            ...MONO, fontSize: 10, background: 'none', border: `1px solid ${T.border}`,
            color: T.muted, cursor: 'pointer', padding: '2px 9px',
          }}>CLOSE</button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  )
}

// ── Canvas ────────────────────────────────────────────────────────────────────

/**
 * Charts here redraw at the sim frame rate over hundreds of points. Canvas keeps
 * that at a few hundred microseconds; an SVG chart would rebuild the DOM 10x a
 * second and drag the whole screen down.
 */
export function Canvas({ draw, height, onPick, style }: {
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
  height: number
  onPick?: (xFrac: number, yFrac: number, e: React.MouseEvent) => void
  style?: CSSProperties
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const wrap = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(0)

  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(entries => setW(Math.floor(entries[0].contentRect.width)))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const cv = ref.current
    if (!cv || w <= 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = Math.max(1, Math.floor(w * dpr))
    cv.height = Math.max(1, Math.floor(height * dpr))
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, height)
    draw(ctx, w, height)
  })

  return (
    <div ref={wrap} style={{ width: '100%', height, position: 'relative', ...style }}>
      <canvas
        ref={ref}
        style={{ width: '100%', height, display: 'block', cursor: onPick ? 'crosshair' : undefined }}
        onClick={e => {
          if (!onPick || !ref.current) return
          const r = ref.current.getBoundingClientRect()
          onPick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e)
        }}
      />
    </div>
  )
}

/** Resolve a --theme-* token to a literal, which canvas needs (it cannot read var()). */
export function useTokens(): Record<string, string> {
  const [tok, setTok] = useState<Record<string, string>>({})
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      const pick = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb
      setTok({
        bg: pick('--theme-bg', '#101c2e'),
        surface: pick('--theme-surface', '#0d1826'),
        text: pick('--theme-text', '#d7e3fc'),
        muted: pick('--theme-secondary', '#8099b0'),
        gold: pick('--theme-primary', '#c9a84c'),
        blue: pick('--theme-tertiary', '#60a5fa'),
        pos: pick('--theme-positive', '#22c55e'),
        neg: pick('--theme-negative', '#ef4444'),
        warn: pick('--theme-warn', '#e8c04a'),
        border: pick('--theme-border', 'rgba(255,255,255,0.08)'),
      })
    }
    read()
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    return () => mo.disconnect()
  }, [])
  return tok
}

export function hexAlpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${a})`)
  return color
}

// ── Tables ────────────────────────────────────────────────────────────────────

export const TH: CSSProperties = {
  ...LABEL, fontSize: 8.5, padding: '3px 5px', textAlign: 'right',
  position: 'sticky', top: 0, background: T.surface, zIndex: 1, whiteSpace: 'nowrap',
  borderBottom: `1px solid ${T.border}`,
}
export const TD: CSSProperties = { ...MONO, fontSize: 10, padding: '2px 5px', textAlign: 'right', whiteSpace: 'nowrap' }

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{
      ...MONO, fontSize: 10, color: T.muted, padding: '14px 10px',
      textAlign: 'center', lineHeight: 1.6,
    }}>{children}</div>
  )
}
