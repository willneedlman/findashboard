import { useState, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { priceOption, optionPayoff, optionSurface } from '../hooks/useApi'
import useIsMobile from '../hooks/useIsMobile'

const GREEK_HELP: Record<string, string> = {
  delta: 'Rate of change of option price per $1 move in the underlying.',
  gamma: 'Rate of change of Delta per $1 move in the underlying.',
  theta: 'Option value lost per calendar day as time passes.',
  vega:  'Sensitivity of option price to a 1% change in implied volatility.',
  vanna: 'Second-order: Delta sensitivity to changes in volatility.',
  charm: 'Second-order: Delta sensitivity to the passage of time.',
}

const GREEK_COLOR: Record<string, string> = {
  delta: 'var(--theme-tertiary, #1f5673)', gamma: '#7b5ea7', theta: '#8c2e36', vega: '#2f6b4b',
}

import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

function GreekCard({ label, value, help }: { label: string; value: number; help?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ background: 'var(--theme-surface, #142032)', border: '1px solid var(--theme-border, rgba(255,255,255,0.07))', borderTop: '3px solid var(--theme-primary, #c9a84c)', padding: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>{label}</span>
        {help && (
          <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', cursor: 'help' }}
            onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>ⓘ</span>
        )}
        {show && help && (
          <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6,
            background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', padding: '6px 8px', width: 180, fontSize: 11,
            color: 'var(--theme-text, #d7e3fc)', lineHeight: '15px', zIndex: 50, pointerEvents: 'none' }}>
            {help}
          </div>
        )}
      </div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: 'var(--theme-text, #d7e3fc)' }}>
        {value}
      </div>
    </div>
  )
}

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
        {label}
      </div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

export function OptionsPricerContent() {
  const isMobile = useIsMobile()
  const [params, setParams] = useState({ S: 100, K: 100, T: 30, sigma: 20, r: 5, option_type: 'call' })
  const [view, setView] = useState<'2d' | 'payoff'>('2d')
  const [paramsOpen, setParamsOpen] = useState(true)

  const { mutate: calcPrice,   data: priceData,   isPending: pricePending,   isError: priceError }   = useMutation({ mutationFn: () => priceOption(params) })
  const { mutate: calcPayoff,  data: payoffData }  = useMutation({ mutationFn: () => optionPayoff(params) })
  const { mutate: calcSurface, data: surfaceData } = useMutation({ mutationFn: () => optionSurface(params) })

  useEffect(() => { calcPrice(); calcPayoff(); calcSurface() }, [])

  const recalc = () => { calcPrice(); calcPayoff(); calcSurface() }
  const set = (k: keyof typeof params) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setParams(p => ({ ...p, [k]: k === 'option_type' ? e.target.value : +e.target.value }))

  const isCall = params.option_type === 'call'

  return (
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="Pricing Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {([
              { label: 'Spot Price ($)',     key: 'S',     step: 1 },
              { label: 'Strike Price ($)',   key: 'K',     step: 1 },
              { label: 'Days to Expiry',     key: 'T',     step: 1 },
              { label: 'Volatility (%)',     key: 'sigma', step: 0.5 },
              { label: 'Risk-Free Rate (%)', key: 'r',     step: 0.25 },
            ] as const).map(f => (
              <div key={f.key}>
                <label style={LABEL}>{f.label}</label>
                <input type="number" value={(params as any)[f.key]} step={f.step}
                  onChange={set(f.key as any)} style={INPUT}
                  onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')}
                />
              </div>
            ))}
            <div>
              <label style={LABEL}>Option Type</label>
              <select value={params.option_type} onChange={set('option_type')} style={{ ...INPUT, cursor: 'pointer' }}>
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </div>
          </div>
          </RailSection>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={recalc} disabled={pricePending} style={{
              width: '100%', background: pricePending ? 'var(--theme-hover, rgba(255,255,255,0.04))' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
              border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: pricePending ? 'default' : 'pointer',
              opacity: pricePending ? 0.6 : 1, transition: 'opacity 0.15s',
            }}>
              {pricePending ? 'Calculating…' : 'Calculate'}
            </button>
            {priceError && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', textAlign: 'center', fontFamily: 'var(--theme-sans)' }}>Server unavailable — is the backend running?</div>}
          </div>
        </>}>

          {/* Premium + Greeks */}
          {priceData && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              {/* Premium header */}
              <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>
                  Option Premium
                </span>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 28, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)' }}>
                  ${priceData.price}
                </span>
                {!isMobile && (
                  <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.08em' }}>
                    {params.option_type.toUpperCase()} · S={params.S} · K={params.K} · T={params.T}d · σ={params.sigma}% · r={params.r}%
                  </span>
                )}
              </div>
              {/* Greeks grid */}
              <div style={{ padding: 10, display: 'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(6,1fr)', gap: 8 }}>
                <GreekCard label="Delta" value={priceData.greeks.delta} help={GREEK_HELP.delta} />
                <GreekCard label="Gamma" value={priceData.greeks.gamma} help={GREEK_HELP.gamma} />
                <GreekCard label="Theta" value={priceData.greeks.theta} help={GREEK_HELP.theta} />
                <GreekCard label="Vega"  value={priceData.greeks.vega}  help={GREEK_HELP.vega}  />
                <GreekCard label="Vanna" value={priceData.vanna}        help={GREEK_HELP.vanna} />
                <GreekCard label="Charm" value={priceData.charm}        help={GREEK_HELP.charm} />
              </div>
            </div>
          )}

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            {(['2d', 'payoff'] as const).map(t => (
              <button key={t} onClick={() => setView(t)} style={{
                padding: '7px 16px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
                color: view === t ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.18))',
                borderBottom: view === t ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent',
                marginBottom: -1,
              }}>
                {t === '2d' ? '2D Greeks' : 'Payoff Diagram'}
              </button>
            ))}
          </div>

          {/* Payoff chart */}
          {view === 'payoff' && payoffData && (
            <ChartPanel label="P&L at Expiry" height={348}>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={payoffData.spot.map((s: number, i: number) => ({ spot: s.toFixed(1), pnl: payoffData.payoff[i] }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="spot" tick={TICK} interval="preserveStartEnd" />
                  <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(2)}`} orientation="right" />
                  <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, 'P&L']} contentStyle={TOOLTIP_STYLE} />
                  <ReferenceLine y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.15))" strokeDasharray="4 4" />
                  <ReferenceLine x={String(params.K.toFixed(1))} stroke="var(--theme-warn, #d97736)" strokeDasharray="4 4"
                    label={{ value: 'Strike', fill: 'var(--theme-warn, #d97736)', fontSize: 9 }} />
                  <Line type="monotone" dataKey="pnl" stroke="var(--theme-positive)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>
          )}

          {/* 2D Greeks grid */}
          {view === '2d' && surfaceData && (
            <div className="chart-pair">
              {(['delta', 'gamma', 'theta', 'vega'] as const).map(greek => (
                <ChartPanel key={greek} label={greek.toUpperCase()} height={208}>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={surfaceData.spot.map((s: number, i: number) => ({ spot: s.toFixed(0), value: surfaceData[greek][i] }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                      <XAxis dataKey="spot" tick={TICK} interval="preserveStartEnd" />
                      <YAxis tick={TICK} orientation="right" />
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                      <ReferenceLine x={String(params.S.toFixed(0))} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)" strokeDasharray="3 3" />
                      <Line type="monotone" dataKey="value" stroke={GREEK_COLOR[greek]} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartPanel>
              ))}
            </div>
          )}

        </SidebarLayout>
  )
}

export default function OptionsPricer() {
  return <PageWrapper title="Options Pricer"><OptionsPricerContent /></PageWrapper>
}
