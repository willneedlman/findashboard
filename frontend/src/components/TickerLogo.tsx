import { useEffect, useState } from 'react'
import { tickerLogoSources, tickerLogoVisualScale } from '../lib/tickerLogos'

function tickerColor(ticker: string): string {
  const code = ticker.charCodeAt(0)
  return `hsl(${(code * 37) % 360}, 35%, 22%)`
}

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
}

export default function TickerLogo({
  ticker,
  size = 28,
  logoUrl,
  crossOrigin,
  fit = 'cover',
  cornerRadius = '50%',
  padding = 0,
  logoBackground = 'var(--theme-surface, #1a2a3d)',
  normalizeVisualWeight = false,
}: TickerLogoProps) {
  // Try the resolved (name-based logo.dev / finnhub) URL first when present, then
  // the symbol-based CDNs (Parqet, FMP), then a monogram — so both paths together
  // maximize coverage: logo.dev catches freshly-filed names, Parqet/FMP catch
  // established tickers logo.dev misses (SPCX, CBRS).
  const sources = logoUrl ? [logoUrl, ...tickerLogoSources(ticker)] : tickerLogoSources(ticker)
  const [idx, setIdx] = useState(0)
  // Reset to the first provider when the symbol changes (component is reused) or
  // when a preferred logoUrl arrives after mount (async enrichment).
  const key = `${ticker}|${logoUrl ?? ''}`
  useEffect(() => setIdx(0), [key])

  return (
    <span
      aria-label={`${ticker} logo`}
      style={{
        width: size,
        height: size,
        borderRadius: cornerRadius,
        background: tickerColor(ticker),
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: size * 0.36, fontWeight: 700 }}>
        {ticker.slice(0, 2).toUpperCase()}
      </span>
      {idx < sources.length && (
      <img
        key={`${ticker}-${idx}`}
        src={sources[idx]}
        alt=""
        aria-hidden="true"
        crossOrigin={crossOrigin}
        width={size}
        height={size}
        onError={() => setIdx(i => i + 1)}
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
