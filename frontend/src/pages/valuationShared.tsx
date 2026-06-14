// Shared design tokens for the Stock Valuation tabs so every tool reads as one
// consistent, well-spaced system. Matches the DCF tab's density.

export const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12,
  padding: '6px 8px', width: '100%', outline: 'none', boxSizing: 'border-box',
}

// Native <select> styled to match INPUT: reset appearance, add a gold-muted chevron.
export const SELECT: React.CSSProperties = {
  ...INPUT,
  appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
  cursor: 'pointer', paddingRight: 26,
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2399907e' stroke-width='1.4' fill='none'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 9px center',
}

export const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', marginBottom: 5, display: 'block',
}

export const HINT: React.CSSProperties = {
  fontSize: 9, lineHeight: 1.5, color: 'var(--theme-text-dim, rgba(255,255,255,0.42))',
  marginTop: 4, fontFamily: 'var(--theme-mono)',
}

// 14px inset + 14px between groups = the breathing room the DCF sidebar has.
export const SIDEBAR: React.CSSProperties = { padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }

export const SECTION: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
  color: 'var(--theme-text, #d7e3fc)', paddingBottom: 6,
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

export const PRIMARY_BTN: React.CSSProperties = {
  ...INPUT, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--theme-primary, #c9a84c)', borderColor: 'var(--theme-primary, #c9a84c)',
  background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
}

export const GHOST_BTN: React.CSSProperties = {
  ...INPUT, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)',
}

// Readout list (the small key/value stats under the inputs).
export const READOUT_ROW: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--theme-mono)',
  fontSize: 9.5, color: 'var(--theme-secondary, #99907e)', lineHeight: 2,
}

// Tooltip: explicit light text so it never renders gray-on-gray.
export const TOOLTIP_STYLE = {
  background: 'var(--theme-surface, #142032)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
  borderRadius: 0,
}
export const TOOLTIP_LABEL = { color: 'var(--theme-text, #d7e3fc)', fontWeight: 700 }
export const TOOLTIP_ITEM = { color: 'var(--theme-text, #d7e3fc)' }
export const TOOLTIP_CURSOR = { fill: 'rgba(255,255,255,0.05)' }
export const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

export const TH: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', padding: '9px 12px', textAlign: 'right',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
export const TD: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '9px 12px', textAlign: 'right',
  color: 'var(--theme-text, #d7e3fc)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.05))',
}

export const PANEL: React.CSSProperties = {
  background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

export const METRIC_GRID: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12,
}

export const STACK: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18 }

export function fmtM(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}T`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(1)}B`
  return `$${v.toFixed(0)}M`
}

// Labelled input group with an optional hint line.
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={LABEL}>{label}</label>
      {children}
      {hint && <div style={HINT}>{hint}</div>}
    </div>
  )
}

// Titled chart panel with the inset label tab used across the valuation charts.
export function ChartPanel({ title, height = 240, children }: { title: string; height?: number; children: React.ReactNode }) {
  return (
    <div style={{ ...PANEL, padding: '30px 10px 10px', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.85))',
        padding: '4px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
      }}>{title}</div>
      <div style={{ height }}>{children}</div>
    </div>
  )
}
