import { useMemo } from 'react'
import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:    'var(--theme-bg, #101c2e)',
  muted: 'var(--theme-secondary, #8a9ab0)',
  pos:   '#22C55E',
  neg:   '#EF4444',
  mono:  'var(--theme-mono)',
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD']

interface Quote { current_price: number | null; pct_change_1d: number | null }

// Strip Yahoo decorations for a clean tape label: ^VIX -> VIX, BTC-USD -> BTC.
function tapeLabel(sym: string): string {
  return sym.replace(/^\^/, '').replace(/-USD$/, '')
}

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function IndexTapeWidget({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers?.length ? config.tickers : DEFAULT_TICKERS

  const results = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['index-tape-quote', t],
      queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(t)}`).then(r => r.data as Quote),
      staleTime: 60_000,
      refetchInterval: 60_000,
    })),
  })

  const segments = tickers.map((t, i) => {
    const q = results[i]?.data
    const price = q?.current_price ?? null
    const pct = q?.pct_change_1d ?? null
    return { sym: tapeLabel(t), price, pct }
  })

  // Seamless marquee needs the run duplicated; the track translates -50% over a
  // full cycle so the second copy lands exactly where the first began.
  const animate = !prefersReducedMotion && segments.length > 0
  const durationSec = Math.max(20, segments.length * 4)

  const Segment = ({ s, k }: { s: typeof segments[number]; k: string }) => {
    const color = s.pct == null ? T.muted : s.pct >= 0 ? T.pos : T.neg
    return (
      <span key={k} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexShrink: 0 }}>
        <span style={{ color: T.muted, letterSpacing: '0.04em' }}>{s.sym}</span>
        <span style={{ color }}>
          {s.price != null ? s.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
          {s.pct != null && ` ${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%`}
        </span>
      </span>
    )
  }

  const Run = ({ keyPrefix }: { keyPrefix: string }) => (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 26, paddingRight: 26, flexShrink: 0 }}>
      {segments.map((s, i) => <Segment key={`${keyPrefix}-${i}`} s={s} k={`${keyPrefix}-${i}`} />)}
    </div>
  )

  return (
    <div
      style={{
        background: T.bg, width: '100%', height: '100%', display: 'flex', alignItems: 'center',
        overflow: 'hidden', fontFamily: T.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', padding: '0 14px',
      }}
    >
      <style>{`@keyframes tape-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
      {animate ? (
        <div
          className="index-tape-track"
          onMouseEnter={e => (e.currentTarget.style.animationPlayState = 'paused')}
          onMouseLeave={e => (e.currentTarget.style.animationPlayState = 'running')}
          style={{ display: 'inline-flex', willChange: 'transform', animation: `tape-scroll ${durationSec}s linear infinite` }}
        >
          <Run keyPrefix="a" />
          <Run keyPrefix="b" />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 26, overflowX: 'auto' }}>
          {segments.map((s, i) => <Segment key={i} s={s} k={`s-${i}`} />)}
        </div>
      )}
    </div>
  )
}
