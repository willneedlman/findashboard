import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTheme } from '../contexts/ThemeContext'

const MIN_PW = 8

const inp: React.CSSProperties = { background: 'var(--theme-bg, #0a1220)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '8px 10px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)', textTransform: 'uppercase', letterSpacing: '0.12em', display: 'block', marginBottom: 4 }
const primaryBtn: React.CSSProperties = { background: 'var(--theme-primary, #c9a84c)', border: 'none', color: '#0a1220', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '10px 0', cursor: 'pointer', width: '100%' }

export default function ResetPassword() {
  const { resetPassword } = useTheme()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''

  const [pw, setPw]   = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setErr('')
    if (pw.length < MIN_PW) { setErr(`Password must be at least ${MIN_PW} characters.`); return }
    if (pw !== pw2) { setErr('Passwords do not match.'); return }
    setLoading(true)
    try {
      const ok = await resetPassword(token, pw)
      if (!ok) setErr('This reset link is invalid or has expired. Request a new one from the sign-in page.')
      else setDone(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--theme-bg, #101c2e)', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 360, background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '28px 26px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--theme-primary, #c9a84c)', marginBottom: 4 }}>
            Alphatape Terminal
          </h1>
          <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-secondary, #8099b0)', letterSpacing: '0.04em' }}>
            Set a new password
          </p>
        </div>

        {!token ? (
          <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: '#ef4444', lineHeight: '17px' }}>
            This link is missing its reset token. Request a new reset link from the sign-in page.
          </p>
        ) : done ? (
          <>
            <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: 'var(--theme-text, #d7e3fc)', lineHeight: '17px' }}>
              Your password has been reset. Sign in with your new password to continue.
            </p>
            <button onClick={() => navigate('/settings')} style={primaryBtn}>Go to Sign In</button>
          </>
        ) : (
          <>
            <div><label style={lbl}>New password ({MIN_PW}+ characters)</label><input style={inp} type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} autoFocus disabled={loading} /></div>
            <div><label style={lbl}>Confirm password</label><input style={inp} type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} disabled={loading} /></div>
            {err && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: '#ef4444', lineHeight: '15px' }}>{err}</span>}
            <button onClick={submit} disabled={loading} style={{ ...primaryBtn, background: loading ? 'rgba(255,255,255,0.08)' : primaryBtn.background, color: loading ? 'var(--theme-secondary, #8099b0)' : primaryBtn.color, cursor: loading ? 'default' : 'pointer' }}>
              {loading ? '…' : 'Reset Password'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
