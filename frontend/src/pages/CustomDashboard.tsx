import { useState, useEffect, useRef } from 'react'
import RGL, { type Layout, type Layouts } from 'react-grid-layout'
import { useTheme } from '../contexts/ThemeContext'
import 'react-grid-layout/css/styles.css'

// react-grid-layout v1 is CJS; Vite 8/Rolldown pre-bundles it to a single
// default export that carries Responsive/WidthProvider as properties.
const { Responsive, WidthProvider } = RGL as unknown as {
  Responsive: React.ComponentType<any>
  WidthProvider: (c: React.ComponentType<any>) => React.ComponentType<any>
}
import { Lock, Unlock, Plus, RotateCcw, X, ChevronDown,
  LayoutGrid, Gauge, Search, Filter, Globe, Layers, Shield, BarChart3, LineChart,
  Briefcase, Activity, Eye, PieChart, Newspaper, TrendingUp, DollarSign, Maximize2, Minimize2, type LucideIcon } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import WidgetFrame from '../components/dashboard/WidgetFrame'
import WidgetRenderer from '../components/dashboard/WidgetRenderer'
import WidgetPalette from '../components/dashboard/WidgetPalette'
import { useDashboard, PRESET_LABELS, PRESET_ICONS, TICKER_WIDGET_TYPES, type WidgetType, type WidgetConfig, type PresetKey } from '../hooks/useDashboard'
import useIsMobile from '../hooks/useIsMobile'

const ResponsiveGridLayout = WidthProvider(Responsive)

const BREAKPOINTS = { lg: 1080, md: 900, sm: 720, xs: 480, xxs: 0 }
const COLS        = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }

// Pickable dashboard icons (string key persisted per dashboard, resolved here).
const DASH_ICONS: Record<string, LucideIcon> = {
  grid: LayoutGrid, gauge: Gauge, search: Search, filter: Filter, globe: Globe,
  layers: Layers, shield: Shield, bar: BarChart3, line: LineChart, briefcase: Briefcase,
  activity: Activity, eye: Eye, pie: PieChart, news: Newspaper, trending: TrendingUp, dollar: DollarSign,
}
const DASH_ICON_KEYS = Object.keys(DASH_ICONS)
function DashIcon({ k, size = 13 }: { k?: string; size?: number }) {
  const Ic = DASH_ICONS[k ?? 'grid'] ?? LayoutGrid
  return <Ic size={size} />
}
// Default icon for a dashboard: its explicit icon, else one inferred from a
// preset name (so existing preset dashboards look distinct without setup).
const NAME_ICON: Record<string, string> = Object.fromEntries(
  (Object.keys(PRESET_LABELS) as PresetKey[]).map(k => [PRESET_LABELS[k], PRESET_ICONS[k]])
)
const iconForDash = (d: { name: string; icon?: string }) => d.icon ?? NAME_ICON[d.name] ?? 'grid'

export default function CustomDashboard() {
  const isMobile = useIsMobile()
  const { user } = useTheme()
  const {
    widgets, layouts, addWidget, removeWidget, updateWidget, updateLayouts, resetDashboard, setAllTickers,
    showTicker, setShowTicker,
    dashboards, activeId, switchDashboard, createDashboard, renameDashboard, deleteDashboard, setDashboardIcon,
  } = useDashboard(user?.id)
  const [editMode, setEditMode] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)

  // Full-screen the dashboard (toolbar + grid) via the Fullscreen API, so the
  // board can fill the display with no terminal chrome around it.
  const fullscreenRef = useRef<HTMLDivElement>(null)
  const [isFull, setIsFull] = useState(false)
  useEffect(() => {
    const onChange = () => setIsFull(document.fullscreenElement === fullscreenRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else fullscreenRef.current?.requestFullscreen?.()
  }

  // Dashboard-wide ticker: one input that retargets every ticker-driven widget
  // so you don't set them one by one.
  const tickerWidgets = widgets.filter(w => TICKER_WIDGET_TYPES.includes(w.type))
  const [tickerInput, setTickerInput] = useState('')
  useEffect(() => {
    const cur = widgets.find(w => TICKER_WIDGET_TYPES.includes(w.type) && w.ticker)?.ticker
    setTickerInput(cur ? cur.toUpperCase() : '')
    // re-seed from the active dashboard when switching tabs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])
  const applyTicker = () => {
    const sym = tickerInput.trim().toUpperCase()
    if (!sym) return
    setAllTickers(sym)
  }

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
      <div ref={fullscreenRef} className="ft-dashboard-fs">
      {/* ── Consolidated top bar: one line — icon-collapsed dashboard tabs + controls ── */}
      {isMobile ? (
        <h1 className="ft-page-title" style={{ marginBottom: 12 }}>My Dashboard</h1>
      ) : (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingBottom: 8 }}>
        {/* Dashboards — the active one shows its name, the rest collapse to their icon (name on hover).
            flex-wrap (not overflow) so the New-preset menu and icon picker popovers aren't clipped. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          {dashboards.map(d => {
            const isActive = d.id === activeId
            return (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', flexShrink: 0, position: 'relative' }}>
                <button
                  onClick={() => switchDashboard(d.id)}
                  onDoubleClick={() => { if (editMode) { const n = window.prompt('Rename dashboard', d.name); if (n && n.trim()) renameDashboard(d.id, n.trim()) } }}
                  title={isActive ? (editMode ? 'Double-click to rename' : d.name) : d.name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: isActive ? 7 : 0,
                    padding: isActive ? '5px 12px' : '6px', cursor: 'pointer',
                    border: `1px solid ${isActive ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                    background: isActive ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent',
                    color: isActive ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #5e768f)',
                  }}
                >
                  <DashIcon k={iconForDash(d)} />
                  {isActive && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{d.name}</span>}
                </button>
                {editMode && isActive && (
                  <>
                    <button onClick={() => setIconPickerOpen(o => !o)} title="Choose icon"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #5e768f)', padding: '2px', display: 'flex' }}>
                      <ChevronDown size={12} />
                    </button>
                    {dashboards.length > 1 && (
                      <button onClick={() => deleteDashboard(d.id)} title="Delete dashboard"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-negative)', padding: '2px', display: 'flex' }}>
                        <X size={12} />
                      </button>
                    )}
                    {iconPickerOpen && (
                      <div style={{ position: 'absolute', top: '120%', left: 0, zIndex: 40, background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-primary, #c9a84c)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', padding: 8, display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
                        {DASH_ICON_KEYS.map(k => {
                          const sel = iconForDash(d) === k
                          return (
                            <button key={k} onClick={() => { setDashboardIcon(d.id, k); setIconPickerOpen(false) }} title={k}
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, cursor: 'pointer', border: `1px solid ${sel ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`, background: sel ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent', color: sel ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)' }}>
                              <DashIcon k={k} size={14} />
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
          {/* New dashboard (preset menu) */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setPresetMenuOpen(o => !o)} title="New dashboard"
              style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', cursor: 'pointer', border: '1px dashed var(--theme-border, rgba(255,255,255,0.18))', background: 'transparent', color: 'var(--theme-secondary, #5e768f)' }}>
              <Plus size={13} />
            </button>
            {presetMenuOpen && (
              <div style={{ position: 'absolute', top: '120%', left: 0, zIndex: 30, minWidth: 150, background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-primary, #c9a84c)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', padding: '7px 10px 4px' }}>From preset</div>
                {(['cockpit', 'research', 'screening', 'market-overview', 'options', 'risk', 'main'] as PresetKey[]).map(k => (
                  <button key={k} onClick={() => { createDashboard(k); setPresetMenuOpen(false) }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'var(--theme-sans)', fontSize: 11, padding: '7px 10px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--theme-text, #d7e3fc)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary) 10%, transparent)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >{PRESET_LABELS[k]}</button>
                ))}
                <button onClick={() => { createDashboard('blank'); setPresetMenuOpen(false) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'var(--theme-sans)', fontSize: 11, padding: '7px 10px', cursor: 'pointer', border: 'none', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'transparent', color: 'var(--theme-primary, #c9a84c)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary) 10%, transparent)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >Custom — start blank</button>
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span title={editMode ? 'Drag to rearrange · resize from corners · click + to add widgets' : `${widgets.length} widget${widgets.length !== 1 ? 's' : ''} · click the lock to customise`}
            style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>
            {editMode ? 'Drag · resize · + add' : `${widgets.length} widget${widgets.length !== 1 ? 's' : ''}`}
          </span>
          {(showTicker || tickerWidgets.length > 0) && (
            <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))' }} title={`Applies to ${tickerWidgets.length} ticker widget${tickerWidgets.length !== 1 ? 's' : ''} on this dashboard`}>
              <span style={{ display: 'flex', alignItems: 'center', fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', padding: '0 8px', background: 'var(--theme-surface, #0d1826)' }}>Ticker</span>
              <input
                value={tickerInput}
                onChange={e => setTickerInput(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter') applyTicker() }}
                placeholder="AAPL"
                size={Math.max(8, tickerInput.length + 1)}
                style={{ background: 'var(--theme-bg, #101c2e)', border: 'none', borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', padding: '6px 8px', outline: 'none' }}
              />
              <button onClick={applyTicker} title="Apply ticker to all widgets"
                style={{ background: 'color-mix(in srgb, var(--theme-primary) 12%, transparent)', border: 'none', borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-primary, #c9a84c)', padding: '0 12px', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
              >Apply</button>
            </div>
          )}
          {editMode && (
            <>
              <button
                onClick={() => setPaletteOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)', padding: '6px 12px', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
              >
                <Plus size={12} /> Add Widget
              </button>
              <button
                onClick={handleReset}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: `1px solid ${confirmReset ? 'var(--theme-negative, #ef4444)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`, color: confirmReset ? 'var(--theme-negative, #ef4444)' : 'var(--theme-secondary, #5e768f)', padding: '6px 12px', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
              >
                <RotateCcw size={12} /> {confirmReset ? 'Confirm Reset' : 'Reset'}
              </button>
            </>
          )}
          <button
            onClick={() => { setEditMode(e => !e); setPaletteOpen(false) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: editMode ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'var(--theme-surface, #1f2a3d)', border: `1px solid ${editMode ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`, color: editMode ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #5e768f)', padding: '6px 12px', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', transition: 'all 0.15s' }}
          >
            {editMode ? <><Unlock size={12} /> Done</> : <><Lock size={12} /> Edit</>}
          </button>
          <button
            onClick={toggleFullscreen}
            title={isFull ? 'Exit full screen' : 'Full screen'}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-secondary, #5e768f)', padding: '6px 10px', cursor: 'pointer', transition: 'all 0.15s' }}
          >
            {isFull ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>
      )}

      {/* ── Mobile: not available ── */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px', gap: 12, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 32, color: 'var(--theme-text-subtle, rgba(255,255,255,0.08))' }}>⊞</div>
          <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 13, fontWeight: 600, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.06em' }}>
            Desktop Only
          </div>
          <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-secondary, #5e768f)', maxWidth: 260, lineHeight: 1.6 }}>
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
                  onUpdate={(patch: Partial<WidgetConfig>) => updateWidget(w.id, patch)}
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
        onAdd={(type: WidgetType) => { if (type === 'ticker-control') setShowTicker(true); else addWidget(type) }}
      />
      </div>
    </PageWrapper>
  )
}
