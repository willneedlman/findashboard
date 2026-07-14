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
  const mark = (
    <g fill="none" stroke={color} strokeWidth={tile ? 11 : 7.5} strokeLinejoin="round" strokeLinecap="round">
      <path d="M25 82 L50 20 L75 82" />
      <path d="M36 56 L64 56" />
      <path d="M50 56 L50 82" />
    </g>
  )
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
