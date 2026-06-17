import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive, #22c55e)',
  neg:     'var(--theme-negative, #ef4444)',
}

interface SentimentSnap {
  composite_score: number
  label: string
  in_window_count: number
  bull_count: number
  bear_count: number
  neutral_count: number
}

function toneColor(label: string): string {
  const l = (label || '').toLowerCase()
  if (l.includes('bull')) return T.pos
  if (l.includes('bear')) return T.neg
  return T.gold
}

const TF_OPTIONS = [{ h: 1, l: '1H' }, { h: 4, l: '4H' }, { h: 24, l: '24H' }]

export default function SentimentWidget({ config }: { config: WidgetConfig }) {
  const [hours, setHours] = useState(config.timeframeHours ?? 4)

  const { data, isLoading, isError } = useQuery<SentimentSnap>({
    queryKey: ['sentiment-widget', hours],
    queryFn: () => axios.get(`/api/sentiment/snapshot?timeframe_hours=${hours}`).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })

  const total = data ? Math.max(data.bull_count + data.bear_count + data.neutral_count, 1) : 1
  const pct = (n: number) => `${(100 * n / total).toFixed(0)}%`
  const tone = data ? toneColor(data.label) : T.muted

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', gap: 2, padding: '3px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {TF_OPTIONS.map(({ h, l }) => (
          <button key={h} onClick={() => setHours(h)} style={{
            fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 7px',
            border: hours === h ? '1px solid color-mix(in srgb, var(--theme-primary) 55%, transparent)' : `1px solid ${T.border}`,
            background: hours === h ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent',
            color: hours === h ? T.gold : 'rgba(255,255,255,0.3)',
            cursor: 'pointer', letterSpacing: '0.06em',
          }}>{l}</button>
        ))}
      </div>

      {isLoading && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Scoring…</div>}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Sentiment unavailable</div>}

      {data && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12, padding: '10px 12px' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: T.mono, fontSize: 34, fontWeight: 700, color: tone, lineHeight: 1 }}>
              {data.composite_score > 0 ? '+' : ''}{data.composite_score.toFixed(0)}
            </div>
            <div style={{ fontFamily: T.label, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: tone, marginTop: 4 }}>{data.label}</div>
          </div>

          {/* Bull / neutral / bear proportion bar */}
          <div>
            <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', border: `1px solid ${T.border}` }}>
              <div style={{ width: pct(data.bull_count), background: T.pos }} />
              <div style={{ width: pct(data.neutral_count), background: 'var(--theme-hover, rgba(255,255,255,0.10))' }} />
              <div style={{ width: pct(data.bear_count), background: T.neg }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: T.mono, fontSize: 9 }}>
              <span style={{ color: T.pos }}>{data.bull_count} bull</span>
              <span style={{ color: T.muted }}>{data.neutral_count} neutral</span>
              <span style={{ color: T.neg }}>{data.bear_count} bear</span>
            </div>
          </div>

          <div style={{ textAlign: 'center', fontFamily: T.mono, fontSize: 8, color: T.muted, letterSpacing: '0.06em' }}>
            {data.in_window_count} headlines analyzed
          </div>
        </div>
      )}
    </div>
  )
}
