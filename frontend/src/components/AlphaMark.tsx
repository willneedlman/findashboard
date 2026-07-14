interface Props {
  size?: number
  /** Render inside the navy app-icon tile (rounded square). */
  tile?: boolean
  color?: string
  title?: string
  className?: string
  style?: React.CSSProperties
}

/** AlphaTape brand mark — geometric A+T monogram, rendered as a stroked vector. */
export default function AlphaMark({ size = 32, tile = false, color = 'var(--theme-primary, #c9a84c)', title = 'AlphaTape', className, style }: Props) {
  const referenceMark = (
    <>
      <clipPath id="alphatape-mark-clip"><rect x="0" y="0" width="100" height="83" /></clipPath>
      <g transform="translate(50 0) scale(1.08 1) translate(-50 0)" clipPath="url(#alphatape-mark-clip)" fill="none" stroke={color} strokeWidth={tile ? 10 : 7.5} strokeLinejoin="miter" strokeMiterlimit="12" strokeLinecap="butt" shapeRendering="geometricPrecision">
        <path d="M23 90 L50 17 L77 90" />
        <path d="M36 56 L64 56" />
        <path d="M50 56 L50 90" />
      </g>
    </>
  )
  const mark = referenceMark
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
          <rect x="0.5" y="0.5" width="99" height="99" rx="22" fill="url(#alphatile)" stroke="color-mix(in srgb, var(--theme-primary) 16%, transparent)" />
        </>
      )}
      {tile
        ? <g transform="translate(50 50) scale(0.62) translate(-50 -50)">{mark}</g>
        : mark}
    </svg>
  )
}
