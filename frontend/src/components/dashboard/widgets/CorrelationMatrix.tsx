import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useTheme } from '../../../contexts/ThemeContext'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)', dim: '#3a4d62',
  mono: 'var(--theme-mono)',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const PERIOD_OPTIONS = [63, 126, 252, 756]

interface MatrixCell { row: string; col: string; value: number }
interface MatrixResult { tickers: string[]; matrix: MatrixCell[] }

export default function CorrelationMatrix({ config }: { config: WidgetConfig }) {
  const { theme } = useTheme()
  const tickers = config.tickers?.length ? config.tickers : ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD']
  const periodDays = config.periodDays ?? 252
  const periodIdx = [63, 126, 252, 756].indexOf(periodDays)

  // Theme-aware cell coloring
  const [pr, pg, pb] = hexToRgb(theme.primaryColor)    // diagonal
  const [tr, tg, tb] = hexToRgb(theme.tertiaryColor)   // positive correlation
  const NEG: [number,number,number] = [140, 46, 54]     // semantic red — fixed

  const cellBg = (v: number): string => {
    if (v >= 0.999) return `rgba(${pr},${pg},${pb},0.85)`
    if (v > 0) return `rgba(${tr},${tg},${tb},${Math.min(v * 0.9, 0.85).toFixed(2)})`
    return `rgba(${NEG[0]},${NEG[1]},${NEG[2]},${Math.min(Math.abs(v) * 0.9, 0.85).toFixed(2)})`
  }

  const cellTextColor = (v: number): string => {
    if (v >= 0.999) return 'var(--theme-bg, #0a1628)'
    return Math.abs(v) > 0.4 ? T.text : T.muted
  }

  const today = new Date().toISOString().split('T')[0]
  const startDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() - periodDays)
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
    background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
    backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
  }

  return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '6px 8px', gap: 6 }}>
        {tickers.length < 2 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 11 }}>Add at least 2 tickers in settings.</span>
          </div>
        ) : isError ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: T.neg, fontFamily: T.mono, fontSize: 11 }}>Data unavailable.</span>
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
              border: '1px solid var(--theme-border, rgba(215,227,252,0.18))',
              borderRadius: 2, padding: 6,
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {/* Column headers */}
              <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                <div style={{ width: 40, flexShrink: 0 }} />
                {tks.map(tk => (
                  <div key={tk} style={{ flex: 1, textAlign: 'center', fontFamily: T.mono, fontSize: 8, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tk.replace('-USD', '')}
                  </div>
                ))}
              </div>

              {/* Rows — each takes equal share of remaining height */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {tks.map(row => (
                  <div key={row} style={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
                    {/* Row label */}
                    <div style={{ width: 40, flexShrink: 0, fontFamily: T.mono, fontSize: 8, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
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
              border: '1px solid var(--theme-border, rgba(215,227,252,0.18))',
              borderRadius: 2, padding: '5px 8px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ display: 'flex', gap: 1, flex: 1, height: 7, borderRadius: 1, overflow: 'hidden' }}>
                {Array.from({ length: 21 }, (_, i) => {
                  const v = -1 + i / 10
                  return <div key={i} style={{ flex: 1, background: cellBg(v) }} />
                })}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 8, color: T.dim, whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
                −1 &nbsp;·&nbsp; 0 &nbsp;·&nbsp; +1
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
