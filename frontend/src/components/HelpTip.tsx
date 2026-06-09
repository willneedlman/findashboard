import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface HelpTipProps {
  text: string
  width?: number
  position?: 'top' | 'bottom' | 'right' | 'left'
  anchor?: 'left' | 'right'
}

export default function HelpTip({ text, width = 220, position = 'top', anchor = 'right' }: HelpTipProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const calcCoords = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const gap = 8
    let top = 0
    let left = 0

    if (position === 'top') {
      top = r.top - gap
      left = anchor === 'left' ? r.left : r.right - width
    } else if (position === 'bottom') {
      top = r.bottom + gap
      left = anchor === 'left' ? r.left : r.right - width
    } else if (position === 'right') {
      top = r.top + r.height / 2
      left = r.right + gap
    } else {
      top = r.top + r.height / 2
      left = r.left - width - gap
    }

    // clamp so tip stays inside viewport
    const vw = window.innerWidth
    const vh = window.innerHeight
    left = Math.max(8, Math.min(left, vw - width - 8))
    top = Math.max(8, Math.min(top, vh - 8))

    setCoords({ top, left })
  }, [position, anchor, width])

  useEffect(() => {
    if (!open) return
    calcCoords()
    function onClose(e: MouseEvent) {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        tipRef.current && !tipRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', onClose)
    window.addEventListener('scroll', calcCoords, true)
    window.addEventListener('resize', calcCoords)
    return () => {
      document.removeEventListener('mousedown', onClose)
      window.removeEventListener('scroll', calcCoords, true)
      window.removeEventListener('resize', calcCoords)
    }
  }, [open, calcCoords])

  const translateY = (position === 'right' || position === 'left') ? '-50%' : position === 'top' ? '-100%' : '0'

  const tipStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 9999,
    top: coords?.top ?? 0,
    left: coords?.left ?? 0,
    transform: `translateY(${translateY})`,
    background: 'var(--theme-surface, #0d1826)',
    border: '1px solid rgba(201,168,76,0.35)',
    padding: '8px 10px',
    width,
    fontSize: 10,
    lineHeight: 1.55,
    color: 'var(--theme-text, #d7e3fc)',
    fontFamily: 'var(--theme-sans)',
    fontWeight: 400,
    letterSpacing: 0,
    textTransform: 'none',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    pointerEvents: 'none',
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 5, verticalAlign: 'middle' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: 14, height: 14,
          borderRadius: '50%',
          background: open ? 'rgba(201,168,76,0.25)' : 'rgba(201,168,76,0.12)',
          border: '1px solid rgba(201,168,76,0.4)',
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
        title="Help"
      >
        ?
      </button>
      {open && coords && createPortal(
        <div ref={tipRef} style={tipStyle}>{text}</div>,
        document.body
      )}
    </span>
  )
}
