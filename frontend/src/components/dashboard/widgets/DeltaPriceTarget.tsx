import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import useContainerSize from '../../../hooks/useContainerSize'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #142032)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
}

const shimmerStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 4,
}

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.10))', color: T.text,
  fontFamily: T.mono, fontSize: 11, padding: '4px 6px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}

// ── Black-Scholes helpers ─────────────────────────────────────────────────────

function normCDF(x: number): number {
  const a = 0.2316419
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429
  const t = 1 / (1 + a * Math.abs(x))
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))))
  const n = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
  const cdf = 1 - n * poly
  return x >= 0 ? cdf : 1 - cdf
}

function bsDelta(S: number, K: number, Ty: number, r: number, sigma: number, isCall: boolean): number {
  if (Ty <= 0) return isCall ? 1 : -1
  if (sigma <= 0 || K <= 0 || S <= 0) return 0
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * Ty) / (sigma * Math.sqrt(Ty))
  return isCall ? normCDF(d1) : normCDF(d1) - 1
}

/**
 * Binary-search for the strike whose |delta| equals targetDelta.
 *
 * Call delta  ∈ (0, 1)  — DECREASES as K rises (OTM call → delta near 0)
 *   → if |delta| too high, K is too low  → raise lo
 *
 * Put  delta  ∈ (-1, 0) — |delta| INCREASES as K rises (deep ITM put → |delta| near 1)
 *   → if |delta| too high, K is too high → lower hi
 */
function findStrikeForDelta(
  S: number, Ty: number, r: number, sigma: number,
  targetDelta: number, isCall: boolean,
): number {
  const absTgt = Math.abs(targetDelta)
  let lo = S * 0.1, hi = S * 4.0
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const absDelta = Math.abs(bsDelta(S, mid, Ty, r, sigma, isCall))
    if (isCall) {
      absDelta > absTgt ? lo = mid : hi = mid
    } else {
      absDelta > absTgt ? hi = mid : lo = mid
    }
  }
  return (lo + hi) / 2
}

const PRESETS = [0.10, 0.25, 0.40, 0.50]
const DEFAULT_VOL = 20  // fallback 20% when no IV available

export default function DeltaPriceTarget({ config }: { config: WidgetConfig }) {
  const [ticker, setTicker] = useState(config.ticker ?? 'SPY')
  const [tickerInput, setTickerInput] = useState(config.ticker ?? 'SPY')
  const [targetDelta, setTargetDelta] = useState(config.targetDelta ?? 0.25)
  const [expDays, setExpDays] = useState(config.expDays ?? 30)
  const [optionType, setOptionType] = useState<'call' | 'put'>(config.optionType ?? 'call')
  const [manualVol, setManualVol] = useState<number>(0)
  const fillIvRef   = useRef(false)
  const [filling,    setFilling]    = useState(false)
  const [justFilled, setJustFilled] = useState(false)
  const [committed, setCommitted] = useState({
    targetDelta: config.targetDelta ?? 0.25,
    expDays: config.expDays ?? 30,
    optionType: config.optionType ?? 'call',
    manualVol: 0,
    ran: false,
  })
  const { ref, width } = useContainerSize<HTMLDivElement>()

  const wide = width >= 440

  const { data, isLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['delta-target-snap', ticker],
    queryFn: () => axios.get('/api/options/snapshot?ticker=' + ticker).then(r => r.data),
    enabled: !!ticker, staleTime: 600_000,
  })

  const spot = (data?.spot ?? 0) as number
  const impliedVol = (data?.atm_iv ?? 0) as number

  const doFill = () => {
    setManualVol(Math.round(impliedVol * 10) / 10)
    fillIvRef.current = false
    setFilling(false)
    setJustFilled(true)
    setTimeout(() => setJustFilled(false), 1800)
  }

  const handleFetch = () => {
    const t = tickerInput.trim()
    if (!t) return
    if (t === ticker && impliedVol > 0) { doFill(); return }
    fillIvRef.current = true
    setFilling(true)
    setTicker(t)
  }

  useEffect(() => {
    if (fillIvRef.current && impliedVol > 0) doFill()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impliedVol])

  // Resolve sigma: manual → implied → 20% fallback
  const committedSigma = committed.manualVol > 0
    ? committed.manualVol / 100
    : impliedVol > 0
      ? impliedVol / 100
      : DEFAULT_VOL / 100

  const isCall = committed.optionType === 'call'
  const canCompute = committed.ran && spot > 0 && committed.expDays > 0
  const Ty = committed.expDays / 365

  const targetStrike = canCompute
    ? findStrikeForDelta(spot, Ty, 0.045, committedSigma, committed.targetDelta, isCall)
    : null

  const presetStrikes = canCompute
    ? PRESETS.map(d => ({ d, strike: findStrikeForDelta(spot, Ty, 0.045, committedSigma, d, isCall) }))
    : null

  const runCalc = () => setCommitted({ targetDelta, expDays, optionType, manualVol, ran: true })

  const volLabel = manualVol > 0 ? `${manualVol}% manual` : impliedVol > 0 ? `${impliedVol.toFixed(1)}% IV` : `${DEFAULT_VOL}% default`

  const toggleBtn = (type: 'call' | 'put'): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 11, fontFamily: T.mono, cursor: 'pointer',
    border: `1px solid ${T.border}`, background: optionType === type ? T.gold : 'var(--theme-bg, #0a1628)',
    color: optionType === type ? 'var(--theme-bg, #101c2e)' : T.muted, fontWeight: optionType === type ? 700 : 400,
    borderRadius: type === 'call' ? '3px 0 0 3px' : '0 3px 3px 0',
  })

  const controls = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: wide ? '10px 12px' : '8px 10px', flexShrink: 0 }}>
      {/* Ticker input */}
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
          disabled={filling}
          style={{
            background: filling
              ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 25%, transparent)'
              : justFilled
                ? 'color-mix(in srgb, var(--theme-positive) 20%, transparent)'
                : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
            border: `1px solid ${justFilled ? 'color-mix(in srgb, var(--theme-positive) 50%, transparent)' : T.border}`,
            color:  filling ? T.muted : justFilled ? 'var(--theme-positive)' : T.gold,
            fontFamily: T.mono, fontSize: 10, padding: '4px 8px',
            cursor: filling ? 'default' : 'pointer', transition: 'all 0.3s', minWidth: 28, textAlign: 'center' as const,
          }}
        >{filling ? '…' : justFilled ? 'OK' : 'Fill'}</button>
      </div>

      <div style={{ display: 'flex' }}>
        <button style={toggleBtn('call')} onClick={() => setOptionType('call')}>CALL</button>
        <button style={toggleBtn('put')} onClick={() => setOptionType('put')}>PUT</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Delta target</span>
        <input type="number" style={inputStyle} value={targetDelta} min={0.01} max={0.99} step={0.01}
          onChange={e => setTargetDelta(Math.min(0.99, Math.max(0.01, +e.target.value)))}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Expiry (days)</span>
        <input type="number" style={inputStyle} value={expDays} min={1}
          onChange={e => setExpDays(Math.max(1, +e.target.value))}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Vol % · {volLabel}
        </span>
        <input
          type="number" min={0} max={500} step={0.5}
          style={{ ...inputStyle, borderColor: justFilled && manualVol > 0 ? 'color-mix(in srgb, var(--theme-positive) 40%, transparent)' : undefined }}
          value={manualVol === 0 ? '' : manualVol}
          placeholder={impliedVol > 0 ? impliedVol.toFixed(1) : String(DEFAULT_VOL)}
          onChange={e => setManualVol(e.target.value === '' ? 0 : Math.max(0, +e.target.value))}
          onKeyDown={e => e.key === 'Enter' && runCalc()}
        />
      </div>

      <button
        onClick={runCalc}
        disabled={isLoading || spot === 0}
        style={{
          background: justFilled
            ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 80%, var(--theme-positive))'
            : isLoading || spot === 0 ? 'rgba(201,168,76,0.3)' : T.gold,
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: wide ? '10px 12px' : '8px 10px', gap: 10, overflowY: 'auto' }}>
      {/* Large strike display */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 0' }}>
        <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Target Strike</span>
        {!committed.ran
          ? <span style={{ color: T.muted, fontSize: 13, fontFamily: T.mono }}>Press Calculate</span>
          : isLoading
            ? <div style={{ ...shimmerStyle, height: 40, width: 140 }} />
            : targetStrike !== null
              ? <span style={{ color: T.gold, fontSize: 28, fontWeight: 700, fontFamily: T.mono, lineHeight: 1.1 }}>${targetStrike.toFixed(2)}</span>
              : <span style={{ color: T.muted, fontSize: 20, fontWeight: 700 }}>—</span>
        }
        <span style={{ color: T.muted, fontSize: 10, fontFamily: T.mono }}>
          Δ{committed.targetDelta.toFixed(2)}
          {spot > 0 && <> · Spot ${spot.toFixed(2)}</>}
          {' · '}{(committedSigma * 100).toFixed(1)}% vol
        </span>
      </div>

      {/* Preset chips */}
      <div>
        <div style={{ color: T.muted, fontSize: 9, fontFamily: T.mono, marginBottom: 6, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Common targets</div>
        <div style={{ display: 'flex', gap: 5 }}>
          {PRESETS.map((d, i) => {
            const ps = presetStrikes?.[i]
            const active = targetDelta === d
            return (
              <button key={d} onClick={() => setTargetDelta(d)} style={{
                flex: 1, padding: '5px 4px',
                background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, var(--theme-bg, #0a1628))' : 'var(--theme-bg, #0a1628)',
                border: `1px solid ${active ? T.gold : T.border}`, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              }}>
                <span style={{ color: active ? T.gold : T.muted, fontSize: 10, fontFamily: T.mono, fontWeight: active ? 700 : 400 }}>
                  Δ{d.toFixed(2)}
                </span>
                {isLoading
                  ? <div style={{ ...shimmerStyle, height: 12, width: '80%' }} />
                  : ps
                    ? <span style={{ color: active ? T.text : T.muted, fontSize: 10, fontFamily: T.mono }}>${ps.strike.toFixed(0)}</span>
                    : <span style={{ color: T.muted, fontSize: 10 }}>—</span>
                }
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )

  return (
    <div ref={ref} style={{ background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {wide ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 155, borderRight: `1px solid ${T.border}`, overflowY: 'auto', flexShrink: 0 }}>
            {controls}
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
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
