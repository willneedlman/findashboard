import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { SettingsContent } from '../pages/Settings'
import { T } from '../lib/theme'

// Settings used to be a destination. Reaching it meant leaving whatever you had
// open — a half-built formula, a zoomed chart, a screen mid-run — and coming
// back to it rebuilt from scratch. Changing a font should not cost you your
// work, so it opens over the page instead and the page stays exactly as it was.

export const OPEN_SETTINGS = 'ft:open-settings'

/** Open the settings overlay from anywhere. */
export function openSettings() {
  window.dispatchEvent(new Event(OPEN_SETTINGS))
}

export default function SettingsOverlay() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_SETTINGS, onOpen)
    return () => window.removeEventListener(OPEN_SETTINGS, onOpen)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    // The page underneath must not scroll away behind the panel.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, close])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Terminal settings"
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'color-mix(in srgb, #000 55%, transparent)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 'clamp(12px, 4vh, 48px) 16px',
      }}>
      <div
        style={{
          width: 'min(940px, 100%)', maxHeight: '100%', display: 'flex', flexDirection: 'column',
          background: T.bg, border: `1px solid ${T.border}`,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 8px 0', flexShrink: 0 }}>
          <button onClick={close} aria-label="Close settings" title="Close settings (Esc)"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, background: 'transparent', border: `1px solid ${T.border}`,
              color: T.muted, cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.color = T.gold; e.currentTarget.style.borderColor = T.goldTint(55) }}
            onMouseLeave={e => { e.currentTarget.style.color = T.muted; e.currentTarget.style.borderColor = T.border }}>
            <X size={13} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
          <SettingsContent inOverlay />
        </div>
      </div>
    </div>
  )
}
