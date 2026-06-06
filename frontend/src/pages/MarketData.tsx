import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import PageHeader from '../components/PageHeader'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import TVChart from '../components/charts/TVChart'
import { fetchMarketHistory } from '../hooks/useApi'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import EmptyState from '../components/EmptyState'
import useIsMobile from '../hooks/useIsMobile'

// Stitch "Aurelian Terminal" metric card — label-caps header, large tabular value
function TerminalMetric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      background: 'var(--theme-surface, #142032)', border: '1px solid rgba(255,255,255,0.07)',
      borderTop: '3px solid var(--theme-primary, #c9a84c)', padding: 12,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 24, fontWeight: 700, color: color ?? '#d7e3fc' }}>
        {value}
      </div>
    </div>
  )
}

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div className="ft-chart-panel" style={{ marginBottom: 12 }}>
      <div className="ft-chart-label">{label}</div>
      <div style={{ padding: '8px 8px 8px', height }}>
        {children}
      </div>
    </div>
  )
}

const TICK_STYLE = { fontSize: 10, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'JetBrains Mono, monospace' }

export default function MarketData() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const [ticker, setTickerState] = useState(searchParams.get('ticker') || 'SPY')
  const [start, setStartState]   = useState(searchParams.get('start')  || '2020-01-01')
  const [end, setEndState]       = useState(searchParams.get('end')    || '2024-12-31')

  const setTicker = (v: string) => { setTickerState(v); setSearchParams(p => { p.set('ticker', v); return p }) }
  const setStart  = (v: string) => { setStartState(v);  setSearchParams(p => { p.set('start', v);  return p }) }
  const setEnd    = (v: string) => { setEndState(v);    setSearchParams(p => { p.set('end', v);    return p }) }

  const { mutate, data, isPending, error } = useMutation({
    mutationFn: () => fetchMarketHistory(ticker, start, end),
  })

  const m = data?.metrics
  const returnColor = m ? (m.total_return >= 0 ? '#22C55E' : '#EF4444') : '#d7e3fc'

  const inputStyle = {
    background: 'var(--theme-surface, #142032)', border: '1px solid rgba(255,255,255,0.10)', color: '#d7e3fc',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px',
    width: '100%', outline: 'none',
  }

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={180} sidebarTitle="Market Controls" sidebar={<>
          <div>
            <span className="ft-sidebar-label">Ticker</span>
            <input
              value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
              style={{ ...inputStyle, textTransform: 'uppercase', fontSize: 14, fontWeight: 700 }}
              onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
            />
          </div>

          <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />

          <div>
            <span className="ft-sidebar-label">Start Date</span>
            <input type="date" value={start} onChange={e => setStart(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
            />
          </div>

          <div>
            <span className="ft-sidebar-label">End Date</span>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
            />
          </div>

          <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />

          <button
            onClick={() => mutate()} disabled={isPending}
            style={{
              background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '7px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1, width: '100%',
            }}
          >
            {isPending ? 'Loading…' : '↓ Load Data'}
          </button>

          {error && <div style={{ color: '#EF4444', fontSize: 10, lineHeight: '14px' }}>Error — check ticker and date range.</div>}
        </>}>

        {/* Right: metrics + charts */}
          {data && (
            <>
              {/* Summary stats — single panel with dividers */}
              <div className="ft-panel" style={{ marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)' }}>
                  {[
                    { label: 'Total Return',    value: `${m!.total_return > 0 ? '+' : ''}${m!.total_return}%`, color: returnColor },
                    { label: 'Max Drawdown',    value: `${m!.max_drawdown}%`,  color: '#EF4444' },
                    { label: 'Ann. Volatility', value: `${m!.ann_volatility}%` },
                    { label: 'Current Price',   value: `$${m!.current_price.toLocaleString()}`, color: 'var(--theme-primary, #c9a84c)' },
                  ].map((stat, i) => (
                    <div key={stat.label} style={{ padding: '12px 14px', borderRight: isMobile ? (i % 2 === 0 ? '1px solid rgba(255,255,255,0.06)' : 'none') : (i < 3 ? '1px solid rgba(255,255,255,0.06)' : 'none'), borderBottom: isMobile && i < 2 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
                      <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', marginBottom: 6 }}>{stat.label}</div>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: isMobile ? 16 : 20, fontWeight: 700, color: stat.color ?? '#d7e3fc', lineHeight: 1.1 }}>{stat.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              <ChartPanel label="Price (EOD Close)" height={268}>
                <TVChart data={data.price} color="#1f5673" height={240} fillArea />
              </ChartPanel>

              <ChartPanel label="30D Rolling Volatility (Annualised)" height={188}>
                <TVChart data={data.volatility} color="#d97736" height={160} formatValue={v => `${(v * 100).toFixed(1)}%`} />
              </ChartPanel>

              <ChartPanel label="Peak Drawdown" height={168}>
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={data.drawdown.map((d: any) => ({ ...d, value: +(d.value * 100).toFixed(2) }))}>
                    <defs>
                      <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8c2e36" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#8c2e36" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={TICK_STYLE} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={TICK_STYLE} tickFormatter={v => `${v}%`} orientation="right" />
                    <Tooltip formatter={(v: number) => [`${v}%`, 'Drawdown']} contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                    <Area type="monotone" dataKey="value" stroke="#8c2e36" fill="url(#ddGrad)" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}

          {!data && !isPending && (
            <EmptyState title="Market Data" hint="Enter a ticker and date range, then press Load Data." />
          )}

      </SidebarLayout>
    </PageWrapper>
  )
}
