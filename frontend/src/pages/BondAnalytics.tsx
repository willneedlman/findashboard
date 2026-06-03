import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { fetchBondAnalytics } from '../hooks/useApi'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
const INPUT: React.CSSProperties = { background: '#0a1628', border: '1px solid #4d4637', color: '#d7e3fc', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none' }
const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 4, display: 'block' }
const TOOLTIP_STYLE = { background: '#142032', border: '1px solid #4d4637', borderRadius: 0 }
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

function MetricCard({ label, value, delta, deltaPositive }: { label: string; value: string; delta?: string; deltaPositive?: boolean }) {
  return (
    <div style={{ background: '#142032', border: '1px solid rgba(255,255,255,0.07)', borderTop: '3px solid #c9a84c', padding: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700, color: '#d7e3fc' }}>{value}</div>
      {delta && <div style={{ fontSize: 10, marginTop: 2, color: deltaPositive ? '#22C55E' : '#EF4444' }}>{delta}</div>}
    </div>
  )
}

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'rgba(46,57,77,0.8)', padding: '3px 8px', borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc' }}>{label}</div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

export default function BondAnalytics() {
  const [p, setP]     = useState({ face: 1000, coupon_rate: 5, market_price: 1000, maturity: 10 })
  const [shift, setShift] = useState(0)

  const { mutate, data } = useMutation({ mutationFn: () => fetchBondAnalytics(p) })
  const set = (k: keyof typeof p) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP(prev => ({ ...prev, [k]: +e.target.value }))

  const shiftedPoint = data?.sensitivity.find((s: any) => s.shift === shift)

  const liveBondType = (() => {
    const price = shiftedPoint ? shiftedPoint.price : data?.sensitivity.find((s: any) => s.shift === 0)?.price
    if (!data || price == null) return data?.bond_type ?? 'Par Bond'
    const face = p.face
    if (price > face * 1.001) return 'Premium Bond'
    if (price < face * 0.999) return 'Discount Bond'
    return 'Par Bond'
  })()

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={190} sidebarTitle="Bond Parameters" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Bond Parameters</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            {([
              { label: 'Face Value ($)',    key: 'face',         step: 100  },
              { label: 'Coupon Rate (%)',   key: 'coupon_rate',  step: 0.25 },
              { label: 'Market Price ($)',  key: 'market_price', step: 1    },
              { label: 'Maturity (Years)',  key: 'maturity',     step: 1    },
            ] as const).map(f => (
              <div key={f.key}>
                <label style={LABEL}>{f.label}</label>
                <input type="number" value={(p as any)[f.key]} step={f.step} onChange={set(f.key as any)} style={INPUT}
                  onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
              </div>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: '1px solid #2e394d' }}>
            <button onClick={() => mutate()} style={{
              width: '100%', background: '#1f2a3d', border: '1px solid #c9a84c', color: '#c9a84c',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: 'pointer',
            }}>
              ⬢ Analyze Bond
            </button>
          </div>
      </>}>
          {data && (
            <>
              {/* Bond type + metrics */}
              <div style={{ background: '#101c2e', border: '1px solid #2e394d' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid #2e394d', background: '#142032', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e' }}>Bond Classification</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 700, color: liveBondType === 'Premium Bond' ? '#22C55E' : liveBondType === 'Discount Bond' ? '#EF4444' : '#c9a84c' }}>{liveBondType}</span>
                </div>
                <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
                  <MetricCard label="Implied YTM"        value={`${data.ytm}%`} />
                  <MetricCard label="Modified Duration"  value={String(data.mod_duration)} />
                  <MetricCard label="Convexity"          value={String(data.convexity)} />
                  <MetricCard label="Coupon Payment"     value={`$${data.coupon_payment}`} />
                </div>
              </div>

              {/* Duration sensitivity */}
              <div style={{ background: '#101c2e', border: '1px solid #2e394d' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Duration-Adjusted Price Sensitivity</span>
                </div>
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#99907e', whiteSpace: 'nowrap' }}>Rate Shift</span>
                    <input type="range" min={-300} max={300} step={5} value={shift}
                      onChange={e => setShift(+e.target.value)} style={{ flex: 1, accentColor: '#c9a84c' }} />
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700, color: '#c9a84c', whiteSpace: 'nowrap', width: 72, textAlign: 'right' }}>
                      {shift > 0 ? '+' : ''}{shift} bps
                    </span>
                  </div>

                  {shiftedPoint && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 12 }}>
                      <MetricCard label="Rate Shift" value={`${shift > 0 ? '+' : ''}${shift} bps`} />
                      <MetricCard label="New Price" value={`$${shiftedPoint.price.toFixed(2)}`}
                        delta={`${((shiftedPoint.price - p.market_price) / p.market_price * 100).toFixed(2)}%`}
                        deltaPositive={shiftedPoint.price > p.market_price} />
                      <MetricCard label="New YTM" value={`${Math.max(((data.ytm / 100) + shift / 10000) * 100, 0.01).toFixed(2)}%`} />
                    </div>
                  )}
                </div>

                <ChartPanel label="Price vs Rate Shift" height={248}>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={data.sensitivity}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                      <XAxis dataKey="shift" tick={TICK} tickFormatter={v => `${v}bps`} interval="preserveStartEnd" />
                      <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
                      <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, 'Price']} contentStyle={TOOLTIP_STYLE} />
                      <ReferenceLine x={shift} stroke="#d97736" strokeDasharray="4 4" />
                      <ReferenceLine y={p.market_price} stroke="rgba(255,255,255,0.1)" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="price" stroke="#1f5673" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartPanel>
              </div>

              <ChartPanel label="Cash Flow Schedule: Nominal vs Present Value" height={288}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.cash_flows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="year" tick={TICK} />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar dataKey="nominal" name="Nominal CF" fill="#1f5673" opacity={0.85} />
                    <Bar dataKey="pv"      name="Present Value" fill="#d97736" opacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}
          {!data && (
            <EmptyState title="Bond Analytics" hint="Enter face value, coupon rate, market price and maturity, then press Analyze Bond." />
          )}
      </SidebarLayout>
    </PageWrapper>
  )
}
