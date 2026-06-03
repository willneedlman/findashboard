import { useState, useMemo } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import axios from 'axios'

interface Leg {
  option_type: 'call' | 'put'
  action:      'buy' | 'sell'
  K: number; premium: number; quantity: number
  ticker: string
}

const DEFAULT_TICKER = 'SPY'
const mk = (type: Leg['option_type'], action: Leg['action'], K: number, premium: number): Leg =>
  ({ option_type: type, action, K, premium, quantity: 1, ticker: DEFAULT_TICKER })

const PRESETS: Record<string, Leg[]> = {
  'Long Call':     [mk('call', 'buy',  100, 3)],
  'Long Put':      [mk('put',  'buy',  100, 3)],
  'Bull Spread':   [mk('call', 'buy',  95, 6), mk('call', 'sell', 105, 2)],
  'Long Straddle': [mk('call', 'buy',  100, 3), mk('put',  'buy',  100, 3)],
  'Iron Condor':   [mk('put',  'buy',  85, 1), mk('put',  'sell', 90, 2),
                    mk('call', 'sell', 110, 2), mk('call', 'buy',  115, 1)],
}

const PRESET_DESC: Record<string, string> = {
  'Long Call':     'Bullish. Unlimited upside, capped loss at premium paid.',
  'Long Put':      'Bearish. Profit as price falls, max loss is premium.',
  'Bull Spread':   'Capped bull play — lower cost, lower max gain.',
  'Long Straddle': 'Profit from big move in either direction. Needs volatility.',
  'Iron Condor':   'Range-bound income. Max profit if price stays between short strikes.',
}

const LEG_COLORS = ['#1f5673', '#7b5ea7', '#d97736', '#2f6b4b', '#8c2e36']
const INPUT:  React.CSSProperties = { background: '#0a1628', border: '1px solid #4d4637', color: '#d7e3fc', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '4px 7px', outline: 'none' }
const SELECT: React.CSSProperties = { ...INPUT, cursor: 'pointer' }
const TOOLTIP_STYLE = { background: '#142032', border: '1px solid #4d4637', borderRadius: 0 }
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

// Pure intrinsic payoff at expiry — no Black-Scholes needed
function intrinsic(S: number, leg: Leg): number {
  const val = leg.option_type === 'call' ? Math.max(S - leg.K, 0) : Math.max(leg.K - S, 0)
  const sign = leg.action === 'buy' ? 1 : -1
  return sign * (val - leg.premium) * leg.quantity * 100
}

export default function StrategyBuilder() {
  const [legs, setLegs]         = useState<Leg[]>(PRESETS['Long Call'])
  const [preset, setPreset]     = useState('Long Call')
  const [fetching, setFetching] = useState<Record<number, boolean>>({})
  const [spotOverrides, setSpotOverrides] = useState<Record<string, number>>({})

  const uniqueTickers  = useMemo(() => [...new Set(legs.map(l => l.ticker))], [legs])
  const primaryTicker  = uniqueTickers[0] ?? DEFAULT_TICKER
  const secondaryTickers = uniqueTickers.slice(1)

  const getSpot    = (tk: string) => spotOverrides[tk] ?? legs.find(l => l.ticker === tk)?.K ?? 100
  const setPrimary = (v: number)  => setSpotOverrides(s => ({ ...s, [primaryTicker]: v }))

  // Fetch live spot + ATM premium from options chain
  const fetchSpotForLeg = async (i: number) => {
    const tk = legs[i].ticker.trim().toUpperCase()
    if (!tk) return
    setFetching(f => ({ ...f, [i]: true }))
    try {
      const [histResp, chainResp] = await Promise.allSettled([
        axios.get(`/api/market/history?ticker=${tk}&start=2024-01-01`),
        axios.get(`/api/options/chain?ticker=${tk}`),
      ])
      const spotPx: number | null = histResp.status === 'fulfilled'
        ? histResp.value.data?.metrics?.current_price ?? null : null
      if (!spotPx) return
      const atm = Math.round(spotPx)
      let premium = 2
      if (chainResp.status === 'fulfilled') {
        const side = legs[i].option_type === 'call'
          ? chainResp.value.data?.calls : chainResp.value.data?.puts
        if (side?.length) {
          const closest = [...side].sort((a: any, b: any) =>
            Math.abs(a.strike - spotPx) - Math.abs(b.strike - spotPx))[0]
          if (closest.bid > 0 && closest.ask > 0)
            premium = +((closest.bid + closest.ask) / 2).toFixed(2)
          else if (closest.lastPrice > 0)
            premium = +closest.lastPrice.toFixed(2)
        }
      }
      setLegs(p => p.map((l, idx) => idx === i ? { ...l, K: atm, premium } : l))
      setSpotOverrides(s => ({ ...s, [tk]: atm }))
    } catch { /* ignore */ }
    setFetching(f => ({ ...f, [i]: false }))
  }

  // Build expiry payoff chart data
  const chartData = useMemo(() => {
    const atm   = legs.find(l => l.ticker === primaryTicker)?.K ?? 100
    const spot  = getSpot(primaryTicker)
    const lo    = atm * 0.75
    const hi    = atm * 1.25
    const steps = 200

    // Secondary tickers contribute a fixed offset at their slider price
    const secondaryOffset = legs
      .filter(l => l.ticker !== primaryTicker)
      .reduce((sum, leg) => sum + intrinsic(getSpot(leg.ticker), leg), 0)

    const rows = Array.from({ length: steps + 1 }, (_, i) => {
      const S     = lo + (hi - lo) * (i / steps)
      const total = legs.filter(l => l.ticker === primaryTicker)
        .reduce((sum, leg) => sum + intrinsic(S, leg), 0) + secondaryOffset
      const row: Record<string, number> = {
        price:  +S.toFixed(2),
        total:  +total.toFixed(2),
        profit: +Math.max(total, 0).toFixed(2),
        loss:   +Math.min(total, 0).toFixed(2),
      }
      // Per-leg lines (primary ticker only)
      legs.filter(l => l.ticker === primaryTicker).forEach((leg, idx) => {
        row[`leg${idx}`] = +intrinsic(S, leg).toFixed(2)
      })
      return row
    })

    const allVals = rows.map(r => r.total)
    const rawMin  = Math.min(...allVals)
    const rawMax  = Math.max(...allVals)
    const maxRisk = Math.max(Math.abs(rawMin), 50)
    const yMax    = Math.ceil(Math.min(rawMax, maxRisk * 3) * 1.12)
    const yMin    = Math.floor(rawMin * 1.12)

    // Breakeven prices (zero-crossings)
    const breakevens: number[] = []
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].total * rows[i + 1].total < 0) {
        const x = rows[i].price + (0 - rows[i].total) *
          (rows[i + 1].price - rows[i].price) / (rows[i + 1].total - rows[i].total)
        breakevens.push(+x.toFixed(2))
      }
    }

    return { rows, atm, spot, yMin, yMax, breakevens, lo, hi, pct: (spot - atm) / atm * 100 }
  }, [legs, spotOverrides, primaryTicker])

  const primaryLegs = legs.filter(l => l.ticker === primaryTicker)

  const addLeg    = () => setLegs(p => [...p, mk('call', 'buy', getSpot(DEFAULT_TICKER), 2)])
  const removeLeg = (i: number) => setLegs(p => p.filter((_, j) => j !== i))
  const updateLeg = (i: number, k: keyof Leg, v: string | number) =>
    setLegs(p => p.map((l, idx) => idx === i ? { ...l, [k]: v } : l))

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={210} sidebarTitle="Strategy Builder" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Strategy Builder</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflowY: 'auto' }}>

            {/* Presets */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 5 }}>Presets</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {Object.keys(PRESETS).map(name => (
                  <button key={name} onClick={() => { setPreset(name); setLegs(PRESETS[name]); setSpotOverrides({}) }} style={{
                    padding: '6px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                    background: preset === name ? 'rgba(201,168,76,0.12)' : 'transparent',
                    border: `1px solid ${preset === name ? '#c9a84c' : '#2e394d'}`,
                    color: preset === name ? '#c9a84c' : '#4d4637', cursor: 'pointer', textAlign: 'left',
                  }}>
                    <div>{name}</div>
                    <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.03em', textTransform: 'none', color: preset === name ? '#99907e' : '#3a4555', marginTop: 2, lineHeight: '12px' }}>
                      {PRESET_DESC[name]}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Legs */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e' }}>Legs ({legs.length})</div>
                <button onClick={addLeg} style={{ fontSize: 10, color: '#c9a84c', background: 'none', border: 'none', cursor: 'pointer' }}>+ ADD</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {legs.map((leg, i) => (
                  <div key={i} style={{ background: '#0a1628', border: `1px solid ${LEG_COLORS[i % LEG_COLORS.length]}44`, padding: 7 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: leg.action === 'buy' ? '#22C55E' : '#EF4444', textTransform: 'uppercase' }}>
                        LEG {i + 1}
                      </span>
                      <button onClick={() => removeLeg(i)} style={{ fontSize: 12, color: '#4d4637', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                    </div>

                    {/* Ticker + fetch — use min-width: 0 on input to prevent overflow */}
                    <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
                      <input value={leg.ticker} placeholder="TICKER"
                        onChange={e => updateLeg(i, 'ticker', e.target.value.toUpperCase())}
                        style={{ ...INPUT, flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}
                        onFocus={e => (e.target.style.borderColor = '#c9a84c')}
                        onBlur={e => (e.target.style.borderColor = '#4d4637')}
                        onKeyDown={e => e.key === 'Enter' && fetchSpotForLeg(i)}
                      />
                      <button onClick={() => fetchSpotForLeg(i)} disabled={fetching[i] || !leg.ticker.trim()}
                        title="Fetch live spot price and ATM premium"
                        style={{
                          background: '#142032', border: '1px solid #4d4637',
                          color: fetching[i] ? '#4d4637' : '#c9a84c',
                          fontSize: 14, padding: '0 8px', cursor: fetching[i] ? 'default' : 'pointer',
                          flexShrink: 0, lineHeight: 1,
                        }}>
                        {fetching[i] ? '…' : '↓'}
                      </button>
                    </div>

                    {/* Type / Action */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 4 }}>
                      <select value={leg.option_type} onChange={e => updateLeg(i, 'option_type', e.target.value)} style={{ ...SELECT, fontSize: 11 }}>
                        <option value="call">Call</option>
                        <option value="put">Put</option>
                      </select>
                      <select value={leg.action} onChange={e => updateLeg(i, 'action', e.target.value)} style={{ ...SELECT, fontSize: 11 }}>
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                      </select>
                    </div>

                    {/* Strike / Premium / Qty */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                      {[
                        { label: 'STRIKE',  key: 'K',       step: 1,    val: leg.K },
                        { label: 'PREMIUM', key: 'premium', step: 0.25, val: leg.premium },
                        { label: 'QTY',     key: 'quantity',step: 1,    val: leg.quantity },
                      ].map(f => (
                        <div key={f.key}>
                          <div style={{ fontSize: 9, color: '#4d4637', marginBottom: 2 }}>{f.label}</div>
                          <input type="number" value={f.val} step={f.step} min={f.key === 'quantity' ? 1 : undefined}
                            onChange={e => updateLeg(i, f.key as keyof Leg, f.key === 'quantity' ? Math.max(1, +e.target.value) : +e.target.value)}
                            style={{ ...INPUT, width: '100%', fontSize: 11 }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>}>

        {/* ── Right: payoff chart ── */}

          {/* Expiry Payoff Diagram */}
          <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'rgba(46,57,77,0.8)', padding: '3px 8px', borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc' }}>
              {primaryTicker} P&L at Expiry
            </div>
            <div style={{ position: 'absolute', top: 0, right: 0, padding: '3px 8px', fontSize: 10, color: '#4d4637', zIndex: 10 }}>
              per contract (×100 shares) · intrinsic only
            </div>

            <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 0, height: 340 }}>
              <ResponsiveContainer width="100%" height={312}>
                <ComposedChart data={chartData.rows} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="price" tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                  <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right"
                    domain={[chartData.yMin, chartData.yMax]} />
                  <Tooltip formatter={(v: number, name: string) => [`$${(+v).toFixed(2)}`, name === 'total' ? 'Total P&L' : name]}
                    labelFormatter={v => `${primaryTicker} @ $${(+v).toFixed(2)}`} contentStyle={TOOLTIP_STYLE} />

                  {/* Green profit zone */}
                  <Area type="monotone" dataKey="profit" fill="rgba(47,107,75,0.25)" stroke="none" />
                  {/* Red loss zone */}
                  <Area type="monotone" dataKey="loss"   fill="rgba(140,46,54,0.25)"  stroke="none" />

                  {/* Breakeven line */}
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" strokeWidth={1} strokeDasharray="4 4" />

                  {/* Strike reference lines */}
                  {[...new Set(primaryLegs.map(l => l.K))].map(K => (
                    <ReferenceLine key={K} x={K} stroke="rgba(201,168,76,0.3)" strokeDasharray="3 4"
                      label={{ value: `$${K}`, fill: '#c9a84c', fontSize: 8, position: 'insideTopRight' }} />
                  ))}

                  {/* Spot marker */}
                  <ReferenceLine x={chartData.spot} stroke="rgba(217,119,54,0.7)" strokeWidth={1.5} strokeDasharray="4 2" />

                  {/* Breakeven markers */}
                  {chartData.breakevens.map((be, i) => (
                    <ReferenceLine key={i} x={be} stroke="rgba(255,255,255,0.25)" strokeDasharray="2 4"
                      label={{ value: `BE $${be}`, fill: '#99907e', fontSize: 8, position: 'insideTopLeft' }} />
                  ))}

                  {/* Per-leg dashed contributions */}
                  {primaryLegs.map((_, idx) => (
                    <Line key={idx} type="monotone" dataKey={`leg${idx}`} stroke={LEG_COLORS[idx % LEG_COLORS.length]}
                      strokeWidth={1} strokeDasharray="5 3" dot={false} name={`Leg ${idx + 1}`} legendType="none" />
                  ))}

                  {/* Total P&L — main gold line */}
                  <Line type="monotone" dataKey="total" stroke="#c9a84c" strokeWidth={2.5} dot={false} name="total" legendType="none" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Spot price slider */}
            <div style={{ padding: '8px 14px 12px', borderTop: '1px solid #2e394d' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#99907e', whiteSpace: 'nowrap', width: 68 }}>
                  {primaryTicker} Spot
                </span>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <input type="range"
                    min={+(chartData.atm * 0.75).toFixed(2)}
                    max={+(chartData.atm * 1.25).toFixed(2)}
                    step={0.5} value={chartData.spot}
                    onChange={e => setPrimary(+e.target.value)}
                    style={{ width: '100%', accentColor: '#c9a84c' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    {[-20, -10, 0, +10, +20].map(p => (
                      <button key={p} onClick={() => setPrimary(+(chartData.atm * (1 + p / 100)).toFixed(2))}
                        style={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                          color: p === 0 ? '#c9a84c' : p < 0 ? '#EF4444' : '#22C55E',
                          background: 'none', border: '1px solid #2e394d', padding: '2px 5px', cursor: 'pointer' }}>
                        {p === 0 ? 'ATM' : `${p > 0 ? '+' : ''}${p}%`}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 700, color: '#c9a84c' }}>
                    ${chartData.spot.toFixed(2)}
                  </div>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: chartData.pct >= 0 ? '#22C55E' : '#EF4444' }}>
                    {chartData.pct >= 0 ? '+' : ''}{chartData.pct.toFixed(1)}% vs ATM
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Secondary ticker sliders */}
          {secondaryTickers.length > 0 && (
            <div style={{ background: '#101c2e', border: '1px solid #2e394d' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
                  Secondary Ticker Prices at Expiry
                </span>
              </div>
              <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {secondaryTickers.map(tk => {
                  const atm  = legs.find(l => l.ticker === tk)?.K ?? 100
                  const spot = getSpot(tk)
                  const pct  = (spot - atm) / atm * 100
                  return (
                    <div key={tk}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#c9a84c', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{tk}</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: pct >= 0 ? '#22C55E' : '#EF4444' }}>
                          ${spot.toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)
                        </span>
                      </div>
                      <input type="range" min={+(atm * 0.75).toFixed(2)} max={+(atm * 1.25).toFixed(2)} step={0.5} value={spot}
                        onChange={e => setSpotOverrides(s => ({ ...s, [tk]: +e.target.value }))}
                        style={{ width: '100%', accentColor: '#c9a84c' }} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Leg summary + breakeven */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {legs.map((leg, i) => (
              <span key={i} style={{ fontSize: 10, padding: '3px 8px', fontFamily: 'JetBrains Mono, monospace',
                border: `1px solid ${LEG_COLORS[i % LEG_COLORS.length]}`,
                color: LEG_COLORS[i % LEG_COLORS.length] }}>
                {leg.action === 'buy' ? '▲' : '▼'} {leg.ticker} {leg.option_type.toUpperCase()} K={leg.K} @ ${leg.premium} ×{leg.quantity}
              </span>
            ))}
            {chartData.breakevens.length > 0 && (
              <span style={{ fontSize: 10, padding: '3px 8px', fontFamily: 'JetBrains Mono, monospace', color: '#99907e', border: '1px solid #2e394d' }}>
                BE: {chartData.breakevens.map(b => `$${b}`).join(' / ')}
              </span>
            )}
          </div>
      </SidebarLayout>
    </PageWrapper>
  )
}
