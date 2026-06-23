import { useState, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import TickerInput from '../components/TickerInput'
import ExpirySelect from '../components/ExpirySelect'
import { priceOption, optionPayoff, optionSurface, fetchOptionsChain } from '../hooks/useApi'
import useIsMobile from '../hooks/useIsMobile'

const GREEK_HELP: Record<string, string> = {
  delta:  'Rate of change of option price per $1 move in the underlying.',
  gamma:  'Rate of change of Delta per $1 move in the underlying.',
  theta:  'Option value lost per calendar day as time passes.',
  vega:   'Sensitivity of option price to a 1% change in implied volatility.',
  vanna:  'Second-order: Delta sensitivity to changes in volatility.',
  charm:  'Second-order: Delta sensitivity to the passage of time.',
  lambda: 'Lambda (omega): percent change in option value per 1% move in the underlying — the option\'s leverage.',
}

const GREEK_COLOR: Record<string, string> = {
  delta: 'var(--theme-tertiary, #1f5673)', gamma: '#7b5ea7', theta: '#8c2e36', vega: '#2f6b4b',
}

import { INPUT, SELECT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

interface ChainRow {
  strike: number; lastPrice: number; bid: number; ask: number
  impliedVolatility: number; volume: number; openInterest: number
}
interface ChainData {
  expiry: string; expirations: string[]; spot: number | null; dte: number; t_days: number
  calls: ChainRow[]; puts: ChainRow[]
}
const rowMark = (r: ChainRow) =>
  r.bid > 0 && r.ask > 0 ? (r.bid + r.ask) / 2 : (r.ask > 0 ? r.ask : r.lastPrice)

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

type Params = { S: number; K: number; T: number; sigma: number; r: number; option_type: string }

export function OptionsPricerContent() {
  const isMobile = useIsMobile()
  const [params, setParams] = useState<Params>({ S: 100, K: 100, T: 30, sigma: 20, r: 5, option_type: 'call' })
  const [view, setView] = useState<'2d' | 'payoff'>('2d')
  const [paramsOpen, setParamsOpen] = useState(true)

  // Live-chain loader state
  const [chainOpen, setChainOpen] = useState(false)
  const [chainSym, setChainSym] = useState('')
  const [chainExpiry, setChainExpiry] = useState('')
  const [selectedIdx, setSelectedIdx] = useState('')   // index of the chosen contract row
  const [loadedMark, setLoadedMark] = useState<{ mark: number; label: string } | null>(null)

  const { mutate: calcPrice,   data: priceData,   isPending: pricePending,   isError: priceError }   = useMutation({ mutationFn: (p: Params) => priceOption(p) })
  const { mutate: calcPayoff,  data: payoffData }  = useMutation({ mutationFn: (p: Params) => optionPayoff(p) })
  const { mutate: calcSurface, data: surfaceData } = useMutation({ mutationFn: (p: Params) => optionSurface(p) })
  const chainMut = useMutation<ChainData, unknown, { ticker: string; expiry?: string }>({
    mutationFn: ({ ticker, expiry }) => fetchOptionsChain(ticker, expiry),
    onSuccess: d => { setChainExpiry(d.expiry); setSelectedIdx('') },
  })

  const runAll = (p: Params) => { calcPrice(p); calcPayoff(p); calcSurface(p) }
  useEffect(() => { runAll(params) }, [])

  const recalc = () => runAll(params)
  const set = (k: keyof Params) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    // Hand-editing a parameter detaches the analysis from the loaded contract,
    // so drop the market-mark chip and the contract selection rather than show a
    // price tied to a strike the user has since changed.
    setLoadedMark(null)
    setSelectedIdx('')
    setParams(p => ({ ...p, [k]: k === 'option_type' ? e.target.value : +e.target.value }))
  }

  const chain = chainMut.data
  const chainRows = chain ? (params.option_type === 'call' ? chain.calls : chain.puts) : []

  // Pull a real listed contract into the analyzer: spot, strike, days-to-expiry
  // and implied vol all come straight from the live chain, then we re-price.
  const applyContract = (idx: string) => {
    const r = chainRows[+idx]
    if (!r || !chain || !chain.spot) return
    setSelectedIdx(idx)
    const next: Params = {
      ...params,
      S: chain.spot,
      K: r.strike,
      // t_days carries the precise time to expiry (intraday hours for 0-DTE);
      // round to 3 dp so the Days-to-Expiry field stays legible.
      T: Math.round((chain.t_days ?? chain.dte) * 1000) / 1000,
      sigma: Math.round(r.impliedVolatility * 1000) / 10,
    }
    setParams(next)
    runAll(next)
    setLoadedMark({ mark: rowMark(r), label: `${chainSym.toUpperCase()} ${chain.expiry} ${r.strike}${params.option_type === 'call' ? 'C' : 'P'}` })
  }

  return (
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="Live Chain" open={chainOpen} onToggle={() => setChainOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={LABEL}>Underlying</label>
              <TickerInput
                value={chainSym}
                onChange={setChainSym}
                onEnter={() => chainSym && chainMut.mutate({ ticker: chainSym })}
                placeholder="Ticker or company"
                style={INPUT}
                aria-label="Underlying ticker for live options chain"
              />
            </div>
            <button onClick={() => chainSym && chainMut.mutate({ ticker: chainSym })} disabled={!chainSym || chainMut.isPending} style={{
              width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
              border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '7px 0', cursor: (!chainSym || chainMut.isPending) ? 'default' : 'pointer',
              opacity: (!chainSym || chainMut.isPending) ? 0.6 : 1,
            }}>
              {chainMut.isPending ? 'Loading…' : 'Load Chain'}
            </button>
            {chainMut.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', fontFamily: 'var(--theme-sans)' }}>No chain found for that symbol.</div>}
            {chain && (
              <>
                <div>
                  <label style={LABEL}>Expiry</label>
                  <ExpirySelect ticker={chainSym} value={chainExpiry} expirations={chain.expirations}
                    autoSelect={false} style={{ ...SELECT, cursor: 'pointer' }}
                    onChange={exp => { setChainExpiry(exp); chainMut.mutate({ ticker: chainSym, expiry: exp }) }} />
                </div>
                <div>
                  <label style={LABEL}>Contract ({params.option_type === 'call' ? 'Calls' : 'Puts'})</label>
                  <select value={selectedIdx} style={{ ...SELECT, cursor: 'pointer' }}
                    onChange={e => applyContract(e.target.value)}>
                    <option value="" disabled>Select strike…</option>
                    {chainRows.map((r, i) => (
                      <option key={`${r.strike}-${i}`} value={i}>
                        {r.strike} · ${rowMark(r).toFixed(2)} · IV {(r.impliedVolatility * 100).toFixed(0)}%
                      </option>
                    ))}
                  </select>
                  {chain.spot != null && <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', fontFamily: 'var(--theme-mono)', marginTop: 5 }}>Spot ${chain.spot.toFixed(2)} · {chain.dte === 0 ? `${(chain.t_days * 24).toFixed(1)}h to expiry` : `${chain.dte}d to expiry`}</div>}
                </div>
              </>
            )}
          </div>
          </RailSection>
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
                {loadedMark && (
                  <span style={{ fontSize: 10, fontFamily: 'var(--theme-mono)', color: 'var(--theme-tertiary, #60a5fa)', letterSpacing: '0.04em' }}>
                    Mkt ${loadedMark.mark.toFixed(2)} · {loadedMark.label}
                  </span>
                )}
                {!isMobile && (
                  <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.08em' }}>
                    {params.option_type.toUpperCase()} · S={params.S} · K={params.K} · T={params.T}d · σ={params.sigma}% · r={params.r}%
                  </span>
                )}
              </div>
              {/* Greeks grid */}
              <div style={{ padding: 10, display: 'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(7,1fr)', gap: 8 }}>
                <GreekCard label="Delta"  value={priceData.greeks.delta} help={GREEK_HELP.delta} />
                <GreekCard label="Gamma"  value={priceData.greeks.gamma} help={GREEK_HELP.gamma} />
                <GreekCard label="Theta"  value={priceData.greeks.theta} help={GREEK_HELP.theta} />
                <GreekCard label="Vega"   value={priceData.greeks.vega}  help={GREEK_HELP.vega}  />
                <GreekCard label="Vanna"  value={priceData.vanna}        help={GREEK_HELP.vanna} />
                <GreekCard label="Charm"  value={priceData.charm}        help={GREEK_HELP.charm} />
                <GreekCard label="Lambda" value={priceData.lambda}       help={GREEK_HELP.lambda} />
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
