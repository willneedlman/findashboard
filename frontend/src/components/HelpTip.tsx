import { useState, useRef, useEffect, useCallback, useId, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

interface HelpTipTextProps {
  text: string
  title?: undefined
  body?: undefined
  source?: undefined
}

interface HelpTipStructuredProps {
  text?: undefined
  // Structured content: an uppercase gold title, a body line, and an
  // optional citation footer — the shape InfoTip used to own.
  title: string
  body: string
  source?: string
}

type HelpTipProps = (HelpTipTextProps | HelpTipStructuredProps) & {
  width?: number
  position?: 'top' | 'bottom' | 'right' | 'left'
  anchor?: 'left' | 'right'
}

export default function HelpTip({ text, title, body, source, width, position = 'top', anchor = 'right' }: HelpTipProps) {
  const w = width ?? (title ? 260 : 220)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const tipId = useId()

  const calcCoords = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const gap = 8
    const margin = 12
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const popupWidth = Math.min(w, viewportWidth - margin * 2)
    const popupHeight = Math.min(tipRef.current?.offsetHeight ?? 120, viewportHeight - margin * 2)
    let top = 0
    let left = 0
    let resolvedPosition = position

    if (position === 'top' && r.top - gap - popupHeight < margin) {
      resolvedPosition = 'bottom'
    } else if (position === 'bottom' && r.bottom + gap + popupHeight > viewportHeight - margin) {
      resolvedPosition = 'top'
    } else if (position === 'right' && r.right + gap + popupWidth > viewportWidth - margin) {
      resolvedPosition = 'left'
    } else if (position === 'left' && r.left - gap - popupWidth < margin) {
      resolvedPosition = 'right'
    }

    if (resolvedPosition === 'top') {
      top = r.top - gap - popupHeight
      left = anchor === 'left' ? r.left : r.right - popupWidth
    } else if (resolvedPosition === 'bottom') {
      top = r.bottom + gap
      left = anchor === 'left' ? r.left : r.right - popupWidth
    } else if (resolvedPosition === 'right') {
      top = r.top + r.height / 2 - popupHeight / 2
      left = r.right + gap
    } else {
      top = r.top + r.height / 2 - popupHeight / 2
      left = r.left - popupWidth - gap
    }

    left = Math.max(margin, Math.min(left, viewportWidth - popupWidth - margin))
    top = Math.max(margin, Math.min(top, viewportHeight - popupHeight - margin))

    setCoords({ top, left, width: popupWidth })
  }, [position, anchor, w])

  useEffect(() => {
    if (!open) return
    calcCoords()
    function onClose(e: MouseEvent) {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        tipRef.current && !tipRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onClose)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', calcCoords, true)
    window.addEventListener('resize', calcCoords)
    return () => {
      document.removeEventListener('mousedown', onClose)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', calcCoords, true)
      window.removeEventListener('resize', calcCoords)
    }
  }, [open, calcCoords])

  useLayoutEffect(() => {
    if (!open || !coords || !tipRef.current) return
    const frame = window.requestAnimationFrame(calcCoords)
    return () => window.cancelAnimationFrame(frame)
  }, [open, coords?.width, calcCoords])

  const tipStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1200,
    top: coords?.top ?? 0,
    left: coords?.left ?? 0,
    background: 'var(--theme-surface, #0d1826)',
    border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
    boxShadow: '0 10px 30px rgba(0,0,0,0.42)',
    padding: '10px 12px',
    width: coords?.width ?? w,
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
    fontSize: 10.5,
    lineHeight: 1.6,
    color: 'var(--theme-text, #d7e3fc)',
    fontFamily: 'var(--theme-sans)',
    fontWeight: 400,
    letterSpacing: 0,
    textTransform: 'none',
    pointerEvents: 'auto',
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 5, verticalAlign: 'middle' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close help' : 'Open help'}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        style={{
          width: 14, height: 14,
          borderRadius: 0,
          background: open ? 'color-mix(in srgb, var(--theme-primary) 25%, transparent)' : 'color-mix(in srgb, var(--theme-primary) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-primary) 40%, transparent)',
          color: 'var(--theme-primary, #c9a84c)',
          fontSize: 9,
          fontFamily: 'var(--theme-sans)',
          fontWeight: 700,
          cursor: 'pointer',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          flexShrink: 0,
          transition: 'background 0.15s',
        }}
      >
        ?
      </button>
      {open && coords && createPortal(
        <div id={tipId} ref={tipRef} role="tooltip" style={tipStyle}>
          {title ? (
            <>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)', marginBottom: 6 }}>{title}</div>
              <div>{body}</div>
              {source && (
                <div style={{ marginTop: 9, paddingTop: 8, borderTop: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>{source}</div>
              )}
            </>
          ) : text}
        </div>,
        document.body
      )}
    </span>
  )
}
