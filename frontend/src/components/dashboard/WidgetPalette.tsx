import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { WidgetType } from '../../hooks/useDashboard'
import { WIDGET_DEFINITIONS, WIDGET_TYPES } from './widgetRegistry'

const ALL_TYPES = [...WIDGET_TYPES].sort((a, b) => {
  const da = WIDGET_DEFINITIONS[a]
  const db = WIDGET_DEFINITIONS[b]
  return da.category.localeCompare(db.category) || da.name.localeCompare(db.name)
})

interface WidgetPaletteProps {
  open: boolean
  onClose: () => void
  onAdd: (type: WidgetType) => void
}

export default function WidgetPalette({ open, onClose, onAdd }: WidgetPaletteProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, zIndex: 48, background: 'rgba(0,0,0,0.5)' }}
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, width: 300,
              zIndex: 49, background: 'var(--theme-bg, #060e1c)', borderLeft: '1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)',
              display: 'flex', flexDirection: 'column', overflowY: 'auto',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.08)))', flexShrink: 0 }}>
              <div>
                <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>
                  Add Widget
                </div>
                <div style={{ fontSize: 10, color: 'var(--theme-secondary, #8099b0)', marginTop: 2 }}>
                  Click to add to dashboard
                </div>
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #8099b0)' }}>
                <X size={16} />
              </button>
            </div>

            {/* Widget list */}
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ALL_TYPES.map(type => (
                <button
                  key={type}
                  onClick={() => { onAdd(type); onClose() }}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 11, width: '100%',
                    background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.08)))', padding: '10px 12px',
                    cursor: 'pointer', textAlign: 'left', transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => ((e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)')}
                  onMouseLeave={e => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--theme-border, rgba(255,255,255,0.08))')}
                >
                  <span style={{
                    width: 32, height: 32, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)',
                    background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)',
                    fontFamily: 'var(--theme-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.02em',
                    color: 'var(--theme-primary, #c9a84c)', lineHeight: 1,
                  }}>{WIDGET_DEFINITIONS[type].icon}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, fontWeight: 600, color: 'var(--theme-text, #d7e3fc)', marginBottom: 3 }}>
                      {WIDGET_DEFINITIONS[type].name}
                    </div>
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, color: 'var(--theme-primary, #c9a84c)', marginBottom: 3 }}>{WIDGET_DEFINITIONS[type].category} | {WIDGET_DEFINITIONS[type].priority}</div>
                    <div style={{ fontSize: 10, color: 'var(--theme-secondary, #8099b0)', lineHeight: '14px' }}>
                      {WIDGET_DEFINITIONS[type].description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
