import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import useContainerSize from '../../../hooks/useContainerSize'

const T = {
  bg: '#101c2e', border: '#2e394d', headerBg: '#142032',
  gold: '#c9a84c', text: '#d7e3fc', muted: '#5e768f',
  mono: 'JetBrains Mono, monospace', label: 'IBM Plex Sans, sans-serif',
  pos: '#22C55E', neg: '#EF4444',
}

const shimmerStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, #101c2e 25%, #1a2d45 50%, #101c2e 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 4,
}

const inputStyle: React.CSSProperties = {
  background: '#0a1628', border: '1px solid #4d4637', color: T.text,
  fontFamily: T.mono, fontSize: 11, padding: '4px 6px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}

function bsPrice(S: number, K: number, Ty: number, r: number, sigma: number, isCall: boolean) {
  if (Ty <= 0) return { price: Math.max(0, isCall ? S - K : K - S), delta: isCall ? 1 : -1, gamma: 0, theta: 0, vega: 0 }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * Ty) / (sigma * Math.sqrt(Ty))
  const d2 = d1 - sigma * Math.sqrt(Ty)
  const N = (x: number) => { const a=0.2316419,a1=0.319381530,a2=-0.356563782,a3=1.781477937,a4=-1.821255978,a5=1.330274429; const t=1/(1+a*Math.abs(x)); const poly=t*(a1+t*(a2+t*(a3+t*(a4+t*a5)))); const n=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI); const cdf=1-n*poly; return x>=0?cdf:1-cdf }
  const phi = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
  const price = isCall ? S*N(d1)-K*Math.exp(-r*Ty)*N(d2) : K*Math.exp(-r*Ty)*N(-d2)-S*N(-d1)
  return {
    price: Math.max(0, price),
    delta: isCall ? N(d1) : N(d1) - 1,
    gamma: phi(d1) / (S * sigma * Math.sqrt(Ty)),
    theta: (-(S*phi(d1)*sigma)/(2*Math.sqrt(Ty)) - r*K*Math.exp(-r*Ty)*(isCall?N(d2):N(-d2)))/365,
    vega: S * phi(d1) * Math.sqrt(Ty) / 100,
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ color: T.muted, fontSize: 9, fontFamily: T.label, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </div>
  )
}

function Greek({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
      <span style={{ color: T.muted, fontSize: 9, fontFamily: T.label, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ color: color ?? T.text, fontSize: 16, fontWeight: 700, fontFamily: T.mono }}>{value}</span>
    </div>
  )
}

export default function OptionsPricerWidget({ config }: { config: WidgetConfig }) {
  const [ticker, setTicker] = useState(config.ticker ?? 'SPY')
  const [tickerInput, setTickerInput] = useState(config.ticker ?? 'SPY')
  const [optionType, setOptionType] = useState<'call' | 'put'>('call')
  const [strike, setStrike] = useState(0)
  const [expDays, setExpDays] = useState(30)
  const [vol, setVol] = useState(0)
  const [committed, setCommitted] = useState({ optionType: 'call' as 'call' | 'put', strike: 0, expDays: 30, vol: 0, ran: false })
  const { ref, width, height } = useContainerSize<HTMLDivElement>()

  const wide = width >= 440
  const tall = height >= 320

  const { data, isLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['options-pricer-spot', ticker],
    queryFn: () => axios.get('/api/corporate/hub?ticker=' + ticker).then(r => r.data),
    enabled: !!ticker, staleTime: 60_000,
  })

  const spot = (data?.spot ?? 0) as number
  const impliedVol = (data?.implied_move ?? 0) as number
  const sigma = committed.vol > 0 ? committed.vol / 100 : impliedVol / 100
  const K = committed.strike > 0 ? committed.strike : spot
  const Ty = committed.expDays / 365
  const greeks = committed.ran && spot > 0 && K > 0 && sigma > 0 && Ty > 0
    ? bsPrice(spot, K, Ty, 0.045, sigma, committed.optionType === 'call')
    : null
  const volLabel = vol > 0 ? `${vol}% manual` : impliedVol > 0 ? `${impliedVol.toFixed(1)}% IV` : '—'

  const runCalc = () => setCommitted({ optionType, strike, expDays, vol, ran: true })

  const toggleBtn = (type: 'call' | 'put'): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 11, fontFamily: T.mono, cursor: 'pointer',
    border: `1px solid ${T.border}`, background: optionType === type ? T.gold : '#0a1628',
    color: optionType === type ? '#101c2e' : T.muted, fontWeight: optionType === type ? 700 : 400,
    borderRadius: type === 'call' ? '3px 0 0 3px' : '0 3px 3px 0',
  })

  const controls = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: wide ? '10px 12px' : '8px 10px', flexShrink: 0 }}>
      {/* Ticker input */}
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={tickerInput}
          onChange={e => setTickerInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && setTicker(tickerInput.trim())}
          style={{ ...inputStyle, flex: 1, textTransform: 'uppercase' }}
          placeholder="Ticker…"
        />
        <button
          onClick={() => setTicker(tickerInput.trim())}
          style={{ background: 'rgba(201,168,76,0.15)', border: `1px solid ${T.border}`, color: T.gold, fontFamily: T.mono, fontSize: 10, padding: '4px 8px', cursor: 'pointer' }}
        >→</button>
      </div>

      {/* Call/Put toggle */}
      <div style={{ display: 'flex' }}>
        <button style={toggleBtn('call')} onClick={() => setOptionType('call')}>CALL</button>
        <button style={toggleBtn('put')} onClick={() => setOptionType('put')}>PUT</button>
      </div>

      <Field label={`Strike ${strike === 0 ? '(ATM)' : ''}`}>
        <input type="number" style={inputStyle}
          value={strike === 0 ? '' : strike}
          placeholder={spot > 0 ? spot.toFixed(2) : '0'}
          onChange={e => setStrike(e.target.value === '' ? 0 : +e.target.value)}
        />
      </Field>

      <Field label="Expiry (days)">
        <input type="number" style={inputStyle} value={expDays} min={1}
          onChange={e => setExpDays(Math.max(1, +e.target.value))}
        />
      </Field>

      <Field label={`Vol % · ${volLabel}`}>
        <input type="number" style={inputStyle}
          value={vol === 0 ? '' : vol}
          placeholder={impliedVol > 0 ? impliedVol.toFixed(1) : '—'}
          onChange={e => setVol(e.target.value === '' ? 0 : +e.target.value)}
          onKeyDown={e => e.key === 'Enter' && runCalc()}
        />
      </Field>

      <button
        onClick={runCalc}
        disabled={isLoading || spot === 0}
        style={{
          background: isLoading || spot === 0 ? 'rgba(201,168,76,0.3)' : T.gold,
          border: 'none', color: '#0a1628', fontFamily: T.mono, fontSize: 10,
          fontWeight: 700, letterSpacing: '0.12em', padding: '6px 0',
          cursor: isLoading || spot === 0 ? 'not-allowed' : 'pointer',
          width: '100%', textTransform: 'uppercase' as const,
        }}
      >
        {isLoading ? 'Loading…' : '⬢ Calculate'}
      </button>
    </div>
  )

  const results = (
    <div style={{ padding: wide ? '10px 12px' : '8px 10px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
      {!committed.ran ? (
        <span style={{ color: T.muted, fontSize: 11, fontFamily: T.label }}>Set inputs and press Calculate</span>
      ) : isLoading ? (
        <>
          <div style={{ display: 'flex', gap: 10 }}>
            {[1,2,3].map(i => <div key={i} style={{ ...shimmerStyle, height: 40, flex: 1 }} />)}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {[1,2].map(i => <div key={i} style={{ ...shimmerStyle, height: 40, flex: 1 }} />)}
          </div>
        </>
      ) : greeks ? (
        <>
          <div style={{ display: 'flex', gap: tall ? 16 : 10 }}>
            <Greek label="Price" value={`$${greeks.price.toFixed(2)}`} color={T.gold} />
            <Greek label="Delta" value={greeks.delta.toFixed(4)} />
            <Greek label="Gamma" value={greeks.gamma.toFixed(5)} />
          </div>
          <div style={{ display: 'flex', gap: tall ? 16 : 10 }}>
            <Greek label="Theta / day" value={`${greeks.theta < 0 ? '' : '+'}$${greeks.theta.toFixed(4)}`} color={greeks.theta < 0 ? T.neg : T.pos} />
            <Greek label="Vega / 1%" value={`$${greeks.vega.toFixed(4)}`} color={T.pos} />
          </div>
        </>
      ) : (
        <span style={{ color: T.muted, fontSize: 11, fontFamily: T.label }}>Enter valid inputs</span>
      )}
    </div>
  )

  return (
    <div ref={ref} style={{ background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Header */}
      <div style={{ background: T.headerBg, borderBottom: `1px solid ${T.border}`, padding: '6px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ color: T.gold, fontWeight: 700, fontSize: 11, letterSpacing: '0.08em' }}>{ticker} OPTIONS PRICER</span>
        <span style={{ color: T.muted, fontSize: 10, fontFamily: T.label }}>{spot > 0 ? `$${spot.toFixed(2)}` : isLoading ? 'Loading…' : '—'}</span>
      </div>

      {/* Body — horizontal when wide, vertical when narrow */}
      {wide ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 160, borderRight: `1px solid ${T.border}`, overflowY: 'auto', flexShrink: 0 }}>
            {controls}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {results}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {controls}
          <div style={{ borderTop: `1px solid ${T.border}` }}>
            {results}
          </div>
        </div>
      )}
    </div>
  )
}
