// Pre-run / empty state for tools. Renders a ghost of the cockpit the tool will
// fill — a KPI strip and a chart-or-table preview with real labels — so a
// full-width page never reads as an unfinished void. Backward compatible: called
// with just {title, hint} it renders a clean centered message (no config, no
// ghost). Flagship tools pass kpis/preview/columns to get the full ghost cockpit.
// (Design handoff 2026-07-11: ToolPreview replaces the old caret-in-a-void.)

const MONO = 'var(--theme-mono)'
const SEC = 'var(--theme-secondary, #8099b0)'
const TXT = 'var(--theme-text, #d7e3fc)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
// The ⌘ glyph only renders in a system font — a theme mono font shows tofu.
const KEY_FONT = '-apple-system, "Segoe UI", system-ui, sans-serif'

export interface EmptyStateProps {
  title: string
  hint: string
  keys?: string[]                       // key badges under the message, e.g. ['Enter', '⌘K']
  kpis?: string[]                       // ghost KPI-strip labels (enables the cockpit)
  preview?: 'chart' | 'table'           // ghost output preview (enables the cockpit)
  columns?: string[]                    // table header labels when preview='table'
  previewLabel?: string
}

function KeyBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: KEY_FONT, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
      color: SEC, border: `1px solid ${BORDER}`, borderRadius: 2, padding: '1px 6px',
    }}>{children}</span>
  )
}

function Message({ title, hint, keys, overlay }: { title: string; hint: string; keys?: string[]; overlay?: boolean }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 9, textAlign: 'center', ...(overlay ? { position: 'absolute', inset: 0 } : {}),
    }}>
      <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: TXT }}>
        {title}
      </div>
      <div style={{ fontSize: 11.5, color: SEC, letterSpacing: '0.02em', lineHeight: '17px', maxWidth: 380 }}>
        {hint}
      </div>
      {keys && keys.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {keys.map((k, i) => <KeyBadge key={i}>{k}</KeyBadge>)}
        </div>
      )}
    </div>
  )
}

// Ghost KPI strip — real labels, muted placeholder bars.
function GhostKpis({ labels }: { labels: string[] }) {
  return (
    <div className="ft-ghost-kpis" style={{ display: 'grid', gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))`, background: 'var(--theme-hover, rgba(0,0,0,0.12))', border: `1px solid ${BORDER}` }}>
      {labels.map((label, i) => (
        <div className="ft-ghost-kpi" key={i} style={{ minWidth: 0, padding: '11px 16px', borderLeft: i === 0 ? 'none' : `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: SEC }}>{label}</div>
          <div style={{ height: 15, width: 48 + (i * 13) % 40, background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 9%, transparent)', marginTop: 7 }} />
        </div>
      ))}
    </div>
  )
}

function GhostChart({ title, hint, keys }: { title: string; hint: string; keys?: string[] }) {
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 220, border: `1px solid ${BORDER}`, padding: '16px', boxSizing: 'border-box', overflow: 'hidden' }}>
      <svg viewBox="0 0 1000 330" preserveAspectRatio="none" style={{ display: 'block', position: 'absolute', inset: 16, width: 'auto', height: 'auto' }}>
        {[66, 132, 198, 264].map(y => <line key={y} x1="0" y1={y} x2="1000" y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />)}
        <path d="M30 40 C 340 62 620 150 975 296" fill="none" stroke="color-mix(in srgb, var(--theme-text, #d7e3fc) 16%, transparent)" strokeWidth="2" strokeDasharray="7 7" vectorEffect="non-scaling-stroke" />
      </svg>
      <Message title={title} hint={hint} keys={keys} overlay />
    </div>
  )
}

function GhostTable({ title, hint, keys, columns }: { title: string; hint: string; keys?: string[]; columns: string[] }) {
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 220, border: `1px solid ${BORDER}`, padding: '12px 0 0', boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ display: 'flex', padding: '0 16px 8px', borderBottom: `1px solid ${BORDER}` }}>
        {columns.map((c, i) => (
          <div key={i} style={{ flex: 1, fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: SEC, textAlign: i === 0 ? 'left' : 'right' }}>{c}</div>
        ))}
      </div>
      {[0, 1, 2, 3, 4].map(r => (
        <div key={r} style={{ display: 'flex', padding: '0 16px', height: 30, alignItems: 'center', borderBottom: `1px solid var(--theme-border-faint, rgba(255,255,255,0.04))` }}>
          {columns.map((_, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', justifyContent: i === 0 ? 'flex-start' : 'flex-end' }}>
              <div style={{ height: 10, width: i === 0 ? 74 : 46, background: `color-mix(in srgb, var(--theme-text, #d7e3fc) ${Math.max(2, 7 - r)}%, transparent)` }} />
            </div>
          ))}
        </div>
      ))}
      <div style={{ position: 'absolute', inset: '12px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Message title={title} hint={hint} keys={keys} />
      </div>
    </div>
  )
}

export default function EmptyState({ title, hint, keys, kpis, preview, columns }: EmptyStateProps) {
  const cockpit = !!(kpis?.length || preview)
  if (!cockpit) {
    // Clean centered message — no caret, no fake ghost when the tool gives no config.
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 24px',
        background: 'var(--theme-bg, #101c2e)', border: `1px solid ${BORDER}`, minHeight: 220,
      }}>
        <Message title={title} hint={hint} keys={keys} />
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 320,
      background: 'var(--theme-bg, #101c2e)', border: `1px solid ${BORDER}`, boxSizing: 'border-box',
    }}>
      {kpis?.length ? <GhostKpis labels={kpis} /> : null}
      {preview === 'table'
        ? <GhostTable title={title} hint={hint} keys={keys} columns={columns ?? ['', '', '', '']} />
        : <GhostChart title={title} hint={hint} keys={keys} />}
    </div>
  )
}
