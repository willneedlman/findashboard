import { useState, useEffect, useCallback } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Home, LayoutGrid, Briefcase, X, Menu, Settings,
  ShieldAlert, Star, ChevronRight, ChevronLeft, Search,
} from 'lucide-react'
import Footer from './Footer'
import AlphaMark from './AlphaMark'
import TickerLinkChip from './TickerLinkChip'
import AlertToastQueue from './AlertToastQueue'
import { useAlertSocket, type AlertPayload } from '../hooks/useAlertSocket'
import useIsMobile from '../hooks/useIsMobile'
import { useTheme } from '../contexts/ThemeContext'
import { HUBS, ALL_TOOLS, hubForLocation, type Hub, type HubTool } from '../lib/hubs'

const ADMIN_USERS = ['wneedlman']

interface LayoutProps { children: React.ReactNode }

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { user } = useTheme()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isAdmin = !!user && ADMIN_USERS.includes(user.username?.toLowerCase())

  const hubLanding = location.pathname.match(/^\/hub\/([^/]+)/)
  const activeHub = hubLanding
    ? HUBS.find(h => h.slug === hubLanding[1])
    : hubForLocation(location.pathname, location.search)
  const isToolActive = (route: string) =>
    route.includes('?') ? route === location.pathname + location.search : route === location.pathname

  // Favorites are persisted by route path under ft_nav_favorites (unchanged store).
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('ft_nav_favorites') ?? '[]') } catch { return [] }
  })
  const toggleFav = (path: string) => {
    setFavorites(prev => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
      localStorage.setItem('ft_nav_favorites', JSON.stringify(next))
      return next
    })
  }
  const favItems = favorites.map(p => ALL_TOOLS.find(t => t.route === p)).filter((x): x is HubTool => x != null)

  // Independent open/close per hub; the current hub defaults open.
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ [activeHub?.slug ?? 'research']: true }))
  useEffect(() => {
    if (activeHub) setOpen(o => (o[activeHub.slug] ? o : { ...o, [activeHub.slug]: true }))
  }, [activeHub?.slug]) // eslint-disable-line react-hooks/exhaustive-deps

  const [pendingAlerts, setPendingAlerts] = useState<AlertPayload[]>([])
  const onAlert = useCallback((a: AlertPayload) => {
    setPendingAlerts([a])
    // Fire the OS notification whenever permission is granted — not only when the
    // tab is hidden — so the user actually sees it. The in-app toast still shows.
    if ('Notification' in window && Notification.permission === 'granted') {
      const body = a.condition === 'macro_event_within_days'
        ? `Upcoming${a.fired_tickers?.length ? ` → ${a.fired_tickers.join('; ')}` : ' macro events'}`
        : a.condition.startsWith('strategy')
        ? `${a.condition === 'strategy_entry' ? 'Entry' : 'Exit'} signal fired${a.fired_tickers?.length ? ` → ${a.fired_tickers.join(', ')}` : ''}`
        : `${a.condition.replace(/_/g, ' ')} ${a.threshold}${a.current_price > 0 ? ` → $${a.current_price.toFixed(2)}` : ''}`
      new Notification(`Alert: ${a.ticker}`, { body, icon: '/favicon.svg' })
    }
  }, [])
  useAlertSocket(user?.id ?? null, onAlert)

  useEffect(() => { setDrawerOpen(false) }, [location.pathname])
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  // ── Mobile ──
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen overflow-hidden">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', height: 52, flexShrink: 0, background: 'var(--theme-bg, #060e1c)', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)', position: 'sticky', top: 0, zIndex: 40 }}>
          <Link to="/app" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlphaMark size={22} color="var(--theme-primary, #c9a84c)" />
            <div style={{ fontFamily: 'Cinzel, Georgia, serif', color: 'var(--theme-primary, #c9a84c)', fontSize: 15, fontWeight: 700, letterSpacing: '0.08em' }}>
              ALPHATAPE <span style={{ color: 'var(--theme-secondary, #5e768f)', fontSize: 10, letterSpacing: '0.2em', fontFamily: 'var(--theme-sans)', fontWeight: 600 }}>TERMINAL</span>
            </div>
          </Link>
          <button onClick={() => setDrawerOpen(true)} aria-label="Open menu" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-primary, #c9a84c)', padding: 0, minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Menu size={22} />
          </button>
        </div>

        <main id="main-content" style={{ flex: 1, overflowY: 'auto', background: 'var(--theme-bg, #0a1628)' }}>
          <div style={{ padding: location.pathname === '/dashboard' ? '16px 14px 200px' : '16px 14px', display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            <div style={{ flex: 1 }}>{children}</div>
            {location.pathname !== '/dashboard' && <Footer />}
          </div>
        </main>

        <AnimatePresence>
          {drawerOpen && (
            <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={() => setDrawerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.65)' }} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {drawerOpen && (
            <motion.div key="drawer" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ duration: 0.25, ease: 'easeInOut' }} style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 264, zIndex: 50, background: 'var(--theme-bg, #060e1c)', borderLeft: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary) 12%, transparent)' }}>
                <div style={{ fontFamily: 'Cinzel, Georgia, serif', color: 'var(--theme-primary, #c9a84c)', fontSize: 14, fontWeight: 700, letterSpacing: '0.08em' }}>MENU</div>
                <button onClick={() => setDrawerOpen(false)} aria-label="Close menu" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #99907e)', minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
              </div>

              <div style={{ margin: '8px 12px 4px', padding: '6px 0 8px', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, var(--theme-surface, #0d1826))', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' }}>
                <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)', marginBottom: 2, paddingLeft: 14, fontFamily: 'var(--theme-sans)' }}>Workspaces</p>
                <MobileLink to="/app" icon={Home} label="Home" active={location.pathname === '/app'} />
                <MobileLink to="/dashboard" icon={LayoutGrid} label="My Dashboard" active={location.pathname === '/dashboard'} />
                <MobileLink to="/portfolio-manager" icon={Briefcase} label="Portfolio Manager" active={location.pathname === '/portfolio-manager'} />
              </div>

              <div style={{ padding: '4px 12px 0' }}>
                {isAdmin && (
                  <Link to="/admin" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 10px', minHeight: 44, marginBottom: 2, textDecoration: 'none', background: location.pathname === '/admin' ? 'color-mix(in srgb, var(--theme-negative) 10%, transparent)' : 'transparent', borderLeft: location.pathname === '/admin' ? '2px solid var(--theme-negative)' : '2px solid transparent', color: location.pathname === '/admin' ? 'var(--theme-negative)' : 'color-mix(in srgb, var(--theme-negative) 55%, transparent)', fontSize: 13, fontFamily: 'var(--theme-sans)' }}>
                    <ShieldAlert size={15} style={{ flexShrink: 0 }} /><span>Admin Hub</span>
                  </Link>
                )}
                <MobileLink to="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings'} />
              </div>

              <nav style={{ flex: 1, padding: '4px 12px 24px' }}>
                {favItems.length > 0 && (
                  <div>
                    <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)', marginTop: 18, marginBottom: 4, paddingLeft: 8, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--theme-sans)' }}>
                      <Star size={9} fill="currentColor" /> Favorites
                    </p>
                    {favItems.map(t => <MobileLink key={t.route} to={t.route} icon={t.icon} label={t.title} active={isToolActive(t.route)} isFav onFavToggle={toggleFav} favKey={t.route} />)}
                  </div>
                )}
                {HUBS.map(hub => (
                  <div key={hub.slug}>
                    <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.4))', marginTop: 18, marginBottom: 4, paddingLeft: 8, fontFamily: 'var(--theme-sans)' }}>{hub.label}</p>
                    {hub.tools.map(t => (
                      <MobileLink key={t.route} to={t.route} icon={t.icon} label={t.title} active={isToolActive(t.route)} isFav={favorites.includes(t.route)} onFavToggle={toggleFav} favKey={t.route} />
                    ))}
                  </div>
                ))}
              </nav>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  // ── Desktop ──
  return (
    <div className="flex h-screen overflow-hidden" id="ft-root">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <AlertToastQueue alerts={pendingAlerts} />
      <motion.aside
        animate={{ width: collapsed ? 64 : 204 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="flex-shrink-0 flex flex-col overflow-hidden"
        style={{ minWidth: 0, background: 'var(--theme-bg, #060e1c)', borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 19%, transparent)' }}
      >
        {/* brand (→ home) + collapse chevron */}
        <div style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 2 : 9, justifyContent: 'flex-start', padding: collapsed ? '0 4px 0 16px' : '0 14px', minHeight: 64, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' }}>
          <button onClick={() => navigate('/app')} aria-label="Home" title="Home" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
            <AlphaMark size={24} color="var(--theme-primary, #c9a84c)" />
            {!collapsed && (
              <span style={{ display: 'block', paddingLeft: 9, borderLeft: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 28%, transparent)', textAlign: 'left' }}>
                <span style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: 14, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--theme-primary, #c9a84c)', display: 'block', lineHeight: 1.05 }}>ALPHATAPE</span>
                <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', display: 'block' }}>Terminal</span>
              </span>
            )}
          </button>
          <button
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Open sidebar' : 'Close sidebar'}
            title={collapsed ? 'Open sidebar' : 'Close sidebar'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: collapsed ? 0 : 4, marginLeft: 'auto', display: 'flex', alignItems: 'center', color: 'var(--theme-secondary, #5e768f)' }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {/* command palette launcher */}
        <div style={{ margin: '10px 8px 0' }}>
          <button onClick={() => window.dispatchEvent(new Event('cmdk:open'))} title="Search tools & tickers (Cmd/Ctrl-K)"
            style={{ width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', gap: 8,
              padding: collapsed ? '7px 0' : '7px 10px', background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
              cursor: 'pointer', color: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-sans)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Search size={14} />
              {!collapsed && <span style={{ fontSize: 12 }}>Search…</span>}
            </span>
            {!collapsed && (
              <span style={{ fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', lineHeight: '14px', color: 'var(--theme-secondary, #8099b0)', border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '1px 6px' }}>
                {/Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
              </span>
            )}
          </button>
        </div>

        <TickerLinkChip collapsed={collapsed} />

        {/* workspaces */}
        <div style={{ margin: '10px 8px 4px', padding: collapsed ? '6px 4px' : 6, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, var(--theme-surface, #0d1826))', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' }}>
          {!collapsed && <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)', margin: '0 0 5px', paddingLeft: 8, fontFamily: 'var(--theme-sans)' }}>Workspaces</p>}
          <Row icon={Home} label="Home" collapsed={collapsed} active={location.pathname === '/app'} onClick={() => navigate('/app')} />
          <Row icon={LayoutGrid} label="My Dashboard" collapsed={collapsed} active={location.pathname === '/dashboard'} onClick={() => navigate('/dashboard')} />
          <Row icon={Briefcase} label="Portfolio Manager" collapsed={collapsed} active={location.pathname === '/portfolio-manager'} onClick={() => navigate('/portfolio-manager')} />
        </div>

        <nav className="flex-1 overflow-y-auto" style={{ padding: '4px 8px 10px' }}>
          {/* favorites */}
          {favItems.length > 0 && (
            <>
              {collapsed
                ? <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '10px 6px' }} />
                : <p style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)', margin: '16px 0 5px', paddingLeft: 8, fontFamily: 'var(--theme-sans)' }}><Star size={9} fill="currentColor" /> Favorites</p>}
              {favItems.map(t => (
                <Row key={t.route} icon={t.icon} label={t.title} collapsed={collapsed} active={isToolActive(t.route)} onClick={() => navigate(t.route)} star="on" onStar={() => toggleFav(t.route)} />
              ))}
            </>
          )}

          {/* hubs */}
          {!collapsed && <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.4))', margin: '10px 0 5px', paddingLeft: 8, fontFamily: 'var(--theme-sans)' }}>Hubs</p>}
          {collapsed && <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '10px 6px' }} />}
          {HUBS.map(hub => (
            <HubBlock
              key={hub.slug}
              hub={hub}
              collapsed={collapsed}
              isOpen={!!open[hub.slug]}
              isActive={activeHub?.slug === hub.slug}
              onToggle={() => setOpen(o => ({ ...o, [hub.slug]: !o[hub.slug] }))}
              navigate={navigate}
              isToolActive={isToolActive}
              favorites={favorites}
              toggleFav={toggleFav}
            />
          ))}
        </nav>

        {/* bottom strip */}
        <div style={{ padding: '8px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          {isAdmin && (
            <Row icon={ShieldAlert} label="Admin Hub" collapsed={collapsed} active={location.pathname === '/admin'} danger onClick={() => navigate('/admin')} />
          )}
          <Row icon={Settings} label={user ? user.displayName : 'Settings'} collapsed={collapsed} active={location.pathname === '/settings'} onClick={() => navigate('/settings')} />
        </div>
      </motion.aside>

      <main id="main-content" className="flex-1 overflow-y-auto" style={{ background: 'var(--theme-bg, #0a1628)' }}>
        {location.pathname === '/dashboard' ? (
          <div style={{ padding: '24px 24px 300px' }}>{children}</div>
        ) : location.pathname === '/app' ? (
          // Home is a full-bleed command surface: no max-width/padding here so the
          // ticker tape spans the whole main width; Home centers its own content.
          // The content region fills the viewport so the disclaimer footer only
          // appears on scroll (same rule for every branch below).
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            <div style={{ flex: 1, minHeight: '100vh' }}>{children}</div>
            <Footer />
          </div>
        ) : location.pathname === '/chart-studio' && collapsed ? (
          // Sidebar collapsed → Chart Studio goes full-bleed: no gutters, no footer,
          // maximal chart area edge-to-edge.
          <div style={{ minHeight: '100vh' }}>{children}</div>
        ) : location.pathname === '/flows-map' || location.pathname === '/chart-studio' ? (
          // Map cockpit and Chart Studio want the full main width: gutters waste chart area.
          <div className="px-4 py-4" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            <div style={{ flex: 1, minHeight: 'calc(100vh - 32px)' }}>{children}</div>
            <Footer />
          </div>
        ) : (
          // Tools own the page: full width with modest gutters, no centered max-width column.
          <div className="w-full px-5 2xl:px-8 py-5" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', boxSizing: 'border-box' }}>
            <div style={{ flex: 1, minHeight: 'calc(100vh - 40px)' }}>{children}</div>
            <Footer />
          </div>
        )}
      </main>
    </div>
  )
}

// ── A hub: collapsible row + indented tool tree ──
function HubBlock({ hub, collapsed, isOpen, isActive, onToggle, navigate, isToolActive, favorites, toggleFav }: {
  hub: Hub; collapsed: boolean; isOpen: boolean; isActive: boolean; onToggle: () => void
  navigate: (to: string) => void; isToolActive: (route: string) => boolean
  favorites: string[]; toggleFav: (path: string) => void
}) {
  const Icon = hub.icon
  return (
    <div>
      <Row
        icon={Icon}
        label={hub.label}
        collapsed={collapsed}
        active={isActive}
        onClick={() => navigate(`/hub/${hub.slug}`)}
        title={collapsed ? hub.label : undefined}
        chevron={collapsed ? undefined : (isOpen ? 'open' : 'closed')}
        onChevron={onToggle}
      />
      {isOpen && !collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', margin: '0 0 6px 18px', paddingLeft: 13, borderLeft: '1px solid rgba(255,255,255,0.09)' }}>
          {hub.tools.map(t => (
            <ToolRow key={t.route} label={t.title} active={isToolActive(t.route)} fav={favorites.includes(t.route)} onClick={() => navigate(t.route)} onStar={() => toggleFav(t.route)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Indented tool row (text + star) ──
function ToolRow({ label, active, fav, onClick, onStar }: { label: string; active: boolean; fav: boolean; onClick: () => void; onStar: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 8px', cursor: 'pointer', color: active ? 'var(--theme-primary, #c9a84c)' : (hover ? 'var(--theme-text, #dce3ed)' : 'var(--theme-secondary, #7e93a8)'), background: hover || active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)' : 'transparent', fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: active ? 600 : 400, transition: 'color 0.12s ease, background 0.12s ease' }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {(hover || fav) && (
        <button onClick={e => { e.stopPropagation(); onStar() }} title={fav ? 'Remove from favorites' : 'Add to favorites'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', color: fav ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-dim, rgba(255,255,255,0.35))', flexShrink: 0 }}>
          <Star size={11} fill={fav ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
}

// ── Generic sidebar row (workspaces, hub headers, favorites, bottom) ──
function Row({ icon: Icon, label, collapsed, active, onClick, chevron, onChevron, star, onStar, danger, title }: {
  icon: React.ElementType; label: string; collapsed: boolean; active: boolean; onClick: () => void
  chevron?: 'open' | 'closed'; onChevron?: () => void; star?: 'on'; onStar?: () => void; danger?: boolean; title?: string
}) {
  const [hover, setHover] = useState(false)
  const accent = danger ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)'
  const color = active ? accent : danger ? 'color-mix(in srgb, var(--theme-negative) 55%, transparent)' : (hover ? 'var(--theme-text, #cdd9ef)' : 'var(--theme-secondary, #5e768f)')
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title ?? (collapsed ? label : undefined)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, justifyContent: collapsed ? 'center' : 'flex-start',
        padding: '6px 8px', margin: '2px 0', cursor: 'pointer',
        color, background: active ? `color-mix(in srgb, ${accent} 10%, transparent)` : (hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)' : 'transparent'),
        borderLeft: `2px solid ${active ? accent : 'transparent'}`,
        fontFamily: 'var(--theme-sans)', fontSize: 12, fontWeight: active ? 600 : 400,
        transition: 'color 0.13s ease, background 0.13s ease',
      }}
    >
      <Icon size={15} style={{ flexShrink: 0 }} />
      {!collapsed && <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>}
      {!collapsed && chevron && (
        <button
          onClick={e => { e.stopPropagation(); onChevron?.() }}
          aria-label={chevron === 'open' ? 'Collapse' : 'Expand'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0 2px 6px', display: 'flex', alignItems: 'center', color: 'var(--theme-secondary, #5e768f)', flexShrink: 0 }}
        >
          <ChevronRight size={13} style={{ transform: chevron === 'open' ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.16s ease' }} />
        </button>
      )}
      {!collapsed && star === 'on' && (
        <button onClick={e => { e.stopPropagation(); onStar?.() }} title="Remove from favorites" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', color: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }}>
          <Star size={11} fill="currentColor" />
        </button>
      )}
    </div>
  )
}

// ── Mobile nav link ──
function MobileLink({ to, icon: Icon, label, active, isFav, onFavToggle, favKey }: { to: string; icon: React.ElementType; label: string; active: boolean; isFav?: boolean; onFavToggle?: (path: string) => void; favKey?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <Link to={to} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 10px', minHeight: 44, marginBottom: 2, textDecoration: 'none', background: active ? 'color-mix(in srgb, var(--theme-primary) 8%, transparent)' : 'transparent', borderLeft: active ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent', color: active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #5e768f)', fontSize: 13, fontFamily: 'var(--theme-sans)' }}>
        <Icon size={15} style={{ flexShrink: 0 }} /><span style={{ flex: 1 }}>{label}</span>
      </Link>
      {onFavToggle && favKey && (
        <button onClick={() => onFavToggle(favKey)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '11px 10px', color: isFav ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-dim, rgba(255,255,255,0.35))', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
}
