import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../../lib/theme'
import type { WidgetConfig } from '../../../hooks/useDashboard'

interface Item {
  asset_directions?: Record<string, number>
}
interface Source { items: Item[] }
interface BreakingItem { text: string; direction: number; seen_in_sources: number }
interface SentimentSnap {
  composite_score: number
  forward_composite: number
  backward_composite: number
  label: string
  in_window_count: number
  bull_count: number
  bear_count: number
  neutral_count: number
  momentum?: { delta: number; label: string }
  baseline_delta?: number
  sources: Source[]
  breaking: BreakingItem[]
}

const TF_OPTIONS = [{ h: 1, l: '1H' }, { h: 4, l: '4H' }, { h: 24, l: '24H' }]

function tone(value: number): string {
  return value > 52 ? T.pos : value < 48 ? T.neg : T.gold
}

function assetDirections(data?: SentimentSnap): [string, number][] {
  const values = new Map<string, number[]>()
  for (const source of data?.sources ?? []) {
    for (const item of source.items) {
      for (const [asset, direction] of Object.entries(item.asset_directions ?? {})) {
        values.set(asset, [...(values.get(asset) ?? []), direction])
      }
    }
  }
  return [...values.entries()]
    .map(([asset, rows]) => [asset, rows.reduce((sum, value) => sum + value, 0) / rows.length] as [string, number])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
}

export default function SentimentWidget({ config }: { config: WidgetConfig }) {
  const [hours, setHours] = useState(config.timeframeHours ?? 4)
  const { data, isLoading, isError } = useQuery<SentimentSnap>({
    queryKey: ['sentiment-widget', hours],
    queryFn: () => axios.get(`/api/sentiment/snapshot?timeframe_hours=${hours}`).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })
  const total = data ? Math.max(data.bull_count + data.bear_count + data.neutral_count, 1) : 1
  const pct = (value: number) => `${100 * value / total}%`
  const assets = assetDirections(data)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', gap: 2, padding: '3px 8px', borderBottom: `1px solid ${T.border}` }}>
        {TF_OPTIONS.map(option => (
          <button key={option.h} onClick={() => setHours(option.h)} style={{
            border: `1px solid ${hours === option.h ? T.gold : T.border}`, background: 'transparent',
            color: hours === option.h ? T.gold : T.muted, fontFamily: T.mono, fontSize: 8,
            padding: '1px 7px', cursor: 'pointer',
          }}>
            {option.l}
          </button>
        ))}
      </div>
      {isLoading && <div style={{ padding: 12, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>Scoring headlines...</div>}
      {isError && <div style={{ padding: 12, color: T.neg, fontFamily: T.mono, fontSize: 10 }}>Sentiment unavailable</div>}
      {data && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
            {[
              ['COMPOSITE', data.composite_score],
              ['FORWARD', data.forward_composite],
              ['BACKWARD', data.backward_composite],
            ].map(([label, raw]) => {
              const value = Number(raw)
              return (
                <div key={String(label)} style={{ padding: 6, border: `1px solid ${T.border}`, background: T.surface }}>
                  <div style={{ color: T.muted, fontFamily: T.label, fontSize: 7 }}>{label}</div>
                  <div style={{ color: tone(value), fontFamily: T.mono, fontSize: 15, fontWeight: 700 }}>{value.toFixed(0)}</div>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6, color: T.muted, fontFamily: T.mono, fontSize: 8 }}>
            <span style={{ color: data.momentum && data.momentum.delta >= 0 ? T.pos : T.neg }}>MOM {data.momentum ? `${data.momentum.delta >= 0 ? '+' : ''}${data.momentum.delta.toFixed(1)}` : '-'}</span>
            <span>BASE {data.baseline_delta == null ? '-' : `${data.baseline_delta >= 0 ? '+' : ''}${data.baseline_delta.toFixed(1)}`}</span>
            <span>{data.in_window_count} HEADLINES</span>
          </div>
          <div style={{ display: 'flex', height: 6, marginTop: 7, overflow: 'hidden', border: `1px solid ${T.border}` }}>
            <div style={{ width: pct(data.bull_count), background: T.pos }} />
            <div style={{ width: pct(data.neutral_count), background: T.muted }} />
            <div style={{ width: pct(data.bear_count), background: T.neg }} />
          </div>
          {assets.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: T.muted, fontFamily: T.label, fontSize: 7, letterSpacing: '0.1em' }}>ASSET DIRECTION</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {assets.map(([asset, direction]) => (
                  <span key={asset} style={{
                    border: `1px solid ${direction >= 0 ? T.pos : T.neg}`, color: direction >= 0 ? T.pos : T.neg,
                    padding: '1px 4px', fontFamily: T.mono, fontSize: 8,
                  }}>
                    {asset.toUpperCase()} {direction >= 0 ? 'BULL' : 'BEAR'}
                  </span>
                ))}
              </div>
            </div>
          )}
          {data.breaking?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: T.muted, fontFamily: T.label, fontSize: 7, letterSpacing: '0.1em' }}>BREAKING</div>
              {data.breaking.slice(0, 2).map(item => (
                <div key={item.text} style={{ marginTop: 4, color: T.text, fontFamily: T.label, fontSize: 9, lineHeight: 1.3 }}>
                  <span style={{ color: item.direction >= 0 ? T.pos : T.neg }}>{item.direction >= 0 ? 'BULL' : 'BEAR'}</span>
                  {' '}{item.text} <span style={{ color: T.muted }}>({item.seen_in_sources} sources)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
