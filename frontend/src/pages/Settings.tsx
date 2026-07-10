import { useState, useRef, useEffect, useCallback } from 'react'
import { useTheme, DEFAULT_THEME, MONO_FONTS, SANS_FONTS, applyTheme, type Theme } from '../contexts/ThemeContext'

const PREVIEW_SKIP = new Set(['San Francisco'])
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'
import axios from 'axios'

// ── Admin whitelist — add usernames here to grant access to site-wide stats ──
const ADMIN_USERS = [
  'wneedlman',
]

// ── Palette of preset color schemes ──────────────────────────────────────────
const PRESETS: { name: string; theme: Partial<Theme> }[] = [
  { name: 'Terminal Gold',  theme: { primaryColor: '#c9a84c', secondaryColor: '#5e768f', tertiaryColor: '#60a5fa', bgColor: '#101c2e', surfaceColor: '#0d1826', chartNeutralColor: '#4a7fa5', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Bloomberg',      theme: { primaryColor: '#ff6600', secondaryColor: '#888888', tertiaryColor: '#ffb800', bgColor: '#000000', surfaceColor: '#0d0d0d', chartNeutralColor: '#668099', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Emerald Dark',   theme: { primaryColor: '#059669', secondaryColor: '#31aa8a', tertiaryColor: '#6ee7b7', bgColor: '#092f1c', surfaceColor: '#031c0f', chartNeutralColor: '#3a7a5f', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Crimson Night',  theme: { primaryColor: '#e11d48', secondaryColor: '#c99caa', tertiaryColor: '#fda4af', bgColor: '#2c0216', surfaceColor: '#160310', chartNeutralColor: '#7a4870', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Mainstreet',     theme: { primaryColor: '#a97c50', secondaryColor: '#adadaf', tertiaryColor: '#73a579', bgColor: '#1a1410', surfaceColor: '#231d17', chartNeutralColor: '#8a7a55', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Stealth Mono',   theme: { primaryColor: '#e2e8f0', secondaryColor: '#475569', tertiaryColor: '#64748b', bgColor: '#000000', surfaceColor: '#0a0a0a', chartNeutralColor: '#5a7090', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Dracula',        theme: { primaryColor: '#ac81ea', secondaryColor: '#6272a4', tertiaryColor: '#c7609b', bgColor: '#29182f', surfaceColor: '#231429', chartNeutralColor: '#6872a8', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Ocean',          theme: { primaryColor: '#88c0d0', secondaryColor: '#c0c4ce', tertiaryColor: '#a3be8c', bgColor: '#1e2430', surfaceColor: '#19202c', chartNeutralColor: '#5a8099', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Linen',          theme: { primaryColor: '#7c2d12', secondaryColor: '#292524', tertiaryColor: '#c9a787', bgColor: '#faf7f2', surfaceColor: '#e8dfd0', chartNeutralColor: '#7a7060', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Morning Mist',   theme: { primaryColor: '#1e3a8a', secondaryColor: '#1e293b', tertiaryColor: '#0f766e', bgColor: '#f1f5f9', surfaceColor: '#dbe4ef', chartNeutralColor: '#5a7590', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Rosewood',       theme: { primaryColor: '#881337', secondaryColor: '#5a1c1c', tertiaryColor: '#c47878', bgColor: '#fdf4f4', surfaceColor: '#e8d5d5', chartNeutralColor: '#ff9494', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
  { name: 'Paper White',    theme: { primaryColor: '#171717', secondaryColor: '#64748b', tertiaryColor: '#404040', bgColor: '#ffffff', surfaceColor: '#f4f4f5', chartNeutralColor: '#9ca3af', primaryFont: 'San Francisco', secondaryFont: 'Sora', primaryFontUrl: '', secondaryFontUrl: '' } },
]

// ── Small UI helpers ──────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontFamily: 'var(--theme-sans, Sora, sans-serif)', fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function ColorSwatch({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div
          onClick={() => inputRef.current?.click()}
          style={{ width: 32, height: 32, background: value, border: '2px solid var(--theme-text-faint, rgba(255,255,255,0.15))', borderRadius: 3, cursor: 'pointer', flexShrink: 0 }}
          title="Click to pick color"
        />
        <input ref={inputRef} type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }} />
        <input
          type="text" value={value}
          onChange={e => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) onChange(e.target.value) }}
          style={{ background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono, ui-monospace, monospace)', fontSize: 11, padding: '4px 8px', width: 90, outline: 'none', letterSpacing: '0.05em' }}
        />
      </div>
    </div>
  )
}

function FontSelector({ label, value, options, onChange, onUpload, isMono = true }: {
  label: string; value: string; options: string[]
  onChange: (v: string) => void
  onUpload: (name: string, url: string) => void
  isMono?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [fontsInjected, setFontsInjected] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || fontsInjected) return
    options.forEach(font => {
      if (PREVIEW_SKIP.has(font)) return
      const id = `ft-preview-${font.replace(/\s+/g, '-').toLowerCase()}`
      if (!document.getElementById(id)) {
        const link = document.createElement('link')
        link.id = id; link.rel = 'stylesheet'
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;700&display=swap`
        document.head.appendChild(link)
      }
    })
    setFontsInjected(true)
  }, [open, fontsInjected, options])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    const name = file.name.replace(/\.[^.]+$/, '')
    onUpload(name, url)
    e.target.value = ''
  }

  const sample = isMono ? '0123  AAPL  $4,820  −0.25%' : 'Portfolio  AAPL  Equity'
  const fallback = isMono ? 'monospace' : 'sans-serif'
  const isCustom = !options.includes(value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</span>
      <div ref={dropRef} style={{ position: 'relative', display: 'flex', gap: 6 }}>

        {/* Trigger */}
        <button
          onClick={() => setOpen(o => !o)}
          style={{ flex: 1, background: 'var(--theme-bg, #0a1220)', border: `1px solid ${open ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`, color: 'var(--theme-text, #d7e3fc)', fontFamily: `'${value}', ${fallback}`, fontSize: 11, padding: '4px 8px', cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', outline: 'none' }}
        >
          <span>{value}{isCustom ? ' (custom)' : ''}</span>
          <span style={{ opacity: 0.4, fontSize: 8, fontFamily: 'var(--theme-sans)', marginLeft: 6 }}>{open ? '▲' : '▼'}</span>
        </button>

        <button
          onClick={() => fileRef.current?.click()}
          title="Upload custom font file (.ttf .woff .woff2)"
          style={{ background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Upload
        </button>
        <input ref={fileRef} type="file" accept=".ttf,.woff,.woff2,.otf" style={{ display: 'none' }} onChange={handleFile} />

        {/* Custom dropdown panel */}
        {open && (
          <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, right: 52, zIndex: 200, background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-text-subtle, rgba(255,255,255,0.14))', boxShadow: '0 10px 32px rgba(0,0,0,0.7)', maxHeight: 320, overflowY: 'auto' }}>
            {isCustom && (
              <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))', fontFamily: `'${value}', ${fallback}`, fontSize: 12, color: 'var(--theme-primary, #c9a84c)' }}>
                {value} (custom)
              </div>
            )}
            {options.map(f => {
              const active = f === value
              return (
                <div
                  key={f}
                  onClick={() => { onChange(f); setOpen(false) }}
                  style={{ padding: '7px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', background: active ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}
                  onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--theme-border-faint, rgba(255,255,255,0.05))' }}
                  onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <span style={{ fontFamily: `'${f}', ${fallback}`, fontSize: 13, color: active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)', letterSpacing: isMono ? '0.03em' : '0' }}>
                    {sample}
                  </span>
                  <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.32))', letterSpacing: '0.08em' }}>
                    {f}{active ? ' [on]' : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Live preview of selected font */}
      <span style={{ fontFamily: `'${value}', ${fallback}`, fontSize: 12, color: 'var(--theme-primary)', letterSpacing: '0.04em' }}>
        0123  AAPL  $4.82T  Δ−0.25
      </span>
    </div>
  )
}

// ── Admin panel ───────────────────────────────────────────────────────────────
interface UserStats {
  total_users: number; new_last_7d: number; new_last_30d: number
  users: { id: string; username: string; display_name: string; created_at: string; last_login_at: string | null; login_count: number }[]
}
interface HealthData {
  python: string; users_db: string; cache_entries: number; cache_size_kb: number
  api_keys: Record<string, boolean>
}

function AdminPanel() {
  const [secret,  setSecret]  = useState('')
  const [data,    setData]    = useState<UserStats | null>(null)
  const [health,  setHealth]  = useState<HealthData | null>(null)
  const [err,     setErr]     = useState('')
  const [loading, setLoading] = useState(false)
  const [tab,     setTab]     = useState<'users' | 'health'>('users')
  const [pinReset,setPinReset]= useState<{ username: string; pin: string } | null>(null)
  const [actionMsg, setActionMsg] = useState('')

  const hdrs = { 'x-admin-secret': secret }

  const fetchAll = async () => {
    setErr(''); setLoading(true); setActionMsg('')
    try {
      const [statsRes, healthRes] = await Promise.all([
        axios.get('/api/users/stats',    { headers: hdrs }),
        axios.get('/api/users/admin/health', { headers: hdrs }),
      ])
      setData(statsRes.data)
      setHealth(healthRes.data)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setErr(msg ?? 'Failed — check your admin secret')
    } finally { setLoading(false) }
  }

  const deleteUser = async (username: string) => {
    if (!confirm(`Delete user @${username}? This cannot be undone.`)) return
    try {
      await axios.delete(`/api/users/admin/user/${username}`, { headers: hdrs })
      setActionMsg(`Deleted @${username}`)
      setData(prev => prev ? { ...prev, users: prev.users.filter(u => u.username !== username), total_users: prev.total_users - 1 } : prev)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setActionMsg(`Error: ${msg}`)
    }
  }

  const resetPin = async () => {
    if (!pinReset) return
    try {
      await axios.post(`/api/users/admin/reset-pin/${pinReset.username}`, { new_pin: pinReset.pin }, { headers: hdrs })
      setActionMsg(`Password reset for @${pinReset.username}`)
      setPinReset(null)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setActionMsg(`Error: ${msg}`)
    }
  }

  const evictCache = async () => {
    try {
      await axios.post('/api/users/admin/cache/evict', {}, { headers: hdrs })
      setActionMsg('Cache evicted — expired entries cleared')
      fetchAll()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setActionMsg(`Error: ${msg}`)
    }
  }

  const inp: React.CSSProperties = { background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 11, padding: '4px 8px', outline: 'none', flex: 1 }
  const btn = (active = true): React.CSSProperties => ({
    background: active ? 'var(--theme-primary)' : 'var(--theme-border-faint, rgba(255,255,255,0.05))',
    border: `1px solid ${active ? 'var(--theme-primary)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
    color: active ? '#0a1220' : 'var(--theme-secondary)',
    fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase', padding: '4px 12px', cursor: active ? 'pointer' : 'default',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Secret + Fetch */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="password" value={secret} onChange={e => setSecret(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && fetchAll()} placeholder="ADMIN_SECRET env var" style={inp} autoComplete="off" />
        <button onClick={fetchAll} disabled={loading || !secret} style={btn(!!secret && !loading)}>
          {loading ? '…' : 'Fetch'}
        </button>
      </div>
      {err && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-negative, #ef4444)' }}>{err}</span>}
      {actionMsg && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: actionMsg.startsWith('Error') ? 'var(--theme-negative, #ef4444)' : 'var(--theme-positive, #22c55e)' }}>{actionMsg}</span>}

      {data && health && (<>
        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', gap: 0 }}>
          {(['users', 'health'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', borderBottom: tab === t ? '2px solid var(--theme-primary)' : '2px solid transparent',
              color: tab === t ? 'var(--theme-primary)' : 'var(--theme-secondary)',
              fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', padding: '5px 14px', cursor: 'pointer',
            }}>{t}</button>
          ))}
        </div>

        {tab === 'users' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {[{ label: 'Total Users', value: data.total_users }, { label: 'Last 7 Days', value: data.new_last_7d }, { label: 'Last 30 Days', value: data.new_last_30d }].map(s => (
                <div key={s.label} style={{ background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 10px' }}>
                  <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 22, fontWeight: 700, color: 'var(--theme-primary)' }}>{s.value}</div>
                </div>
              ))}
            </div>
            {/* Password reset form */}
            {pinReset && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 10px' }}>
                <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', whiteSpace: 'nowrap' }}>New password for @{pinReset.username}:</span>
                <input type="password" autoComplete="new-password" value={pinReset.pin}
                  onChange={e => setPinReset(p => p ? { ...p, pin: e.target.value } : null)}
                  style={{ ...inp, flex: 1 }} placeholder="8+ characters" />
                <button onClick={resetPin} style={btn(pinReset.pin.length >= 8)}>Save</button>
                <button onClick={() => setPinReset(null)} style={btn(false)}>Cancel</button>
              </div>
            )}
            {/* User table */}
            <div style={{ border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', maxHeight: 340, overflowY: 'auto', overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 70px 50px 100px', minWidth: 480, background: 'var(--theme-bg, #080f1d)', padding: '5px 10px', position: 'sticky', top: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                {['Display','Username','Joined','Last Login','Logins','Actions'].map(h => (
                  <span key={h} style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</span>
                ))}
              </div>
              {data.users.map((u, i) => (
                <div key={u.username} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 70px 50px 100px', minWidth: 480, padding: '5px 10px', background: i % 2 === 0 ? 'var(--theme-surface, #0d1826)' : 'transparent', borderBottom: i < data.users.length - 1 ? '1px solid #1a2535' : 'none', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.display_name}</span>
                  <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)' }}>@{u.username}</span>
                  <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)' }}>{new Date(u.created_at).toLocaleDateString()}</span>
                  <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)' }}>{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : '—'}</span>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary)', textAlign: 'right' }}>{u.login_count}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => setPinReset({ username: u.username, pin: '' })}
                      style={{ background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: 'var(--theme-tertiary, #60a5fa)', fontFamily: 'var(--theme-sans)', fontSize: 7, padding: '2px 5px', cursor: 'pointer' }}>PW</button>
                    <button onClick={() => deleteUser(u.username)}
                      style={{ background: 'color-mix(in srgb, var(--theme-negative) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 30%, transparent)', color: 'var(--theme-negative, #ef4444)', fontFamily: 'var(--theme-sans)', fontSize: 7, padding: '2px 5px', cursor: 'pointer' }}>DEL</button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)' }}>
              {data.total_users} user{data.total_users !== 1 ? 's' : ''} · up to 200 shown
            </div>
          </div>
        )}

        {tab === 'health' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* API keys */}
            <div>
              <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>API Keys</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Object.entries(health.api_keys).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: v ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)' }}>{v ? 'YES' : 'NO'}</span>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-text, #d7e3fc)' }}>{k}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Cache */}
            <div>
              <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>Disk Cache</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {[{ label: 'Entries', value: health.cache_entries }, { label: 'Size (KB)', value: health.cache_size_kb }].map(s => (
                  <div key={s.label} style={{ background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 10px' }}>
                    <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: 'var(--theme-primary)' }}>{s.value}</div>
                  </div>
                ))}
              </div>
              <button onClick={evictCache} style={{ ...btn(), width: '100%' }}>Evict Expired Cache Entries</button>
            </div>
            {/* Server info */}
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span>Python {health.python}</span>
              <span>DB: {health.users_db}</span>
            </div>
          </div>
        )}
      </>)}
    </div>
  )
}

// ── Auth forms ────────────────────────────────────────────────────────────────
const MIN_PW = 8

const emailValid = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim())

function AuthPanel({ onDone }: { onDone: () => void }) {
  const { login, register, setPassword, setEmail, forgotPassword, mustSetEmail } = useTheme()
  const [step,    setStep]   = useState<'auth' | 'set-password' | 'set-email' | 'forgot'>('auth')
  const [mode,    setMode]   = useState<'login' | 'register'>('login')
  const [uname,   setUname]  = useState('')
  const [display, setDisplay] = useState('')
  const [emailIn, setEmailIn] = useState('')
  const [pw,      setPw]     = useState('')
  const [err,     setErr]    = useState('')
  const [info,    setInfo]   = useState('')
  const [loading, setLoading] = useState(false)
  const [newPw,   setNewPw]  = useState('')
  const [newPw2,  setNewPw2] = useState('')

  const inp: React.CSSProperties = { background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '6px 10px', width: '100%', outline: 'none', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em', display: 'block', marginBottom: 4 }
  const submitBtn: React.CSSProperties = { background: 'var(--theme-primary, #c9a84c)', border: 'none', color: '#0a1220', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '10px 0', cursor: 'pointer', width: '100%', transition: 'background 0.15s' }
  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 10, cursor: 'pointer', padding: 0, textDecoration: 'underline', letterSpacing: '0.04em', alignSelf: 'flex-start' }
  const liveBtn = (fn: () => void, label: string) => (
    <button onClick={fn} disabled={loading} style={{ ...submitBtn, background: loading ? 'rgba(255,255,255,0.08)' : submitBtn.background, color: loading ? 'var(--theme-secondary)' : submitBtn.color, cursor: loading ? 'default' : 'pointer' }}>
      {loading ? '…' : label}
    </button>
  )
  const errLine = err && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-negative, #ef4444)' }}>{err}</span>
  const infoLine = info && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-positive, #4ea674)', lineHeight: '15px' }}>{info}</span>
  const wrap = { maxWidth: 340, display: 'flex', flexDirection: 'column' as const, gap: 14 }

  const handleSubmit = async () => {
    setErr('')
    const trimmedUser = uname.trim()
    const cred = pw   // password (legacy PIN still accepted by server on login)
    if (!trimmedUser || !cred) { setErr('Enter username and password.'); return }
    if (mode === 'register') {
      if (trimmedUser.length < 2) { setErr('Username must be at least 2 characters.'); return }
      if (cred.length < MIN_PW) { setErr(`Password must be at least ${MIN_PW} characters.`); return }
      if (!emailValid(emailIn)) { setErr('Enter a valid email address.'); return }
    }
    setLoading(true)
    try {
      if (mode === 'login') {
        const res = await login(trimmedUser, cred)
        if (!res) setErr('Username or password not recognized.')
        else if (res === 'migrate') setStep('set-password')   // legacy PIN — force a password
        else if (res === 'set-email') setStep('set-email')    // legacy account with no email
        else onDone()
      } else {
        const res = await register(trimmedUser, display.trim() || trimmedUser, cred, emailIn.trim())
        if (res === 'taken') setErr('Username already taken — try signing in instead.')
        else if (res === 'email-taken') setErr('That email is already registered.')
        else if (!res) setErr('Could not create your profile. Try again.')
        else onDone()
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSetPassword = async () => {
    setErr('')
    if (newPw.length < MIN_PW) { setErr(`Password must be at least ${MIN_PW} characters.`); return }
    if (newPw !== newPw2) { setErr('Passwords do not match.'); return }
    setLoading(true)
    try {
      const ok = await setPassword(newPw)
      if (!ok) { setErr('Could not set password — please sign in again.'); return }
      // Legacy accounts also lack an email: chain to the email gate when needed.
      if (mustSetEmail) { setStep('set-email'); setNewPw(''); setNewPw2('') }
      else onDone()
    } finally {
      setLoading(false)
    }
  }

  const handleSetEmail = async () => {
    setErr('')
    if (!emailValid(emailIn)) { setErr('Enter a valid email address.'); return }
    setLoading(true)
    try {
      const res = await setEmail(emailIn.trim())
      if (res === 'taken') setErr('That email is already registered.')
      else if (!res) setErr('Could not save your email. Try again.')
      else onDone()
    } finally {
      setLoading(false)
    }
  }

  const handleForgot = async () => {
    setErr(''); setInfo('')
    if (!emailValid(emailIn)) { setErr('Enter a valid email address.'); return }
    setLoading(true)
    try {
      await forgotPassword(emailIn.trim())
      setInfo('If that email has an account, a reset link is on its way. Check your inbox.')
    } finally {
      setLoading(false)
    }
  }

  // ── Forced password migration for legacy PIN accounts ──
  if (step === 'set-password') {
    return (
      <div style={wrap}>
        <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text)', lineHeight: '16px' }}>
          For your security, 4-digit PINs are no longer supported. Please set a password to continue.
        </div>
        <div><label style={lbl}>New password ({MIN_PW}+ characters)</label><input style={inp} type="password" autoComplete="new-password" value={newPw} onChange={e => setNewPw(e.target.value)} autoFocus disabled={loading} /></div>
        <div><label style={lbl}>Confirm password</label><input style={inp} type="password" autoComplete="new-password" value={newPw2} onChange={e => setNewPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSetPassword()} disabled={loading} /></div>
        {errLine}
        {liveBtn(handleSetPassword, 'Set Password')}
      </div>
    )
  }

  // ── Email gate for legacy accounts created before email was required ──
  if (step === 'set-email') {
    return (
      <div style={wrap}>
        <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text)', lineHeight: '16px' }}>
          Add an email to your account. You will need it to recover your password if you ever forget it.
        </div>
        <div><label style={lbl}>Email</label><input style={inp} type="email" autoComplete="email" value={emailIn} onChange={e => setEmailIn(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSetEmail()} autoFocus disabled={loading} /></div>
        {errLine}
        {liveBtn(handleSetEmail, 'Save Email')}
      </div>
    )
  }

  // ── Forgot password: request a reset link ──
  if (step === 'forgot') {
    return (
      <div style={wrap}>
        <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text)', lineHeight: '16px' }}>
          Enter the email on your account. We will send you a link to set a new password.
        </div>
        <div><label style={lbl}>Email</label><input style={inp} type="email" autoComplete="email" value={emailIn} onChange={e => setEmailIn(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleForgot()} autoFocus disabled={loading} /></div>
        {errLine}
        {infoLine}
        {liveBtn(handleForgot, 'Send Reset Link')}
        <button onClick={() => { setStep('auth'); setErr(''); setInfo('') }} style={linkBtn}>Back to sign in</button>
      </div>
    )
  }

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', marginBottom: 4 }}>
        {(['login', 'register'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setErr('') }} style={{ flex: 1, background: 'none', border: 'none', borderBottom: mode === m ? '2px solid var(--theme-primary)' : '2px solid transparent', color: mode === m ? 'var(--theme-primary)' : 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 0', cursor: 'pointer' }}>
            {m === 'login' ? 'Sign In' : 'Create Profile'}
          </button>
        ))}
      </div>

      <div><label style={lbl}>Username</label><input style={inp} value={uname} onChange={e => setUname(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} autoFocus disabled={loading} /></div>
      {mode === 'register' && <div><label style={lbl}>Display Name <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>(optional)</span></label><input style={inp} value={display} onChange={e => setDisplay(e.target.value)} disabled={loading} /></div>}
      {mode === 'register' && <div><label style={lbl}>Email</label><input style={inp} type="email" autoComplete="email" value={emailIn} onChange={e => setEmailIn(e.target.value)} disabled={loading} /></div>}
      <div><label style={lbl}>Password{mode === 'register' ? ` (${MIN_PW}+ characters)` : ''}</label><input style={inp} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} disabled={loading} /></div>
      {errLine}
      {liveBtn(handleSubmit, mode === 'login' ? 'Sign In' : 'Create & Sign In')}
      {mode === 'login' && <button onClick={() => { setStep('forgot'); setErr(''); setInfo('') }} style={linkBtn}>Forgot password?</button>}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Settings() {
  const { theme, user, allUsers, setTheme, logout, deleteUser } = useTheme()
  const [confirmDel, setConfirmDel] = useState(false)
  const [saved,      setSaved]      = useState(false)
  const isMobile = useIsMobile()

  // Draft: local copy of theme; edits here are previewed immediately but not persisted until Save
  const [draft, setDraftRaw] = useState<Theme>(() => ({ ...theme }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(theme)

  // Keep draft in sync when the persisted theme changes (e.g. user switches profile)
  useEffect(() => { setDraftRaw({ ...theme }) }, [user?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Preview draft changes via CSS vars — no localStorage write
  useEffect(() => { applyTheme(draft) }, [draft])

  const patchDraft = useCallback((patch: Partial<Theme>) => {
    setDraftRaw(prev => ({ ...prev, ...patch }))
    setSaved(false)
  }, [])

  const handleSave = () => {
    setTheme(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleDiscard = () => {
    setDraftRaw({ ...theme })
    applyTheme(theme)
  }

  const handleReset = () => {
    setDraftRaw({ ...DEFAULT_THEME })
  }

  // Gate: no user → show auth. Keyed purely off user (not local authed flag)
  // so sign-out always brings back the auth panel.
  if (!user) {
    return (
      <PageWrapper>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '20px 0' : '32px 24px' }}>
          <h1 style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: 'var(--theme-primary)', letterSpacing: '0.08em', marginBottom: 8 }}>
            TERMINAL SETTINGS
          </h1>
          <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: 'var(--theme-secondary)', marginBottom: 32 }}>
            Sign in to save your personalisation across sessions, or create a new local profile.
          </p>
          <AuthPanel onDone={() => {/* user state drives the re-render — no local flag needed */}} />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '20px 0' : '32px 24px' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 36, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: 'var(--theme-primary)', letterSpacing: '0.08em', margin: 0 }}>
              TERMINAL SETTINGS
            </h1>
            <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: dirty ? '#f59e0b' : 'var(--theme-secondary)', marginTop: 4, transition: 'color 0.2s' }}>
              {user ? (dirty ? 'Unsaved changes' : saved ? 'Saved' : `Signed in as ${user.displayName}`) : 'Guest session · sign in to persist settings'}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {dirty && (
              <button onClick={handleDiscard} style={{ background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
                Discard
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!dirty}
              style={{
                background: dirty ? 'var(--theme-primary)' : 'var(--theme-border-faint, rgba(255,255,255,0.05))',
                border: `1px solid ${dirty ? 'var(--theme-primary)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                color: dirty ? 'var(--theme-bg)' : 'var(--theme-text-dim)',
                fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                padding: '6px 20px', cursor: dirty ? 'pointer' : 'default',
                transition: 'all 0.15s',
              }}
            >
              {saved ? 'Saved' : 'Save'}
            </button>
            {user && (
              <button onClick={logout} style={{ background: 'color-mix(in srgb, var(--theme-negative) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 35%, transparent)', color: 'var(--theme-negative, #ef4444)', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
                Sign Out
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? 24 : 40, alignItems: 'start' }}>

          {/* ── Left column ─────────────────────────────────────────────── */}
          <div>
            <Section title="Color Presets">
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 8 }}>
                {PRESETS.map(p => (
                  <button key={p.name} onClick={() => patchDraft(p.theme as Partial<Theme>)}
                    style={{ background: p.theme.bgColor, border: `1px solid ${p.theme.primaryColor}55`, padding: '8px 10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[p.theme.primaryColor, p.theme.secondaryColor, p.theme.tertiaryColor].map((c, i) => (
                        <div key={i} style={{ width: 12, height: 12, background: c, borderRadius: 2 }} />
                      ))}
                    </div>
                    <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: p.theme.primaryColor, letterSpacing: '0.08em' }}>{p.name}</span>
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Custom Colors">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <ColorSwatch label="Primary (accent)"     value={draft.primaryColor}        onChange={v => patchDraft({ primaryColor: v })} />
                <ColorSwatch label="Secondary (muted)"    value={draft.secondaryColor}      onChange={v => patchDraft({ secondaryColor: v })} />
                <ColorSwatch label="Tertiary (highlight)" value={draft.tertiaryColor}       onChange={v => patchDraft({ tertiaryColor: v })} />
                <ColorSwatch label="Background"           value={draft.bgColor}             onChange={v => patchDraft({ bgColor: v })} />
                <ColorSwatch label="Surface / Cards"      value={draft.surfaceColor}        onChange={v => patchDraft({ surfaceColor: v })} />
                <ColorSwatch label="Chart Neutral"        value={draft.chartNeutralColor ?? '#4a7fa5'} onChange={v => patchDraft({ chartNeutralColor: v })} />
              </div>
            </Section>

            <button onClick={handleReset} style={{ background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
              Reset to Defaults
            </button>
          </div>

          {/* ── Right column ────────────────────────────────────────────── */}
          <div>
            <Section title="Typography">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <FontSelector
                  label="Numbers & data (monospace)"
                  value={draft.primaryFont} options={MONO_FONTS}
                  onChange={v => patchDraft({ primaryFont: v, primaryFontUrl: '' })}
                  onUpload={(name, url) => patchDraft({ primaryFont: name, primaryFontUrl: url })}
                />
                <FontSelector
                  label="Interface typeface"
                  value={draft.secondaryFont} options={SANS_FONTS}
                  onChange={v => patchDraft({ secondaryFont: v, secondaryFontUrl: '' })}
                  onUpload={(name, url) => patchDraft({ secondaryFont: name, secondaryFontUrl: url })}
                />
              </div>
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginTop: 12, lineHeight: 1.5 }}>
                Upload .ttf / .woff / .woff2 to use a custom font locally. Uploaded fonts are stored in memory for this session only.
              </p>
            </Section>

            <Section title="Preview">
              <div style={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${draft.primaryColor}40`, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-primary)', fontWeight: 700, letterSpacing: '0.1em' }}>ALPHATAPE TERMINAL</div>
                <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Options Snapshot · NVDA</div>
                <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                  <div><div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', marginBottom: 2 }}>ATM IV</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: 'var(--theme-primary)' }}>54.7%</div></div>
                  <div><div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', marginBottom: 2 }}>1D %</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: 'var(--theme-positive, #22c55e)' }}>+2.9%</div></div>
                  <div><div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', marginBottom: 2 }}>BETA</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: 'var(--theme-tertiary)' }}>1.34</div></div>
                </div>
                <div style={{ height: 4, background: `linear-gradient(to right, ${draft.primaryColor}, ${draft.tertiaryColor})`, borderRadius: 2, marginTop: 4 }} />
              </div>
            </Section>

            {user && (
              <Section title={`Account · ${allUsers.length} profile${allUsers.length !== 1 ? 's' : ''}`}>
                {/* Current user */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: 'var(--theme-text, #d7e3fc)' }}>
                    {user.displayName}
                    <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', marginLeft: 8 }}>@{user.username}</span>
                    <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-primary)', marginLeft: 8, border: `1px solid ${draft.primaryColor}40`, padding: '1px 5px' }}>current</span>
                  </div>
                  <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>
                    Created {new Date(user.createdAt).toLocaleDateString()}
                  </div>
                  {!confirmDel ? (
                    <button onClick={() => setConfirmDel(true)} style={{ alignSelf: 'flex-start', background: 'transparent', border: '1px solid #3a1010', color: '#8c2e2e', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 12px', cursor: 'pointer' }}>
                      Delete Profile
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-negative, #ef4444)' }}>Delete permanently?</span>
                      <button onClick={() => deleteUser(user.id)} style={{ background: 'var(--theme-negative, #ef4444)', border: 'none', color: '#fff', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer' }}>Yes, delete</button>
                      <button onClick={() => setConfirmDel(false)} style={{ background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, padding: '3px 10px', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  )}
                </div>

                {/* All profiles table */}
                {allUsers.length > 1 && (
                  <div>
                    <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                      All profiles on this device
                    </div>
                    <div style={{ border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', overflowX: 'auto' }}>
                      {/* Header */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 60px', minWidth: 420, background: 'var(--theme-bg, #080f1d)', padding: '5px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                        {['Display Name', 'Username', 'Created', ''].map(h => (
                          <span key={h} style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{h}</span>
                        ))}
                      </div>
                      {allUsers.map((u, i) => (
                        <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 60px', minWidth: 420, padding: '6px 10px', background: i % 2 === 0 ? 'var(--theme-surface, #0d1826)' : 'transparent', borderBottom: i < allUsers.length - 1 ? '1px solid #1a2535' : 'none', alignItems: 'center' }}>
                          <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: u.id === user.id ? 'var(--theme-primary)' : 'var(--theme-text, #d7e3fc)' }}>
                            {u.displayName}
                          </span>
                          <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)' }}>@{u.username}</span>
                          <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>
                            {new Date(u.createdAt).toLocaleDateString()}
                          </span>
                          {u.id !== user.id ? (
                            <button onClick={() => deleteUser(u.id)} style={{ background: 'transparent', border: '1px solid #3a1010', color: '#8c2e2e', fontFamily: 'var(--theme-sans)', fontSize: 8, padding: '2px 6px', cursor: 'pointer' }}>
                              Delete
                            </button>
                          ) : (
                            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>you</span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginTop: 6 }}>
                      {allUsers.length} profile{allUsers.length !== 1 ? 's' : ''} stored in this browser's localStorage
                    </div>
                  </div>
                )}
              </Section>
            )}
          </div>
        </div>

        {/* ── Admin stats — only visible to whitelisted usernames ────────── */}
        {user && ADMIN_USERS.includes(user.username.toLowerCase()) && (
          <div style={{ marginTop: 40, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))', paddingTop: 32 }}>
            <Section title="Site-Wide User Stats (Admin)">
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-secondary)', marginBottom: 12 }}>
                Enter your <code style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-primary)' }}>ADMIN_SECRET</code> Fly env var to view registrations from all devices.
              </p>
              <AdminPanel />
            </Section>
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
