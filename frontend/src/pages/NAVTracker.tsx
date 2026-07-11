import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { KpiCell } from '../components/mmCockpit'
import { fetchNAVProxy, fetchNAVRegistry } from '../hooks/useApi'
import EmptyState from '../components/EmptyState'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection, VerdictStrip, RangeTrack } from './valuationShared'
import { T } from '../lib/theme'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const POS = 'var(--theme-positive)', NEG = 'var(--theme-negative)'
const BLUE = 'var(--theme-tertiary, #60a5fa)', WARN = 'var(--theme-warn)'
const TIER_LABELS: Record<string, string> = {
  'mstr-edgar': 'EDGAR live', 'coingecko': 'CoinGecko live', 'fund-nav': 'Fund NAV live',
  'manual': 'Manual', 'needs-manual': 'Enter manually',
}

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
  const [paramsOpen, setParamsOpen] = useState(true)

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
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="NAV Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          </RailSection>
          <div style={{ padding: 12 }}>
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
            <EmptyState title="NAV Proxy Tracker" hint="Pick a preset company or enter holdings, then press Calculate NAV."
              keys={['Enter']} kpis={['Price', 'True Net NAV', 'Premium', 'Holdings', 'Spot']}
              preview="chart" previewLabel="Price vs Net NAV Floor" />
          )}

          {data && (
            <>
              {/* Verdict strip — Market/NAV multiple + premium range */}
              {(() => {
                const c = data.current
                const nav = c.nav_per_share
                const mult = nav > 0 ? c.target_price / nav : 0
                const prem = c.premium
                const mults = ((data.series ?? []) as { premium: number }[])
                  .map(s => 1 + s.premium / 100).filter(m => isFinite(m)).sort((a, b) => a - b)
                const floor = mults.length ? mults[0] : mult
                const peak = mults.length ? mults[mults.length - 1] : mult
                const median = mults.length ? mults[Math.floor(mults.length / 2)] : mult
                const clamp = (x: number) => Math.max(0, Math.min(100, x))
                const pct = (v: number) => peak > floor ? clamp((v - floor) / (peak - floor) * 100) : 50
                return (
                  <VerdictStrip
                    primary={{ label: 'Market / NAV', value: `${mult.toFixed(2)}×`, tone: 'gold',
                      context: `${prem >= 0 ? '+' : ''}${prem}% premium to NAV`, contextTone: prem >= 0 ? 'pos' : 'neg' }}
                    range={mults.length >= 3 ? (
                      <RangeTrack title="Premium range"
                        chip={{ text: `now ${mult.toFixed(2)}× · median ${median.toFixed(2)}×`, tone: 'muted' }}
                        gradient={`linear-gradient(90deg, ${T.posTint(32)}, color-mix(in srgb, var(--theme-secondary) 22%, transparent), ${T.negTint(32)})`}
                        ticks={[{ pct: pct(median), tone: 'muted' }, { pct: pct(mult), tone: 'gold' }]}
                        labels={[
                          { text: `${floor.toFixed(2)}× floor`, pct: 0, tone: 'muted' },
                          { text: `now ${mult.toFixed(2)}×`, pct: pct(mult), tone: 'gold' },
                          { text: `${peak.toFixed(2)}× peak`, pct: 100, tone: 'muted' },
                        ]} />
                    ) : undefined}
                    cells={[
                      { label: `${p.target} price`, value: `$${c.target_price.toLocaleString()}` },
                      { label: 'NAV / share', value: `$${nav.toLocaleString()}`, tone: 'blue' },
                    ]}
                  />
                )
              })()}
              {(() => {
                const c = data.current
                const tier = data.source_tier as string | undefined
                const liveTier = tier === 'mstr-edgar' || tier === 'coingecko' || tier === 'fund-nav'
                return (
                  <div style={STRIP}>
                    <KpiCell grow align="top" valueSize={15} label={`${p.target} Price`} value={`$${c.target_price.toLocaleString()}`} />
                    <KpiCell grow align="top" valueSize={15} label="Gross Asset / Share" value={`$${c.gav_per_share.toLocaleString()}`} />
                    <KpiCell grow align="top" valueSize={15} label="True Net NAV / Share" value={`$${c.nav_per_share.toLocaleString()}`} color={BLUE} />
                    <KpiCell grow align="top" valueSize={15} label="Implied Premium" value={`${c.premium > 0 ? '+' : ''}${c.premium}%`} color={c.premium > 0 ? POS : NEG} />
                    <KpiCell grow align="top" valueSize={15} label={`${data.asset_label ?? p.asset} Spot`} value={`$${c.asset_spot.toLocaleString()}`} />
                    <KpiCell grow align="top" valueSize={15} label="Total Holdings" value={Number(data.holdings).toLocaleString()}
                      sub={TIER_LABELS[tier ?? ''] ?? 'Source'} subColor={liveTier ? POS : WARN} />
                    {data.unrealized_pnl !== 0 && (
                      <KpiCell grow align="top" valueSize={15} label="Unrealized P&L" value={`$${data.unrealized_pnl}B`} color={data.unrealized_pnl > 0 ? POS : NEG} />
                    )}
                  </div>
                )
              })()}

              <ChartPanel label={`${p.target} Price vs Net NAV Floor`} height={288}>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.series}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="target" stroke="var(--theme-primary, #c9a84c)" strokeWidth={2.5} dot={false} name={p.target} />
                    <Line type="monotone" dataKey="nav" stroke={BLUE} strokeWidth={2} strokeDasharray="5 3" dot={false} name="Net NAV Floor" />
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
