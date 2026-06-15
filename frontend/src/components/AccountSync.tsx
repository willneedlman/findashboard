import { useEffect, useRef } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { sync, startAutoPush, reset, clearLocal } from '../lib/accountSync'

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
    if (prev !== undefined && prev !== null) {
      reset()
      clearLocal()
    }

    if (!uid) return
    const token = localStorage.getItem('ft-session-token')
    if (!token) return

    sync(uid, token).then(changed => {
      // If the account had data this device didn't, reload once so already-mounted
      // pages re-read the hydrated localStorage. Same-device users have no diff, so
      // this is a no-op for them; the hydration leaves local == server, so it can't
      // loop.
      if (changed) window.location.reload()
    })
  }, [user])

  return null
}
