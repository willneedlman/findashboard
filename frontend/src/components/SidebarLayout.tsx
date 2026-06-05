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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="ft-panel">
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: open ? '1px solid rgba(255,255,255,0.06)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={12} style={{ color: 'var(--theme-primary, #c9a84c)' }} />
              <span style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>
                {sidebarTitle}
              </span>
            </div>
            {open
              ? <ChevronUp   size={13} style={{ color: 'var(--theme-secondary, #5e768f)' }} />
              : <ChevronDown size={13} style={{ color: 'var(--theme-secondary, #5e768f)' }} />
            }
          </button>
          {open && <div style={{ padding: 14 }}>{sidebar}</div>}
        </div>
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    )
  }

  // Desktop: sidebar flush against content, separated by a single border
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 1px 4px rgba(0,0,0,0.35)' }}>
      {/* Sidebar */}
      <div style={{
        width: sidebarWidth,
        flexShrink: 0,
        background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 100%, black 8%)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        alignSelf: 'stretch',
      }}>
        {/* Sidebar title strip */}
        <div style={{
          padding: '9px 14px',
          background: 'rgba(0,0,0,0.2)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          flexShrink: 0,
        }}>
          <SlidersHorizontal size={10} style={{ color: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
          <span style={{
            fontFamily: 'IBM Plex Sans, sans-serif',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.16em',
            textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)',
          }}>
            {sidebarTitle}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {sidebar}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: 'var(--theme-surface, #0d1826)' }}>
        {children}
      </div>
    </div>
  )
}
