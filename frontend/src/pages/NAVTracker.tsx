import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import SidebarLayout from '../components/SidebarLayout'
import { fetchNAVProxy, fetchNAVRegistry } from '../hooks/useApi'
import EmptyState from '../components/EmptyState'
const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}
const TOOLTIP_STYLE = { background: 'var(--theme-surface, #142032)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderRadius: 0 }
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
      }}>
        {label}
      </div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

export default function NAVTracker() {
  const [p, setP] = useState({
    target: 'MSTR', asset: 'BTC-USD',
    start: '2023-01-01',
    gross_debt_m: 4200, gross_cash_m: 150,
    use_live: true,
  })
  const [holdings, setHoldings] = useState(843706)
  const [avgCost, setAvgCost] = useState(75699)
  const [preset, setPreset] = useState('MSTR')

  const { data: registry } = useQuery({ queryKey: ['nav-registry'], queryFn: fetchNAVRegistry, staleTime: Infinity })

  const applyPreset = (ticker: string) => {
    setPreset(ticker)
    if (ticker === '__custom__') { setP(x => ({ ...x, use_live: false })); return }
    const r = registry?.find(e => e.ticker === ticker)
    if (!r) return
    setP(x => ({ ...x, target: r.ticker, asset: r.asset, use_live: true }))
  }

  const { mutate, data, isPending } = useMutation({
    mutationFn: () => fetchNAVProxy({
      ...p,
      holdings: p.use_live ? null : holdings,
      avg_cost: p.use_live ? null : avgCost,
    }),
  })

  const focus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')

  return (
    <PageWrapper title="NAV Tracker">
      <SidebarLayout sidebarWidth={200} sidebarTitle="NAV Controls" sidebar={<>

        {/* Left sidebar */}

          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
              NAV Parameters
            </div>
          </div>

          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            <div>
              <label style={LABEL}>Preset Company</label>
              <select style={INPUT} value={preset}
                onChange={e => applyPreset(e.target.value)}
                onFocus={focus} onBlur={blur}>
                {Array.from(new Set((registry ?? []).map(r => r.category))).map(cat => (
                  <optgroup key={cat} label={cat}>
                    {(registry ?? []).filter(r => r.category === cat).map(r => (
                      <option key={r.ticker} value={r.ticker}>
                        {r.ticker} — {r.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="__custom__">Custom / manual…</option>
              </select>
            </div>
            <div>
              <label style={LABEL}>Target Ticker</label>
              <input style={INPUT} value={p.target}
                onChange={e => { setP(x => ({ ...x, target: e.target.value.toUpperCase() })); setPreset('__custom__') }}
                onFocus={focus} onBlur={blur} />
            </div>
            <div>
              <label style={LABEL}>Asset / Proxy Ticker</label>
              <input style={INPUT} value={p.asset}
                onChange={e => setP(x => ({ ...x, asset: e.target.value.toUpperCase() }))}
                onFocus={focus} onBlur={blur} />
            </div>
            <div>
              <label style={LABEL}>Analysis Start</label>
              <input type="date" style={INPUT} value={p.start}
                onChange={e => setP(x => ({ ...x, start: e.target.value }))}
                onFocus={focus} onBlur={blur} />
            </div>
            {!p.use_live && (
              <>
                <div>
                  <label style={LABEL}>Gross Debt ($M)</label>
                  <input type="number" style={INPUT} value={p.gross_debt_m} step={100}
                    onChange={e => setP(x => ({ ...x, gross_debt_m: +e.target.value }))}
                    onFocus={focus} onBlur={blur} />
                </div>
                <div>
                  <label style={LABEL}>Cash Reserves ($M)</label>
                  <input type="number" style={INPUT} value={p.gross_cash_m} step={10}
                    onChange={e => setP(x => ({ ...x, gross_cash_m: +e.target.value }))}
                    onFocus={focus} onBlur={blur} />
                </div>
              </>
            )}

            {/* Holdings section */}
            <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 10 }}>
              <label style={LABEL}>Asset Holdings</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={p.use_live}
                  onChange={e => setP(x => ({ ...x, use_live: e.target.checked }))}
                  style={{ accentColor: 'var(--theme-primary, #c9a84c)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', lineHeight: '14px' }}>Use live / registry data</span>
              </label>

              {!p.use_live && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <label style={LABEL}>Holdings Count</label>
                    <input type="number" style={INPUT} value={holdings} step={1000}
                      onChange={e => setHoldings(+e.target.value)}
                      onFocus={focus} onBlur={blur} />
                  </div>
                  <div>
                    <label style={LABEL}>Avg Cost ($ / unit)</label>
                    <input type="number" style={INPUT} value={avgCost} step={100}
                      onChange={e => setAvgCost(+e.target.value)}
                      onFocus={focus} onBlur={blur} />
                  </div>
                </div>
              )}

              {p.use_live && (
                <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', lineHeight: '14px' }}>
                  Holdings, debt and NAV are fetched live (SEC EDGAR for MSTR, CoinGecko for crypto, fund NAV for trusts). Disable to enter values manually.
                </div>
              )}
            </div>
          </div>

          <div style={{ padding: 10, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Loading…' : 'Calculate NAV'}
            </button>
          </div>

      {/* Right panel */}
      </>}>

          {!data && !isPending && (
            <EmptyState title="NAV Proxy Tracker" hint="Pick a preset company or enter holdings, then press Calculate NAV." />
          )}

          {data && (
            <>
              <div className="metric-grid">
                <MetricCard label={`${p.target} Price`} value={`$${data.current.target_price.toLocaleString()}`}
                  help={`Live market price of ${p.target}. Compared against net NAV floor to determine premium or discount.`} />
                <MetricCard label="Gross Asset / Share" value={`$${data.current.gav_per_share.toLocaleString()}`}
                  help="Gross Asset Value per share — total asset holdings at spot, divided by shares outstanding. Does not subtract debt." />
                <MetricCard label="True Net NAV / Share" value={`$${data.current.nav_per_share.toLocaleString()}`}
                  help="Net Asset Value per share — holdings at spot minus gross debt and adjusted for cash, divided by shares outstanding." />
                <MetricCard label="Implied Premium"
                  value={`${data.current.premium > 0 ? '+' : ''}${data.current.premium}%`}
                  deltaPositive={data.current.premium > 0}
                  help={`How much ${p.target} market price exceeds (or trails) the True Net NAV per share.`} />
                <MetricCard label={`${data.asset_label ?? p.asset} Spot`} value={`$${data.current.asset_spot.toLocaleString()}`}
                  help={`Current spot price of ${data.asset_label ?? p.asset}. Drives real-time GAV and NAV calculations.`} />
                <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderTop: '3px solid var(--theme-primary, #c9a84c)', padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 6 }}>
                    Total Holdings
                  </div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, color: 'var(--theme-text, #d7e3fc)' }}>
                    {Number(data.holdings).toLocaleString()}
                  </div>
                  {(() => {
                    const tier = data.source_tier as string | undefined
                    const live = tier === 'mstr-edgar' || tier === 'coingecko' || tier === 'fund-nav'
                    const labels: Record<string, string> = {
                      'mstr-edgar': 'EDGAR live', 'coingecko': 'CoinGecko live', 'fund-nav': 'Fund NAV live',
                      'manual': 'Manual', 'needs-manual': 'Enter manually',
                    }
                    return (
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
                          padding: '2px 7px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          background: live ? 'color-mix(in srgb, var(--theme-positive) 12%, transparent)' : 'color-mix(in srgb, var(--theme-warn) 12%, transparent)',
                          border: `1px solid ${live ? 'color-mix(in srgb, var(--theme-positive) 35%, transparent)' : 'color-mix(in srgb, var(--theme-warn) 35%, transparent)'}`,
                          color: live ? 'var(--theme-positive)' : 'var(--theme-warn)',
                        }}>
                          {labels[tier ?? ''] ?? 'Source'}
                        </span>
                        <span style={{ fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.28))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={data.source}>{data.source}</span>
                      </div>
                    )
                  })()}
                </div>
                {data.unrealized_pnl !== 0 && (
                  <MetricCard label="Unrealized P&L"
                    value={`$${data.unrealized_pnl}B`}
                    deltaPositive={data.unrealized_pnl > 0}
                    help="Unrealized gain or loss — (current spot − avg cost) × holdings." />
                )}
              </div>

              <ChartPanel label={`${p.target} Price vs Net NAV Floor`} height={288}>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.series}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="target" stroke="#1f5673" strokeWidth={2.5} dot={false} name={p.target} />
                    <Line type="monotone" dataKey="nav" stroke="#d97736" strokeWidth={2} strokeDasharray="5 3" dot={false} name="Net NAV Floor" />
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Historical Premium / Discount %" height={188}>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={data.series}>
                    <defs>
                      <linearGradient id="premGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2f6b4b" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#2f6b4b" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `${v}%`} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Area type="monotone" dataKey="premium" stroke="#2f6b4b" fill="url(#premGrad)" strokeWidth={1.5} name="Premium %" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}
      </SidebarLayout>
    </PageWrapper>
  )
}
