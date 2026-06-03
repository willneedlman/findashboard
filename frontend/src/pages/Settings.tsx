import { useState, useRef, useEffect, useCallback } from 'react'
import { useTheme, DEFAULT_THEME, MONO_FONTS, SANS_FONTS, applyTheme, type Theme } from '../contexts/ThemeContext'
import PageWrapper from '../components/PageWrapper'

// ── Palette of preset color schemes ──────────────────────────────────────────
const PRESETS: { name: string; theme: Partial<Theme> }[] = [
  { name: 'Terminal Gold',  theme: { primaryColor: '#c9a84c', secondaryColor: '#5e768f', tertiaryColor: '#60a5fa', bgColor: '#101c2e', surfaceColor: '#0d1826' } },
  { name: 'Emerald Dark',   theme: { primaryColor: '#10b981', secondaryColor: '#6b7280', tertiaryColor: '#818cf8', bgColor: '#0a1a0f', surfaceColor: '#0d1f14' } },
  { name: 'Crimson Night',  theme: { primaryColor: '#ef4444', secondaryColor: '#6b7280', tertiaryColor: '#f59e0b', bgColor: '#1a0a0a', surfaceColor: '#1f0d0d' } },
  { name: 'Arctic Blue',    theme: { primaryColor: '#38bdf8', secondaryColor: '#64748b', tertiaryColor: '#a78bfa', bgColor: '#0a1020', surfaceColor: '#0d1530' } },
  { name: 'Violet Storm',   theme: { primaryColor: '#a78bfa', secondaryColor: '#6b7280', tertiaryColor: '#34d399', bgColor: '#110a1e', surfaceColor: '#160d26' } },
  { name: 'Cyber Citrus',   theme: { primaryColor: '#d4f724', secondaryColor: '#556677', tertiaryColor: '#f97316', bgColor: '#0d0f0a', surfaceColor: '#111308' } },
]

// ── Small UI helpers ──────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontFamily: 'var(--theme-sans, IBM Plex Sans, sans-serif)', fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
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
          style={{ width: 32, height: 32, background: value, border: '2px solid rgba(255,255,255,0.15)', borderRadius: 3, cursor: 'pointer', flexShrink: 0 }}
          title="Click to pick colour"
        />
        <input ref={inputRef} type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }} />
        <input
          type="text" value={value}
          onChange={e => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) onChange(e.target.value) }}
          style={{ background: '#0a1220', border: '1px solid #2e394d', color: '#d7e3fc', fontFamily: 'var(--theme-mono, JetBrains Mono, monospace)', fontSize: 11, padding: '4px 8px', width: 90, outline: 'none', letterSpacing: '0.05em' }}
        />
      </div>
    </div>
  )
}

function FontSelector({ label, value, options, onChange, onUpload }: {
  label: string; value: string; options: string[]
  onChange: (v: string) => void
  onUpload: (name: string, url: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    const name = file.name.replace(/\.[^.]+$/, '')
    onUpload(name, url)
    e.target.value = ''
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ flex: 1, background: '#0a1220', border: '1px solid #2e394d', color: '#d7e3fc', fontFamily: `'${value}', monospace`, fontSize: 11, padding: '4px 8px', outline: 'none', cursor: 'pointer' }}
        >
          {options.includes(value) ? null : <option value={value}>{value} (custom)</option>}
          {options.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
        <button
          onClick={() => fileRef.current?.click()}
          title="Upload custom font file (.ttf .woff .woff2)"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid #2e394d', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Upload
        </button>
        <input ref={fileRef} type="file" accept=".ttf,.woff,.woff2,.otf" style={{ display: 'none' }} onChange={handleFile} />
      </div>
      <span style={{ fontFamily: `'${value}', monospace`, fontSize: 12, color: 'var(--theme-primary)', letterSpacing: '0.04em' }}>
        0123  AAPL  $4.82T  Δ−0.25
      </span>
    </div>
  )
}

// ── Auth forms ────────────────────────────────────────────────────────────────
function AuthPanel({ onDone }: { onDone: () => void }) {
  const { login, register } = useTheme()
  const [mode,    setMode]   = useState<'login' | 'register'>('login')
  const [uname,   setUname]  = useState('')
  const [display, setDisplay] = useState('')
  const [pin,     setPin]    = useState('')
  const [err,     setErr]    = useState('')

  const handleSubmit = () => {
    setErr('')
    const trimmedUser = uname.trim()
    const trimmedPin  = pin.trim()
    if (mode === 'login') {
      if (!trimmedUser || !trimmedPin) { setErr('Enter username and PIN.'); return }
      if (!login(trimmedUser, trimmedPin)) setErr('Username or PIN not recognised.')
      else onDone()
    } else {
      if (trimmedUser.length < 2) { setErr('Username must be at least 2 characters.'); return }
      if (!/^\d{4}$/.test(trimmedPin)) { setErr('PIN must be exactly 4 digits.'); return }
      if (!register(trimmedUser, display.trim() || trimmedUser, trimmedPin)) setErr('Username already taken.')
      else onDone()
    }
  }

  const inp: React.CSSProperties = { background: '#0a1220', border: '1px solid #2e394d', color: '#d7e3fc', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '6px 10px', width: '100%', outline: 'none', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em', display: 'block', marginBottom: 4 }

  return (
    <div style={{ maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #2e394d', marginBottom: 4 }}>
        {(['login', 'register'] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); setErr('') }} style={{ flex: 1, background: 'none', border: 'none', borderBottom: mode === m ? '2px solid var(--theme-primary)' : '2px solid transparent', color: mode === m ? 'var(--theme-primary)' : 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 0', cursor: 'pointer' }}>
            {m === 'login' ? 'Sign In' : 'Create Profile'}
          </button>
        ))}
      </div>

      <div><label style={lbl}>Username</label><input style={inp} value={uname} onChange={e => setUname(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} autoFocus /></div>
      {mode === 'register' && <div><label style={lbl}>Display Name <span style={{ color: '#3a4d62' }}>(optional)</span></label><input style={inp} value={display} onChange={e => setDisplay(e.target.value)} /></div>}
      <div><label style={lbl}>PIN (4 digits)</label><input style={inp} type="text" inputMode="numeric" maxLength={4} autoComplete="off" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} onKeyDown={e => e.key === 'Enter' && handleSubmit()} /></div>
      {err && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: '#ef4444' }}>{err}</span>}
      <button onClick={handleSubmit} style={{ background: 'var(--theme-primary)', border: 'none', color: '#0a1220', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '8px 0', cursor: 'pointer' }}>
        {mode === 'login' ? 'Sign In' : 'Create & Sign In'}
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Settings() {
  const { theme, user, allUsers, setTheme, logout, deleteUser } = useTheme()
  const [confirmDel, setConfirmDel] = useState(false)
  const [saved,      setSaved]      = useState(false)

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
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
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
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 36, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: 'var(--theme-primary)', letterSpacing: '0.08em', margin: 0 }}>
              TERMINAL SETTINGS
            </h1>
            <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: dirty ? '#f59e0b' : 'var(--theme-secondary)', marginTop: 4, transition: 'color 0.2s' }}>
              {user ? (dirty ? 'Unsaved changes' : saved ? '✓ Saved' : `Signed in as ${user.displayName}`) : 'Guest session · sign in to persist settings'}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {dirty && (
              <button onClick={handleDiscard} style={{ background: 'transparent', border: '1px solid #2e394d', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
                Discard
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!dirty}
              style={{
                background: dirty ? 'var(--theme-primary)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${dirty ? 'var(--theme-primary)' : '#2e394d'}`,
                color: dirty ? '#0a1220' : '#3a4d62',
                fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                padding: '6px 20px', cursor: dirty ? 'pointer' : 'default',
                transition: 'all 0.15s',
              }}
            >
              {saved ? '✓ Saved' : 'Save'}
            </button>
            {user && (
              <button onClick={logout} style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
                Sign Out
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40, alignItems: 'start' }}>

          {/* ── Left column ─────────────────────────────────────────────── */}
          <div>
            <Section title="Color Presets">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
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
                <ColorSwatch label="Primary (accent)"     value={draft.primaryColor}   onChange={v => patchDraft({ primaryColor: v })} />
                <ColorSwatch label="Secondary (muted)"    value={draft.secondaryColor} onChange={v => patchDraft({ secondaryColor: v })} />
                <ColorSwatch label="Tertiary (highlight)" value={draft.tertiaryColor}  onChange={v => patchDraft({ tertiaryColor: v })} />
                <ColorSwatch label="Background"           value={draft.bgColor}        onChange={v => patchDraft({ bgColor: v })} />
                <ColorSwatch label="Surface / Cards"      value={draft.surfaceColor}   onChange={v => patchDraft({ surfaceColor: v })} />
              </div>
            </Section>

            <button onClick={handleReset} style={{ background: 'transparent', border: '1px solid #2e394d', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 14px', cursor: 'pointer' }}>
              Reset to Defaults
            </button>
          </div>

          {/* ── Right column ────────────────────────────────────────────── */}
          <div>
            <Section title="Typography">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <FontSelector
                  label="Primary font (numbers, code)"
                  value={draft.primaryFont} options={MONO_FONTS}
                  onChange={v => patchDraft({ primaryFont: v, primaryFontUrl: '' })}
                  onUpload={(name, url) => patchDraft({ primaryFont: name, primaryFontUrl: url })}
                />
                <FontSelector
                  label="Secondary font (labels, UI)"
                  value={draft.secondaryFont} options={SANS_FONTS}
                  onChange={v => patchDraft({ secondaryFont: v, secondaryFontUrl: '' })}
                  onUpload={(name, url) => patchDraft({ secondaryFont: name, secondaryFontUrl: url })}
                />
              </div>
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: '#3a4d62', marginTop: 12, lineHeight: 1.5 }}>
                Upload .ttf / .woff / .woff2 to use a custom font locally. Uploaded fonts are stored in memory for this session only.
              </p>
            </Section>

            <Section title="Preview">
              <div style={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${draft.primaryColor}40`, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-primary)', fontWeight: 700, letterSpacing: '0.1em' }}>FINANCE TERMINAL</div>
                <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Options Snapshot · NVDA</div>
                <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                  <div><div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', marginBottom: 2 }}>ATM IV</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: 'var(--theme-primary)' }}>54.7%</div></div>
                  <div><div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', marginBottom: 2 }}>1D %</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: '#22C55E' }}>+2.9%</div></div>
                  <div><div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: 'var(--theme-secondary)', marginBottom: 2 }}>BETA</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: 'var(--theme-tertiary)' }}>1.34</div></div>
                </div>
                <div style={{ height: 4, background: `linear-gradient(to right, ${draft.primaryColor}, ${draft.tertiaryColor})`, borderRadius: 2, marginTop: 4 }} />
              </div>
            </Section>

            {user && (
              <Section title="Account">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: '#d7e3fc' }}>
                    {user.displayName}
                    <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary)', marginLeft: 8 }}>@{user.username}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: '#3a4d62' }}>
                    Created {new Date(user.createdAt).toLocaleDateString()} · {allUsers.length} profile{allUsers.length !== 1 ? 's' : ''} stored locally
                  </div>
                  {!confirmDel ? (
                    <button onClick={() => setConfirmDel(true)} style={{ alignSelf: 'flex-start', background: 'transparent', border: '1px solid #3a1010', color: '#8c2e2e', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 12px', cursor: 'pointer', marginTop: 4 }}>
                      Delete Profile
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: '#ef4444' }}>Delete permanently?</span>
                      <button onClick={() => deleteUser(user.id)} style={{ background: '#ef4444', border: 'none', color: '#fff', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer' }}>Yes, delete</button>
                      <button onClick={() => setConfirmDel(false)} style={{ background: 'transparent', border: '1px solid #2e394d', color: 'var(--theme-secondary)', fontFamily: 'var(--theme-sans)', fontSize: 9, padding: '3px 10px', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  )}
                </div>
              </Section>
            )}
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}
