import { useState } from 'react'
import RGL, { type Layout, type Layouts } from 'react-grid-layout'
import { useTheme } from '../contexts/ThemeContext'
import 'react-grid-layout/css/styles.css'

// react-grid-layout v1 is CJS; Vite 8/Rolldown pre-bundles it to a single
// default export that carries Responsive/WidthProvider as properties.
const { Responsive, WidthProvider } = RGL as unknown as {
  Responsive: React.ComponentType<any>
  WidthProvider: (c: React.ComponentType<any>) => React.ComponentType<any>
}
import { Lock, Unlock, Plus, RotateCcw } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import WidgetFrame from '../components/dashboard/WidgetFrame'
import WidgetRenderer from '../components/dashboard/WidgetRenderer'
import WidgetPalette from '../components/dashboard/WidgetPalette'
import { useDashboard, type WidgetType } from '../hooks/useDashboard'
import useIsMobile from '../hooks/useIsMobile'

const ResponsiveGridLayout = WidthProvider(Responsive)

const BREAKPOINTS = { lg: 1080, md: 900, sm: 720, xs: 480, xxs: 0 }
const COLS        = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }

export default function CustomDashboard() {
  const isMobile = useIsMobile()
  const { user } = useTheme()
  const { widgets, layouts, addWidget, removeWidget, updateWidget, updateLayouts, resetDashboard } = useDashboard(user?.id)
  const [editMode, setEditMode] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const handleLayoutChange = (_: Layout[], allLayouts: Layouts) => {
    if (allLayouts.lg) updateLayouts(allLayouts.lg)
  }

  const rglLayouts: Layouts = { lg: layouts, md: layouts, sm: layouts }

  const handleReset = () => {
    if (confirmReset) { resetDashboard(); setConfirmReset(false) }
    else { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 3000) }
  }

  return (
    <PageWrapper>
      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: 18, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--theme-primary, #c9a84c)', marginBottom: 2 }}>
            My Dashboard
          </h1>
          <p style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 11, color: 'var(--theme-secondary, #5e768f)' }}>
            {editMode ? 'Drag to rearrange · resize from corners · click + to add widgets' : `${widgets.length} widget${widgets.length !== 1 ? 's' : ''} · click the lock to customise`}
          </p>
        </div>

        {!isMobile && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {editMode && (
            <>
              <button
                onClick={() => setPaletteOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)', padding: '6px 12px', cursor: 'pointer', fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
              >
                <Plus size={12} /> Add Widget
              </button>
              <button
                onClick={handleReset}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: `1px solid ${confirmReset ? '#EF4444' : 'rgba(255,255,255,0.08)'}`, color: confirmReset ? '#EF4444' : 'var(--theme-secondary, #5e768f)', padding: '6px 12px', cursor: 'pointer', fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
              >
                <RotateCcw size={12} /> {confirmReset ? 'Confirm Reset' : 'Reset'}
              </button>
            </>
          )}
          <button
            onClick={() => { setEditMode(e => !e); setPaletteOpen(false) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: editMode ? 'rgba(201,168,76,0.12)' : 'var(--theme-surface, #1f2a3d)', border: `1px solid ${editMode ? 'var(--theme-primary, #c9a84c)' : 'rgba(255,255,255,0.08)'}`, color: editMode ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #5e768f)', padding: '6px 12px', cursor: 'pointer', fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', transition: 'all 0.15s' }}
          >
            {editMode ? <><Unlock size={12} /> Done</> : <><Lock size={12} /> Edit</>}
          </button>
        </div>}
      </div>

      {/* ── Mobile: not available ── */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px', gap: 12, textAlign: 'center' }}>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 32, color: 'rgba(255,255,255,0.08)' }}>⊞</div>
          <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 13, fontWeight: 600, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.06em' }}>
            Desktop Only
          </div>
          <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 11, color: 'var(--theme-secondary, #5e768f)', maxWidth: 260, lineHeight: 1.6 }}>
            The custom dashboard requires a larger screen. Open it on a desktop or tablet for the full drag-and-resize experience.
          </div>
        </div>
      ) : (
        /* ── Desktop: react-grid-layout ── */
        <div className={editMode ? 'rgl-edit-mode' : ''}>
          <ResponsiveGridLayout
            layouts={rglLayouts}
            breakpoints={BREAKPOINTS}
            cols={COLS}
            rowHeight={60}
            margin={[10, 10]}
            isDraggable={editMode}
            isResizable={editMode}
            draggableCancel=".widget-no-drag"
            resizeHandles={['se', 'sw']}
            onLayoutChange={handleLayoutChange}
            compactType="vertical"
            preventCollision={false}
            useCSSTransforms
          >
            {widgets.map(w => (
              <div key={w.id}>
                <WidgetFrame
                  config={w}
                  editMode={editMode}
                  onRemove={() => removeWidget(w.id)}
                  onUpdate={patch => updateWidget(w.id, patch)}
                >
                  <WidgetRenderer config={w} />
                </WidgetFrame>
              </div>
            ))}
          </ResponsiveGridLayout>
        </div>
      )}

      {/* ── Widget palette drawer ── */}
      <WidgetPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAdd={(type: WidgetType) => addWidget(type)}
      />
    </PageWrapper>
  )
}
