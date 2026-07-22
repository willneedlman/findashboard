// Pre-run / empty state for tools. A single quiet, centered message — the tool's
// name, one line of guidance, and (optionally) a cue pointing at the primary
// action. No fake KPI strip, no dashed ghost chart: the placeholder never
// pretends to be a filled cockpit, so it can't read as duplicated or unfinished.
//
// Same file also renders the loading and unavailable variants so every tool's
// three states share one layout. Backward compatible: the old cockpit props
// (kpis / preview / columns / previewLabel) are still accepted so existing call
// sites compile unchanged — they are simply ignored now.
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
  hint: string
  variant?: EmptyVariant       // 'empty' (default) | 'loading' | 'unavailable'
  action?: string              // primary-button label, e.g. 'Calculate' — renders the CTA cue (empty only)
  onRetry?: () => void         // optional retry affordance (unavailable only)
  keys?: string[]              // key badges under the message, e.g. ['Enter', '⌘K']
  progress?: number            // 0-100 (loading only) — swaps the indeterminate slide for a
                                // determinate bar that eases to the given width, so callers
                                // tracking real completion (e.g. "N / M enriched") get a bar
                                // that visibly glides forward instead of jumping in place
                                // whenever the underlying count updates in large steps.
  // ── Deprecated / ignored (kept for source compatibility with old call sites) ──
  kpis?: string[]
  preview?: 'chart' | 'table'
  columns?: string[]
  previewLabel?: string
}

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

export default function EmptyState({ title, hint, variant = 'empty', action, onRetry, keys, progress }: EmptyStateProps) {
  // ── Loading ──────────────────────────────────────────────────────────────
  if (variant === 'loading') {
    const determinate = progress != null
    return (
      <div role="status" aria-live="polite" style={{ ...SHELL, flexDirection: 'column', gap: 14, minHeight: 220 }}>
        <div style={{ ...TITLE_STYLE, color: TXT }}>{title}</div>
        <div style={HINT_STYLE}>{hint}</div>
        <div className="es-load-track" style={{ width: 150, height: 2, background: BORDER, overflow: 'hidden', marginTop: 2 }}>
          <div className="es-load-fill" style={determinate ? {
            width: `${Math.max(0, Math.min(100, progress))}%`, height: '100%', background: PRIMARY,
            transition: 'width 0.5s ease',
          } : {
            width: '40%', height: '100%', background: PRIMARY,
            animation: 'es-load-slide 1.1s ease-in-out infinite',
          }} />
        </div>
      </div>
    )
  }

  // ── Unavailable ──────────────────────────────────────────────────────────
  if (variant === 'unavailable') {
    return (
      <div role="alert" style={{ ...SHELL, flexDirection: 'column', gap: 12, minHeight: 220 }}>
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
  return (
    <div style={{ ...SHELL, minHeight: 236 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div style={{ ...TITLE_STYLE, color: TXT }}>{title}</div>
        <div style={HINT_STYLE}>{hint}</div>
        {action && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 4 }}>
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: DIM }}>then press</span>
            <span style={{
              fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: PRIMARY, border: `1px solid ${PRIMARY}`,
              background: `color-mix(in srgb, ${PRIMARY} 10%, transparent)`, padding: '6px 14px',
            }}>{action}</span>
          </div>
        )}
        {keys && keys.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {keys.map((k, i) => <KeyBadge key={i}>{k}</KeyBadge>)}
          </div>
        )}
      </div>
    </div>
  )
}
