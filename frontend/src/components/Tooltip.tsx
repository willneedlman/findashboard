import { useState } from 'react'
import { createPortal } from 'react-dom'

// Styled hover tooltip that renders into document.body, so it escapes any
// overflow:auto/hidden ancestor (e.g. a scrolling table) and paints above the
// page chrome. Positioned with fixed coordinates from the trigger's rect and
// flipped above the trigger when there isn't room below.
interface TooltipProps {
  label: string
  children: React.ReactNode
}

export default function Tooltip({ label, children }: TooltipProps) {
  const [box, setBox] = useState<DOMRect | null>(null)

  const below = box ? box.bottom + 40 < window.innerHeight : true
  const cx = box ? box.left + box.width / 2 : 0
  const top = box ? (below ? box.bottom + 8 : box.top - 8) : 0

  return (
    <>
      <span
        style={{ display: 'inline-flex' }}
        onMouseEnter={e => setBox(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setBox(null)}
      >
        {children}
      </span>
      {box && createPortal(
        <div
          role="tooltip"
          className="fdb-tooltip"
          style={{
            position: 'fixed', left: cx, top, zIndex: 1000,
            transform: `translate(-50%, ${below ? '0' : '-100%'})`,
            pointerEvents: 'none', whiteSpace: 'nowrap',
            background: 'var(--theme-surface, #0d1826)',
            border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, var(--theme-border, rgba(255,255,255,0.12)))',
            color: 'var(--theme-text, #d7e3fc)',
            fontFamily: 'var(--theme-mono)', fontSize: 11, letterSpacing: '0.02em',
            padding: '5px 9px', boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
          }}
        >
          {label}
          <span
            style={{
              position: 'absolute', left: '50%', width: 7, height: 7,
              transform: 'translateX(-50%) rotate(45deg)',
              background: 'var(--theme-surface, #0d1826)',
              borderLeft: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, var(--theme-border, rgba(255,255,255,0.12)))',
              borderTop: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, var(--theme-border, rgba(255,255,255,0.12)))',
              ...(below
                ? { top: -4 }
                : { bottom: -4, transform: 'translateX(-50%) rotate(225deg)' }),
            }}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
