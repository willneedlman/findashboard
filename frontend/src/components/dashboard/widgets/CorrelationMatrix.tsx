import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: '#101c2e', border: '#2e394d', headerBg: '#0d1826',
  gold: '#c9a84c', text: '#d7e3fc', muted: '#5e768f', dim: '#3a4d62',
  mono: 'JetBrains Mono, monospace', label: 'IBM Plex Sans, sans-serif',
  pos: '#22C55E', neg: '#EF4444',
}

const PERIODS = [
  { label: '3M', days: 63 },
  { label: '6M', days: 126 },
  { label: '1Y', days: 252 },
  { label: '3Y', days: 756 },
]

interface MatrixCell { row: string; col: string; value: number }
interface MatrixResult { tickers: string[]; matrix: MatrixCell[] }

function cellBg(v: number): string {
  if (v >= 0.999) return 'rgba(201,168,76,0.85)'
  if (v > 0) return `rgba(31,86,115,${Math.min(v * 0.9, 0.85).toFixed(2)})`
  return `rgba(180,50,60,${Math.min(Math.abs(v) * 0.9, 0.85).toFixed(2)})`
}

function cellTextColor(v: number): string {
  if (v >= 0.999) return '#0a1628'
  return Math.abs(v) > 0.4 ? T.text : T.muted
}

export default function CorrelationMatrix({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers?.length ? config.tickers : ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD']
  const [periodIdx, setPeriodIdx] = useState(2)  // default 1Y

  const today = new Date().toISOString().split('T')[0]
  const startDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() - PERIODS[periodIdx].days)
    return d.toISOString().split('T')[0]
  })()

  const { data, isLoading, isError } = useQuery<MatrixResult>({
    queryKey: ['corr-widget', tickers.join(','), periodIdx],
    queryFn: () => axios.post('/api/correlation/matrix', { tickers, start: startDate, end: today }).then(r => r.data),
    staleTime: 300_000,
    enabled: tickers.length >= 2,
  })

  const base: React.CSSProperties = {
    background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: T.mono,
  }

  // Build a lookup map for fast cell access
  const lookup = new Map<string, number>()
  data?.matrix.forEach(c => lookup.set(`${c.row}|${c.col}`, c.value))

  const tks = data?.tickers ?? tickers

  const shimmer: React.CSSProperties = {
    background: 'linear-gradient(90deg,#101c2e 25%,#1a2d45 50%,#101c2e 75%)',
    backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
  }

  return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: T.headerBg, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold, letterSpacing: '0.08em' }}>CORRELATION</span>
        <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted }}>return correlation · {tks.length} tickers</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, paddingRight: 26 }}>
          {PERIODS.map((p, i) => (
            <button key={p.label} onClick={() => setPeriodIdx(i)} style={{
              fontFamily: T.mono, fontSize: 9, padding: '2px 6px', cursor: 'pointer', border: 'none',
              background: i === periodIdx ? 'rgba(201,168,76,0.2)' : 'transparent',
              color: i === periodIdx ? T.gold : T.muted,
              outline: i === periodIdx ? `1px solid rgba(201,168,76,0.4)` : '1px solid transparent',
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* Matrix body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '6px 8px', gap: 6 }}>
        {tickers.length < 2 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11 }}>Add at least 2 tickers in settings.</span>
          </div>
        ) : isError ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: T.neg, fontFamily: T.label, fontSize: 11 }}>Data unavailable.</span>
          </div>
        ) : isLoading ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {tickers.map((_, ri) => (
              <div key={ri} style={{ display: 'flex', gap: 3, flex: 1 }}>
                <div style={{ ...shimmer, width: 40, borderRadius: 2 }} />
                {tickers.map((__, ci) => <div key={ci} style={{ ...shimmer, flex: 1 }} />)}
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Heatmap — outlined, fills available height */}
            <div style={{
              flex: 1, minHeight: 0,
              border: '1px solid rgba(215,227,252,0.18)',
              borderRadius: 2, padding: 6,
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {/* Column headers */}
              <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                <div style={{ width: 40, flexShrink: 0 }} />
                {tks.map(tk => (
                  <div key={tk} style={{ flex: 1, textAlign: 'center', fontFamily: T.label, fontSize: 8, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tk.replace('-USD', '')}
                  </div>
                ))}
              </div>

              {/* Rows — each takes equal share of remaining height */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {tks.map(row => (
                  <div key={row} style={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
                    {/* Row label */}
                    <div style={{ width: 40, flexShrink: 0, fontFamily: T.label, fontSize: 8, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {row.replace('-USD', '')}
                    </div>
                    {/* Cells */}
                    {tks.map(col => {
                      const v = lookup.get(`${row}|${col}`) ?? 0
                      const isDiag = row === col
                      return (
                        <div
                          key={col}
                          title={`${row} / ${col}: ${v.toFixed(3)}`}
                          style={{
                            flex: 1, minWidth: 0, minHeight: 0,
                            background: cellBg(v),
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            borderRadius: 2, cursor: 'default', overflow: 'hidden',
                          }}
                        >
                          <span style={{ fontFamily: T.mono, fontSize: isDiag ? 8 : 9, color: cellTextColor(v), fontWeight: isDiag ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {isDiag ? row.replace('-USD', '').slice(0, 4) : v.toFixed(2)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Legend — outlined */}
            <div style={{
              flexShrink: 0,
              border: '1px solid rgba(215,227,252,0.18)',
              borderRadius: 2, padding: '5px 8px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ display: 'flex', gap: 1, flex: 1, height: 7, borderRadius: 1, overflow: 'hidden' }}>
                {Array.from({ length: 21 }, (_, i) => {
                  const v = -1 + i / 10
                  return <div key={i} style={{ flex: 1, background: cellBg(v) }} />
                })}
              </div>
              <span style={{ fontFamily: T.label, fontSize: 8, color: T.dim, whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
                −1 &nbsp;·&nbsp; 0 &nbsp;·&nbsp; +1
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
