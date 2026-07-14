import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import SidebarLayout from '../components/SidebarLayout'
import { fetchOptionsChain } from '../hooks/useApi'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '5px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', fontSize: 11, fontFamily: 'var(--theme-mono)', color: 'var(--theme-text, #d7e3fc)', textAlign: 'right', verticalAlign: 'middle' }

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

const SELECT: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none' }

export function OptionsChainScannerContent() {
  const cc = useChartColors()
  const [sp] = useSearchParams()
  const [ticker, setTicker] = useState((sp.get('ticker') ?? '').toUpperCase())
  const [topN, setTopN]     = useState(12)
  const [paramsOpen, setParamsOpen] = useState(true)
  const [view, setView]     = useState<'calls' | 'puts' | 'chart'>('calls')
  const [expiry, setExpiry] = useState<string>('')

  const { mutate, data, isPending } = useMutation<any, Error, string | void>({
    // sym override: URL-driven scans pass the fresh symbol explicitly because
    // setTicker hasn't committed yet when the effect fires.
    mutationFn: async (sym) => {
      const tk = sym || ticker
      const [chainResp, histResp] = await Promise.all([
        fetchOptionsChain(tk, expiry || undefined),
        axios.get(`/api/market/history?ticker=${tk}&start=2024-01-01`).catch(() => ({ data: null })),
      ])
      return { ...chainResp, spot: histResp.data?.metrics?.current_price ?? null }
    },
  })

  // Auto-scan on ?ticker= arrival AND on same-route ticker changes (palette,
  // drawer, linked mode) — those change only the search string, no remount.
  useEffect(() => {
    const t = (sp.get('ticker') || '').trim().toUpperCase()
    if (t) { setTicker(t); mutate(t) }
  }, [sp])  // eslint-disable-line react-hooks/exhaustive-deps

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
    <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="Chain Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={LABEL}>Target Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
            </div>
            <div>
              <label style={LABEL}>Strikes Per Side</label>
              <input type="number" value={topN} step={2} min={4} max={30} onChange={e => setTopN(+e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
            </div>
            <div>
              <label style={LABEL}>Expiry</label>
              {data?.expirations?.length ? (
                <select value={expiry || data.expiry} onChange={e => { setExpiry(e.target.value); setTimeout(() => mutate(), 0) }} style={SELECT}>
                  {(data.expirations as string[]).map((e: string) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>Load chain to see expirations</div>
              )}
              {spot && <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginTop: 4 }}>Spot: <span style={{ color: 'var(--theme-primary, #c9a84c)' }}>${spot.toFixed(2)}</span></div>}
            </div>
          </div>
          </RailSection>
          <div style={{ padding: 12 }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Loading…' : 'Load Chain'}
            </button>
          </div>
        </>}>

          {data && (
            <>
              {/* Answer-first sentiment strip */}
              <div style={STRIP}>
                <KpiCell grow minWidth={170} label={pcRatio < 1 ? 'P/C OI Ratio · Bullish' : 'P/C OI Ratio · Bearish'} value={pcRatio.toFixed(2)} color={pcRatio < 1 ? 'var(--theme-positive)' : 'var(--theme-negative)'} valueSize={16} />
                <KpiCell grow label="Total Call OI" value={totalCallOI.toLocaleString()} color="var(--theme-positive)" />
                <KpiCell grow label="Total Put OI" value={totalPutOI.toLocaleString()} color="var(--theme-negative)" />
                <KpiCell grow label="IV Skew (P−C)" value={`${ivSkew > 0 ? '+' : ''}${ivSkew.toFixed(1)}%`} color={ivSkew > 0 ? 'var(--theme-negative)' : 'var(--theme-positive)'} />
                <KpiCell grow label="Avg Call IV" value={`${(avgCallIV * 100).toFixed(1)}%`} />
                <KpiCell grow label="Avg Put IV" value={`${(avgPutIV * 100).toFixed(1)}%`} />
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                {(['calls', 'puts', 'chart'] as const).map(t => (
                  <button key={t} onClick={() => setView(t)} style={{
                    padding: '7px 16px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                    textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
                    color: view === t ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.18))',
                    borderBottom: view === t ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent',
                    marginBottom: -1,
                  }}>
                    {t === 'chart' ? 'OI Chart' : t}
                  </button>
                ))}
              </div>

              {/* OI Chart */}
              {view === 'chart' && (
                <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)', zIndex: 10 }}>
                    Open Interest by Strike — Calls vs Puts
                  </div>
                  <div style={{ paddingTop: 30, padding: '30px 8px 8px' }}>
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="strike" tick={TICK} />
                        <YAxis tick={TICK} tickFormatter={v => Math.abs(v).toLocaleString()} />
                        <Tooltip formatter={(v: number) => [Math.abs(v).toLocaleString(), '']} contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                        <Bar dataKey="callOI" name="Call OI" fill={cc.gainMuted} />
                        <Bar dataKey="putOI"  name="Put OI"  fill={cc.lossMuted} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Chain table */}
              {view !== 'chart' && (
                <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
                      {view === 'calls' ? 'Call' : 'Put'} Chain — {ticker}
                    </span>
                    {spot && <span style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)' }}>Spot ${spot.toFixed(2)}</span>}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--theme-bg, #0a1628)' }}>
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
                            <tr key={i} style={{ background: isATM ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)' : 'transparent' }}
                              onMouseEnter={e => { if (!isATM) (e.currentTarget as HTMLElement).style.background = 'var(--theme-hover, rgba(255,255,255,0.03))' }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isATM ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)' : 'transparent' }}>
                              <td style={{ ...TD, textAlign: 'left', fontWeight: 700, color: isATM ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)' }}>
                                {row.strike}
                                {isATM && <span style={{ fontSize: 9, color: 'var(--theme-primary, #c9a84c)', marginLeft: 5, letterSpacing: '0.1em' }}>ATM</span>}
                              </td>
                              <td style={TD}>{row.lastPrice?.toFixed(2) ?? '—'}</td>
                              <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{row.bid?.toFixed(2) ?? '—'}</td>
                              <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{row.ask?.toFixed(2) ?? '—'}</td>
                              <td style={TD}>{row.volume?.toLocaleString() ?? '—'}</td>
                              <td style={TD}>{row.openInterest?.toLocaleString() ?? '—'}</td>
                              <td style={{ ...TD, color: row.impliedVolatility > 0.5 ? 'var(--theme-warn, #d97736)' : 'var(--theme-text, #d7e3fc)' }}>
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
            <EmptyState title="Options Chain Scanner" hint="Enter a ticker and expiry, then press Load Chain."
              keys={['Enter']} kpis={['Spot', 'ATM IV', 'Put/Call', 'Max Pain', 'Total OI']}
              preview="table" previewLabel="Options Chain" columns={['Strike', 'Bid', 'Ask', 'IV', 'Open Int']} />
          )}
        </SidebarLayout>
  )
}

export default function OptionsChainScanner() {
  return <PageWrapper title="Options Chain Scanner"><OptionsChainScannerContent /></PageWrapper>
}
