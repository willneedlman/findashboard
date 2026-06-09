import { createContext, useContext, useEffect, useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Theme {
  primaryColor:   string   // gold accent  default #c9a84c
  secondaryColor: string   // muted text   default #5e768f
  tertiaryColor:  string   // blue accent  default #60a5fa
  bgColor:        string   // app bg       default #101c2e
  surfaceColor:   string   // card/panel   default #0d1826
  primaryFont:    string   // mono font    default JetBrains Mono
  secondaryFont:  string   // label font   default IBM Plex Sans
  primaryFontUrl:   string // '' = use Google Fonts / system
  secondaryFontUrl: string
}

export interface User {
  id:          string
  username:    string
  displayName: string
  theme:       Theme
  createdAt:   string
}

interface ThemeCtx {
  theme:       Theme
  user:        User | null
  allUsers:    User[]
  setTheme:    (t: Partial<Theme>) => void
  login:       (username: string, pin: string) => Promise<boolean>
  logout:      () => void
  register:    (username: string, displayName: string, pin: string) => Promise<boolean>
  deleteUser:  (id: string) => void
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_THEME: Theme = {
  primaryColor:    '#c9a84c',
  secondaryColor:  '#8099b0',
  tertiaryColor:   '#60a5fa',
  bgColor:         '#101c2e',
  surfaceColor:    '#0d1826',
  primaryFont:     'JetBrains Mono',
  secondaryFont:   'IBM Plex Sans',
  primaryFontUrl:  '',
  secondaryFontUrl: '',
}

// Popular font presets — chosen for visual distinctiveness across categories
export const MONO_FONTS = [
  'JetBrains Mono',   // default — proportional serifs, ligatures
  'Fira Code',        // rounded, ligature-heavy
  'Courier Prime',    // classic typewriter feel
  'Space Mono',       // wide, retro terminal
  'Inconsolata',      // narrow, clean
  'Martian Mono',     // ultra-wide condensed blocks
  'Geist Mono',       // minimal, Vercel-style
  'DM Mono',          // subtle, editorial
]
export const SANS_FONTS = [
  'IBM Plex Sans',    // default — neutral, technical
  'Inter',            // clean, UI-optimised
  'DM Sans',          // geometric, modern
  'Sora',             // rounded, futuristic
  'Space Grotesk',    // mono-inspired sans
  'Anybody',          // wide, display-grade
  'Oxanium',          // sci-fi / fintech feel
  'Barlow',           // condensed, editorial
]

const STORAGE_USERS   = 'ft-users'
const STORAGE_SESSION = 'ft-session'

// ── CSS injection ─────────────────────────────────────────────────────────────

let _styleEl: HTMLStyleElement | null = null

function hexLuminance(hex: string): number {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0,2), 16) / 255
  const g = parseInt(c.slice(2,4), 16) / 255
  const b = parseInt(c.slice(4,6), 16) / 255
  const lin = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function applyTheme(t: Theme) {
  if (!_styleEl) {
    _styleEl = document.createElement('style')
    _styleEl.id = 'ft-theme'
    document.head.appendChild(_styleEl)
  }

  const isLight = hexLuminance(t.bgColor) > 0.18
  const textColor    = isLight ? '#1a1a1a'                   : '#d7e3fc'
  const textMuted    = isLight ? '#374151'                   : '#8099b0'
  const textDim      = isLight ? 'rgba(0,0,0,0.45)'  : 'rgba(255,255,255,0.35)'
  const textFaint    = isLight ? 'rgba(0,0,0,0.30)'  : 'rgba(255,255,255,0.22)'
  const textSubtle   = isLight ? 'rgba(0,0,0,0.20)'  : 'rgba(255,255,255,0.14)'
  const borderColor  = isLight ? 'rgba(0,0,0,0.10)'  : 'rgba(255,255,255,0.08)'
  const borderFaint  = isLight ? 'rgba(0,0,0,0.06)'  : 'rgba(255,255,255,0.05)'
  const surfaceHover = isLight ? 'rgba(0,0,0,0.04)'  : 'rgba(255,255,255,0.04)'

  // Load Google Fonts if no custom URL provided
  const monoSrc   = t.primaryFontUrl   || `https://fonts.googleapis.com/css2?family=${encodeURIComponent(t.primaryFont)}:wght@400;700&display=swap`
  const sansSrc   = t.secondaryFontUrl || `https://fonts.googleapis.com/css2?family=${encodeURIComponent(t.secondaryFont)}:wght@400;600;700&display=swap`
  const builtinFonts = [
    'JetBrains Mono', 'IBM Plex Sans', 'Cinzel', 'Lora', 'IBM Plex Mono',
    'Fira Code', 'Inconsolata', 'Inter', 'DM Sans', 'Space Grotesk',
    'Courier Prime', 'Space Mono', 'DM Mono',
  ]

  // Only inject <link> for Google-Fonts-style URLs
  const injectLink = (href: string, id: string) => {
    if (!href.startsWith('http')) return
    let el = document.getElementById(id) as HTMLLinkElement | null
    if (!el) { el = document.createElement('link'); el.id = id; el.rel = 'stylesheet'; document.head.appendChild(el) }
    if (el.href !== href) el.href = href
  }
  if (!builtinFonts.includes(t.primaryFont)   || t.primaryFontUrl)   injectLink(monoSrc, 'ft-font-mono')
  if (!builtinFonts.includes(t.secondaryFont) || t.secondaryFontUrl) injectLink(sansSrc, 'ft-font-sans')

  // Inject custom @font-face for uploaded fonts (data: or blob: URLs)
  const customFontFace = (name: string, src: string) =>
    src && !src.startsWith('http')
      ? `@font-face { font-family: '${name}'; src: url('${src}'); font-display: swap; }`
      : ''

  _styleEl.textContent = `
    ${customFontFace(t.primaryFont,   t.primaryFontUrl)}
    ${customFontFace(t.secondaryFont, t.secondaryFontUrl)}

    :root {
      --theme-primary:   ${t.primaryColor};
      --theme-secondary: ${t.secondaryColor};
      --theme-tertiary:  ${t.tertiaryColor};
      --theme-bg:        ${t.bgColor};
      --theme-surface:   ${t.surfaceColor};
      --theme-mono:      '${t.primaryFont}', monospace;
      --theme-sans:      '${t.secondaryFont}', sans-serif;
      --theme-text:        ${textColor};
      --theme-text-muted:  ${textMuted};
      --theme-text-dim:    ${textDim};
      --theme-text-faint:  ${textFaint};
      --theme-text-subtle: ${textSubtle};
      --theme-border:      ${borderColor};
      --theme-border-faint:${borderFaint};
      --theme-hover:       ${surfaceHover};
    }

    /* ── Layout / Navigation overrides ──────────────────────────────── */
    #ft-root { background: ${t.bgColor} !important; }
    .ft-nav-active { color: ${t.primaryColor} !important; border-left-color: ${t.primaryColor} !important; background: ${t.primaryColor}1a !important; }
    .ft-nav-link:hover { color: ${t.primaryColor}cc !important; }
    .ft-sidebar { background: ${t.surfaceColor} !important; border-right-color: ${t.primaryColor}30 !important; }
    .ft-logo { color: ${t.primaryColor} !important; }
    .ft-logo-sub { color: ${t.secondaryColor} !important; }

    /* ── Global background ───────────────────────────────────────────── */
    html, body, #root { background: ${t.bgColor} !important; }
  `

  // Also push as real CSS custom props onto :root so var() works everywhere
  const root = document.documentElement
  root.style.setProperty('--theme-primary',    t.primaryColor)
  root.style.setProperty('--theme-secondary',  t.secondaryColor)
  root.style.setProperty('--theme-tertiary',   t.tertiaryColor)
  root.style.setProperty('--theme-bg',         t.bgColor)
  root.style.setProperty('--theme-surface',    t.surfaceColor)
  root.style.setProperty('--theme-text',         textColor)
  root.style.setProperty('--theme-text-muted',  textMuted)
  root.style.setProperty('--theme-text-dim',    textDim)
  root.style.setProperty('--theme-text-faint',  textFaint)
  root.style.setProperty('--theme-text-subtle', textSubtle)
  root.style.setProperty('--theme-border',      borderColor)
  root.style.setProperty('--theme-border-faint',borderFaint)
  root.style.setProperty('--theme-hover',       surfaceHover)
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function loadUsers(): User[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_USERS) ?? '[]') } catch { return [] }
}
function saveUsers(users: User[]) {
  localStorage.setItem(STORAGE_USERS, JSON.stringify(users))
}
function loadSession(): string | null {
  return localStorage.getItem(STORAGE_SESSION)
}
function saveSession(id: string | null) {
  if (id) localStorage.setItem(STORAGE_SESSION, id)
  else localStorage.removeItem(STORAGE_SESSION)
}

// ── Context ───────────────────────────────────────────────────────────────────

const Ctx = createContext<ThemeCtx>({
  theme: DEFAULT_THEME, user: null, allUsers: [],
  setTheme: () => {}, login: async () => false, logout: () => {},
  register: async () => false, deleteUser: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [users,   setUsersState] = useState<User[]>(loadUsers)
  const [userId,  setUserId]     = useState<string | null>(loadSession)

  const user = users.find(u => u.id === userId) ?? null
  const theme = user?.theme ?? DEFAULT_THEME

  // Apply CSS whenever theme changes
  useEffect(() => { applyTheme(theme) }, [theme])

  // No on-mount sync needed — auth is now server-side

  const persistUsers = useCallback((next: User[]) => {
    setUsersState(next)
    saveUsers(next)
  }, [])

  const setTheme = useCallback((patch: Partial<Theme>) => {
    if (!userId) return
    persistUsers(users.map(u => u.id === userId ? { ...u, theme: { ...u.theme, ...patch } } : u))
  }, [userId, users, persistUsers])

  const login = useCallback(async (username: string, pin: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin }),
      })
      if (!res.ok) return false
      const data: { id: string; username: string; display_name: string; created_at: string } = await res.json()
      const existing = users.find(u => u.id === data.id)
      const u: User = {
        id:          data.id,
        username:    data.username,
        displayName: data.display_name,
        createdAt:   data.created_at,
        theme:       existing?.theme ?? { ...DEFAULT_THEME },
      }
      const next = existing
        ? users.map(u => u.id === data.id ? { ...u, username: u.username, displayName: u.displayName } : u)
        : [...users, u]
      persistUsers(next)
      setUserId(u.id)
      saveSession(u.id)
      // Store pin hash for WS auth (SHA-256 of pin, same algorithm as server)
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin))
        const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
        sessionStorage.setItem('ft-pin-hash', hex)
      } catch { /* crypto not available */ }
      return true
    } catch {
      return false
    }
  }, [users, persistUsers])

  const logout = useCallback(() => {
    setUserId(null)
    saveSession(null)
    applyTheme(DEFAULT_THEME)
  }, [])

  const register = useCallback(async (username: string, displayName: string, pin: string): Promise<boolean> => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    try {
      const res = await fetch('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, username, display_name: displayName || username, pin, created_at: createdAt }),
      })
      if (!res.ok) return false
      const u: User = { id, username, displayName: displayName || username, theme: { ...DEFAULT_THEME }, createdAt }
      persistUsers([...users, u])
      setUserId(id)
      saveSession(id)
      return true
    } catch {
      return false
    }
  }, [users, persistUsers])

  const deleteUser = useCallback((id: string) => {
    persistUsers(users.filter(u => u.id !== id))
    if (userId === id) { setUserId(null); saveSession(null); applyTheme(DEFAULT_THEME) }
  }, [users, userId, persistUsers])

  return (
    <Ctx.Provider value={{ theme, user, allUsers: users, setTheme, login, logout, register, deleteUser }}>
      {children}
    </Ctx.Provider>
  )
}

export function useTheme() { return useContext(Ctx) }
