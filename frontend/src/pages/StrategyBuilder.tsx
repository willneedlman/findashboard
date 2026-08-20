import { useState, useEffect, useMemo, useRef } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import SidebarLayout from '../components/SidebarLayout'
import ExpirySelect from '../components/ExpirySelect'
import axios from 'axios'
import { TICK, RailSection } from './valuationShared'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip, textClip } from '../lib/reportCaptureRegistry'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
import { type Leg, type GreekPos, type GreekResult, DEFAULT_TICKER, DEFAULT_EXPIRY, mk, roundToStrike, scalePreset, GREEK_COLORS, PRESETS, PRESET_DESC, PRESET_GROUPS, LEG_COLORS, LS_KEY, toOCC, INPUT, SELECT, type LegChain, fmtExpiry, intrinsic, impliedVol, legPnlAt, type PendingOptionStrategy } from './strategy-builder/shared'
import { useSavedStrategies, saveStrategy, deleteSavedStrategy, savedStrategyTicker, type SavedStrategy } from './strategy-builder/savedStrategies'

// Payoff-chart legend swatches — reuse the exact stroke/fill of each series so
// the swatch matches whatever theme is active.
const legWrap: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }
const legLine = (color: string, dashed: boolean, w = 2): React.CSSProperties => ({ width: 16, height: 0, borderTop: `${w}px ${dashed ? 'dashed' : 'solid'} ${color}`, flex: 'none' })
const legVert = (color: string): React.CSSProperties => ({ width: 0, height: 11, borderLeft: `2px dashed ${color}`, flex: 'none' })
const legFill = (color: string): React.CSSProperties => ({ width: 11, height: 11, background: color, flex: 'none' })

export default function StrategyBuilder() {
  const [legs, setLegs]               = useState<Leg[]>(PRESETS['Long Call'])
  const [preset, setPreset]           = useState('Long Call')
  const [paramsOpen, setParamsOpen]   = useState(true)
  const [tab, setTab]                 = useState<'manual' | 'describe'>('manual')
  const [openGroups, setOpenGroups]   = useState<Record<string, boolean>>(
    Object.fromEntries(PRESET_GROUPS.map(g => [g.label, g.label === 'Single Leg']))
  )
  const [spotOverrides, setSpotOverrides] = useState<Record<string, number>>({})
  const [daysFromNow, setDaysFromNow] = useState(0)   // 0 = today's mark; max = expiry
  const [greekResult, setGreekResult] = useState<GreekResult | null>(null)
  const [greekLoading, setGreekLoading] = useState(false)
  const [greekError, setGreekError]   = useState<string | null>(null)
  const [aiNarrative, setAiNarrative] = useState<any>(null)
  const [aiNarrativePending, setAiNarrativePending] = useState(false)
  const [sentToPaperTrader, setSentToPaperTrader] = useState(false)
  const [legChains, setLegChains]     = useState<Record<number, LegChain>>({})

  // Saved-strategy library (localStorage-backed, per-browser).
  const savedStrategies = useSavedStrategies()
  const [saving, setSaving]           = useState(false)
  const [saveName, setSaveName]       = useState('')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [confirmDel, setConfirmDel]   = useState<string | null>(null)

  const startSave = () => { setSaveName(preset || `${primaryTicker} strategy`); setSaving(true) }
  const commitSave = () => {
    const s = saveStrategy(saveName, legs, spotOverrides)
    setActiveSavedId(s.id); setSaving(false); setSaveName('')
  }
  const loadSaved = (s: SavedStrategy) => {
    setLegs(s.legs.map(l => ({ ...l })))
    setSpotOverrides({ ...s.spotOverrides })
    setLegChains({})
    setPreset('')
    setActiveSavedId(s.id)
  }

  const uniqueTickers    = useMemo(() => [...new Set(legs.map(l => l.ticker))], [legs])
  const primaryTicker    = uniqueTickers[0] ?? DEFAULT_TICKER
  const secondaryTickers = uniqueTickers.slice(1)

  const getSpot    = (tk: string) => spotOverrides[tk] ?? legs.find(l => l.ticker === tk)?.K ?? 100
  const setPrimary = (v: number)  => setSpotOverrides(s => ({ ...s, [primaryTicker]: v }))

  // Presets are written at a $100 scale and scalePreset moves them onto a real
  // spot, but nothing supplied one until you loaded a chain. So the page opened
  // reading SPY SPOT $100.00 with a strike of 100 while SPY was $776: a real
  // ticker priced at a placeholder. Seed it from a quote instead. Preset
  // switching already rescales from getSpot, so it inherits this.
  useEffect(() => {
    const tk = primaryTicker
    if (!tk || spotOverrides[tk]) return
    let cancelled = false
    axios.get(`/api/market/quote/${encodeURIComponent(tk)}`)
      .then(r => {
        const spot = Number(r.data?.current_price)
        if (cancelled || !Number.isFinite(spot) || spot <= 0) return
        setSpotOverrides(s => (s[tk] ? s : { ...s, [tk]: spot }))
        setLegs(prev => prev.map(l => l.ticker === tk ? { ...l, K: roundToStrike((l.K / 100) * spot, spot) } : l))
      })
      .catch(() => { /* No quote: the preset scale still builds a usable payoff. */ })
    return () => { cancelled = true }
  }, [primaryTicker])   // eslint-disable-line react-hooks/exhaustive-deps

  const setChain = (i: number, patch: Partial<LegChain>) =>
    setLegChains(c => ({ ...c, [i]: { ...c[i], ...patch } }))

  // Fetch full options chain for a leg — populates contract picker
  const fetchSpotForLeg = async (i: number) => {
    const leg = legs[i]
    const tk = leg.ticker.trim().toUpperCase()
    if (!tk) return
    // Honour what is already typed. With a strike AND an expiry in hand the
    // button prices THAT contract; it used to always load the front expiry and
    // overwrite the strike with the at-the-money one, which threw away both
    // inputs and made a far-dated leg impossible to price from the tile.
    const wantExpiry = (leg.expiry || '').trim()
    const wantK = Number(leg.K)
    const targeted = !!wantExpiry && Number.isFinite(wantK) && wantK > 0

    setChain(i, { loading: true })
    try {
      const query = targeted
        ? `?ticker=${tk}&expiry=${encodeURIComponent(wantExpiry)}`
        : `?ticker=${tk}`
      const res = await axios.get(`/api/options/chain${query}`)
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
      if (targeted) {
        const side = (leg.option_type === 'call' ? d.calls : d.puts) ?? []
        // Snap to the nearest listed strike when the typed one is not on the
        // board, so the premium always belongs to a contract that exists.
        const pick = side.find((c: any) => Math.abs(c.strike - wantK) < 1e-9) ?? min_strike(side, wantK)
        if (pick) {
          setLegs(p => p.map((l, idx) => idx !== i ? l : {
            ...l, K: pick.strike, premium: mid(pick), expiry: d.expiry || wantExpiry,
          }))
        }
        if (spot) setSpotOverrides(s => ({ ...s, [tk]: spot }))
        setActiveChainLeg(i)
        setDateInput(d.expiry || wantExpiry)
        return
      }
      // Nothing typed yet: seed the leg from the front expiry at the money.
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
    // Focus the x-range on the strikes and current spot rather than a fixed
    // +/-25% of the strike (which wastes most of the chart on a single option).
    // Pad enough to show the payoff slopes; wide spreads or a dragged spot
    // naturally widen the window.
    const anchors = [spot, ...legs.filter(l => l.ticker === primaryTicker).map(l => l.K)].filter(v => v > 0)
    const aLo   = Math.min(...anchors)
    const aHi   = Math.max(...anchors)
    const xPad  = Math.max((aHi - aLo) * 0.55, atm * 0.10)
    const lo    = Math.max(0, aLo - xPad)
    const hi    = aHi + xPad
    const steps = 80

    // Secondary tickers contribute a fixed offset at their slider price
    const secondaryOffset = legs
      .filter(l => l.ticker !== primaryTicker)
      .reduce((sum, leg) => sum + intrinsic(getSpot(leg.ticker), leg), 0)

    const primary = legs.filter(l => l.ticker === primaryTicker)
    // Implied vol + days-to-expiry per primary leg, for the before-expiry curve.
    const legMeta = primary.map(leg => {
      const dteDays = Math.max(0, Math.round((new Date(leg.expiry + 'T12:00:00').getTime() - Date.now()) / 86400000))
      const iv = impliedVol(leg.premium, leg.option_type, getSpot(leg.ticker), leg.K, dteDays / 365)
      return { leg, dteDays, iv }
    })
    const maxDte = legMeta.reduce((m, x) => Math.max(m, x.dteDays), 0)
    const frontDte = legMeta.reduce((m, x) => Math.min(m, x.dteDays), maxDte)
    // A diagonal/calendar has legs on different expiries. Each leg settles at the
    // terminal price S, EXCEPT a leg the time slider has already passed, which is
    // realized (locked at the current spot). So a surviving long leg only shows
    // its uncapped upside once the slider is past the shorter-dated leg's expiry;
    // before that the short is still live at S and caps the payoff.
    const multiExpiry = maxDte !== frontDte
    const tDays = Math.min(daysFromNow, maxDte)
    const showT = maxDte > 0   // before-expiry curve only meaningful with time left

    const buildRow = (S: number): Record<string, number> => {
      const total = (multiExpiry
        ? legMeta.reduce((sum, m) => sum + intrinsic(tDays > m.dteDays ? spot : S, m.leg), 0)
        : primary.reduce((sum, leg) => sum + intrinsic(S, leg), 0)) + secondaryOffset
      // A leg already expired at the slider date is REALIZED: its P&L is locked
      // at the current spot (a constant), not re-priced against the x-axis. That
      // lets a surviving longer-dated leg show its true (e.g. uncapped) payoff
      // instead of being offset by a short leg that no longer exists.
      const tval  = showT
        ? legMeta.reduce((sum, m) => sum + (tDays > m.dteDays
            ? legPnlAt(spot, m.leg, m.iv, m.dteDays)
            : legPnlAt(S, m.leg, m.iv, tDays)), 0) + secondaryOffset
        : total
      const row: Record<string, number> = {
        price:  +S.toFixed(2),
        total:  +total.toFixed(2),
        tval:   +tval.toFixed(2),
        profit: +Math.max(total, 0).toFixed(2),
        loss:   +Math.min(total, 0).toFixed(2),
      }
      primary.forEach((leg, idx) => {
        row[`leg${idx}`] = +intrinsic(S, leg).toFixed(2)
      })
      return row
    }

    // Even grid, plus an exact point at the spot so the crosshair snaps to the
    // spot line instead of jumping over it (spot rarely lands on a grid step).
    const prices = Array.from({ length: steps + 1 }, (_, i) => +(lo + (hi - lo) * (i / steps)).toFixed(2))
    if (spot > lo && spot < hi) prices.push(+spot.toFixed(2))
    const rows = [...new Set(prices)].sort((a, b) => a - b).map(buildRow)

    // Y domain follows the NET P&L (gold total) over the visible range, so the
    // whole payoff is on screen. The per-leg dashed lines can run far outside
    // it, which is what allowDataOverflow on the YAxis is for.
    //
    // The span is measured from BOTH ends, never from the downside alone. It
    // used to clamp the top at 30x the max loss, which silently cut the chart
    // off whenever reward was large relative to risk: a 730/800 call spread
    // bought for nothing has zero risk, so the clamp fell back to its 50 floor
    // and pinned the axis at 1575 while the payoff ran to 7000. Debit spreads
    // and long calls are exactly the shapes that hit it.
    const allVals = rows.map(r => r.total)
    const rawMin  = Math.min(...allVals)
    const rawMax  = Math.max(...allVals)
    const span    = Math.max(Math.abs(rawMin), Math.abs(rawMax), 50)
    const top     = Math.max(rawMax, 0)
    const bot     = Math.min(rawMin, 0)
    const pad     = Math.max(span * 0.08, 10)
    // A floor sitting exactly at zero (a spread that cost nothing) gets a thin
    // pad instead of a full one, so the frame is not half empty below the line.
    const yMax    = Math.ceil(top + pad)
    const yMin    = Math.floor(bot - (bot < 0 ? pad : pad * 0.15))

    // Breakeven prices (zero-crossings)
    const breakevens: number[] = []
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].total * rows[i + 1].total < 0) {
        const x = rows[i].price + (0 - rows[i].total) *
          (rows[i + 1].price - rows[i].price) / (rows[i + 1].total - rows[i].total)
        breakevens.push(+x.toFixed(2))
      }
    }

    return { rows, atm, spot, yMin, yMax, breakevens, lo, hi, pct: (spot - atm) / atm * 100, maxDte, tDays, showT, multiExpiry }
  }, [legs, spotOverrides, primaryTicker, daysFromNow]) // spotOverrides intentional — live updates

  const primaryLegs = legs.filter(l => l.ticker === primaryTicker)

  // Chain picker state
  const [activeChainLeg, setActiveChainLeg] = useState<number | null>(null)
  const [strikeCount,    setStrikeCount]    = useState(10)
  const [dateInput,      setDateInput]      = useState('')

  const activeChain = activeChainLeg !== null ? legChains[activeChainLeg] : null

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

  const TAB = 'Options Strategy'
  useReportCapture(() => {
    if (!legs.length) return null
    const netCost = legs.reduce((s, l) => s + (l.action === 'buy' ? 1 : -1) * (l.premium ?? 0) * (l.quantity ?? 0), 0) * 100
    const pieces: ClipDraft[] = [
      kpiClip(TAB, `${preset} · Summary`, [
        { label: netCost >= 0 ? 'Net Debit' : 'Net Credit', value: `$${Math.abs(netCost).toFixed(2)}` },
        { label: 'Breakeven', value: chartData.breakevens.length ? chartData.breakevens.map(b => `$${b}`).join(' · ') : '—' },
        { label: 'Legs', value: String(legs.length) },
        { label: `${primaryTicker} Spot`, value: `$${chartData.spot.toFixed(2)}` },
      ]),
      tableClip(TAB, 'Strategy Legs',
        ['Action', 'Ticker', 'Type', 'Strike', 'Expiry', 'Premium', 'Qty'],
        legs.map(l => [
          l.action.toUpperCase(), l.ticker, l.option_type.toUpperCase(),
          l.K, l.expiry, l.premium, l.quantity,
        ]),
      ),
    ]
    if (chartData.rows?.length) {
      pieces.push(chartClip(TAB, 'Payoff at Expiry', 'line', 'price',
        chartData.rows.map((r: any) => ({ price: r.price, total: r.total, tval: r.tval })),
        [
          { key: 'total', label: 'At Expiry' },
          ...(chartData.showT ? [{ key: 'tval', label: 'At Selected Date' }] : []),
        ],
      ))
    }
    if (greekResult) {
      pieces.push(kpiClip(TAB, 'Portfolio Greeks', [
        { label: 'Net Delta', value: `${greekResult.net.delta >= 0 ? '+' : ''}${greekResult.net.delta.toFixed(4)}` },
        { label: 'Net Gamma', value: `${greekResult.net.gamma >= 0 ? '+' : ''}${greekResult.net.gamma.toFixed(4)}` },
        { label: 'Net Theta', value: `${greekResult.net.theta >= 0 ? '+' : ''}${greekResult.net.theta.toFixed(4)}` },
        { label: 'Net Vega', value: `${greekResult.net.vega >= 0 ? '+' : ''}${greekResult.net.vega.toFixed(4)}` },
      ]))
      if (greekResult.positions?.length) {
        pieces.push(tableClip(TAB, 'Per-Leg Greeks',
          ['Ticker', 'K', 'Expiry', 'Type', 'Pos', 'Qty', 'Δ', 'Γ', 'Θ', 'ν'],
          greekResult.positions.map((pos: any) => [
            pos.ticker, pos.strike, pos.expiry, pos.option_type, pos.position_type, pos.qty,
            pos.delta.toFixed(4), pos.gamma.toFixed(4), pos.theta.toFixed(4), pos.vega.toFixed(4),
          ]),
        ))
      }
    }
    if (aiNarrative?.summary) {
      pieces.push(textClip(TAB, 'AI Risk Analysis', [
        aiNarrative.summary,
        aiNarrative.rate_sensitivity && `Rate Sensitivity: ${aiNarrative.rate_sensitivity}`,
        aiNarrative.yield_context && `Context: ${aiNarrative.yield_context}`,
        aiNarrative.investor_fit && `Fit: ${aiNarrative.investor_fit}`,
      ].filter(Boolean).join('\n\n')))
    }
    return pieces
  }, { disabled: !legs.length, sourceTab: TAB })

  return (
    <PageWrapper title="Options Strategy">
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Manual vs AI tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              {(['manual', 'describe'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '4px 10px', fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
                  background: tab === t ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                  border: `1px solid ${tab === t ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
                  color: tab === t ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                  flex: 1,
                }}>{t === 'manual' ? 'Manual' : 'Describe (AI)'}</button>
              ))}
            </div>

            <div style={{ display: tab === 'describe' ? 'block' : 'none' }}>
              <AiOptionsStrategyChat onAccept={(draft) => {
                setPreset(draft.name)
                setLegs(draft.legs)
                // Seed the real spot the backend grounded the strikes on so the
                // payoff chart and greeks center on the live price, not a guess.
                const tk = draft.ticker || draft.legs[0]?.ticker
                setSpotOverrides(draft.spot && tk ? { [tk]: draft.spot } : {})
                setLegChains({})
                setActiveSavedId(null)
                setTab('manual')
              }} />
            </div>

            <div style={{ display: tab === 'manual' ? 'flex' : 'none', flexDirection: 'column', gap: 10 }}>
                {/* Presets */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 6 }}>Presets</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {PRESET_GROUPS.map(group => (
                  <div key={group.label}>
                    <button
                      onClick={() => setOpenGroups(s => ({ ...s, [group.label]: !s[group.label] }))}
                      style={{
                        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '5px 6px', marginBottom: 2, background: 'var(--theme-hover, rgba(255,255,255,0.03))',
                        border: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                        cursor: 'pointer', color: 'var(--theme-secondary, #8099b0)',
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                      }}
                    >
                      <span>{group.label}</span>
                      <span style={{ fontSize: 8, opacity: 0.6 }}>{openGroups[group.label] ? '↑' : '↓'}</span>
                    </button>
                    {openGroups[group.label] && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4, paddingLeft: 4 }}>
                        {group.keys.map(name => (
                          <button key={name} onClick={() => {
                            setPreset(name)
                            setLegs(scalePreset(PRESETS[name], getSpot(primaryTicker)))
                            setSpotOverrides({})
                            setLegChains({})
                            setActiveSavedId(null)
                            setOpenGroups(s => ({ ...s, [group.label]: true }))
                          }} style={{
                            padding: '5px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                            background: preset === name ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' : 'transparent',
                            border: `1px solid ${preset === name ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.07))'}`,
                            color: preset === name ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                            cursor: 'pointer', textAlign: 'left',
                          }}>
                            <div>{name}</div>
                            <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none', color: preset === name ? 'color-mix(in srgb, var(--theme-primary) 60%, transparent)' : 'rgba(255,255,255,0.15)', marginTop: 2, lineHeight: '12px' }}>
                              {PRESET_DESC[name]}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Saved strategies library */}
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>Saved</div>
                  {!saving && (
                    <button onClick={startSave} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--theme-primary, #c9a84c)', background: 'none', border: 'none', cursor: 'pointer' }}>+ SAVE</button>
                  )}
                </div>

                {saving && (
                  <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                    <input
                      autoFocus value={saveName}
                      onChange={e => setSaveName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitSave(); if (e.key === 'Escape') { setSaving(false); setSaveName('') } }}
                      placeholder="Strategy name"
                      style={{ ...INPUT, flex: 1, minWidth: 0 }}
                    />
                    <button onClick={commitSave} title="Save strategy" style={{ padding: '4px 8px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-primary) 14%, transparent)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)' }}>Save</button>
                    <button onClick={() => { setSaving(false); setSaveName('') }} title="Cancel" aria-label="Cancel saving" style={{ padding: '4px 8px', fontSize: 11, cursor: 'pointer', background: 'none', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-secondary, #8099b0)' }}>×</button>
                  </div>
                )}

                {savedStrategies.length === 0 ? (
                  <div style={{ fontSize: 9, color: 'var(--theme-secondary, #8099b0)', lineHeight: '13px', padding: '0 2px 4px' }}>
                    No saved strategies yet. Build one and press Save to keep it here.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {savedStrategies.map(s => {
                      const on = activeSavedId === s.id
                      return (
                        <div key={s.id} style={{ display: 'flex', gap: 3, alignItems: 'stretch' }}>
                          <button onClick={() => loadSaved(s)} title="Load this strategy" style={{
                            flex: 1, minWidth: 0, padding: '5px 8px', textAlign: 'left', cursor: 'pointer',
                            background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' : 'transparent',
                            border: `1px solid ${on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.07))'}`,
                            color: on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
                          }}>
                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                            <div style={{ fontSize: 9, fontWeight: 400, color: on ? 'color-mix(in srgb, var(--theme-primary) 60%, transparent)' : 'rgba(255,255,255,0.2)', marginTop: 1 }}>
                              {s.legs.length} leg{s.legs.length === 1 ? '' : 's'} · {savedStrategyTicker(s)}
                            </div>
                          </button>
                          {confirmDel === s.id ? (
                            <div style={{ display: 'flex', gap: 2 }}>
                              <button onClick={() => { deleteSavedStrategy(s.id); if (activeSavedId === s.id) setActiveSavedId(null); setConfirmDel(null) }}
                                title="Confirm delete" style={{ padding: '0 7px', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-negative) 14%, transparent)', border: '1px solid var(--theme-negative)', color: 'var(--theme-negative)' }}>Del</button>
                              <button onClick={() => setConfirmDel(null)} title="Cancel" aria-label="Cancel removing this strategy" style={{ padding: '0 7px', fontSize: 11, cursor: 'pointer', background: 'none', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-secondary, #8099b0)' }}>×</button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmDel(s.id)} title="Remove saved strategy" aria-label="Remove saved strategy" style={{ padding: '0 8px', fontSize: 12, cursor: 'pointer', background: 'none', border: '1px solid var(--theme-border, rgba(255,255,255,0.07))', color: 'var(--theme-secondary, #8099b0)' }}>×</button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Send to Paper Trader */}
              <button
                onClick={sendToPaperTrader}
                style={{
                  marginTop: 8, width: '100%', padding: '7px 8px',
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                  cursor: 'pointer', border: '1px solid',
                  borderColor: sentToPaperTrader ? 'var(--theme-positive)' : 'color-mix(in srgb, var(--theme-primary) 50%, transparent)',
                  background: sentToPaperTrader ? 'color-mix(in srgb, var(--theme-positive) 12%, transparent)' : 'color-mix(in srgb, var(--theme-primary) 7%, transparent)',
                  color: sentToPaperTrader ? 'var(--theme-positive)' : 'var(--theme-primary, #c9a84c)',
                  transition: 'background 0.2s var(--ease-out), border-color 0.2s var(--ease-out), color 0.2s var(--ease-out)',
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
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>Legs ({legs.length})</div>
                <button onClick={addLeg} style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', background: 'none', border: 'none', cursor: 'pointer' }}>+ ADD</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {legs.map((leg, i) => (
                  <div key={i} style={{ background: 'var(--theme-bg, #0a1628)', border: `1px solid ${LEG_COLORS[i % LEG_COLORS.length]}44`, padding: 7 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: leg.action === 'buy' ? 'var(--theme-positive)' : 'var(--theme-negative)', textTransform: 'uppercase' }}>
                          LEG {i + 1}
                        </span>
                        {daysFromNow > dte(leg.expiry) && (
                          <span title="This leg has expired at the selected time. It is settled at intrinsic value."
                            style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', border: '1px solid var(--theme-text-subtle, rgba(255,255,255,0.14))', padding: '0 4px' }}>
                            Expired
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        {legChains[i]?.expiries?.length > 0 && (
                          <button
                            onClick={() => { setActiveChainLeg(activeChainLeg === i ? null : i); setDateInput(legChains[i].selectedExpiry) }}
                            title={activeChainLeg === i ? 'Close chain' : 'Open chain picker'}
                            style={{
                              fontSize: 8, fontWeight: 700, padding: '1px 6px', cursor: 'pointer',
                              letterSpacing: '0.06em', textTransform: 'uppercase',
                              background: activeChainLeg === i ? 'color-mix(in srgb, var(--theme-primary) 18%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
                              border: `1px solid ${activeChainLeg === i ? 'color-mix(in srgb, var(--theme-primary) 45%, transparent)' : 'var(--theme-text-subtle, rgba(255,255,255,0.12))'}`,
                              color: activeChainLeg === i ? 'var(--theme-primary, #c9a84c)' : '#8099b0',
                            }}
                          >
                            {activeChainLeg === i ? '× Chain' : 'Chain'}
                          </button>
                        )}
                        <button onClick={() => removeLeg(i)} title="Remove leg" aria-label="Remove leg" style={{ fontSize: 12, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
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
                        title="Fetch price. With a strike and expiry set it prices that contract, otherwise it loads the chain at the money."
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
                    {/* Expiry — restricted to the ticker's real option expiries */}
                    <div>
                      <div style={{ fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginBottom: 2 }}>EXPIRY</div>
                      <ExpirySelect
                        ticker={leg.ticker}
                        value={leg.expiry ?? ''}
                        expirations={legChains[i]?.expiries?.length ? legChains[i].expiries : undefined}
                        onChange={v => { if (legChains[i]?.expiries?.length) fetchExpiry(i, v); else updateLeg(i, 'expiry', v) }}
                        style={{ ...INPUT, width: '100%', fontSize: 11 }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            </div>
          </div>
          </RailSection>
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
                    <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>Chain</span>
                    {legs.map((l, idx) => legChains[idx]?.expiries?.length > 0 && (
                      <button key={idx} onClick={() => { setActiveChainLeg(idx); setDateInput(legChains[idx].selectedExpiry) }}
                        style={{
                          fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer', letterSpacing: '0.06em',
                          background: activeChainLeg === idx ? `${LEG_COLORS[idx % LEG_COLORS.length]}30` : 'transparent',
                          border: `1px solid ${activeChainLeg === idx ? LEG_COLORS[idx % LEG_COLORS.length] : 'var(--theme-border, rgba(255,255,255,0.1))'}`,
                          color: activeChainLeg === idx ? LEG_COLORS[idx % LEG_COLORS.length] : 'var(--theme-secondary, #8099b0)',
                        }}>
                        {l.ticker || `Leg ${idx+1}`}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {/* Expiry dropdown — only the chain's real expiries */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.35))', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Expiry</span>
                      <ExpirySelect
                        ticker={leg.ticker}
                        value={exp || dateInput}
                        expirations={activeChain.expiries?.length ? activeChain.expiries : undefined}
                        onChange={v => { fetchExpiry(activeChainLeg, v); setDateInput(v) }}
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
                            background: exp === e ? 'color-mix(in srgb, var(--theme-primary) 15%, transparent)' : 'transparent',
                            border: `1px solid ${exp === e ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                            color: exp === e ? 'var(--theme-primary, #c9a84c)' : '#8099b0',
                          }}>
                          {fmtExpiry(e)}
                        </button>
                      ))}
                    </div>

                    {/* Strikes count */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.35))', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Strikes</span>
                      {[5, 10, 15, 20, 30, 50].map(n => (
                        <button key={n} onClick={() => setStrikeCount(n)} style={{
                          fontSize: 9, padding: '2px 7px', cursor: 'pointer',
                          background: strikeCount === n ? 'color-mix(in srgb, var(--theme-primary) 15%, transparent)' : 'transparent',
                          border: `1px solid ${strikeCount === n ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
                          color: strikeCount === n ? 'var(--theme-primary, #c9a84c)' : '#8099b0',
                        }}>{n}</button>
                      ))}
                    </div>

                    <button onClick={() => setActiveChainLeg(null)} title="Close chain" aria-label="Close chain" style={{ background: 'none', border: 'none', color: 'var(--theme-text-faint, rgba(255,255,255,0.25))', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>×</button>
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
                            <th style={{ ...TH, textAlign: 'center', color: 'color-mix(in srgb, var(--theme-primary) 55%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 5%, transparent)', minWidth: 80 }}>CALLS · STRIKE · PUTS</th>
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

                            const rowBg = isATM ? 'color-mix(in srgb, var(--theme-primary) 6%, transparent)' : 'transparent'

                            const callClick = () => c && (selectContract(activeChainLeg, c), updateLeg(activeChainLeg, 'option_type', 'call'))
                            const putClick  = () => p && (selectContract(activeChainLeg, p), updateLeg(activeChainLeg, 'option_type', 'put'))

                            return (
                              <tr key={K}
                                style={{ borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', background: rowBg }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')}
                                onMouseLeave={e => (e.currentTarget.style.background = rowBg)}>

                                {/* Call cells */}
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-positive)', background: callSel ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : undefined }}>
                                  {c?.delta?.toFixed(2) ?? '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-text-dim)', background: callSel ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : undefined }}>
                                  {c?.openInterest ? (c.openInterest >= 1000 ? `${(c.openInterest/1000).toFixed(1)}k` : c.openInterest) : '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-text-dim)', background: callSel ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : undefined }}>
                                  {c?.volume ? (c.volume >= 1000 ? `${(c.volume/1000).toFixed(1)}k` : c.volume) : '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-text, #d7e3fc)', background: callSel ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : undefined }}>
                                  {c?.bid > 0 ? c.bid.toFixed(2) : '—'}
                                </td>
                                <td onClick={callClick} style={{ ...TD_base, textAlign: 'right', cursor: 'pointer', color: 'var(--theme-positive)', fontWeight: callSel ? 700 : 400, background: callSel ? 'color-mix(in srgb, var(--theme-primary) 18%, transparent)' : undefined }}>
                                  {c?.ask > 0 ? c.ask.toFixed(2) : '—'}
                                </td>

                                {/* Strike */}
                                <td style={{ ...TD_base, textAlign: 'center', background: 'color-mix(in srgb, var(--theme-primary) 5%, transparent)', fontWeight: 700,
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
              per contract (×100 shares) · {chartData.multiExpiry ? 'expired legs (per time slider) realized at spot' : 'intrinsic only'}
            </div>

            <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 0, height: 340 }}>
              <ResponsiveContainer width="100%" height={312}>
                <ComposedChart data={chartData.rows} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="price" type="number" domain={[chartData.lo, chartData.hi]} tick={TICK} tickFormatter={v => `$${(+v).toFixed(2)}`} interval="preserveStartEnd" allowDataOverflow />
                  <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right"
                    domain={[chartData.yMin, chartData.yMax]} allowDataOverflow />
                  <Tooltip
                    cursor={{ stroke: 'var(--theme-text-faint, rgba(255,255,255,0.3))', strokeWidth: 1, strokeDasharray: '3 3' }}
                    content={(props) => {
                      const { active, payload, label } = props as { active?: boolean; payload?: { dataKey?: string; value?: number }[]; label?: number }
                      if (!active || !payload?.length) return null
                      const at = (k: string) => payload.find(p => p.dataKey === k)?.value
                      const total = at('total'), tval = at('tval')
                      const signed = (v?: number) => v == null ? '—' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`
                      const col = (v?: number) => v == null ? 'var(--theme-text, #d7e3fc)' : v >= 0 ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
                      const row = (lbl: string, lblColor: string, v?: number) => (
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, marginTop: 4 }}>
                          <span style={{ color: lblColor }}>{lbl}</span>
                          <span style={{ color: col(v), fontWeight: 700 }}>{signed(v)}</span>
                        </div>
                      )
                      return (
                        <div style={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.16))', padding: '8px 11px', fontFamily: 'var(--theme-mono)', fontSize: 11, boxShadow: '0 6px 20px rgba(0,0,0,0.55)' }}>
                          <div style={{ color: 'var(--theme-text, #d7e3fc)', fontWeight: 700, marginBottom: 2 }}>
                            {primaryTicker} @ ${label != null ? (+label).toFixed(2) : '—'}
                          </div>
                          {row('At expiry', 'var(--theme-primary, #c9a84c)', total)}
                          {chartData.showT && row(chartData.tDays === 0 ? 'Today' : `+${chartData.tDays}d`, 'var(--theme-tertiary, #60a5fa)', tval)}
                        </div>
                      )
                    }}
                  />

                  {/* Green profit zone */}
                  <Area isAnimationActive={false} type="monotone" dataKey="profit" fill="rgba(47,107,75,0.25)" stroke="none" />
                  {/* Red loss zone */}
                  <Area isAnimationActive={false} type="monotone" dataKey="loss"   fill="rgba(140,46,54,0.25)"  stroke="none" />

                  {/* Breakeven line */}
                  <ReferenceLine y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.2))" strokeWidth={1} strokeDasharray="4 4" />

                  {/* Strike reference lines. Labels are staggered vertically by
                      index so near-adjacent strikes (e.g. 720/721) don't overlap. */}
                  {[...new Set(primaryLegs.map(l => l.K))].sort((a, b) => a - b).map((K, i) => (
                    <ReferenceLine key={K} x={K} stroke="color-mix(in srgb, var(--theme-primary) 65%, transparent)" strokeDasharray="3 4"
                      label={({ viewBox }: any) => (
                        <text x={viewBox.x + 3} y={viewBox.y + 10 + i * 11} fill="var(--theme-primary, #c9a84c)" fontSize={8}>{`$${K}`}</text>
                      )} />
                  ))}

                  {/* Spot marker */}
                  <ReferenceLine x={chartData.spot} stroke="rgba(217,119,54,0.7)" strokeWidth={1.5} strokeDasharray="4 2" />

                  {/* Breakeven markers. Labels sit at the BOTTOM (strikes are at the
                      top) so a breakeven near a strike never overlaps its label,
                      and are staggered among themselves. */}
                  {chartData.breakevens.map((be, i) => (
                    <ReferenceLine key={i} x={be} stroke="rgba(255,255,255,0.55)" strokeDasharray="2 4"
                      label={({ viewBox }: any) => (
                        <text x={viewBox.x + 3} y={viewBox.y + viewBox.height - 6 - i * 11} fill="var(--theme-secondary, #8099b0)" fontSize={8}>{`BE $${be}`}</text>
                      )} />
                  ))}

                  {/* Per-leg dashed contributions (dimmed once the leg has expired). */}
                  {primaryLegs.map((leg, idx) => (
                    <Line isAnimationActive={false} key={idx} type="monotone" dataKey={`leg${idx}`} stroke={LEG_COLORS[idx % LEG_COLORS.length]}
                      strokeWidth={1} strokeDasharray="5 3" dot={false} name={`Leg ${idx + 1}`} legendType="none"
                      strokeOpacity={daysFromNow > dte(leg.expiry) ? 0.25 : 1} />
                  ))}

                  {/* Before-expiry P&L (Black-Scholes at the chosen day) */}
                  {chartData.showT && (
                    <Line isAnimationActive={false} type="monotone" dataKey="tval" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={1.75} strokeDasharray="5 3" dot={false} name="tval" legendType="none" />
                  )}

                  {/* Total P&L at expiry — main gold line */}
                  <Line isAnimationActive={false} type="monotone" dataKey="total" stroke="var(--theme-primary, #c9a84c)" strokeWidth={2.5} dot={false} name="total" legendType="none" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Legend — what the lines, shaded zones, and vertical markers mean. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center', padding: '2px 12px 8px', fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>
              <span style={legWrap}><i style={legLine('var(--theme-primary, #c9a84c)', false, 2.5)} />P&L at expiry</span>
              {chartData.showT && (
                <span style={legWrap}><i style={legLine('var(--theme-tertiary, #60a5fa)', true)} />{chartData.tDays === 0 ? 'Value now' : `Value +${chartData.tDays}d`}</span>
              )}
              {primaryLegs.map((l, i) => (
                <span key={i} style={legWrap}>
                  <i style={legLine(LEG_COLORS[i % LEG_COLORS.length], true)} />
                  {`${l.action === 'buy' ? 'Long' : 'Short'} ${l.K}${l.option_type === 'call' ? 'C' : 'P'}`}
                </span>
              ))}
              <span style={legWrap}><i style={legFill('rgba(47,107,75,0.55)')} />Profit</span>
              <span style={legWrap}><i style={legFill('rgba(140,46,54,0.55)')} />Loss</span>
              <span style={legWrap}><i style={legVert('rgba(217,119,54,0.85)')} />Spot</span>
              <span style={legWrap}><i style={legVert('color-mix(in srgb, var(--theme-primary) 65%, transparent)')} />Strike</span>
              <span style={legWrap}><i style={legVert('rgba(255,255,255,0.7)')} />Break-even</span>
            </div>

            {/* Spot price slider */}
            <div style={{ padding: '8px 14px 12px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap', width: 68 }}>
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

            {/* Time-decay slider: dashed blue line = P&L this many days from now */}
            {chartData.showT && (
              <div style={{ padding: '8px 14px 12px', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-tertiary, #60a5fa)', whiteSpace: 'nowrap', width: 68 }}>
                    Time
                  </span>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <input type="range" min={0} max={chartData.maxDte} step={1} value={chartData.tDays}
                      onChange={e => setDaysFromNow(+e.target.value)}
                      style={{ width: '100%', accentColor: 'var(--theme-tertiary, #60a5fa)' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      {[0, 0.25, 0.5, 0.75, 1].map(f => {
                        const d = Math.round(chartData.maxDte * f)
                        return (
                          <button key={f} onClick={() => setDaysFromNow(d)}
                            style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-tertiary, #60a5fa)',
                              background: 'none', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '2px 5px', cursor: 'pointer' }}>
                            {f === 0 ? 'Today' : f === 1 ? 'Expiry' : `+${d}d`}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 14, fontWeight: 700, color: 'var(--theme-tertiary, #60a5fa)' }}>
                      {chartData.tDays === 0 ? 'Today' : `+${chartData.tDays}d`}
                    </div>
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary, #8099b0)' }}>
                      {Math.max(0, chartData.maxDte - chartData.tDays)} DTE left
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', marginTop: 6 }}>
                  <span style={{ color: 'var(--theme-tertiary, #60a5fa)' }}>--- </span>P&L at this date (Black-Scholes, implied vol from premium) ·
                  <span style={{ color: 'var(--theme-primary, #c9a84c)' }}> — </span>at expiry
                </div>
              </div>
            )}
          </div>

          {/* Secondary ticker sliders */}
          {secondaryTickers.length > 0 && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
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
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: pct >= 0 ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)' }}>
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

          {/* Answer-first strip: net cost + breakevens + spot */}
          {(() => {
            const netCost = legs.reduce((s, l) => s + (l.action === 'buy' ? 1 : -1) * (l.premium ?? 0) * (l.quantity ?? 0), 0) * 100
            return (
              <div style={STRIP}>
                <KpiCell grow minWidth={150} label={netCost >= 0 ? 'Net Debit' : 'Net Credit'} value={`$${Math.abs(netCost).toFixed(2)}`} color="var(--theme-primary, #c9a84c)" valueSize={16} />
                <KpiCell grow label="Breakeven" value={chartData.breakevens.length ? chartData.breakevens.map(b => `$${b}`).join(' · ') : '—'} color="var(--theme-tertiary, #60a5fa)" />
                <KpiCell grow label="Legs" value={String(legs.length)} />
                <KpiCell grow label={`${primaryTicker} Spot`} value={`$${chartData.spot.toFixed(2)}`} />
              </div>
            )
          })()}

          {/* Leg summary + breakeven */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {legs.map((leg, i) => (
              <span key={i} style={{ fontSize: 10, padding: '3px 8px', fontFamily: 'var(--theme-mono)',
                border: `1px solid ${LEG_COLORS[i % LEG_COLORS.length]}`,
                color: LEG_COLORS[i % LEG_COLORS.length] }}>
                {leg.action === 'buy' ? '↑' : '↓'} {leg.ticker} {leg.option_type.toUpperCase()} K={leg.K} @ ${leg.premium} ×{leg.quantity}
              </span>
            ))}
            {chartData.breakevens.length > 0 && (
              <span style={{ fontSize: 10, padding: '3px 8px', fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #8099b0)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                BE: {chartData.breakevens.map(b => `$${b}`).join(' / ')}
              </span>
            )}
          </div>

          {/* ── Greeks Panel ─────────────────────────────────────────────── */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--theme-surface, #142032)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>Portfolio Greeks</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {greekError && <span style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', fontFamily: 'var(--theme-mono)' }}>{greekError}</span>}
                <button
                  onClick={calculateGreeks}
                  disabled={greekLoading}
                  style={{
                    background: greekLoading ? 'transparent' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--theme-primary) 40%, transparent)', color: greekLoading ? 'rgba(255,255,255,0.3)' : 'var(--theme-primary, #c9a84c)',
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
                <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  {(['delta','gamma','theta','vega'] as const).map(g => {
                    const v = greekResult.net[g]
                    return <KpiCell grow key={g} label={`Net ${g}`} value={`${v >= 0 ? '+' : ''}${v.toFixed(4)}`} color={GREEK_COLORS[g]} />
                  })}
                </div>

                {/* Per-leg table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'rgba(0,0,0,0.2)' }}>
                        {['Ticker','K','Expiry','DTE','Spot','Type','Pos','Qty','Δ','Γ','Θ','ν','Net Δ','Net Γ','Net Θ','Net ν'].map((h, i) => (
                          <th key={h} style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', textAlign: i === 0 ? 'left' : 'right', padding: '5px 8px', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {greekResult.positions.map((pos, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                          <td style={{ padding: '5px 8px', color: 'var(--theme-primary, #c9a84c)', textAlign: 'left' }}>{pos.ticker}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.strike}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.expiry}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-secondary, #8099b0)' }}>{pos.dte}d</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>{pos.spot.toFixed(2)}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--theme-secondary, #8099b0)' }}>{pos.option_type}</td>
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
              <div style={{ padding: '16px 14px', fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-secondary, #8099b0)' }}>
                Add expiry dates to legs, then click Compute Greeks to see Δ Γ Θ ν for each position.
              </div>
            )}
          </div>

          {/* ── AI Risk Narrative ──────────────────────────────────────────── */}
          <div style={{ margin: '0 14px 14px', border: '1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 3%, transparent)' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary) 12%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                  border: '1px solid color-mix(in srgb, var(--theme-primary) 40%, transparent)', color: 'var(--theme-primary, #c9a84c)',
                  fontFamily: 'var(--theme-mono)', fontSize: 9,
                  padding: '2px 6px', cursor: (aiNarrativePending || !greekResult) ? 'default' : 'pointer',
                  opacity: (aiNarrativePending || !greekResult) ? 0.5 : 1,
                }}
              >{aiNarrativePending ? '…' : 'Analyze'}</button>
            </div>
            {!aiNarrative && !aiNarrativePending && (
              <div style={{ padding: '10px 12px', fontSize: 10, color: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-sans)' }}>
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

interface OptionsChatMsg { role: 'user' | 'assistant'; content: string }
export interface OptionsStrategyDraft { name: string; legs: Leg[]; summary: string; spot?: number; ticker?: string }

function AiOptionsStrategyChat({ onAccept }: { onAccept: (draft: OptionsStrategyDraft) => void }) {
  const [messages, setMessages] = useState<OptionsChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<OptionsStrategyDraft | null>(null)

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, pending])

  const T = {
    bg:      'var(--theme-bg, #101c2e)',
    surface: 'var(--theme-surface, #0d1826)',
    border:  'var(--theme-border, rgba(255,255,255,0.10))',
    text:    'var(--theme-text, #d7e3fc)',
    muted:   'var(--theme-secondary, #8099b0)',
    dim:     'var(--theme-text-faint, rgba(255,255,255,0.28))',
    gold:    'var(--theme-primary, #c9a84c)',
    pos:     'var(--theme-pos, #4caf7d)',
    neg:     'var(--theme-neg, #e05c6e)',
    mono:    'var(--theme-mono, ui-monospace, monospace)',
  }

  const inp: React.CSSProperties = {
    background: T.bg, border: `1px solid ${T.border}`,
    color: T.text, fontFamily: T.mono, fontSize: 11,
    padding: '4px 6px', outline: 'none', width: '100%', boxSizing: 'border-box',
  }

  const btn: React.CSSProperties = {
    background: 'transparent', border: `1px solid ${T.border}`,
    color: T.muted, fontFamily: T.mono, fontSize: 9,
    padding: '4px 10px', cursor: 'pointer', letterSpacing: '0.08em',
  }

  const send = async () => {
    const text = input.trim()
    if (!text || pending) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setError('')
    setPending(true)
    try {
      const { data } = await axios.post('/api/ai/options-strategy-chat', { messages: next })
      if (data?.type === 'draft') {
        const draftLegs: Leg[] = Array.isArray(data.legs) ? data.legs.map((l: any) => ({
          option_type: l.option_type === 'put' ? 'put' : 'call',
          action: l.action === 'sell' ? 'sell' : 'buy',
          K: Number(l.K) || 100,
          premium: Number(l.premium) || 2.0,
          quantity: Number(l.quantity) || 1,
          ticker: typeof l.ticker === 'string' && l.ticker ? l.ticker.toUpperCase() : 'SPY',
          expiry: typeof l.expiry === 'string' && l.expiry ? l.expiry : DEFAULT_EXPIRY,
        })) : []
        const hydrated: OptionsStrategyDraft = {
          name: typeof data.name === 'string' && data.name ? data.name : 'Custom Strategy',
          legs: draftLegs,
          summary: typeof data.summary === 'string' && data.summary ? data.summary : 'Draft ready.',
          spot: Number.isFinite(Number(data.spot)) ? Number(data.spot) : undefined,
          ticker: typeof data.ticker === 'string' && data.ticker ? data.ticker.toUpperCase() : undefined,
        }
        setDraft(hydrated)
        setMessages(m => [...m, { role: 'assistant', content: hydrated.summary }])
      } else {
        setDraft(null)
        setMessages(m => [...m, { role: 'assistant', content: data?.text || "Could you clarify that strategy?" }])
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Request failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: 1.4 }}>
        Describe an options strategy. The assistant asks clarifying questions, then drafts the contract legs.
      </div>

      <div ref={listRef} style={{
        display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto',
        padding: messages.length ? 8 : 0, background: messages.length ? T.surface : 'transparent',
        border: messages.length ? `1px solid ${T.border}` : 'none',
      }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono, lineHeight: 1.6, fontStyle: 'italic' }}>
            e.g. "Sell a 10% wide iron condor on SPY for August expiry" or "Buy a 150/160 bull call spread on AAPL"
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{
              fontSize: 8, color: T.dim, fontFamily: T.mono, marginBottom: 2, letterSpacing: '0.08em',
              textTransform: 'uppercase', textAlign: m.role === 'user' ? 'right' : 'left',
            }}>{m.role === 'user' ? 'You' : 'Assistant'}</div>
            <div style={{
              fontSize: 10, fontFamily: T.mono, lineHeight: 1.4, padding: '5px 8px', whiteSpace: 'pre-wrap',
              color: T.text, background: m.role === 'user' ? `${T.gold}14` : T.bg,
              border: `1px solid ${m.role === 'user' ? `${T.gold}40` : T.border}`,
            }}>{m.content}</div>
          </div>
        ))}
        {pending && <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, fontStyle: 'italic' }}>Thinking…</div>}
      </div>

      {draft && (
        <div style={{ border: `1px solid ${T.gold}40`, background: `${T.gold}08`, padding: '8px 10px' }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, fontFamily: T.mono, marginBottom: 6 }}>
            Draft ready ({draft.name})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            {draft.legs.map((leg, idx) => (
              <div key={idx} style={{ fontSize: 9, fontFamily: T.mono, color: T.text }}>
                {leg.action === 'buy' ? '↑ BUY' : '↓ SELL'} {leg.ticker} {leg.option_type.toUpperCase()} K={leg.K} exp={leg.expiry} ×{leg.quantity}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => onAccept(draft)}
              style={{ ...btn, background: T.gold, border: 'none', color: T.bg, fontWeight: 700, letterSpacing: '0.08em', padding: '4px 8px' }}>
              Load Legs
            </button>
            <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>or keep chatting below to adjust</span>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 9, color: T.neg, fontFamily: T.mono }}>{error}</div>}

      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={messages.length ? 'Reply…' : 'Describe strategy…'}
          disabled={pending}
          style={{ ...inp, fontSize: 11, padding: '6px 8px', flex: 1 }} />
        <button onClick={send} disabled={pending || !input.trim()}
          style={{ ...btn, padding: '4px 12px', fontWeight: 700, opacity: (pending || !input.trim()) ? 0.5 : 1, cursor: (pending || !input.trim()) ? 'default' : 'pointer' }}>
          Send
        </button>
      </div>
    </div>
  )
}
