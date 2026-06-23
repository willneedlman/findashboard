import { createContext, useContext, useEffect, useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Theme {
  primaryColor:        string   // gold accent       default #c9a84c
  secondaryColor:      string   // muted text        default #5e768f
  tertiaryColor:       string   // blue accent       default #60a5fa
  bgColor:             string   // app bg            default #101c2e
  surfaceColor:        string   // card/panel        default #0d1826
  chartNeutralColor:   string   // neutral chart fill default #4a7fa5
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
  login:       (username: string, password: string) => Promise<'ok' | 'migrate' | 'set-email' | false>
  logout:      () => void
  register:    (username: string, displayName: string, password: string, email: string) => Promise<boolean | 'taken' | 'email-taken'>
  deleteUser:  (id: string) => void
  mustSetPassword: boolean
  setPassword: (newPassword: string) => Promise<boolean>
  mustSetEmail: boolean
  setEmail:    (email: string) => Promise<boolean | 'taken'>
  forgotPassword: (email: string) => Promise<boolean>
  resetPassword:  (token: string, newPassword: string) => Promise<boolean>
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_THEME: Theme = {
  primaryColor:      '#c9a84c',
  secondaryColor:    '#8099b0',
  tertiaryColor:     '#60a5fa',
  bgColor:           '#101c2e',
  surfaceColor:      '#0d1826',
  chartNeutralColor: '#4a7fa5',
  primaryFont:       'JetBrains Mono',
  secondaryFont:     'IBM Plex Sans',
  primaryFontUrl:    '',
  secondaryFontUrl:  '',
}

// Popular font presets — chosen for visual distinctiveness across categories
// Monospace faces for numbers & tabular data (all monospaced so figures align),
// chosen to be visually distinct in character rather than near-identical.
export const MONO_FONTS = [
  'JetBrains Mono',   // modern terminal — default
  'IBM Plex Mono',    // corporate, professional
  'Roboto Mono',      // clean, neutral
  'Fira Code',        // rounded, ligature-rich
  'Space Mono',       // retro, wide character
  'DM Mono',          // light, editorial
  'Martian Mono',     // ultra-wide condensed blocks
  'San Francisco',    // Apple system font (local) — used as a data face in test preset
]
// Interface typeface — a deliberately varied set so the choices look distinct:
// grotesque · humanist · geometric · rounded · futuristic · serif · display.
export const SANS_FONTS = [
  'Inter',               // neutral grotesque — clean modern default
  'IBM Plex Sans',       // humanist, technical
  'Space Grotesk',       // techy, mono-inspired sans
  'DM Sans',             // geometric, friendly
  'Manrope',             // semi-rounded, contemporary
  'Sora',                // futuristic geometric
  'Geist',               // minimal, Vercel-style
  'Lora',                // serif — editorial warmth
  'Fraunces',            // expressive display serif
  'Bricolage Grotesque', // characterful display grotesque
  'Barlow',              // slightly condensed grotesque
  'Yahoo Sans',          // proprietary (local) — used in the test preset
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
  // For light themes: use the theme's primary accent colour as the main text colour
  // so values/numbers read as themed (not pure black). Guard: only if primary is
  // dark enough for WCAG AA on white (luminance < 0.18).
  const primLum = hexLuminance(t.primaryColor)
  const textColor    = isLight ? (primLum < 0.18 ? t.primaryColor : '#374151') : '#d7e3fc'
  const textMuted    = isLight ? t.secondaryColor             : '#8099b0'
  const textDim      = isLight ? 'rgba(0,0,0,0.45)'  : 'rgba(255,255,255,0.35)'
  const textFaint    = isLight ? 'rgba(0,0,0,0.30)'  : 'rgba(255,255,255,0.22)'
  const textSubtle   = isLight ? 'rgba(0,0,0,0.20)'  : 'rgba(255,255,255,0.14)'
  const borderColor  = isLight ? 'rgba(0,0,0,0.10)'  : 'rgba(255,255,255,0.08)'
  const borderFaint  = isLight ? 'rgba(0,0,0,0.06)'  : 'rgba(255,255,255,0.05)'
  const surfaceHover = isLight ? 'rgba(0,0,0,0.04)'  : 'rgba(255,255,255,0.04)'
  // Semantic positive/negative: the terminal's standard vivid green/red on dark
  // (matches the original hardcoded #22c55e/#ef4444), darker high-contrast
  // variants on light backgrounds — WCAG AA on both.
  const posStrong    = isLight ? '#15803d' : '#16a34a'
  const posSoft      = isLight ? '#16a34a' : '#22c55e'
  const negStrong    = isLight ? '#991b1b' : '#dc2626'
  const negSoft      = isLight ? '#dc2626' : '#ef4444'
  // Warn (amber): b45309 on light (5.7:1 on white), e8c04a on dark
  const warnSoft     = isLight ? '#b45309' : '#e8c04a'
  const warnStrong   = isLight ? '#92400e' : '#d97706'

  // Load Google Fonts if no custom URL provided
  const monoSrc   = t.primaryFontUrl   || `https://fonts.googleapis.com/css2?family=${encodeURIComponent(t.primaryFont)}:wght@400;700&display=swap`
  const sansSrc   = t.secondaryFontUrl || `https://fonts.googleapis.com/css2?family=${encodeURIComponent(t.secondaryFont)}:wght@400;600;700&display=swap`
  const builtinFonts = [
    'JetBrains Mono', 'IBM Plex Mono', 'Roboto Mono', 'Fira Code', 'Space Mono',
    'DM Mono', 'Martian Mono', 'Cinzel', 'Lora', 'IBM Plex Sans', 'Inter',
    'DM Sans', 'Space Grotesk', 'Sora', 'Barlow', 'Manrope', 'Geist',
    'Fraunces', 'Bricolage Grotesque',
    // System/local fonts — not on Google Fonts, so skip the web-font fetch and
    // resolve them from the user's machine (falling back if not installed).
    'San Francisco', 'Yahoo Sans',
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
      --theme-primary:        ${t.primaryColor};
      --theme-secondary:      ${t.secondaryColor};
      --theme-tertiary:       ${t.tertiaryColor};
      --theme-bg:             ${t.bgColor};
      --theme-surface:        ${t.surfaceColor};
      --theme-chart-neutral:  ${t.chartNeutralColor ?? '#4a7fa5'};
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
      --theme-positive:        ${posSoft};
      --theme-positive-strong: ${posStrong};
      --theme-negative:        ${negSoft};
      --theme-negative-strong: ${negStrong};
      --theme-warn:            ${warnSoft};
      --theme-warn-strong:     ${warnStrong};
      --theme-accent-violet:   ${isLight ? '#7c5cd6' : '#a78bfa'};
      --theme-accent-orange:   ${isLight ? '#c2570f' : '#f97316'};
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
  root.style.setProperty('--theme-primary',         t.primaryColor)
  root.style.setProperty('--theme-secondary',       t.secondaryColor)
  root.style.setProperty('--theme-tertiary',        t.tertiaryColor)
  root.style.setProperty('--theme-bg',              t.bgColor)
  root.style.setProperty('--theme-surface',         t.surfaceColor)
  root.style.setProperty('--theme-chart-neutral',   t.chartNeutralColor ?? '#4a7fa5')
  root.style.setProperty('--theme-text',         textColor)
  root.style.setProperty('--theme-text-muted',  textMuted)
  root.style.setProperty('--theme-text-dim',    textDim)
  root.style.setProperty('--theme-text-faint',  textFaint)
  root.style.setProperty('--theme-text-subtle', textSubtle)
  root.style.setProperty('--theme-border',      borderColor)
  root.style.setProperty('--theme-border-faint',borderFaint)
  root.style.setProperty('--theme-hover',       surfaceHover)
  root.style.setProperty('--theme-positive',         posSoft)
  root.style.setProperty('--theme-positive-strong',  posStrong)
  root.style.setProperty('--theme-negative',         negSoft)
  root.style.setProperty('--theme-negative-strong',  negStrong)
  root.style.setProperty('--theme-warn',             warnSoft)
  root.style.setProperty('--theme-warn-strong',      warnStrong)
  root.style.setProperty('--theme-accent-violet',    isLight ? '#7c5cd6' : '#a78bfa')
  root.style.setProperty('--theme-accent-orange',    isLight ? '#c2570f' : '#f97316')
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
  setTheme: () => {}, login: async () => false as const, logout: () => {},
  register: async () => false, deleteUser: () => {},
  mustSetPassword: false, setPassword: async () => false,
  mustSetEmail: false, setEmail: async () => false,
  forgotPassword: async () => false, resetPassword: async () => false,
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [users,   setUsersState] = useState<User[]>(loadUsers)
  const [userId,  setUserId]     = useState<string | null>(loadSession)
  const [mustSetPassword, setMustSetPassword] = useState(false)
  const [mustSetEmail, setMustSetEmail] = useState(false)

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

  const login = useCallback(async (username: string, password: string): Promise<'ok' | 'migrate' | 'set-email' | false> => {
    try {
      const res = await fetch('/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin: password }),
      })
      if (!res.ok) return false
      const data: { id: string; username: string; display_name: string; created_at: string; token?: string; must_set_password?: boolean; must_set_email?: boolean } = await res.json()
      if (data.token) localStorage.setItem('ft-session-token', data.token)
      setMustSetPassword(!!data.must_set_password)
      setMustSetEmail(!!data.must_set_email)
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
      return data.must_set_password ? 'migrate' : data.must_set_email ? 'set-email' : 'ok'
    } catch {
      return false
    }
  }, [users, persistUsers])

  const logout = useCallback(() => {
    // Best-effort server-side session invalidation, then clear the local token.
    const token = localStorage.getItem('ft-session-token')
    if (token) {
      fetch('/api/users/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
    }
    localStorage.removeItem('ft-session-token')
    setMustSetPassword(false)
    setUserId(null)
    saveSession(null)
    applyTheme(DEFAULT_THEME)
  }, [])

  const register = useCallback(async (username: string, displayName: string, password: string, email: string): Promise<boolean | 'taken' | 'email-taken'> => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    try {
      const res = await fetch('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, username, display_name: displayName || username, pin: password, created_at: createdAt, email }),
      })
      if (!res.ok) {
        if (res.status === 409) {
          const d = await res.json().catch(() => null)
          return /email/i.test(d?.detail ?? '') ? 'email-taken' : 'taken'
        }
        return false
      }
      const data = await res.json().catch(() => null)
      if (data?.token) localStorage.setItem('ft-session-token', data.token)
      setMustSetPassword(false)   // new accounts register with a password directly
      setMustSetEmail(false)
      const u: User = { id, username, displayName: displayName || username, theme: { ...DEFAULT_THEME }, createdAt }
      persistUsers([...users, u])
      setUserId(id)
      saveSession(id)
      return true
    } catch {
      return false
    }
  }, [users, persistUsers])

  const setPassword = useCallback(async (newPassword: string): Promise<boolean> => {
    const token = localStorage.getItem('ft-session-token')
    if (!token) return false
    try {
      const res = await fetch('/api/users/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ new_password: newPassword }),
      })
      if (!res.ok) return false
      setMustSetPassword(false)
      return true
    } catch {
      return false
    }
  }, [])

  const setEmail = useCallback(async (email: string): Promise<boolean | 'taken'> => {
    const token = localStorage.getItem('ft-session-token')
    if (!token) return false
    try {
      const res = await fetch('/api/users/set-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) return res.status === 409 ? 'taken' : false
      setMustSetEmail(false)
      return true
    } catch {
      return false
    }
  }, [])

  const forgotPassword = useCallback(async (email: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/users/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      return res.ok   // always ok-shaped server-side; no user enumeration
    } catch {
      return false
    }
  }, [])

  const resetPassword = useCallback(async (token: string, newPassword: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPassword }),
      })
      return res.ok
    } catch {
      return false
    }
  }, [])

  const deleteUser = useCallback((id: string) => {
    persistUsers(users.filter(u => u.id !== id))
    if (userId === id) { setUserId(null); saveSession(null); applyTheme(DEFAULT_THEME) }
  }, [users, userId, persistUsers])

  return (
    <Ctx.Provider value={{ theme, user, allUsers: users, setTheme, login, logout, register, deleteUser, mustSetPassword, setPassword, mustSetEmail, setEmail, forgotPassword, resetPassword }}>
      {children}
    </Ctx.Provider>
  )
}

export function useTheme() { return useContext(Ctx) }
