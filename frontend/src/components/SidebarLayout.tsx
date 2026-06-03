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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Collapsible controls panel */}
        <div style={{ background: '#101c2e', border: '1px solid #2e394d' }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 12px', background: '#142032', border: 'none', cursor: 'pointer',
              borderBottom: open ? '1px solid #2e394d' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={13} style={{ color: '#c9a84c' }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
                {sidebarTitle}
              </span>
            </div>
            {open
              ? <ChevronUp size={14} style={{ color: '#99907e' }} />
              : <ChevronDown size={14} style={{ color: '#99907e' }} />
            }
          </button>
          {open && (
            <div style={{ padding: 12 }}>
              {sidebar}
            </div>
          )}
        </div>

        {/* Main content */}
        <div style={{ minWidth: 0 }}>
          {children}
        </div>
      </div>
    )
  }

  // Desktop: side-by-side
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        width: sidebarWidth,
        flexShrink: 0,
        background: '#101c2e',
        border: '1px solid #2e394d',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {sidebar}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  )
}
