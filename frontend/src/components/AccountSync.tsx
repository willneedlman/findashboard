import { useEffect, useRef } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { sync, startAutoPush, reset, clearLocal, sessionWasRefused, worthReloading } from '../lib/accountSync'

// One reload per tab, whatever else arrives.
const RELOADED = 'ft_sync_reloaded'

// Drives account-scoped persistence: keeps auto-push pointed at the current
// session, and on login / app-load pulls the account's saved data into this
// device. Renders nothing.
export default function AccountSync() {
  const { user } = useTheme()
  const lastUid = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    startAutoPush(() => ({
      uid: user?.id ?? null,
      token: localStorage.getItem('ft-session-token'),
    }))

    const uid = user?.id ?? null
    if (uid === lastUid.current) return
    const prev = lastUid.current
    lastUid.current = uid

    // Leaving a logged-in account (logout or switch to a different user): cancel
    // that account's pending pushes and wipe its local data so the next user can
    // never inherit or re-upload it. (Server copy is re-pulled on their login.)
    //
    // A token the server REFUSED is not someone leaving. It is a session that
    // outlived its backend — which now happens routinely, since dev and the
    // desktop app point at production and an older token gets rejected on the
    // next load. Wiping the device for that turns a re-login into data loss.
    if (prev !== undefined && prev !== null) {
      reset()
      if (!sessionWasRefused()) clearLocal()
    }

    if (!uid) return
    const token = localStorage.getItem('ft-session-token')
    if (!token) return

    sync(uid, token).then(changed => {
      // Reload only for saved work the mounted pages cannot pick up on their
      // own, and only once per tab. Reloading for any change at all looped:
      // opening a tool records it in ft_recents, the next pull overwrites that
      // with the server copy, and the reloaded page records the visit again.
      if (!worthReloading(changed)) return
      try {
        if (sessionStorage.getItem(RELOADED)) return
        sessionStorage.setItem(RELOADED, '1')
      } catch { /* private mode: fall through and reload once */ }
      window.location.reload()
    })
  }, [user])

  return null
}
