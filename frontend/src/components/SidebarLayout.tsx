import { useState } from 'react'
import useIsMobile from '../hooks/useIsMobile'
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react'

interface SidebarLayoutProps {
  sidebar: React.ReactNode
  sidebarTitle?: string
  children: React.ReactNode
  sidebarWidth?: number
}

export default function SidebarLayout({
  sidebar,
  sidebarTitle = 'Controls',
  children,
  sidebarWidth = 210,
}: SidebarLayoutProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)

  if (isMobile) {
    return (
      <div className="ft-tool-layout" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="ft-panel ft-tool-sidebar">
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: open ? '1px solid var(--theme-border, rgba(255,255,255,0.08))' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={12} style={{ color: 'var(--theme-primary, #c9a84c)' }} />
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>
                {sidebarTitle || 'Controls'}
              </span>
            </div>
            {open
              ? <ChevronUp   size={13} style={{ color: 'var(--theme-secondary, #8099b0)' }} />
              : <ChevronDown size={13} style={{ color: 'var(--theme-secondary, #8099b0)' }} />
            }
          </button>
          {open && <div style={{ padding: 14 }}>{sidebar}</div>}
        </div>
        <div className="ft-tool-content" style={{ minWidth: 0 }}>{children}</div>
      </div>
    )
  }

  // Desktop: sidebar flush against content, separated by a single border.
  // Chrome comes from .ft-sidebar-panel / .ft-sidebar-title / .ft-sidebar-body,
  // not an inline copy of them — keeping both is how the two drifted apart. No
  // shadow: this is the largest surface in the tool, and lifting it made the
  // page float over the app sidebar.
  return (
    <div className="ft-tool-layout" style={{ display: 'flex', alignItems: 'flex-start', gap: 0, border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      {/* Sidebar */}
      <div className="ft-tool-sidebar ft-sidebar-panel" style={{ width: sidebarWidth, flexShrink: 0, alignSelf: 'stretch' }}>
        {/* Title strip — omitted when the tool supplies its own RailSection headers (sidebarTitle="") */}
        {sidebarTitle && (
          <div className="ft-sidebar-title">
            <SlidersHorizontal size={10} style={{ color: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
            {sidebarTitle}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {sidebar}
        </div>
      </div>

      {/* Main content — use page bg so panels inside have positive contrast */}
      <div className="ft-tool-content" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: 'var(--theme-bg, #101c2e)' }}>
        {children}
      </div>
    </div>
  )
}
