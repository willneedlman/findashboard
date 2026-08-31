// Pre-run / empty state for tools. A single quiet, centered message — the tool's
// name, one line of guidance, and (optionally) a cue pointing at the primary
// action. No fake KPI strip, no dashed ghost chart: the placeholder never
// pretends to be a filled cockpit, so it can't read as duplicated or unfinished.
//
// Same file also renders the loading and unavailable variants so every tool's
// three states share one layout.
// (Design: "Bare" direction 1a, handoff 2026-07-15.)

const MONO = 'var(--theme-mono)'
const SEC  = 'var(--theme-secondary, #8099b0)'
const TXT  = 'var(--theme-text, #d7e3fc)'
const DIM  = 'var(--theme-text-dim, #6f8299)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const PRIMARY = 'var(--theme-primary, #c9a84c)'
// The ⌘ glyph only renders in a system font — a theme mono font shows tofu.
const KEY_FONT = '-apple-system, "Segoe UI", system-ui, sans-serif'

export type EmptyVariant = 'empty' | 'loading' | 'unavailable'

export interface EmptyStateProps {
  title: string
  hint?: string                // required by 'empty' and 'unavailable'; optional on a compact loader
  variant?: EmptyVariant       // 'empty' (default) | 'loading' | 'unavailable'
  size?: 'default' | 'compact' // compact: no min-height, no panel chrome — fits inside a widget
  action?: string              // primary-button label, e.g. 'Calculate' — renders the CTA cue (empty only)
  // Pass this and the cue becomes the real button. Without it the cue is
  // rendered as plain text: it used to carry the same gold border and fill as
  // the actual button, so it read as clickable and did nothing.
  onAction?: () => void
  onRetry?: () => void         // optional retry affordance (unavailable only)
  keys?: string[]              // key badges under the message, e.g. ['Enter', '⌘K']
  progress?: number            // 0-100 (loading only) — swaps the indeterminate slide for a
                                // determinate bar that eases to the given width, so callers
                                // tracking real completion (e.g. "N / M enriched") get a bar
                                // that visibly glides forward instead of jumping in place
                                // whenever the underlying count updates in large steps.
}

// The three states below fill the space the page actually has rather than a
// fixed 220/236px. On a tall window (a maximised desktop app) the old floor left
// 500px of dead air between the message and the disclaimer footer; on a short
// one it must not force a scroll. 330px covers the page header, the shell's
// gutters and the footer, and the clamp keeps both ends sane.
const FILL_HEIGHT = 'clamp(236px, calc(100vh - 330px), 820px)'

const TITLE_STYLE: React.CSSProperties = {
  fontFamily: MONO, fontSize: 12, fontWeight: 700,
  letterSpacing: '0.18em', textTransform: 'uppercase',
}
const HINT_STYLE: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)', fontSize: 12, color: SEC,
  letterSpacing: '0.02em', lineHeight: '18px', maxWidth: 320,
}
const SHELL: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '48px 24px', textAlign: 'center', boxSizing: 'border-box',
  background: 'var(--theme-surface, #0d1826)', border: `1px solid ${BORDER}`,
}

function KeyBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: KEY_FONT, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
      color: SEC, border: `1px solid ${BORDER}`, borderRadius: 2, padding: '1px 6px',
    }}>{children}</span>
  )
}

export default function EmptyState({ title, hint, variant = 'empty', size = 'default', action, onAction, onRetry, keys, progress }: EmptyStateProps) {
  // ── Loading ──────────────────────────────────────────────────────────────
  if (variant === 'loading') {
    const determinate = progress != null
    const bar = (
      <div className="es-load-track" style={{ width: size === 'compact' ? 96 : 150, height: 2, background: BORDER, overflow: 'hidden', marginTop: 2 }}>
        {/* Determinate fill scales rather than resizing. A solid bar looks the
            same either way, and transform stays off the layout path, so a
            caller updating progress on every tick cannot make the page reflow. */}
        <div className="es-load-fill" style={determinate ? {
          width: '100%', height: '100%', background: PRIMARY,
          transformOrigin: 'left',
          transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})`,
          transition: 'transform 0.5s var(--ease-out)',
        } : {
          width: '40%', height: '100%', background: PRIMARY,
          animation: 'es-load-slide 1.1s ease-in-out infinite',
        }} />
      </div>
    )
    // Compact drops the panel chrome and the 220px floor: a dashboard widget is
    // often shorter than the full state, which is why ~20 of them printed a bare
    // loading string instead and the app grew four loading treatments.
    if (size === 'compact') {
      return (
        <div role="status" aria-live="polite" style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 10, padding: '12px 8px', textAlign: 'center',
        }}>
          <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: SEC }}>{title}</div>
          {bar}
        </div>
      )
    }
    return (
      <div role="status" aria-live="polite" style={{ ...SHELL, flexDirection: 'column', gap: 14, minHeight: FILL_HEIGHT }}>
        <div style={{ ...TITLE_STYLE, color: TXT }}>{title}</div>
        {hint && <div style={HINT_STYLE}>{hint}</div>}
        {bar}
      </div>
    )
  }

  // ── Unavailable ──────────────────────────────────────────────────────────
  if (variant === 'unavailable') {
    return (
      <div role="alert" style={{ ...SHELL, flexDirection: 'column', gap: 12, minHeight: FILL_HEIGHT }}>
        <div style={{ ...TITLE_STYLE, color: SEC }}>{title}</div>
        <div style={{ ...HINT_STYLE, color: DIM }}>{hint}</div>
        {onRetry && (
          <button type="button" onClick={onRetry} style={{
            marginTop: 2, background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontFamily: 'var(--theme-sans)', fontSize: 11, color: PRIMARY,
            borderBottom: `1px solid color-mix(in srgb, ${PRIMARY} 45%, transparent)`,
          }}>Retry</button>
        )}
      </div>
    )
  }

  // ── Empty (pre-run) ──────────────────────────────────────────────────────
  // `compact` is documented as no min-height and no panel chrome, but only the
  // loader honoured it. Nested inside a Panel the fill height inflated the cell
  // to ~670px of empty box around two lines of text.
  return (
    <div style={size === 'compact'
      ? { ...SHELL, padding: '30px 22px', minHeight: 0, background: 'transparent', border: 'none' }
      : { ...SHELL, minHeight: FILL_HEIGHT }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div style={{ ...TITLE_STYLE, color: TXT }}>{title}</div>
        <div style={HINT_STYLE}>{hint}</div>
        {action && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 4 }}>
            {onAction ? (
              <button type="button" onClick={onAction} style={{
                fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
                color: PRIMARY, border: `1px solid ${PRIMARY}`, cursor: 'pointer',
                background: `color-mix(in srgb, ${PRIMARY} 10%, transparent)`, padding: '6px 14px',
              }}>{action}</button>
            ) : (
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: DIM }}>
                then press <span style={{ fontFamily: MONO, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: SEC }}>{action}</span>
              </span>
            )}
          </div>
        )}
        {keys && keys.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            {/* An unlabelled badge reading "Enter" under the message looks like a
                rendering leftover. Say what it is for. */}
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: DIM }}>or press</span>
            {keys.map((k, i) => <KeyBadge key={i}>{k}</KeyBadge>)}
          </div>
        )}
      </div>
    </div>
  )
}
