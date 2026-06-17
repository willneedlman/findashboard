import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import useContainerSize from '../../../hooks/useContainerSize'

const T = {
  bg:     'var(--theme-bg, #101c2e)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  gold:   'var(--theme-primary, #c9a84c)',
  text:   'var(--theme-text, #d7e3fc)',
  muted:  'var(--theme-secondary, #5e768f)',
  mono:   'var(--theme-mono)',
  pos:    '#22C55E', neg: '#EF4444',
}

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: `1px solid ${T.border}`,
  color: T.text, fontFamily: T.mono, fontSize: 11, padding: '4px 6px',
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
    price:  Math.max(0, price),
    delta:  isCall ? N(d1) : N(d1) - 1,
    gamma:  phi(d1) / (S * sigma * Math.sqrt(Ty)),
    theta:  (-(S*phi(d1)*sigma)/(2*Math.sqrt(Ty)) - r*K*Math.exp(-r*Ty)*(isCall?N(d2):N(-d2)))/365,
    vega:   S * phi(d1) * Math.sqrt(Ty) / 100,
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </div>
  )
}

function Greek({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
      <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ color: color ?? T.text, fontSize: 16, fontWeight: 700, fontFamily: T.mono }}>{value}</span>
    </div>
  )
}

export default function OptionsPricerWidget({ config }: { config: WidgetConfig }) {
  const [ticker,      setTicker]      = useState(config.ticker ?? 'SPY')
  const [tickerInput, setTickerInput] = useState(config.ticker ?? 'SPY')
  const [optionType,  setOptionType]  = useState<'call' | 'put'>(config.optionType ?? 'call')
  const [strike,      setStrike]      = useState(config.strike ?? 0)
  const [expDays,     setExpDays]     = useState(config.expDays ?? 30)
  const [vol,         setVol]         = useState(config.vol ?? 0)
  const [committed,   setCommitted]   = useState({
    optionType: config.optionType ?? 'call', strike: config.strike ?? 0,
    expDays: config.expDays ?? 30, vol: config.vol ?? 0, ran: false,
  })
  // Tracks a pending auto-fill triggered by →
  const fillRef      = useRef(false)
  const [filling,    setFilling]      = useState(false)
  const [justFilled, setJustFilled]   = useState(false)
  const { ref, width, height } = useContainerSize<HTMLDivElement>()

  // Follow the dashboard-wide ticker broadcast.
  useEffect(() => {
    if (config.ticker && config.ticker !== ticker) { setTicker(config.ticker); setTickerInput(config.ticker) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.ticker])

  const wide = width  >= 440
  const tall = height >= 320

  const { data, isLoading, isFetching } = useQuery<Record<string, unknown>>({
    queryKey: ['options-pricer-snap', ticker],
    queryFn:  () => axios.get('/api/options/snapshot?ticker=' + ticker).then(r => r.data),
    enabled:  !!ticker, staleTime: 600_000,
  })

  const spot       = (data?.spot ?? 0) as number
  const impliedVol = (data?.atm_iv ?? 0) as number

  const doFill = () => {
    setFilling(false)
    fillRef.current = false
    if (impliedVol > 0) setVol(Math.round(impliedVol * 10) / 10)
    setJustFilled(true)
    setTimeout(() => setJustFilled(false), 1800)
  }

  const handleFetch = () => {
    const t = tickerInput.trim()
    if (!t) return
    if (t === ticker && spot > 0) { doFill(); return }
    fillRef.current = true
    setFilling(true)
    setTicker(t)
  }

  // Auto-fill vol when data arrives; clear spinner even if IV unavailable
  useEffect(() => {
    if (!fillRef.current) return
    if (spot > 0) doFill()   // data loaded — fill vol if available, stop spinner regardless
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spot, impliedVol])

  const sigma  = committed.vol > 0 ? committed.vol / 100 : impliedVol / 100
  const K      = committed.strike > 0 ? committed.strike : spot
  const Ty     = committed.expDays / 365
  const greeks = committed.ran && spot > 0 && K > 0 && sigma > 0 && Ty > 0
    ? bsPrice(spot, K, Ty, 0.045, sigma, committed.optionType === 'call')
    : null
  const volLabel = vol > 0 ? `${vol}% manual` : impliedVol > 0 ? `${impliedVol.toFixed(1)}% IV` : '—'

  const runCalc = () => setCommitted({ optionType, strike, expDays, vol, ran: true })

  const fetchActive = filling || isFetching

  const toggleBtn = (type: 'call' | 'put'): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 11, fontFamily: T.mono, cursor: 'pointer',
    border: `1px solid ${T.border}`,
    background:  optionType === type ? T.gold  : 'var(--theme-bg, #0a1628)',
    color:       optionType === type ? 'var(--theme-bg, #101c2e)' : T.muted,
    fontWeight:  optionType === type ? 700 : 400,
    borderRadius: type === 'call' ? '3px 0 0 3px' : '0 3px 3px 0',
  })

  const controls = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: wide ? '10px 12px' : '8px 10px', flexShrink: 0 }}>

      {/* Ticker row */}
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={tickerInput}
          onChange={e => setTickerInput(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') handleFetch() }}
          style={{ ...inputStyle, flex: 1, textTransform: 'uppercase' }}
          placeholder="Ticker…"
        />
        <button
          onClick={handleFetch}
          disabled={fetchActive}
          style={{
            background: fetchActive
              ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 25%, transparent)'
              : justFilled
                ? 'color-mix(in srgb, var(--theme-positive) 20%, transparent)'
                : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
            border: `1px solid ${justFilled ? 'color-mix(in srgb, var(--theme-positive) 50%, transparent)' : T.border}`,
            color:   fetchActive ? T.muted : justFilled ? 'var(--theme-positive)' : T.gold,
            fontFamily: T.mono, fontSize: 10, padding: '4px 8px', cursor: fetchActive ? 'default' : 'pointer',
            transition: 'all 0.3s', minWidth: 28, textAlign: 'center',
          }}
        >
          {fetchActive ? '…' : justFilled ? 'OK' : 'Fill'}
        </button>
      </div>

      {/* Call / Put */}
      <div style={{ display: 'flex' }}>
        <button style={toggleBtn('call')} onClick={() => setOptionType('call')}>CALL</button>
        <button style={toggleBtn('put')}  onClick={() => setOptionType('put')}>PUT</button>
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
        <input type="number" style={{
          ...inputStyle,
          borderColor: justFilled && vol > 0 ? 'rgba(34,197,94,0.4)' : undefined,
        }}
          value={vol === 0 ? '' : vol}
          placeholder={impliedVol > 0 ? impliedVol.toFixed(1) : '—'}
          onChange={e => setVol(e.target.value === '' ? 0 : Math.max(0, +e.target.value))}
          onKeyDown={e => e.key === 'Enter' && runCalc()}
        />
      </Field>

      <button
        onClick={runCalc}
        disabled={isLoading || spot === 0}
        style={{
          background: justFilled
            ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 80%, #22C55E)'
            : isLoading || spot === 0
              ? 'rgba(201,168,76,0.3)'
              : T.gold,
          border: 'none', color: 'var(--theme-bg, #0a1628)', fontFamily: T.mono, fontSize: 10,
          fontWeight: 700, letterSpacing: '0.12em', padding: '6px 0',
          cursor: isLoading || spot === 0 ? 'not-allowed' : 'pointer',
          width: '100%', textTransform: 'uppercase' as const,
          transition: 'background 0.4s',
        }}
      >
        {isLoading ? 'Fetching IV…' : 'Calculate'}
      </button>
    </div>
  )

  const results = (
    <div style={{ padding: wide ? '10px 12px' : '8px 10px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
      {!committed.ran ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: T.muted, fontSize: 11, fontFamily: T.mono }}>Set inputs and press Calculate</span>
          {spot > 0 && (
            <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, opacity: 0.7 }}>
              Spot ${spot.toFixed(2)} · {impliedVol > 0 ? `IV ${impliedVol.toFixed(1)}%` : 'IV loading…'}
            </span>
          )}
        </div>
      ) : isLoading ? (
        <div style={{ display: 'flex', gap: 10 }}>
          {[1,2,3].map(i => <div key={i} style={{ height: 40, flex: 1, background: 'var(--theme-surface, #0d1826)', borderRadius: 2 }} />)}
        </div>
      ) : greeks ? (
        <>
          <div style={{ display: 'flex', gap: tall ? 16 : 10 }}>
            <Greek label="Price" value={`$${greeks.price.toFixed(2)}`}  color={T.gold} />
            <Greek label="Delta" value={greeks.delta.toFixed(4)} />
            <Greek label="Gamma" value={greeks.gamma.toFixed(5)} />
          </div>
          <div style={{ display: 'flex', gap: tall ? 16 : 10 }}>
            <Greek label="Theta / day" value={`${greeks.theta < 0 ? '' : '+'}$${greeks.theta.toFixed(4)}`} color={greeks.theta < 0 ? T.neg : T.pos} />
            <Greek label="Vega / 1%"  value={`$${greeks.vega.toFixed(4)}`} color={T.pos} />
          </div>
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
              {committed.optionType.toUpperCase()} · K=${K.toFixed(2)} · {committed.expDays}d · {(sigma * 100).toFixed(1)}% vol
            </span>
          </div>
        </>
      ) : (
        <span style={{ color: T.muted, fontSize: 11, fontFamily: T.mono }}>Enter valid inputs</span>
      )}
    </div>
  )

  return (
    <div ref={ref} style={{ background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {wide ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 162, borderRight: `1px solid ${T.border}`, overflowY: 'auto', flexShrink: 0 }}>
            {controls}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {results}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {controls}
          <div style={{ borderTop: `1px solid ${T.border}` }}>{results}</div>
        </div>
      )}
    </div>
  )
}
