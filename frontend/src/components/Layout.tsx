import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, TrendingUp, LineChart, Landmark, Bitcoin,
  BarChart2, Dices, GitBranch, Activity, Building2, Calculator,
  Network, Shuffle, Zap, ChevronLeft, ChevronRight, X, Menu, LayoutGrid, Settings,
} from 'lucide-react'
import Footer from './Footer'
import clsx from 'clsx'
import useIsMobile from '../hooks/useIsMobile'
import { useTheme } from '../contexts/ThemeContext'

const NAV_SECTIONS = [
  {
    label: 'Data & Dashboards',
    items: [
      { to: '/market',      icon: TrendingUp,  label: 'Market Data' },
      { to: '/corporate',   icon: Building2,   label: 'Corporate Hub' },
      { to: '/correlation', icon: Network,      label: 'Correlation Matrix' },
    ],
  },
  {
    label: 'Derivatives & Rates',
    items: [
      { to: '/options',     icon: LineChart,   label: 'Options Pricer' },
      { to: '/chain',       icon: BarChart2,   label: 'Chain Scanner' },
      { to: '/probability', icon: Activity,    label: 'Implied Probability' },
      { to: '/strategy',    icon: Shuffle,     label: 'Strategy Builder' },
      { to: '/gex',         icon: Zap,         label: 'Dealer GEX' },
      { to: '/bond',        icon: Landmark,    label: 'Bond Analytics' },
      { to: '/fed',         icon: GitBranch,   label: 'Macro Rate Engine' },
    ],
  },
  {
    label: 'Portfolio & Valuation',
    items: [
      { to: '/portfolio',   icon: BarChart2,   label: 'Backtester' },
      { to: '/montecarlo',  icon: Dices,       label: 'Monte Carlo' },
      { to: '/dcf',         icon: Calculator,  label: 'DCF Valuation' },
      { to: '/nav',         icon: Bitcoin,     label: 'NAV Tracker' },
    ],
  },
]

interface LayoutProps { children: React.ReactNode }

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Close drawer on route change
  useEffect(() => { setDrawerOpen(false) }, [location.pathname])
  // Prevent body scroll when drawer open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen overflow-hidden">
        {/* ── Mobile top bar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 16px', height: 52, flexShrink: 0,
          background: '#060e1c', borderBottom: '1px solid rgba(201,168,76,0.18)',
          position: 'sticky', top: 0, zIndex: 40,
        }}>
          <Link to="/" style={{ textDecoration: 'none' }}>
            <div style={{ fontFamily: 'Cinzel, Georgia, serif', color: '#c9a84c', fontSize: 15, fontWeight: 700, letterSpacing: '0.08em' }}>
              FINANCE <span style={{ color: '#5e768f', fontSize: 10, letterSpacing: '0.2em', fontFamily: 'IBM Plex Sans, sans-serif', fontWeight: 600 }}>TERMINAL</span>
            </div>
          </Link>
          <button
            onClick={() => setDrawerOpen(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c9a84c', padding: 4 }}
          >
            <Menu size={22} />
          </button>
        </div>

        {/* ── Mobile content ── */}
        <main style={{ flex: 1, overflowY: 'auto', background: '#0a1628' }}>
          <div style={{ padding: location.pathname === '/dashboard' ? '16px 14px 200px' : '16px 14px', display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            <div style={{ flex: 1 }}>{children}</div>
            {location.pathname !== '/dashboard' && <Footer />}
          </div>
        </main>

        {/* ── Overlay backdrop ── */}
        <AnimatePresence>
          {drawerOpen && (
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
              style={{
                position: 'fixed', inset: 0, zIndex: 49,
                background: 'rgba(0,0,0,0.65)',
              }}
            />
          )}
        </AnimatePresence>

        {/* ── Slide-in drawer ── */}
        <AnimatePresence>
          {drawerOpen && (
            <motion.div
              key="drawer"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              style={{
                position: 'fixed', top: 0, right: 0, bottom: 0, width: 260,
                zIndex: 50, background: '#060e1c',
                borderLeft: '1px solid rgba(201,168,76,0.18)',
                display: 'flex', flexDirection: 'column', overflowY: 'auto',
              }}
            >
              {/* Drawer header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 16px', borderBottom: '1px solid rgba(201,168,76,0.12)',
              }}>
                <div style={{ fontFamily: 'Cinzel, Georgia, serif', color: '#c9a84c', fontSize: 14, fontWeight: 700, letterSpacing: '0.08em' }}>
                  MODULES
                </div>
                <button onClick={() => setDrawerOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#99907e' }}>
                  <X size={18} />
                </button>
              </div>

              {/* Home + My Dashboard */}
              <div style={{ padding: '8px 12px 0' }}>
                <MobileNavLink to="/" icon={LayoutDashboard} label="Home" active={location.pathname === '/'} />
                <MobileNavLink to="/dashboard" icon={LayoutGrid} label="My Dashboard" active={location.pathname === '/dashboard'} />
                <MobileNavLink to="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings'} />
              </div>

              {/* Sections */}
              <nav style={{ flex: 1, padding: '4px 12px 24px' }}>
                {NAV_SECTIONS.map(section => (
                  <div key={section.label}>
                    <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#2e4460', marginTop: 18, marginBottom: 4, paddingLeft: 8 }}>
                      {section.label}
                    </p>
                    {section.items.map(item => (
                      <MobileNavLink
                        key={item.to}
                        to={item.to}
                        icon={item.icon}
                        label={item.label}
                        active={location.pathname === item.to}
                      />
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

  const { user } = useTheme()

  // ── Desktop layout ──
  return (
    <div className="flex h-screen overflow-hidden" id="ft-root">
      <motion.aside
        animate={{ width: collapsed ? 56 : 220 }}
        transition={{ duration: 0.25, ease: 'easeInOut' }}
        className="ft-sidebar flex-shrink-0 flex flex-col overflow-hidden"
        style={{ background: '#060e1c', borderRight: '1px solid var(--theme-primary, #c9a84c)30' }}
      >
        <div className="flex items-center justify-between px-3 py-4 border-b border-gold/10 min-h-[64px]">
          {!collapsed && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <Link to="/" className="block ft-logo">
                <div className="font-display ft-logo text-base font-bold tracking-[0.08em]" style={{ color: 'var(--theme-primary, #c9a84c)' }}>FINANCE</div>
                <div className="ft-logo-sub text-[9px] tracking-[0.22em] uppercase font-bold mt-0.5" style={{ color: 'var(--theme-secondary, #5e768f)' }}>TERMINAL</div>
              </Link>
            </motion.div>
          )}
          {collapsed && (
            <Link to="/" className="mx-auto ft-logo">
              <div className="font-display text-lg font-bold" style={{ color: 'var(--theme-primary, #c9a84c)' }}>F</div>
            </Link>
          )}
          <button onClick={() => setCollapsed(c => !c)} className="text-slate-terminal hover:text-gold transition-colors p-1 rounded">
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <div className="px-2 pt-3">
          <NavLink to="/" icon={LayoutDashboard} label="Home" collapsed={collapsed} active={location.pathname === '/'} />
          <div style={{ marginTop: 8 }}>
            <DashboardNavLink to="/dashboard" collapsed={collapsed} active={location.pathname === '/dashboard'} />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4 mt-1">
          {NAV_SECTIONS.map(section => (
            <div key={section.label}>
              {!collapsed && (
                <p className="text-[9px] font-bold tracking-[0.2em] uppercase text-[#2e4460] mt-5 mb-1.5 px-2">
                  {section.label}
                </p>
              )}
              {collapsed && <div className="border-t border-white/5 my-2" />}
              {section.items.map(item => (
                <NavLink key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} active={location.pathname === item.to} />
              ))}
            </div>
          ))}
        </nav>

        {/* Settings / user strip at bottom */}
        <div className="px-2 pb-3 pt-2 border-t border-white/5 flex-shrink-0">
          <Link
            to="/settings"
            title={collapsed ? 'Settings' : undefined}
            className="ft-nav-link flex items-center gap-2.5 py-1.5 transition-all duration-150 my-0.5"
            style={{
              color: location.pathname === '/settings' ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #5e768f)',
              background: location.pathname === '/settings' ? 'var(--theme-primary, #c9a84c)1a' : 'transparent',
              borderLeft: location.pathname === '/settings' ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent',
              paddingLeft: collapsed ? undefined : location.pathname === '/settings' ? 10 : 12,
              justifyContent: collapsed ? 'center' : undefined,
              fontSize: '0.82rem',
              textDecoration: 'none',
            }}
          >
            <Settings size={14} style={{ flexShrink: 0 }} />
            {!collapsed && (
              <span style={{ fontFamily: 'Lora, Georgia, serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user ? user.displayName : 'Settings'}
              </span>
            )}
          </Link>
        </div>
      </motion.aside>

      <main className="flex-1 overflow-y-auto bg-navy-900">
        {location.pathname === '/dashboard' ? (
          /* Dashboard: full width, generous bottom padding so widgets can be dragged/resized freely */
          <div style={{ padding: '24px 24px 300px' }}>
            {children}
          </div>
        ) : (
          <div className="max-w-7xl mx-auto px-6 py-6" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            <div style={{ flex: 1 }}>{children}</div>
            <Footer />
          </div>
        )}
      </main>
    </div>
  )
}

// ── Desktop nav link ──
interface NavLinkProps { to: string; icon: React.ElementType; label: string; collapsed: boolean; active: boolean }

function NavLink({ to, icon: Icon, label, collapsed, active }: NavLinkProps) {
  return (
    <Link
      to={to}
      title={collapsed ? label : undefined}
      className={clsx(
        'flex items-center gap-2.5 py-1.5 text-[0.82rem] transition-all duration-150 my-0.5',
        active ? 'text-gold bg-gold/10 font-semibold' : 'text-slate-terminal hover:text-slate-bright hover:bg-white/4',
        collapsed ? 'justify-center px-2' : 'pl-3 pr-2',
      )}
      style={active ? { borderLeft: '2px solid #c9a84c', paddingLeft: collapsed ? undefined : 10 } : { borderLeft: '2px solid transparent' }}
    >
      <Icon size={14} className="flex-shrink-0" />
      {!collapsed && <span className="font-serif truncate">{label}</span>}
    </Link>
  )
}

// ── Mobile nav link ──
function MobileNavLink({ to, icon: Icon, label, active }: { to: string; icon: React.ElementType; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 10px', marginBottom: 2, textDecoration: 'none',
        background: active ? 'rgba(201,168,76,0.08)' : 'transparent',
        borderLeft: active ? '2px solid #c9a84c' : '2px solid transparent',
        color: active ? '#c9a84c' : '#5e768f',
        fontSize: 13, fontFamily: 'Lora, Georgia, serif',
        transition: 'all 0.15s',
      }}
    >
      <Icon size={15} style={{ flexShrink: 0 }} />
      <span>{label}</span>
    </Link>
  )
}

// ── My Dashboard featured link ──
function DashboardNavLink({ to, collapsed, active }: { to: string; collapsed: boolean; active: boolean }) {
  return (
    <Link
      to={to}
      title={collapsed ? 'My Dashboard' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: 8,
        padding: collapsed ? '6px 0' : '6px 10px',
        textDecoration: 'none',
        background: active ? 'rgba(201,168,76,0.12)' : 'rgba(201,168,76,0.04)',
        border: `1px solid ${active ? '#c9a84c' : 'rgba(201,168,76,0.2)'}`,
        color: active ? '#c9a84c' : 'rgba(201,168,76,0.6)',
        fontSize: '0.82rem',
        fontFamily: 'Lora, Georgia, serif',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        if (!active) el.style.background = 'rgba(201,168,76,0.08)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        if (!active) el.style.background = 'rgba(201,168,76,0.04)'
      }}
    >
      <LayoutGrid size={13} style={{ flexShrink: 0 }} />
      {!collapsed && (
        <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>My Dashboard</span>
      )}
    </Link>
  )
}
