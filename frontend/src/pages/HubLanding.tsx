import { useState, useMemo } from 'react'
import { Navigate, useParams, useNavigate } from 'react-router-dom'
import { Search, LayoutGrid, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import { HUBS, hubBySlug, type HubTool } from '../lib/hubs'

const F = {
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  bright: 'var(--theme-text, #eef3fb)',
  sec: 'var(--theme-secondary, #8099b0)',
  muted: 'var(--theme-secondary, #5e768f)',
  surface: 'var(--theme-surface, #101c2e)',
  panel: 'var(--theme-bg, #0d1826)',
  topbar: 'color-mix(in srgb, var(--theme-bg, #0d1826) 88%, #000)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  borderFaint: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  sans: 'var(--theme-sans)',
  mono: 'var(--theme-mono)',
}

function ToolTile({ tool, num }: { tool: HubTool; num: string }) {
  const navigate = useNavigate()
  const [hover, setHover] = useState(false)
  const Icon = tool.icon
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(tool.route)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(tool.route) } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 11, padding: '16px 16px 15px',
        background: hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, var(--theme-bg, #0d1826))' : F.panel,
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 44%, transparent)' : F.border}`,
        cursor: 'pointer', outline: 'none',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'border-color 0.14s ease, background 0.14s ease, transform 0.14s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, flexShrink: 0,
          background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 20%, transparent)', color: F.gold,
        }}>
          <Icon size={16} />
        </span>
        <span style={{ flex: 1, fontFamily: F.sans, fontSize: 13.5, fontWeight: 700, color: F.text, lineHeight: 1.25 }}>{tool.title}</span>
        <span style={{ fontFamily: F.mono, fontSize: 11, fontWeight: 700, color: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 38%, transparent)', flexShrink: 0 }}>{num}</span>
      </div>
      <div style={{ fontFamily: F.sans, fontSize: 11, color: F.sec, lineHeight: 1.5 }}>{tool.desc}</div>
    </div>
  )
}

export default function HubLanding() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const hub = hubBySlug(slug)
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)

  const ql = q.trim().toLowerCase()
  const tools = useMemo(
    () => !hub ? [] : !ql ? hub.tools : hub.tools.filter(t => `${t.title} ${t.desc}`.toLowerCase().includes(ql)),
    [hub, ql],
  )

  if (!hub) return <Navigate to="/app" replace />
  const hubIndex = HUBS.findIndex(h => h.slug === hub.slug) + 1
  const Watermark = hub.icon

  return (
    <PageWrapper>
      <div className="mx-auto w-full max-w-[1180px] 2xl:max-w-[1440px]" style={{ background: F.surface, border: `1px solid ${F.border}` }}>
        {/* top chrome — breadcrumb + search + my dashboard */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 22px', borderBottom: `1px solid ${F.border}`, background: F.topbar, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: F.sans, fontSize: 11, color: F.muted }}>
            <span style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', color: F.gold }}>ALPHATAPE</span>
            <span style={{ opacity: 0.5 }}>/</span>
            <span style={{ color: 'var(--theme-text, #9fb0c6)', fontWeight: 600 }}>{hub.label}</span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 260px', minWidth: 0, justifyContent: 'flex-end' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, background: F.surface,
              border: `1px solid ${focused ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)' : F.border}`,
              padding: '7px 11px', flex: 1, minWidth: 0, maxWidth: 240, transition: 'border-color 0.15s ease',
            }}>
              <Search size={12} style={{ color: F.muted, flexShrink: 0 }} />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                aria-label={`Filter ${hub.label} tools`}
                placeholder="Search tools, tickers"
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: F.text, fontFamily: F.sans, fontSize: 11.5 }}
              />
              {q && <button onClick={() => setQ('')} aria-label="Clear" style={{ background: 'none', border: 'none', cursor: 'pointer', color: F.muted, display: 'flex', padding: 0 }}><X size={12} /></button>}
            </div>
            <button
              onClick={() => navigate('/dashboard')}
              style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, background: F.gold, border: 'none', padding: '7px 12px', cursor: 'pointer' }}
            >
              <LayoutGrid size={13} style={{ color: '#101c2e' }} />
              <span style={{ fontFamily: F.sans, fontSize: 11.5, fontWeight: 700, color: '#101c2e', whiteSpace: 'nowrap' }}>My Dashboard</span>
            </button>
          </div>
        </div>

        {/* hub switcher tab bar */}
        <div style={{ display: 'flex', padding: '0 22px', borderBottom: `1px solid ${F.border}`, background: F.panel, overflowX: 'auto' }}>
          {HUBS.map(h => {
            const Icon = h.icon
            const active = h.slug === hub.slug
            return (
              <button
                key={h.slug}
                onClick={() => navigate(`/hub/${h.slug}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px',
                  fontFamily: F.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                  background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                  color: active ? F.gold : F.muted,
                  borderBottom: `2px solid ${active ? F.gold : 'transparent'}`, marginBottom: -1,
                  transition: 'color 0.12s ease',
                }}
              >
                <Icon size={13} />{h.label}
              </button>
            )
          })}
        </div>

        {/* masthead */}
        <div style={{ position: 'relative', overflow: 'hidden', padding: '30px 26px 26px', borderBottom: `1px solid ${F.border}`, background: 'linear-gradient(180deg, var(--theme-bg, #0d1826) 0%, var(--theme-surface, #101c2e) 100%)' }}>
          <Watermark size={230} strokeWidth={1.25} style={{ position: 'absolute', top: -46, right: -30, color: F.gold, opacity: 0.06, pointerEvents: 'none' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ width: 22, height: 2, background: F.gold }} />
              <span style={{ fontFamily: F.mono, fontSize: 15, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: F.gold }}>{hub.label} Hub</span>
              <span style={{ fontFamily: F.mono, fontSize: 12, color: F.muted, letterSpacing: '0.1em' }}>{String(hubIndex).padStart(2, '0')} / 06</span>
            </div>
            <p style={{ margin: '14px 0 0', fontFamily: F.sans, fontSize: 13.5, color: F.sec, lineHeight: 1.55, maxWidth: 560 }}>{hub.masthead}</p>
          </div>
        </div>

        {/* tools grid */}
        <div style={{ padding: '22px 26px 30px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 14px' }}>
            <span style={{ fontFamily: F.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.sec }}>All Tools</span>
            <div style={{ flex: 1, height: 1, background: F.borderFaint }} />
          </div>
          {tools.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: F.sans, fontSize: 12, color: F.sec }}>
              No tools match <span style={{ color: F.text, fontFamily: F.mono }}>{q}</span>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 11 }}>
              {tools.map(t => <ToolTile key={t.route} tool={t} num={String(hub.tools.indexOf(t) + 1).padStart(2, '0')} />)}
            </div>
          )}
        </div>
      </div>
    </PageWrapper>
  )
}
