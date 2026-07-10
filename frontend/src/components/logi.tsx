// Shared primitives for the Geo-Logistics hub pages. Adaptive theme tokens
// throughout so light presets keep contrast (see the MaritimeMap token fix).
export const L = {
  mono: 'var(--theme-mono)',
  sans: 'var(--theme-sans)',
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  sec: 'var(--theme-secondary, #8099b0)',
  faint: 'var(--theme-text-faint, #56708a)',
  surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  goldTint: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)',
  pos: 'var(--theme-positive, #3fb6a0)',
  neg: 'var(--theme-negative, #cf4b3f)',
}

export function StaleDot({ stale }: { stale?: boolean }) {
  return stale
    ? <span title="serving cached data (last fetch failed)" style={{ fontFamily: L.mono, fontSize: 8, color: L.faint, border: `1px solid ${L.faint}`, padding: '0 4px', marginLeft: 6 }}>CACHED</span>
    : null
}

export function Spark({ data, color = L.gold, w = 120, h = 30 }: { data: number[]; color?: string; w?: number; h?: number }) {
  const pts = data.filter(v => v != null)
  if (pts.length < 2) return null
  const min = Math.min(...pts), max = Math.max(...pts), rng = max - min || 1
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ')
  return <svg width={w} height={h} style={{ display: 'block' }}><polyline points={d} fill="none" stroke={color} strokeWidth={1.6} /></svg>
}

export function Card({ title, source, stale, children }: { title: string; source?: string; stale?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ background: L.surface, border: `1px solid ${L.border}`, borderRadius: 6, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
        <span style={{ fontFamily: L.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: L.gold }}>{title}<StaleDot stale={stale} /></span>
        {source && <span style={{ fontFamily: L.mono, fontSize: 8.5, color: L.faint, textAlign: 'right' }}>{source}</span>}
      </div>
      {children}
    </div>
  )
}

export function PageHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <div style={{ fontFamily: L.mono, fontSize: 15, fontWeight: 700, letterSpacing: '0.2em', color: L.gold }}>{title}</div>
      <div style={{ fontFamily: L.sans, fontSize: 11, color: L.sec, marginTop: 6 }}>{sub}</div>
    </div>
  )
}
