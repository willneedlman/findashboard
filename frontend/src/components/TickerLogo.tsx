import { useEffect, useState } from 'react'
import { tickerLogoSources, tickerLogoVisualScale } from '../lib/tickerLogos'

// Backs the two-letter monogram when no logo resolves. Hashing the first letter
// gives each symbol a stable, distinguishable tile.
function tickerColor(ticker: string): string {
  const code = ticker.charCodeAt(0)
  return `hsl(${(code * 37) % 360}, 35%, 22%)`
}

// Brand marks are overwhelmingly supplied as a coloured shape on a transparent
// background — Parqet serves Oracle as a bare #C74634 path with no plate — and
// they are drawn to sit on white. Composited onto the monogram tile instead, the
// hashed hue shows through and the mark reads as muddy: Oracle red on the mustard
// tile that "O" happens to hash to was the case that surfaced this. A logo that
// actually loads therefore gets a neutral plate, and the hashed colour stays
// where it belongs, behind the monogram.
const LOGO_PLATE = '#ffffff'

interface TickerLogoProps {
  ticker: string
  size?: number
  logoUrl?: string   // preferred source tried before the symbol-based providers
  crossOrigin?: 'anonymous' | 'use-credentials'
  fit?: 'cover' | 'contain'
  cornerRadius?: number | string
  padding?: number
  logoBackground?: string
  normalizeVisualWeight?: boolean
  showFallbackText?: boolean
}

export default function TickerLogo({
  ticker,
  size = 28,
  logoUrl,
  crossOrigin,
  fit = 'cover',
  cornerRadius = '50%',
  padding = 0,
  logoBackground,
  normalizeVisualWeight = false,
  showFallbackText = true,
}: TickerLogoProps) {
  // Try the resolved (name-based logo.dev / finnhub) URL first when present, then
  // the symbol-based CDNs (Parqet, FMP), then a monogram — so both paths together
  // maximize coverage: logo.dev catches freshly-filed names, Parqet/FMP catch
  // established tickers logo.dev misses (SPCX, CBRS).
  const sources = logoUrl ? [logoUrl, ...tickerLogoSources(ticker)] : tickerLogoSources(ticker)
  const [idx, setIdx] = useState(0)
  const [loaded, setLoaded] = useState(false)
  // Reset to the first provider when the symbol changes (component is reused) or
  // when a preferred logoUrl arrives after mount (async enrichment).
  const key = `${ticker}|${logoUrl ?? ''}`
  useEffect(() => { setIdx(0); setLoaded(false) }, [key])

  return (
    <span
      aria-label={`${ticker} logo`}
      style={{
        width: size,
        height: size,
        borderRadius: cornerRadius,
        background: logoBackground ?? (loaded ? LOGO_PLATE : tickerColor(ticker)),
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {showFallbackText && idx >= sources.length && (
        <span aria-hidden="true" style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: size * 0.36, fontWeight: 700 }}>
          {ticker.slice(0, 2).toUpperCase()}
        </span>
      )}
      {idx < sources.length && (
      <img
        key={`${ticker}-${idx}`}
        src={sources[idx]}
        alt=""
        aria-hidden="true"
        crossOrigin={crossOrigin}
        width={size}
        height={size}
        onError={() => { setLoaded(false); setIdx(i => i + 1) }}
        onLoad={() => setLoaded(true)}
        style={{
          width: fit === 'contain' ? `calc(100% - ${padding * 2}px)` : '100%',
          height: fit === 'contain' ? `calc(100% - ${padding * 2}px)` : '100%',
          borderRadius: fit === 'contain' ? Math.max(0, Number(cornerRadius) || 0) : cornerRadius,
          objectFit: fit,
          objectPosition: 'center',
          boxSizing: 'border-box',
          background: 'transparent',
          flexShrink: 0,
          display: 'block',
          position: 'absolute',
          inset: fit === 'contain' ? padding : 0,
          transform: normalizeVisualWeight ? `scale(${tickerLogoVisualScale(ticker)})` : undefined,
          transformOrigin: 'center',
        }}
      />)}
    </span>
  )
}
