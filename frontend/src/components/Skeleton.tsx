import type { CSSProperties } from 'react'

// Shimmer placeholder bones. Reuses the ft-shimmer keyframe in index.css and the
// theme text color, so it re-themes and respects prefers-reduced-motion.
const SHIMMER: CSSProperties = {
  background: 'linear-gradient(90deg, color-mix(in srgb, var(--theme-text, #d7e3fc) 6%, transparent) 25%, color-mix(in srgb, var(--theme-text, #d7e3fc) 16%, transparent) 50%, color-mix(in srgb, var(--theme-text, #d7e3fc) 6%, transparent) 75%)',
  backgroundSize: '200% 100%',
  animation: 'ft-shimmer 1.4s linear infinite',
}

export function Skel({ w = '100%', h = 10, r = 3, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <div aria-hidden style={{ width: w, height: h, borderRadius: r, flexShrink: 0, ...SHIMMER, ...style }} />
}

const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'

// Skeleton for the Global Markets board: a Spotlight card row over three columns
// of section tables — the same bones as the loaded board, so nothing jumps in.
export function BoardSkeleton({ isMobile }: { isMobile?: boolean }) {
  const card = (
    <div style={{ background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, var(--theme-surface, #0d1826))', border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)`, borderRadius: 0, padding: '13px 14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Skel w={90} h={9} r={0} />
      <Skel w={110} h={20} r={0} />
      <Skel w={64} h={9} r={0} />
    </div>
  )
  const rows = (n: number) => (
    <div>
      <Skel w={120} h={9} r={0} style={{ marginBottom: 12 }} />
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', borderBottom: `1px solid var(--theme-border-faint, rgba(255,255,255,0.05))` }}>
          <Skel w={16} h={16} r={0} />
          <Skel w={`${40 + (i * 7) % 30}%`} h={10} r={0} />
          <Skel w={46} h={12} r={0} style={{ marginLeft: 'auto' }} />
          <Skel w={40} h={12} r={0} />
        </div>
      ))}
    </div>
  )
  return (
    <div aria-busy="true" aria-label="Loading the board">
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 6}, 1fr)`, gap: 12, marginBottom: 26 }}>
        {Array.from({ length: isMobile ? 2 : 6 }).map((_, i) => <div key={i}>{card}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 26 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>{rows(8)}{rows(10)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>{rows(8)}{rows(10)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>{rows(9)}{rows(5)}{rows(3)}</div>
      </div>
    </div>
  )
}
