import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { fetchOptionsChain } from '../hooks/useApi'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
const INPUT: React.CSSProperties = { background: '#0a1628', border: '1px solid #4d4637', color: '#d7e3fc', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none' }
const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 4, display: 'block' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#99907e', padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #2e394d', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '5px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: '#d7e3fc', textAlign: 'right', verticalAlign: 'middle' }
const TOOLTIP_STYLE = { background: '#142032', border: '1px solid #4d4637', borderRadius: 0 }
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: '#142032', border: '1px solid rgba(255,255,255,0.07)', borderTop: '3px solid #c9a84c', padding: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 20, fontWeight: 700, color: '#d7e3fc' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#4d4637', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function OptionsChainScanner() {
  const [ticker, setTicker] = useState('SPY')
  const [topN, setTopN]     = useState(12)
  const [view, setView]     = useState<'calls' | 'puts' | 'chart'>('calls')

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const [chainResp, histResp] = await Promise.all([
        fetchOptionsChain(ticker),
        axios.get(`/api/market/history?ticker=${ticker}&start=2024-01-01`).catch(() => ({ data: null })),
      ])
      return { ...chainResp, spot: histResp.data?.metrics?.current_price ?? null }
    },
  })

  const spot: number | null = data?.spot ?? null

  const filterNearATM = (rows: any[]) => {
    if (!spot || !rows) return rows ?? []
    return [...rows].map(r => ({ ...r, dist: Math.abs(r.strike - spot) }))
      .sort((a, b) => a.dist - b.dist).slice(0, topN * 2).sort((a, b) => a.strike - b.strike)
  }

  const calls = filterNearATM(data?.calls)
  const puts  = filterNearATM(data?.puts)
  const chain = view === 'calls' ? calls : puts

  const totalCallOI = data?.calls?.reduce((s: number, r: any) => s + (r.openInterest || 0), 0) ?? 0
  const totalPutOI  = data?.puts?.reduce((s: number, r: any) => s + (r.openInterest || 0), 0) ?? 0
  const pcRatio     = totalCallOI > 0 ? totalPutOI / totalCallOI : 0
  const avgCallIV   = data?.calls?.length ? data.calls.reduce((s: number, r: any) => s + r.impliedVolatility, 0) / data.calls.length : 0
  const avgPutIV    = data?.puts?.length  ? data.puts.reduce((s: number, r: any) => s + r.impliedVolatility, 0) / data.puts.length  : 0
  const ivSkew      = (avgPutIV - avgCallIV) * 100

  const chartData = calls.map((c: any) => {
    const put = puts.find((p: any) => p.strike === c.strike) || {}
    return { strike: c.strike, callOI: c.openInterest || 0, putOI: -((put as any).openInterest || 0) }
  })

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={190} sidebarTitle="Chain Controls" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Chain Parameters</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            <div>
              <label style={LABEL}>Target Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            <div>
              <label style={LABEL}>Strikes Per Side</label>
              <input type="number" value={topN} step={2} min={4} max={30} onChange={e => setTopN(+e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            {data?.expiry && (
              <div style={{ fontSize: 10, color: '#4d4637', lineHeight: '14px' }}>
                Expiry: <span style={{ color: '#c9a84c' }}>{data.expiry}</span>
                {spot && <><br />Spot: <span style={{ color: '#c9a84c' }}>${spot.toFixed(2)}</span></>}
              </div>
            )}
          </div>
          <div style={{ padding: 10, borderTop: '1px solid #2e394d' }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: '#1f2a3d', border: '1px solid #c9a84c', color: '#c9a84c',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Loading…' : '⬢ Load Chain'}
            </button>
          </div>
        </>}>

          {data && (
            <>
              {/* Metric cards */}
              <div className="metric-grid">
                <SummaryCard label="Put/Call OI Ratio" value={pcRatio.toFixed(2)} sub={pcRatio < 1 ? 'Bullish sentiment' : 'Bearish sentiment'} />
                <SummaryCard label="Total Call OI" value={totalCallOI.toLocaleString()} />
                <SummaryCard label="Total Put OI"  value={totalPutOI.toLocaleString()} />
                <SummaryCard label="IV Skew (Put − Call)" value={`${ivSkew > 0 ? '+' : ''}${ivSkew.toFixed(1)}%`} sub="Positive = fear premium" />
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid #2e394d' }}>
                {(['calls', 'puts', 'chart'] as const).map(t => (
                  <button key={t} onClick={() => setView(t)} style={{
                    padding: '7px 16px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                    textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
                    color: view === t ? '#c9a84c' : '#4d4637',
                    borderBottom: view === t ? '2px solid #c9a84c' : '2px solid transparent',
                    marginBottom: -1,
                  }}>
                    {t === 'chart' ? 'OI Chart' : t}
                  </button>
                ))}
              </div>

              {/* OI Chart */}
              {view === 'chart' && (
                <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, background: 'rgba(46,57,77,0.8)', padding: '3px 8px', borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc', zIndex: 10 }}>
                    Open Interest by Strike — Calls vs Puts
                  </div>
                  <div style={{ paddingTop: 30, padding: '30px 8px 8px' }}>
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="strike" tick={TICK} />
                        <YAxis tick={TICK} tickFormatter={v => Math.abs(v).toLocaleString()} />
                        <Tooltip formatter={(v: number) => [Math.abs(v).toLocaleString(), '']} contentStyle={TOOLTIP_STYLE} />
                        <Bar dataKey="callOI" name="Call OI" fill="#2f6b4b" />
                        <Bar dataKey="putOI"  name="Put OI"  fill="#8c2e36" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Chain table */}
              {view !== 'chart' && (
                <div style={{ background: '#101c2e', border: '1px solid #2e394d' }}>
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid #2e394d', background: '#142032', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
                      {view === 'calls' ? 'Call' : 'Put'} Chain — {ticker}
                    </span>
                    {spot && <span style={{ fontSize: 10, color: '#c9a84c', fontFamily: 'JetBrains Mono, monospace' }}>Spot ${spot.toFixed(2)}</span>}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#0a1628' }}>
                          <th style={{ ...TH, textAlign: 'left' }}>Strike</th>
                          {['Last', 'Bid', 'Ask', 'Volume', 'Open Int.', 'Impl. Vol'].map(h => (
                            <th key={h} style={TH}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {chain.map((row: any, i: number) => {
                          const isATM = spot && Math.abs(row.strike - spot) < spot * 0.005
                          return (
                            <tr key={i} style={{ background: isATM ? 'rgba(201,168,76,0.07)' : 'transparent' }}
                              onMouseEnter={e => { if (!isATM) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)' }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isATM ? 'rgba(201,168,76,0.07)' : 'transparent' }}>
                              <td style={{ ...TD, textAlign: 'left', fontWeight: 700, color: isATM ? '#c9a84c' : '#d7e3fc' }}>
                                {row.strike}
                                {isATM && <span style={{ fontSize: 9, color: '#c9a84c', marginLeft: 5, letterSpacing: '0.1em' }}>ATM</span>}
                              </td>
                              <td style={TD}>{row.lastPrice?.toFixed(2) ?? '—'}</td>
                              <td style={{ ...TD, color: '#99907e' }}>{row.bid?.toFixed(2) ?? '—'}</td>
                              <td style={{ ...TD, color: '#99907e' }}>{row.ask?.toFixed(2) ?? '—'}</td>
                              <td style={TD}>{row.volume?.toLocaleString() ?? '—'}</td>
                              <td style={TD}>{row.openInterest?.toLocaleString() ?? '—'}</td>
                              <td style={{ ...TD, color: row.impliedVolatility > 0.5 ? '#d97736' : '#d7e3fc' }}>
                                {(row.impliedVolatility * 100)?.toFixed(1)}%
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {!data && !isPending && (
            <EmptyState title="Options Chain Scanner" hint="Enter a ticker and expiry, then press Load Chain." />
          )}
        </SidebarLayout>
    </PageWrapper>
  )
}
