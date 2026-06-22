import { useState } from 'react'
import { tickerLogoSources } from '../lib/tickerLogos'

function tickerColor(ticker: string): string {
  const code = ticker.charCodeAt(0)
  return `hsl(${(code * 37) % 360}, 35%, 22%)`
}

interface TickerLogoProps {
  ticker: string
  size?: number
}

export default function TickerLogo({ ticker, size = 28 }: TickerLogoProps) {
  const sources = tickerLogoSources(ticker)
  const [idx, setIdx] = useState(0)
  // Reset to the first provider when the symbol changes (component is reused).
  const [prevTicker, setPrevTicker] = useState(ticker)
  if (ticker !== prevTicker) {
    setPrevTicker(ticker)
    setIdx(0)
  }

  if (idx < sources.length) {
    return (
      <img
        key={`${ticker}-${idx}`}
        src={sources[idx]}
        alt={ticker}
        width={size}
        height={size}
        onError={() => setIdx(i => i + 1)}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'contain',
          background: 'var(--theme-surface, #1a2a3d)',
          flexShrink: 0,
          display: 'block',
        }}
      />
    )
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: tickerColor(ticker),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: size * 0.36, fontWeight: 700 }}>
        {ticker.slice(0, 2).toUpperCase()}
      </span>
    </div>
  )
}
