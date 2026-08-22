import { useEffect, useState } from 'react'
import { Cloud, CloudOff } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'
import { LAST_SYNC_KEY, SYNC_EVENT } from '../lib/accountSync'
import { openSettings } from './SettingsOverlay'
import { T } from '../lib/theme'

// Saved data is account-scoped, so it only leaves the browser once you are
// signed in. Nothing used to say which of those two worlds you were in, and the
// difference only surfaced on the next device: a portfolio uploaded on the live
// site while signed out simply was not there in the app.

const SANS = 'var(--theme-sans)'

function ago(iso: string | null): string | null {
  if (!iso) return null
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(secs)) return null
  if (secs < 90) return 'just now'
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

export default function SyncStatus({ style }: { style?: React.CSSProperties }) {
  const { user } = useTheme()
  const [last, setLast] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_SYNC_KEY) } catch { return null }
  })

  useEffect(() => {
    const read = () => { try { setLast(localStorage.getItem(LAST_SYNC_KEY)) } catch { /* private mode */ } }
    window.addEventListener(SYNC_EVENT, read)
    // A push can land minutes after the last render, so the label re-reads on a
    // slow tick rather than freezing at "just now".
    const t = setInterval(read, 60_000)
    return () => { window.removeEventListener(SYNC_EVENT, read); clearInterval(t) }
  }, [])

  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SANS, fontSize: 10.5,
    lineHeight: 1.4, ...style,
  }

  if (!user) {
    return (
      <span style={{ ...base, color: T.warn }}>
        <CloudOff size={12} />
        Saved to this browser only
        <button onClick={() => openSettings('account')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
            color: T.gold, textDecoration: 'underline', textUnderlineOffset: 2 }}>
          Sign in to sync
        </button>
      </span>
    )
  }

  const when = ago(last)
  return (
    <span style={{ ...base, color: T.muted }}>
      <Cloud size={12} />
      Synced to {user.displayName || user.username}{when ? ` · ${when}` : ''}
    </span>
  )
}
