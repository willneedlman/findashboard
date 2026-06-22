// Demo-only shell for the tools-redesign preview: a faithful slice of the app
// chrome (56px icon rail + bordered workspace) so each redesigned tool reads in
// context. The real app already has this chrome in Layout.tsx; this is just for
// the standalone /redesign preview and is not used by production pages.
import { Search, BarChart3, Layers, Briefcase } from 'lucide-react'
import { T } from '../../lib/theme'

const RAIL_ICONS = [Search, BarChart3, Layers, Briefcase]

export function IconRail({ active = 1 }: { active?: number }) {
  return (
    <div style={{
      width: 56, flex: 'none', background: T.surface,
      borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.07))',
      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 0', gap: 4,
    }}>
      <div style={{ fontFamily: 'Cinzel, serif', fontSize: 22, fontWeight: 700, color: T.gold, lineHeight: 1, marginBottom: 12 }}>α</div>
      {RAIL_ICONS.map((Icon, i) => {
        const on = i === active
        return (
          <div key={i} style={{
            position: 'relative', width: 36, height: 36, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: on ? T.gold : T.muted,
            background: on ? T.goldTint(12) : 'transparent',
          }}>
            {on && <div style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 2, background: T.gold }} />}
            <Icon size={18} strokeWidth={1.6} />
          </div>
        )
      })}
    </div>
  )
}

// Bordered tool frame: icon rail + workspace, max 1180px, centered.
export function ToolFrame({ railActive = 1, children }: { railActive?: number; children: React.ReactNode }) {
  return (
    <div style={{
      width: '100%', maxWidth: 1180, margin: '0 auto', background: T.bg,
      border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', overflow: 'hidden',
    }}>
      <IconRail active={railActive} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}
