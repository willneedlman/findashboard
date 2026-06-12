import { useState, useMemo, useEffect } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import axios from 'axios'

interface Leg {
  option_type: 'call' | 'put'
  action:      'buy' | 'sell'
  K: number; premium: number; quantity: number
  ticker: string
  expiry: string
}

interface GreekPos {
  ticker: string; strike: number; expiry: string; dte: number; spot: number
  option_type: string; position_type: string; qty: number
  delta: number; gamma: number; theta: number; vega: number
  scaled_delta: number; scaled_gamma: number; scaled_theta: number; scaled_vega: number
}
interface GreekResult {
  positions: GreekPos[]
  net: { delta: number; gamma: number; theta: number; vega: number }
}

const DEFAULT_TICKER  = 'SPY'
const DEFAULT_EXPIRY  = (() => {
  const d = new Date(); d.setMonth(d.getMonth() + 2); return d.toISOString().slice(0, 10)
})()
const mk = (type: Leg['option_type'], action: Leg['action'], K: number, premium: number, qty = 1): Leg =>
  ({ option_type: type, action, K, premium, quantity: qty, ticker: DEFAULT_TICKER, expiry: DEFAULT_EXPIRY })

// Round to nearest options strike increment based on spot price
function roundToStrike(k: number, spot: number): number {
  const inc = spot >= 500 ? 5 : spot >= 100 ? 2.5 : spot >= 20 ? 1 : 0.5
  return Math.round(k / inc) * inc
}

// Scale PRESET strikes (authored around spot=100) to actual spot
function scalePreset(legs: Leg[], spot: number): Leg[] {
  if (!spot || spot <= 0) return legs
  return legs.map(l => ({ ...l, K: roundToStrike((l.K / 100) * spot, spot) }))
}

const GREEK_COLORS: Record<string, string> = {
  delta: 'var(--theme-tertiary)', gamma: 'var(--theme-positive)', theta: 'var(--theme-negative)', vega: '#a78bfa',
}

const PRESETS: Record<string, Leg[]> = {
  // Single Leg
  'Long Call':          [mk('call', 'buy',  100, 3)],
  'Long Put':           [mk('put',  'buy',  100, 3)],
  'Short Put':          [mk('put',  'sell',  95, 2)],
  'Short Call':         [mk('call', 'sell', 105, 2)],
  // Vertical Spreads
  'Bull Call Spread':   [mk('call', 'buy',  95, 6),  mk('call', 'sell', 105, 2)],
  'Bear Put Spread':    [mk('put',  'buy', 105, 6),  mk('put',  'sell',  95, 2)],
  'Bull Put Spread':    [mk('put',  'sell', 100, 4), mk('put',  'buy',   90, 1.5)],
  'Bear Call Spread':   [mk('call', 'sell', 100, 4), mk('call', 'buy',  110, 1.5)],
  // Volatility
  'Long Straddle':      [mk('call', 'buy',  100, 3), mk('put',  'buy',  100, 3)],
  'Long Strangle':      [mk('put',  'buy',   90, 1.5), mk('call', 'buy', 110, 1.5)],
  'Short Straddle':     [mk('call', 'sell', 100, 3), mk('put',  'sell', 100, 3)],
  'Short Strangle':     [mk('put',  'sell',  90, 1.5), mk('call', 'sell', 110, 1.5)],
  // Butterfly
  'Call Butterfly':     [mk('call', 'buy',   90, 8), mk('call', 'sell', 100, 3, 2), mk('call', 'buy',  110, 1)],
  'Put Butterfly':      [mk('put',  'buy',  110, 8), mk('put',  'sell', 100, 3, 2), mk('put',  'buy',   90, 1)],
  'Iron Butterfly':     [mk('put',  'buy',   85, 0.5), mk('put',  'sell', 100, 3), mk('call', 'sell', 100, 3), mk('call', 'buy',  115, 0.5)],
  // Condor
  'Iron Condor':        [mk('put',  'buy',   85, 1), mk('put',  'sell',  90, 2), mk('call', 'sell', 110, 2), mk('call', 'buy',  115, 1)],
  'Long Condor':        [mk('call', 'buy',   90, 8), mk('call', 'sell',  95, 5), mk('call', 'sell', 105, 2), mk('call', 'buy',  110, 1)],
  'Rev. Iron Condor':   [mk('put',  'sell',  85, 1), mk('put',  'buy',   90, 2), mk('call', 'buy',  110, 2), mk('call', 'sell', 115, 1)],
  // Ratio / Advanced
  'Call Ratio 1x2':     [mk('call', 'buy',  100, 3), mk('call', 'sell', 110, 1.5, 2)],
  'Risk Reversal':      [mk('put',  'sell',  95, 2), mk('call', 'buy',  105, 2)],
  'Jade Lizard':        [mk('put',  'sell',  90, 1.5), mk('call', 'sell', 110, 1.5), mk('call', 'buy', 115, 0.75)],
  'Synthetic Long':     [mk('call', 'buy',  100, 3), mk('put',  'sell', 100, 3)],
}

const PRESET_DESC: Record<string, string> = {
  'Long Call':         'Bullish. Unlimited upside, capped loss at premium paid.',
  'Long Put':          'Bearish. Profit as price falls, max loss is premium.',
  'Short Put':         'Bullish/neutral. Collect premium; obligated to buy at strike if assigned.',
  'Short Call':        'Bearish/neutral. Collect premium; unlimited risk if price rises.',
  'Bull Call Spread':  'Debit spread. Capped bull play — lower cost, lower max gain.',
  'Bear Put Spread':   'Debit spread. Profit from decline; cost and gain are capped.',
  'Bull Put Spread':   'Credit spread. Keep premium if stock stays above short strike.',
  'Bear Call Spread':  'Credit spread. Keep premium if stock stays below short strike.',
  'Long Straddle':     'Profit from big move either direction. Needs volatility.',
  'Long Strangle':     'Cheaper straddle. Needs larger move; lower premium at risk.',
  'Short Straddle':    'Sell ATM call + put. Max income if price pins at strike.',
  'Short Strangle':    'Sell OTM call + put. Wider profit zone than short straddle.',
  'Call Butterfly':    'Profit if price pins near middle strike. Low cost, capped.',
  'Put Butterfly':     'Same payoff as call butterfly but constructed with puts.',
  'Iron Butterfly':    'Short straddle with wings. Defined risk version of short straddle.',
  'Iron Condor':       'Range-bound income. Max profit if price stays between short strikes.',
  'Long Condor':       'Profit if price lands in middle zone. Lower cost than butterfly.',
  'Rev. Iron Condor':  'Long strangle with short wings. Profit from large move, defined risk.',
  'Call Ratio 1x2':    'Mildly bullish. Profit window above long strike; risk if underlying surges.',
  'Risk Reversal':     'Synthetic long exposure. Bullish with minimal net premium.',
  'Jade Lizard':       'Short OTM put + short call spread. No upside loss; income in range.',
  'Synthetic Long':    'Replicates long stock. Unlimited upside and downside from ATM.',
}

const PRESET_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Single Leg',        keys: ['Long Call', 'Long Put', 'Short Put', 'Short Call'] },
  { label: 'Vertical Spreads',  keys: ['Bull Call Spread', 'Bear Put Spread', 'Bull Put Spread', 'Bear Call Spread'] },
  { label: 'Volatility',        keys: ['Long Straddle', 'Long Strangle', 'Short Straddle', 'Short Strangle'] },
  { label: 'Butterfly',         keys: ['Call Butterfly', 'Put Butterfly', 'Iron Butterfly'] },
  { label: 'Condor',            keys: ['Iron Condor', 'Long Condor', 'Rev. Iron Condor'] },
  { label: 'Ratio / Advanced',  keys: ['Call Ratio 1x2', 'Risk Reversal', 'Jade Lizard', 'Synthetic Long'] },
]

const LEG_COLORS = ['#1f5673', '#7b5ea7', '#d97736', '#2f6b4b', '#8c2e36']

const LS_KEY = 'ft_pending_option_strategy'

function toOCC(ticker: string, expiry: string, type: 'call' | 'put', strike: number): string {
  const d = new Date(expiry + 'T12:00:00')
  const yy = String(d.getFullYear()).slice(2).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const cp = type === 'call' ? 'C' : 'P'
  const stk = String(Math.round(strike * 1000)).padStart(8, '0')
  return `${ticker.toUpperCase()}${yy}${mm}${dd}${cp}${stk}`
}

export interface PendingOptionStrategy {
  name: string
  underlying: string
  orderType: 'debit' | 'credit' | 'market'
  legs: { occ: string; side: 'buy_to_open' | 'sell_to_open'; qty: string; hint: string }[]
  savedAt: number
}
const INPUT:  React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '4px 7px', outline: 'none' }
const SELECT: React.CSSProperties = { ...INPUT, cursor: 'pointer' }

interface LegChain {
  expiries:       string[]
  selectedExpiry: string
  calls:          any[]
  puts:           any[]
  spot:           number | null
  loading:        boolean
}

function fmtExpiry(exp: string): string {
  const d = new Date(exp + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const TOOLTIP_STYLE = { background: 'var(--theme-surface, #142032)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderRadius: 0 }
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

// Pure intrinsic payoff at expiry — no Black-Scholes needed
function intrinsic(S: number, leg: Leg): number {
  const val = leg.option_type === 'call' ? Math.max(S - leg.K, 0) : Math.max(leg.K - S, 0)
  const sign = leg.action === 'buy' ? 1 : -1
  return sign * (val - leg.premium) * leg.quantity * 100
}

export default function StrategyBuilder() {
  const [legs, setLegs]               = useState<Leg[]>(PRESETS['Long Call'])
  const [preset, setPreset]           = useState('Long Call')
  const [openGroups, setOpenGroups]   = useState<Record<string, boolean>>(
    Object.fromEntries(PRESET_GROUPS.map(g => [g.label, g.label === 'Single Leg']))
  )
  const [spotOverrides, setSpotOverrides] = useState<Record<string, number>>({})
  const [greekResult, setGreekResult] = useState<GreekResult | null>(null)
  const [greekLoading, setGreekLoading] = useState(false)
  const [greekError, setGreekError]   = useState<string | null>(null)
  const [aiNarrative, setAiNarrative] = useState<any>(null)
  const [aiNarrativePending, setAiNarrativePending] = useState(false)
  const [sentToPaperTrader, setSentToPaperTrader] = useState(false)
  const [legChains, setLegChains]     = useState<Record<number, LegChain>>({})

  const uniqueTickers    = useMemo(() => [...new Set(legs.map(l => l.ticker))], [legs])
  const primaryTicker    = uniqueTickers[0] ?? DEFAULT_TICKER
  const secondaryTickers = uniqueTickers.slice(1)

  const getSpot    = (tk: string) => spotOverrides[tk] ?? legs.find(l => l.ticker === tk)?.K ?? 100
  const setPrimary = (v: number)  => setSpotOverrides(s => ({ ...s, [primaryTicker]: v }))

  const setChain = (i: number, patch: Partial<LegChain>) =>
    setLegChains(c => ({ ...c, [i]: { ...c[i], ...patch } }))

  // On mount: fetch spot for default ticker and rescale initial preset strikes
  useEffect(() => {
    axios.get(`/api/options/chain?ticker=${DEFAULT_TICKER}`).then(res => {
      const spot: number | null = res.data.spot ?? null
      if (!spot) return
      setSpotOverrides(s => ({ ...s, [DEFAULT_TICKER]: spot }))
      setLegs(prev => scalePreset(PRESETS['Long Call'].map((l, i) => ({ ...prev[i], ...l })), spot))
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch full options chain for a leg — populates contract picker
  const fetchSpotForLeg = async (i: number) => {
    const tk = legs[i].ticker.trim().toUpperCase()
    if (!tk) return
    setChain(i, { loading: true })
    try {
      const res = await axios.get(`/api/options/chain?ticker=${tk}`)
      const d   = res.data
      const spot: number | null = d.spot ?? null
      setChain(i, {
        loading:        false,
        expiries:       d.expirations ?? [],
        selectedExpiry: d.expiry ?? '',
        calls:          d.calls ?? [],
        puts:           d.puts  ?? [],
        spot,
      })
      // Update leg with nearest ATM + expiry
      if (d.expiry) {
        const side = legs[i].option_type === 'call' ? d.calls : d.puts
        const atm  = spot ? min_strike(side, spot) : null
        setLegs(p => p.map((l, idx) => idx !== i ? l : {
          ...l,
          expiry: d.expiry,
          ...(atm ? { K: atm.strike, premium: mid(atm) } : {}),
        }))
        if (spot) setSpotOverrides(s => ({ ...s, [tk]: spot }))
        setActiveChainLeg(i)
        setDateInput(d.expiry)
      }
    } catch {
      setChain(i, { loading: false })
    }
  }

  // Switch expiry for an existing chain — reload contracts
  const fetchExpiry = async (i: number, expiry: string) => {
    const tk = legs[i].ticker.trim().toUpperCase()
    setChain(i, { loading: true, selectedExpiry: expiry })
    try {
      const res = await axios.get(`/api/options/chain?ticker=${tk}&expiry=${expiry}`)
      const d   = res.data
      setChain(i, { loading: false, calls: d.calls ?? [], puts: d.puts ?? [] })
      updateLeg(i, 'expiry', expiry)
    } catch {
      setChain(i, { loading: false })
    }
  }

  // Click a contract row → fill leg fields
  const selectContract = (i: number, contract: any) => {
    const premium = contract.bid > 0 && contract.ask > 0
      ? +((contract.bid + contract.ask) / 2).toFixed(2)
      : +(contract.lastPrice || 0.01).toFixed(2)
    setLegs(p => p.map((l, idx) => idx !== i ? l : { ...l, K: contract.strike, premium }))
  }

  // Helpers
  function mid(c: any): number {
    return c.bid > 0 && c.ask > 0 ? +((c.bid + c.ask) / 2).toFixed(2) : +(c.lastPrice || 0.01).toFixed(2)
  }
  function min_strike(contracts: any[], spot: number) {
    if (!contracts?.length) return null
    return [...contracts].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0]
  }

  // Build expiry payoff chart data — 80 steps keeps rendering fast while looking smooth
  const chartData = useMemo(() => {
    const atm   = legs.find(l => l.ticker === primaryTicker)?.K ?? 100
    const spot  = getSpot(primaryTicker)
    const lo    = atm * 0.75
    const hi    = atm * 1.25
    const steps = 80

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
  }, [legs, spotOverrides, primaryTicker]) // spotOverrides intentional — live updates

  const primaryLegs = legs.filter(l => l.ticker === primaryTicker)

  // Chain picker state
  const [activeChainLeg, setActiveChainLeg] = useState<number | null>(null)
  const [strikeCount,    setStrikeCount]    = useState(10)
  const [dateInput,      setDateInput]      = useState('')

  const activeChain = activeChainLeg !== null ? legChains[activeChainLeg] : null

  // Snap typed date to nearest available expiry
  const snapToExpiry = (raw: string, legIdx: number) => {
    const expiries = legChains[legIdx]?.expiries ?? []
    if (!expiries.length || !raw) return
    const target = new Date(raw + 'T12:00:00').getTime()
    const closest = expiries.reduce((best, exp) =>
      Math.abs(new Date(exp + 'T12:00:00').getTime() - target) <
      Math.abs(new Date(best + 'T12:00:00').getTime() - target) ? exp : best
    )
    fetchExpiry(legIdx, closest)
    setDateInput(closest)
  }

  // DTE from expiry string
  const dte = (exp: string) => {
    const d = Math.round((new Date(exp + 'T12:00:00').getTime() - Date.now()) / 86400000)
    return Math.max(d, 0)
  }

  const sendToPaperTrader = () => {
    const allBuy = legs.every(l => l.action === 'buy')
    const allSell = legs.every(l => l.action === 'sell')
    const orderType: PendingOptionStrategy['orderType'] =
      legs.length === 1 ? 'market' :
      allBuy ? 'debit' :
      allSell ? 'credit' :
      legs.filter(l => l.action === 'sell').length > legs.filter(l => l.action === 'buy').length ? 'credit' : 'debit'

    const pending: PendingOptionStrategy = {
      name: preset,
      underlying: primaryTicker,
      orderType,
      legs: legs.map(l => ({
        occ:  toOCC(l.ticker, l.expiry, l.option_type, l.K),
        side: l.action === 'buy' ? 'buy_to_open' : 'sell_to_open',
        qty:  String(l.quantity),
        hint: `${l.action.toUpperCase()} ${l.option_type.toUpperCase()} K=${l.K} exp=${l.expiry}`,
      })),
      savedAt: Date.now(),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(pending))
    setSentToPaperTrader(true)
    setTimeout(() => setSentToPaperTrader(false), 3000)
  }

  const calculateGreeks = async () => {
    const valid = legs.filter(l => l.ticker && l.K && l.expiry)
    if (!valid.length) { setGreekError('Each leg needs a ticker, strike, and expiry.'); return }
    setGreekLoading(true); setGreekError(null)
    try {
      const res = await axios.post('/api/options/aggregate-greeks', {
        positions: valid.map(l => ({
          ticker:        l.ticker.toUpperCase(),
          strike:        l.K,
          expiry:        l.expiry,
          qty:           l.quantity,
          option_type:   l.option_type,
          position_type: l.action === 'buy' ? 'long' : 'short',
        })),
      })
      setGreekResult(res.data)
    } catch { setGreekError('Calculation failed — check ticker symbols and expiry dates.') }
    finally { setGreekLoading(false) }
  }

  const addLeg    = () => setLegs(p => [...p, mk('call', 'buy', getSpot(DEFAULT_TICKER), 2)])
  const removeLeg = (i: number) => {
    setLegs(p => p.filter((_, j) => j !== i))
    setLegChains(prev => {
      const next: Record<number, LegChain> = {}
      Object.entries(prev).forEach(([k, v]) => {
        const idx = parseInt(k)
        if (idx < i) next[idx] = v
        else if (idx > i) next[idx - 1] = v
      })
      return next
    })
  }
  const updateLeg = (i: number, k: keyof Leg, v: string | number) =>
    setLegs(p => p.map((l, idx) => idx === i ? { ...l, [k]: v } : l))

  return (
    <PageWrapper title="Strategy Builder">
      <SidebarLayout sidebarWidth={210} sidebarTitle="Parameters" sidebar={<>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflowY: 'auto' }}>

            {/* Presets */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 6 }}>Presets</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {PRESET_GROUPS.map(group => (
                  <div key={group.label}>
                    <button
                      onClick={() => setOpenGroups(s => ({ ...s, [group.label]: !s[group.label] }))}
                      style={{
                        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '5px 6px', marginBottom: 2, background: 'var(--theme-hover, rgba(255,255,255,0.03))',
                        border: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                        cursor: 'pointer', color: 'var(--theme-secondary, #5e768f)',
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                      }}
                    >
                      <span>{group.label}</span>
                      <span style={{ fontSize: 8, opacity: 0.6 }}>{openGroups[group.label] ? '▲' : '▼'}</span>
                    </button>
                    {openGroups[group.label] && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4, paddingLeft: 4 }}>
                        {group.keys.map(name => (
                          <button key={name} onClick={() => {
                            setPreset(name)
                            setLegs(scalePreset(PRESETS[name], getSpot(primaryTicker)))
                            setSpotOverrides({})
                            setLegChains({})
                            setOpenGroups(s => ({ ...s, [group.label]: true }))
                          }} style={{
                            padding: '5px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                            background: preset === name ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' : 'transparent',
                            border: `1px solid ${preset === name ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.07))'}`,
                            color: preset === name ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #5e768f)',
                            cursor: 'pointer', textAlign: 'left',
                          }}>
                            <div>{name}</div>
                            <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none', color: preset === name ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.15)', marginTop: 2, lineHeight: '12px' }}>
                              {PRESET_DESC[name]}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Send to Paper Trader */}
              <button
                onClick={sendToPaperTrader}
                style={{
                  marginTop: 8, width: '100%', padding: '7px 8px',
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                  cursor: 'pointer', border: '1px solid',
                  borderColor: sentToPaperTrader ? 'var(--theme-positive)' : 'rgba(201,168,76,0.5)',
                  background: sentToPaperTrader ? 'color-mix(in srgb, var(--theme-positive) 12%, transparent)' : 'rgba(201,168,76,0.07)',
                  color: sentToPaperTrader ? 'var(--theme-positive)' : 'var(--theme-primary, #c9a84c)',
                  transition: 'all 0.2s',
                }}
              >
                {sentToPaperTrader ? 'Sent — approve in Paper Trader' : 'Send to Paper Trader'}
              </button>
              {sentToPaperTrader && (
                <a href="/paper-trading" style={{ display: 'block', marginTop: 4, fontSize: 9, color: 'var(--theme-positive)',
                  fontFamily: 'var(--theme-mono)', textAlign: 'center', textDecoration: 'underline' }}>
                  Go to Paper Trader ↗
                </a>
              )}
            </div>

            {/* Legs */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>Legs ({legs.length})</div>
                <button onClick={addLeg} style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', background: 'none', border: 'none', cursor: 'pointer' }}>+ ADD</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {legs.map((leg, i) => (
                  <div key={i} style={{ background: 'var(--theme-bg, #0a1628)', border: `1px solid ${LEG_COLORS[i % LEG_COLORS.length]}44`, padding: 7 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: leg.action === 'buy' ? 'var(--theme-positive)' : 'var(--theme-negative)', textTransform: 'uppercase' }}>
                        LEG {i + 1}
                      </span>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        {legChains[i]?.expiries?.length > 0 && (
                          <button
                            onClick={() => { setActiveChainLeg(activeChainLeg === i ? null : i); setDateInput(legChains[i].selectedExpiry) }}
                            title={activeChainLeg === i ? 'Close chain' : 'Open chain picker'}
                            style={{
                              fontSize: 8, fontWeight: 700, padding: '1px 6px', cursor: 'pointer',
                              letterSpacing: '0.06em', textTransform: 'uppercase',
                              background: activeChainLeg === i ? 'rgba(201,168,76,0.18)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
                              border: `1px solid ${activeChainLeg === i ? 'rgba(201,168,76,0.45)' : 'var(--theme-text-subtle, rgba(255,255,255,0.12))'}`,
                              color: activeChainLeg === i ? '#c9a84c' : '#5e768f',
                            }}
                          >
                            {activeChainLeg === i ? '× Chain' : 'Chain'}
                          </button>
                        )}
                        <button onClick={() => removeLeg(i)} style={{ fontSize: 12, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                      </div>
                    </div>

                    {/* Ticker + fetch */}
                    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                      <input value={leg.ticker} placeholder="TICKER"
                        onChange={e => updateLeg(i, 'ticker', e.target.value.toUpperCase())}
                        style={{ ...INPUT, flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}
                        onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
                        onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')}
                        onKeyDown={e => e.key === 'Enter' && fetchSpotForLeg(i)}
                      />
                      <button onClick={() => fetchSpotForLeg(i)}
                        disabled={legChains[i]?.loading || !leg.ticker.trim()}
                        title="Load options chain"
                        style={{
                          background: 'var(--theme-surface, #142032)',
                          border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
                          color: legChains[i]?.loading ? '#4d4637' : 'var(--theme-primary, #c9a84c)',
                          fontSize: 14, padding: '0 8px', cursor: legChains[i]?.loading ? 'default' : 'pointer',
                          flexShrink: 0, lineHeight: 1,
                        }}>
                        {legChains[i]?.loading ? '…' : 'v'}
                      </button>
                    </div>

                    {/* Type / Action */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 4 }}>
                      <select value={leg.option_type}
                        onChange={e => updateLeg(i, 'option_type', e.target.value)}
                        style={{ ...SELECT, fontSize: 11 }}>
                        <option value="call">Call</option>
                        <option value="put">Put</option>
                      </select>
                      <select value={leg.action}
                        onChange={e => updateLeg(i, 'action', e.target.value)}
                        style={{ ...SELECT, fontSize: 11 }}>
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                      </select>
                    </div>

                    {/* Selected contract summary */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 4 }}>
                      {[
                        { label: 'K',   key: 'K',        step: 1,    val: leg.K },
                        { label: '@$',  key: 'premium',  step: 0.01, val: leg.premium },
                        { label: 'Qty', key: 'quantity', step: 1,    val: leg.quantity },
                      ].map(f => (
                        <div key={f.key}>
                          <div style={{ fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginBottom: 2 }}>{f.label}</div>
                          <input type="number" value={f.val} step={f.step}
                            min={f.key === 'quantity' ? 1 : undefined}
                            onChange={e => updateLeg(i, f.key as keyof Leg, f.key === 'quantity' ? Math.max(1, +e.target.value) : +e.target.value)}
                            style={{ ...INPUT, width: '100%', fontSize: 11 }} />
                        </div>
                      ))}
                    </div>
                    {/* Expiry */}
                    <div>
                      <div style={{ fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginBottom: 2 }}>EXPIRY</div>
                      <input type="date" value={leg.expiry ?? ''}
                        onChange={e => updateLeg(i, 'expiry', e.target.value)}
                        style={{ ...INPUT, width: '100%', fontSize: 11 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>}>

        {/* ── Right: payoff chart ── */}

          {/* ── Full-width Chain Picker ─────────────────────────────────── */}
          {activeChainLeg !== null && activeChain && (() => {
            const leg   = legs[activeChainLeg]
            const spot  = activeChain.spot
            const exp   = activeChain.selectedExpiry
            const dteN  = exp ? dte(exp) : null

            // Build strike universe: union of all call + put strikes
            const strikeSet = new Set<number>([
              ...activeChain.calls.map((c: any) => c.strike),
              ...activeChain.puts.map((p: any)  => p.strike),
            ])
            const allStrikes = [...strikeSet].sort((a, b) => a - b)

            // Filter to N strikes nearest ATM
            const nearATM = spot
              ? [...allStrikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, strikeCount).sort((a, b) => a - b)
              : allStrikes.slice(0, strikeCount)

            const callMap = Object.fromEntries(activeChain.calls.map((c: any) => [c.strike, c]))
            const putMap  = Object.fromEntries(activeChain.puts.map((p: any)  => [p.strike, p]))

            const TH: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))', padding: '5px 8px', whiteSpace: 'nowrap' }
            const TD_base: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 11, padding: '5px 8px', whiteSpace: 'nowrap' }

            return (
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', marginBottom: 8 }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--theme-surface, #142032)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {/* Leg tabs */}
                    <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>Chain</span>
                    {legs.map((l, idx) => legChains[idx]?.expiries?.length > 0 && (
                      <button key={idx} onClick={() => { setActiveChainLeg(idx); setDateInput(legChains[idx].selectedExpiry) }}
                        style={{
                          fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer', letterSpacing: '0.06em',
                          background: activeChainLeg === idx ? `${LEG_COLORS[idx % LEG_COLORS.length]}30` : 'transparent',
                          border: `1px solid ${activeChainLeg === idx ? LEG_COLORS[idx % LEG_COLORS.length] : 'var(--theme-border, rgba(255,255,255,0.1))'}`,
                          color: activeChainLeg === idx ? LEG_COLORS[idx % LEG_COLORS.length] : '#5e768f',
                        }}>
                        {l.ticker || `Leg ${idx+1}`}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {/* Date input with snap */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.35))', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Expiry</span>
                      <input type="date" value={dateInput}
                        onChange={e => setDateInput(e.target.value)}
                        onBlur={e => snapToExpiry(e.target.value, activeChainLeg)}
                        onKeyDown={e => e.key === 'Enter' && snapToExpiry(dateInput, activeChainLeg)}
                        style={{ background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-text-subtle, rgba(255,255,255,0.12))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 11, padding: '3px 6px', outline: 'none' }}
                      />
                      {exp && dteN !== null && (
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-primary, #c9a84c)' }}>
                          {fmtExpiry(exp)} · <span style={{ color: dteN <= 7 ? 'var(--theme-negative)' : dteN <= 30 ? 'var(--theme-warn)' : 'var(--theme-positive)' }}>{dteN}d</span>
                        </span>
                      )}
                    </div>

                    {/* Quick expiry buttons */}
                    <div style={{ display: 'flex', gap: 3 }}>
                      {activeChain.expiries.slice(0, 8).map(e => (
                        <button key={e} onClick={() => { fetchExpiry(activeChainLeg, e); setDateInput(e) }}
                          style={{
                            fontSize: 8, padding: '2px 7px', cursor: 'pointer',
                            background: exp === e ? 'rgba(201,168,76,0.15)' : 'transparent',
                            border: `1px solid ${exp === e ? 'rgba(201,168,76,0.4)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                            color: exp === e ? '#c9a84c' : '#5e768f',
                          }}>
                          {fmtExpiry(e)}
                        </button>
                      ))}
                    </div>

                    {/* Strikes count */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.35))', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Strikes</span>
                      {[5, 10, 15, 20].map(n => (
                        <button key={n} onClick={() => setStrikeCount(n)} style={{
                          fontSize: 9, padding: '2px 7px', cursor: 'pointer',
                          background: strikeCount === n ? 'rgba(201,168,76,0.15)' : 'transparent',
                          border: `1px solid ${strikeCount === n ? 'rgba(201,168,76,0.4)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                          color: strikeCount === n ? '#c9a84c' : '#5e768f',
                        }}>{n}</button>
                      ))}
                    </div>

                    <button onClick={() => setActiveChainLeg(null)} style={{ background: 'none', border: 'none', color: 'var(--theme-text-faint, rgba(255,255,255,0.25))', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>×</button>
                  </div>
                </div>

                {/* Chain table — calls | strike | puts */}
                {activeChain.loading
                  ? (
                    <div style={{ overflowX: 'auto' }}>
                      <style>{`@keyframes _shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>
                          {Array.from({ length: strikeCount }).map((_, idx) => (
                            <tr key={idx} style={{ borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))' }}>
                              {Array.from({ length: 11 }).map((__, col) => (
                                <td key={col} style={{ padding: '8px 8px' }}>
                                  <div style={{
                                    height: 12, borderRadius: 2,
                                    width: col === 5 ? 60 : col % 5 === 0 ? 32 : 48,
                                    background: 'linear-gradient(90deg, var(--theme-surface) 25%, var(--theme-hover) 50%, var(--theme-surface) 75%)',
                                    backgroundSize: '200% 100%',
                                    animation: '_shimmer 1.6s infinite',
                                    margin: '0 auto',
                                    opacity: col === 5 ? 1 : 0.6,
                                  }} />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                  : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                            {/* Calls side */}
                            <th style={{ ...TH, textAlign: 'right', color: 'color-mix(in srgb, var(--theme-positive) 55%, transparent)' }}>Δ</th>
                            <th style={{ ...TH, textAlign: 'right' }}>OI</th>
                            <th style={{ ...TH, textAlign: 'right' }}>Vol</th>
                            <th style={{ ...TH, textAlign: 'right' }}>Bid</th>
                            <th style={{ ...TH, textAlign: 'right', color: 'color-mix(in srgb, var(--theme-positive) 55%, transparent)' }}>Ask</th>
                            {/* Center */}
                            <th style={{ ...TH, textAlign: 'center', color: 'color-mix(in srgb, var(--theme-primary) 55%, transparent)', background: 'rgba(201,168,76,0.05)', minWidth: 80 }}>CALLS · STRIKE · PUTS</th>
                            {/* Puts side */}
                            <th style={{ ...TH, textAlign: 'left', color: 'color-mix(in srgb, var(--theme-negative) 55%, transparent)' }}>Bid</th>
                            <th style={{ ...TH, textAlign: 'left' }}>Ask</th>
                            <th style={{ ...TH, textAlign: 'left' }}>Vol</th>
                            <th style={{ ...TH, textAlign: 'left' }}>OI</th>
                            <th style={{ ...TH, textAlign: 'left', color: 'color-mix(in srgb, var(--theme-negative) 55%, transparent)' }}>Δ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nearATM.map(K => {
                            const c     = callMap[K]
                            const p     = putMap[K]
                            const isATM = spot && Math.abs(K - spot) < spot * 0.006
                            const callSel = leg.option_type === 'call' && leg.K === K
                            const putSel  = leg.option_type === 'put'  && leg.K === K

                            const rowBg = isATM ? 'rgba(201,168,76,0.06)' : 'transparent'

                            const callClick = () => c && (selectContract(activeChainLeg, c), updateLeg(activeChainLeg, 'option_type', 'call'))
                            const putClick  = () => p && (selectContract(activeChainLeg, p), updateLeg(activeChainLeg, 'option_type', 'put'))

                            return (
                              <tr key={K}
                                style={{ borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', background: rowBg }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')}
                                onMouseLeave={e => (e.currentTarget.style.background = rowBg)}>

                                {/* Call cells */}
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-positive)', background: callSel ? 'rgba(201,168,76,0.12)' : undefined }}>
                                  {c?.delta?.toFixed(2) ?? '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-text-dim)', background: callSel ? 'rgba(201,168,76,0.12)' : undefined }}>
                                  {c?.openInterest ? (c.openInterest >= 1000 ? `${(c.openInterest/1000).toFixed(1)}k` : c.openInterest) : '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-text-dim)', background: callSel ? 'rgba(201,168,76,0.12)' : undefined }}>
                                  {c?.volume ? (c.volume >= 1000 ? `${(c.volume/1000).toFixed(1)}k` : c.volume) : '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-text, #d7e3fc)', background: callSel ? 'rgba(201,168,76,0.12)' : undefined }}>
                                  {c?.bid > 0 ? c.bid.toFixed(2) : '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-positive)', fontWeight: callSel ? 700 : 400, background: callSel ? 'rgba(201,168,76,0.18)' : undefined }}>
                                  {c?.ask > 0 ? c.ask.toFixed(2) : '—'}
                                </td>

                                {/* Strike */}
                                <td style={{ ...TD_base, textAlign: 'center', background: 'rgba(201,168,76,0.05)', fontWeight: 700,
                                  color: isATM ? 'var(--theme-primary, #c9a84c)' : spot && K < spot ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-text-dim)' }}>
                                  {K}
                                  {isATM && <span style={{ fontSize: 8, color: 'var(--theme-primary, #c9a84c)', marginLeft: 4, letterSpacing: '0.08em' }}>ATM</span>}
                                </td>

                                {/* Put cells */}
                                <td onClick={putClick} style={{ ...TD_base, textAlign: 'left', cursor: 'pointer', color: 'var(--theme-negative)', fontWeight: putSel ? 700 : 400, background: putSel ? 'color-mix(in srgb, var(--theme-negative) 20%, transparent)' : undefined }}>
                                  {p?.bid > 0 ? p.bid.toFixed(2) : '—'}
                                </td>
                                <td onClick={putClick} style={{ ...TD_base, textAlign: 'left', cursor: 'pointer', color: 'var(--theme-text, #d7e3fc)', background: putSel ? 'color-mix(in srgb, var(--theme-negative) 20%, transparent)' : undefined }}>
                                  {p?.ask > 0 ? p.ask.toFixed(2) : '—'}
                                </td>
                                <td onClick={putClick} style={{ ...TD_base, textAlign: 'left', cursor: 'pointer', color: 'var(--theme-text-dim)', background: putSel ? 'color-mix(in srgb, var(--theme-negative) 20%, transparent)' : undefined }}>
                                  {p?.volume ? (p.volume >= 1000 ? `${(p.volume/1000).toFixed(1)}k` : p.volume) : '—'}
                                </td>
                                <td onClick={putClick} style={{ ...TD_base, textAlign: 'left', cursor: 'pointer', color: 'var(--theme-text-dim)', background: putSel ? 'color-mix(in srgb, var(--theme-negative) 20%, transparent)' : undefined }}>
                                  {p?.openInterest ? (p.openInterest >= 1000 ? `${(p.openInterest/1000).toFixed(1)}k` : p.openInterest) : '—'}
                                </td>
                                <td onClick={putClick} style={{ ...TD_base, textAlign: 'left', cursor: 'pointer', color: 'var(--theme-negative)', background: putSel ? 'color-mix(in srgb, var(--theme-negative) 25%, transparent)' : undefined }}>
                                  {p?.delta?.toFixed(2) ?? '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {spot && (
                        <div style={{ padding: '4px 12px', borderTop: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>
                          {leg?.ticker} spot ${spot.toFixed(2)} · Click call or put row to select · highlighted = active leg selection
                        </div>
                      )}
                    </div>
                  )
                }
              </div>
            )
          })()}

          {/* Expiry Payoff Diagram */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
              {primaryTicker} P&L at Expiry
            </div>
            <div style={{ position: 'absolute', top: 0, right: 0, padding: '3px 8px', fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', zIndex: 10 }}>
              per contract (×100 shares) · intrinsic only
            </div>

            <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 0, height: 340 }}>
              <ResponsiveContainer width="100%" height={312}>
                <ComposedChart data={chartData.rows} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="price" type="number" domain={[chartData.lo, chartData.hi]} tick={TICK} tickFormatter={v => `$${(+v).toFixed(2)}`} interval="preserveStartEnd" allowDataOverflow />
                  <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right"
                    domain={[chartData.yMin, chartData.yMax]} />
                  <Tooltip formatter={(v: number, name: string) => [`$${(+v).toFixed(2)}`, name === 'total' ? 'Total P&L' : name]}
                    labelFormatter={v => `${primaryTicker} @ $${(+v).toFixed(2)}`} contentStyle={TOOLTIP_STYLE} />

                  {/* Green profit zone */}
                  <Area type="monotone" dataKey="profit" fill="rgba(47,107,75,0.25)" stroke="none" />
                  {/* Red loss zone */}
                  <Area type="monotone" dataKey="loss"   fill="rgba(140,46,54,0.25)"  stroke="none" />

                  {/* Breakeven line */}
                  <ReferenceLine y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.2))" strokeWidth={1} strokeDasharray="4 4" />

                  {/* Strike reference lines */}
                  {[...new Set(primaryLegs.map(l => l.K))].map(K => (
                    <ReferenceLine key={K} x={K} stroke="rgba(201,168,76,0.3)" strokeDasharray="3 4"
                      label={{ value: `$${K}`, fill: 'var(--theme-primary, #c9a84c)', fontSize: 8, position: 'insideTopRight' }} />
                  ))}

                  {/* Spot marker */}
                  <ReferenceLine x={chartData.spot} stroke="rgba(217,119,54,0.7)" strokeWidth={1.5} strokeDasharray="4 2" />

                  {/* Breakeven markers */}
                  {chartData.breakevens.map((be, i) => (
                    <ReferenceLine key={i} x={be} stroke="var(--theme-text-faint, rgba(255,255,255,0.25))" strokeDasharray="2 4"
                      label={{ value: `BE $${be}`, fill: 'var(--theme-secondary, #99907e)', fontSize: 8, position: 'insideTopLeft' }} />
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
            <div style={{ padding: '8px 14px 12px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', whiteSpace: 'nowrap', width: 68 }}>
                  {primaryTicker} Spot
                </span>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <input type="range"
                    min={+(chartData.atm * 0.75).toFixed(2)}
                    max={+(chartData.atm * 1.25).toFixed(2)}
                    step={0.5} value={chartData.spot}
                    onChange={e => setPrimary(+e.target.value)}
                    style={{ width: '100%', accentColor: 'var(--theme-primary, #c9a84c)' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    {[-20, -10, 0, +10, +20].map(p => (
                      <button key={p} onClick={() => setPrimary(+(chartData.atm * (1 + p / 100)).toFixed(2))}
                        style={{ fontSize: 9, fontFamily: 'var(--theme-mono)',
                          color: p === 0 ? 'var(--theme-primary, #c9a84c)' : p < 0 ? 'var(--theme-negative)' : 'var(--theme-positive)',
                          background: 'none', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '2px 5px', cursor: 'pointer' }}>
                        {p === 0 ? 'ATM' : `${p > 0 ? '+' : ''}${p}%`}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 14, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)' }}>
                    ${chartData.spot.toFixed(2)}
                  </div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: chartData.pct >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)' }}>
                    {chartData.pct >= 0 ? '+' : ''}{chartData.pct.toFixed(1)}% vs ATM
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Secondary ticker sliders */}
          {secondaryTickers.length > 0 && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
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
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{tk}</span>
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: pct >= 0 ? '#22C55E' : '#EF4444' }}>
                          ${spot.toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)
                        </span>
                      </div>
                      <input type="range" min={+(atm * 0.75).toFixed(2)} max={+(atm * 1.25).toFixed(2)} step={0.5} value={spot}
                        onChange={e => setSpotOverrides(s => ({ ...s, [tk]: +e.target.value }))}
                        style={{ width: '100%', accentColor: 'var(--theme-primary, #c9a84c)' }} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Leg summary + breakeven */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {legs.map((leg, i) => (
              <span key={i} style={{ fontSize: 10, padding: '3px 8px', fontFamily: 'var(--theme-mono)',
                border: `1px solid ${LEG_COLORS[i % LEG_COLORS.length]}`,
                color: LEG_COLORS[i % LEG_COLORS.length] }}>
                {leg.action === 'buy' ? '▲' : '▼'} {leg.ticker} {leg.option_type.toUpperCase()} K={leg.K} @ ${leg.premium} ×{leg.quantity}
              </span>
            ))}
            {chartData.breakevens.length > 0 && (
              <span style={{ fontSize: 10, padding: '3px 8px', fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #99907e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                BE: {chartData.breakevens.map(b => `$${b}`).join(' / ')}
              </span>
            )}
          </div>

          {/* ── Greeks Panel ─────────────────────────────────────────────── */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--theme-surface, #142032)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Portfolio Greeks</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {greekError && <span style={{ fontSize: 9, color: '#ef4444', fontFamily: 'var(--theme-mono)' }}>{greekError}</span>}
                <button
                  onClick={calculateGreeks}
                  disabled={greekLoading}
                  style={{
                    background: greekLoading ? 'transparent' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
                    border: '1px solid rgba(201,168,76,0.4)', color: greekLoading ? 'rgba(255,255,255,0.3)' : 'var(--theme-primary, #c9a84c)',
                    fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                    padding: '3px 12px', cursor: greekLoading ? 'default' : 'pointer',
                  }}
                >
                  {greekLoading ? 'Computing…' : 'Compute Greeks'}
                </button>
              </div>
            </div>

            {greekResult && (
              <>
                {/* Net greeks row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  {(['delta','gamma','theta','vega'] as const).map((g, i) => {
                    const v = greekResult.net[g]
                    return (
                      <div key={g} style={{ padding: '10px 12px', borderRight: i < 3 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
                        <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', marginBottom: 4 }}>Net {g}</div>
                        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: GREEK_COLORS[g], lineHeight: 1 }}>
                          {v >= 0 ? '+' : ''}{v.toFixed(4)}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Per-leg table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'rgba(0,0,0,0.2)' }}>
                        {['Ticker','K','Expiry','DTE','Spot','Type','Pos','Qty','Δ','Γ','Θ','ν','Net Δ','Net Γ','Net Θ','Net ν'].map((h, i) => (
                          <th key={h} style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', textAlign: i === 0 ? 'left' : 'right', padding: '5px 8px', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {greekResult.positions.map((pos, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                          <td style={{ padding: '5px 8px', color: 'var(--theme-primary, #c9a84c)', textAlign: 'left' }}>{pos.ticker}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.strike}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.expiry}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-secondary, #5e768f)' }}>{pos.dte}d</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.spot.toFixed(2)}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-secondary, #5e768f)' }}>{pos.option_type}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: pos.position_type === 'long' ? 'var(--theme-positive)' : 'var(--theme-negative)' }}>{pos.position_type}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.qty}</td>
                          {(['delta','gamma','theta','vega'] as const).map(g => (
                            <td key={g} style={{ padding: '5px 8px', textAlign: 'right', color: GREEK_COLORS[g] }}>{pos[g].toFixed(4)}</td>
                          ))}
                          {(['scaled_delta','scaled_gamma','scaled_theta','scaled_vega'] as const).map(g => {
                            const greek = g.replace('scaled_','') as keyof typeof GREEK_COLORS
                            return <td key={g} style={{ padding: '5px 8px', textAlign: 'right', color: GREEK_COLORS[greek], fontWeight: 700 }}>{pos[g] >= 0 ? '+' : ''}{pos[g].toFixed(4)}</td>
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {!greekResult && !greekLoading && (
              <div style={{ padding: '16px 14px', fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-secondary, #5e768f)' }}>
                Add expiry dates to legs, then click Compute Greeks to see Δ Γ Θ ν for each position.
              </div>
            )}
          </div>

          {/* ── AI Risk Narrative ──────────────────────────────────────────── */}
          <div style={{ margin: '0 14px 14px', border: '1px solid rgba(201,168,76,0.2)', background: 'rgba(201,168,76,0.03)' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(201,168,76,0.12)', background: 'rgba(201,168,76,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>AI Risk Analysis</span>
              <button
                onClick={async () => {
                  if (!greekResult) return
                  setAiNarrativePending(true)
                  try {
                    const { data: r } = await axios.post('/api/ai/strategy-narrative', {
                      legs: legs.map(l => ({
                        option_type: l.option_type, position_type: l.action,
                        qty: l.quantity, strike: l.K, expiry: l.expiry, ticker: l.ticker,
                      })),
                      net_delta: greekResult.net.delta,
                      net_gamma: greekResult.net.gamma,
                      net_theta: greekResult.net.theta,
                      net_vega: greekResult.net.vega,
                    })
                    setAiNarrative(r)
                  } catch { /* silent */ }
                  setAiNarrativePending(false)
                }}
                disabled={aiNarrativePending || !greekResult}
                style={{
                  background: 'color-mix(in srgb, var(--theme-primary) 10%, transparent)',
                  border: '1px solid rgba(201,168,76,0.4)', color: 'var(--theme-primary, #c9a84c)',
                  fontFamily: 'var(--theme-mono)', fontSize: 9,
                  padding: '2px 6px', cursor: (aiNarrativePending || !greekResult) ? 'default' : 'pointer',
                  opacity: (aiNarrativePending || !greekResult) ? 0.5 : 1,
                }}
              >{aiNarrativePending ? '…' : 'Analyze'}</button>
            </div>
            {!aiNarrative && !aiNarrativePending && (
              <div style={{ padding: '10px 12px', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-sans)' }}>
                Compute Greeks first, then click Analyze for AI risk commentary.
              </div>
            )}
            {aiNarrative && (
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)' }}>{aiNarrative.strategy_name}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '16px', fontFamily: 'var(--theme-sans)' }}>{aiNarrative.summary}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Max Loss', text: aiNarrative.max_loss_scenario, color: 'var(--theme-negative)', borderColor: 'color-mix(in srgb, var(--theme-negative) 13%, transparent)', bg: 'color-mix(in srgb, var(--theme-negative) 5%, transparent)' },
                    { label: 'Max Gain', text: aiNarrative.max_gain_scenario, color: 'var(--theme-positive)', borderColor: 'color-mix(in srgb, var(--theme-positive) 13%, transparent)', bg: 'color-mix(in srgb, var(--theme-positive) 5%, transparent)' },
                  ].map(({ label, text, color, borderColor, bg }) => (
                    <div key={label} style={{ padding: '6px 8px', border: `1px solid ${borderColor}`, background: bg }}>
                      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', fontFamily: 'var(--theme-sans)' }}>{text}</div>
                    </div>
                  ))}
                </div>
                {aiNarrative.ideal_conditions && (
                  <div style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', fontFamily: 'var(--theme-sans)' }}>
                    <span style={{ color: 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>Ideal: </span>{aiNarrative.ideal_conditions}
                  </div>
                )}
                {Array.isArray(aiNarrative.key_risks) && aiNarrative.key_risks.length > 0 && (
                  <div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--theme-negative)', textTransform: 'uppercase', marginBottom: 4 }}>Key Risks</div>
                    {aiNarrative.key_risks.map((r: string, i: number) => (
                      <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', paddingLeft: 8, borderLeft: '2px solid color-mix(in srgb, var(--theme-negative) 30%, transparent)', marginBottom: 3, fontFamily: 'var(--theme-sans)' }}>{r}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
      </SidebarLayout>
    </PageWrapper>
  )
}
