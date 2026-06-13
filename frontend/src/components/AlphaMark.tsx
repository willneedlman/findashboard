import { ALPHA_PATH } from './alphaMarkPath'

interface Props {
  size?: number
  /** Render inside the navy app-icon tile (rounded square). */
  tile?: boolean
  color?: string
  title?: string
  className?: string
  style?: React.CSSProperties
}

/** AlphaTape brand mark — the gold serif alpha (α). Vector path, no font dependency. */
export default function AlphaMark({ size = 32, tile = false, color = '#C9A84C', title = 'AlphaTape', className, style }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={title} className={className} style={style}>
      {tile && (
        <>
          <defs>
            <linearGradient id="alphatile" x1="0.05" y1="0" x2="0.95" y2="1">
              <stop offset="0" stopColor="#0D1B30" />
              <stop offset="1" stopColor="#0A1628" />
            </linearGradient>
          </defs>
          <rect x="0.5" y="0.5" width="99" height="99" rx="22" fill="url(#alphatile)" stroke="rgba(201,168,76,0.16)" />
        </>
      )}
      {/* color set via CSS `fill` so it can resolve a CSS var (theme preset) */}
      {tile
        ? <path d={ALPHA_PATH} style={{ fill: color }} />
        : <g transform="translate(50 50) scale(1.5) translate(-50 -50)"><path d={ALPHA_PATH} style={{ fill: color }} /></g>}
    </svg>
  )
}
