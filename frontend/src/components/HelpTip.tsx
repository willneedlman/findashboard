import { useState, useRef, useEffect } from 'react'

interface HelpTipProps {
  text: string
  width?: number
  position?: 'top' | 'bottom' | 'right'
}

export default function HelpTip({ text, width = 220, position = 'top' }: HelpTipProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const tipStyle: React.CSSProperties = {
    position: 'absolute',
    zIndex: 999,
    background: 'var(--theme-surface, #0d1826)',
    border: '1px solid rgba(201,168,76,0.35)',
    padding: '8px 10px',
    width,
    fontSize: 10,
    lineHeight: 1.55,
    color: '#d7e3fc',
    fontFamily: 'IBM Plex Sans, sans-serif',
    fontWeight: 400,
    letterSpacing: 0,
    textTransform: 'none',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    pointerEvents: 'none',
    // Anchor to the left edge of the ? button so it never overflows the right edge of a sidebar
    ...(position === 'top'    && { bottom: 'calc(100% + 6px)', left: 0 }),
    ...(position === 'bottom' && { top:    'calc(100% + 6px)', left: 0 }),
    ...(position === 'right'  && { top: '50%', left: 'calc(100% + 8px)', transform: 'translateY(-50%)' }),
  }

  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 5, verticalAlign: 'middle' }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: 14, height: 14,
          borderRadius: '50%',
          background: open ? 'rgba(201,168,76,0.25)' : 'rgba(201,168,76,0.12)',
          border: '1px solid rgba(201,168,76,0.4)',
          color: 'var(--theme-primary, #c9a84c)',
          fontSize: 9,
          fontFamily: 'IBM Plex Sans, sans-serif',
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
      {open && <div style={tipStyle}>{text}</div>}
    </span>
  )
}
