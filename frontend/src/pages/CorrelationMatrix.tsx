import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { fetchCorrelation } from '../hooks/useApi'
import EmptyState from '../components/EmptyState'
import TickerTagInput from '../components/TickerTagInput'
import PortfolioIO from '../components/PortfolioIO'
import { useTheme } from '../contexts/ThemeContext'

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid rgba(255,255,255,0.10)', color: '#d7e3fc',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}

export default function CorrelationMatrix() {
  const [tickers, setTickers] = useState(['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'])
  const [start, setStart]         = useState('2020-01-01')
  const [end, setEnd]             = useState('2024-12-31')
  const { theme } = useTheme()

  const [pr, pg, pb] = hexToRgb(theme.primaryColor)
  const [tr, tg, tb] = hexToRgb(theme.tertiaryColor)
  const NEG = '#8c2e36'
  const [nr, ng, nb] = hexToRgb(NEG)

  const cellBg = (v: number): string => {
    if (v >= 0.999) return `rgba(${pr},${pg},${pb},0.9)`
    if (v > 0)      return `rgba(${tr},${tg},${tb},${Math.min(v, 1).toFixed(2)})`
    return `rgba(${nr},${ng},${nb},${Math.min(Math.abs(v), 1).toFixed(2)})`
  }
  const cellText = (v: number): string => {
    if (v >= 0.999) return '#000'
    return Math.abs(v) > 0.35 ? '#ffffff' : 'rgba(255,255,255,0.35)'
  }

  const { mutate, data, isPending } = useMutation({
    mutationFn: () => fetchCorrelation({
      tickers,
      start, end,
    }),
  })

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={190} sidebarTitle="Correlation Controls" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'var(--theme-surface, #142032)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Matrix Controls</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
            <div>
              <label style={LABEL}>Tickers</label>
              <TickerTagInput tickers={tickers} onChange={setTickers} />
            </div>
            <div>
              <label style={LABEL}>Start Date</label>
              <input type="date" value={start} onChange={e => setStart(e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
              />
            </div>
            <div>
              <label style={LABEL}>End Date</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
              />
            </div>
          </div>
          <div style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PortfolioIO
              mode="tickers"
              tickers={tickers}
              onImportTickers={setTickers}
              name="correlation"
            />
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Computing…' : '⬢ Compute Matrix'}
            </button>
          </div>
        </>}>

        {/* Right: heatmap */}
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'var(--theme-surface, #142032)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
              Asset Correlation Heatmap (Pearson — Daily Returns)
            </span>
            {data && (
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', letterSpacing: '0.08em' }}>
                {data.tickers.length} assets · {start} → {end}
              </span>
            )}
          </div>

          {!data && !isPending && (
            <EmptyState title="Correlation Matrix" hint="Enter two or more tickers and press Compute Matrix." />
          )}

          {data && (
            <div style={{ padding: 20, overflowX: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {/* Heatmap — paddingRight = label width so centering is balanced */}
              <div style={{ display: 'inline-block', paddingRight: 80 }}>
                {/* Column headers */}
                <div style={{ display: 'flex', marginLeft: 80 }}>
                  {data.tickers.map((t: string) => (
                    <div key={t} style={{ width: 68, textAlign: 'center', paddingBottom: 8,
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase' }}>
                      {t}
                    </div>
                  ))}
                </div>

                {/* Rows — cells wrapped in a bordered container for contrast */}
                <div style={{ display: 'flex' }}>
                  {/* Row labels */}
                  <div style={{ width: 80, flexShrink: 0 }}>
                    {data.tickers.map((row: string) => (
                      <div key={row} style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 12,
                        fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase' }}>
                        {row}
                      </div>
                    ))}
                  </div>
                  {/* Cell grid with white border */}
                  <div style={{ border: '1px solid rgba(255,255,255,0.18)', display: 'inline-block' }}>
                    {data.tickers.map((row: string) => (
                      <div key={row} style={{ display: 'flex' }}>
                        {data.tickers.map((col: string) => {
                          const cell = data.matrix.find((m: any) => m.row === row && m.col === col)
                          const v = cell?.value ?? 0
                          return (
                            <div key={col} style={{
                              width: 68, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: cellBg(v), color: cellText(v),
                              fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: v >= 0.999 ? 700 : 500,
                              border: '1px solid rgba(0,0,0,0.25)',
                            }}
                              title={`${row} / ${col}: ${v.toFixed(4)}`}
                            >
                              {v.toFixed(2)}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Legend */}
              <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: 320 }}>
                  {['-1.0', '-0.5', '0.0', '+0.5', '+1.0'].map(l => (
                    <span key={l} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--theme-secondary, #99907e)' }}>{l}</span>
                  ))}
                </div>
                <div style={{
                  width: 320, height: 10, border: '1px solid rgba(255,255,255,0.08)',
                  background: `linear-gradient(to right, rgba(${nr},${ng},${nb},1), rgba(${nr},${ng},${nb},0.05) 48%, rgba(11,20,32,1) 50%, rgba(${tr},${tg},${tb},0.05) 52%, rgba(${tr},${tg},${tb},1))`,
                }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', width: 320 }}>
                  <span style={{ fontSize: 10, color: NEG, fontWeight: 700, letterSpacing: '0.1em' }}>NEGATIVE</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', letterSpacing: '0.1em' }}>NEUTRAL</span>
                  <span style={{ fontSize: 10, color: theme.tertiaryColor, fontWeight: 700, letterSpacing: '0.1em' }}>POSITIVE</span>
                </div>
              </div>
            </div>
          )}
      </SidebarLayout>
    </PageWrapper>
  )
}
