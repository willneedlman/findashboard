import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import { X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { KpiCell } from '../components/mmCockpit'
import SidebarLayout from '../components/SidebarLayout'
import TickerInput from '../components/TickerInput'
import ExpirySelect from '../components/ExpirySelect'
import { priceOption, optionPayoff, optionSurface, optionMultiLeg, fetchOptionsChain, fetchRiskFreeRate } from '../hooks/useApi'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'

const GREEK_COLOR: Record<string, string> = {
  delta: 'var(--theme-tertiary, #1f5673)', gamma: '#7b5ea7', theta: '#8c2e36', vega: '#2f6b4b',
}

import { INPUT, Select, LABEL, HINT, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

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

// Cockpit instrument strip — the answer-first band shared with the MM sims and
// IV Tracker: a hero figure then hairline-divided KpiCells.
const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const gFmt = (v: number) => (Number.isFinite(v) ? String(v) : '—')

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

type Leg = { side: 1 | -1; option_type: 'call' | 'put'; qty: number; K: number; T: number; sigma: number }
interface MultiData {
  net_price: number
  greeks: { delta: number; gamma: number; theta: number; vega: number }
  vanna: number; charm: number; lambda: number
  spot: number[]; payoff: number[]
  surface: { spot: number[]; delta: number[]; gamma: number[]; theta: number[]; vega: number[] }
  legs: { option_type: string; side: number; qty: number; K: number; T: number; sigma: number; price: number
          greeks: { delta: number; gamma: number; theta: number; vega: number } }[]
  breakevens: number[]; max_profit: number; max_loss: number
  max_profit_unbounded: boolean; max_loss_unbounded: boolean; current_spot: number
}

// Presets build legs around the live spot and the user's vol/tenor so a new
// structure lands near at-the-money instead of a fixed strike grid.
const ML_PRESETS: Record<string, (S: number, sigma: number, T: number) => Leg[]> = {
  'Long Call':         (S, v, T) => [{ side: 1, option_type: 'call', qty: 1, K: rnd(S), T, sigma: v }],
  'Bull Call Spread':  (S, v, T) => [{ side: 1, option_type: 'call', qty: 1, K: rnd(S), T, sigma: v }, { side: -1, option_type: 'call', qty: 1, K: rnd(S * 1.1), T, sigma: v }],
  'Bear Put Spread':   (S, v, T) => [{ side: 1, option_type: 'put', qty: 1, K: rnd(S), T, sigma: v }, { side: -1, option_type: 'put', qty: 1, K: rnd(S * 0.9), T, sigma: v }],
  'Long Straddle':     (S, v, T) => [{ side: 1, option_type: 'call', qty: 1, K: rnd(S), T, sigma: v }, { side: 1, option_type: 'put', qty: 1, K: rnd(S), T, sigma: v }],
  'Iron Condor':       (S, v, T) => [{ side: 1, option_type: 'put', qty: 1, K: rnd(S * 0.9), T, sigma: v }, { side: -1, option_type: 'put', qty: 1, K: rnd(S * 0.95), T, sigma: v }, { side: -1, option_type: 'call', qty: 1, K: rnd(S * 1.05), T, sigma: v }, { side: 1, option_type: 'call', qty: 1, K: rnd(S * 1.1), T, sigma: v }],
}
function rnd(x: number): number { return Math.round(x) }

function LegEditor({ legs, setLegs, sigma, T }: { legs: Leg[]; setLegs: (l: Leg[]) => void; sigma: number; T: number }) {
  const upd = (i: number, patch: Partial<Leg>) => setLegs(legs.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  const small: React.CSSProperties = { ...INPUT, padding: '5px 6px', fontSize: 11 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {legs.map((leg, i) => (
        <div key={i} style={{ border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => upd(i, { side: leg.side === 1 ? -1 : 1 })} style={{
              flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
              fontFamily: 'var(--theme-sans)',
              background: leg.side === 1 ? 'color-mix(in srgb, var(--theme-positive) 16%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 16%, transparent)',
              border: `1px solid ${leg.side === 1 ? 'var(--theme-positive)' : 'var(--theme-negative)'}`,
              color: leg.side === 1 ? 'var(--theme-positive)' : 'var(--theme-negative)',
            }}>{leg.side === 1 ? 'Long' : 'Short'}</button>
            <select value={leg.option_type} onChange={e => upd(i, { option_type: e.target.value as 'call' | 'put' })} style={{ ...small, flex: 1, cursor: 'pointer' }}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
            <button onClick={() => setLegs(legs.filter((_, idx) => idx !== i))} disabled={legs.length === 1} aria-label={`Remove leg ${i + 1}`} style={{
              width: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '5px 0', cursor: legs.length === 1 ? 'default' : 'pointer',
              background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
              color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', opacity: legs.length === 1 ? 0.3 : 1,
            }}><X size={12} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
            <NumCell label="Qty"    value={leg.qty}   step={1}   onChange={v => upd(i, { qty: v })} />
            <NumCell label="Strike" value={leg.K}     step={1}   onChange={v => upd(i, { K: v })} />
            <NumCell label="Days"   value={leg.T}     step={1}   onChange={v => upd(i, { T: v })} />
            <NumCell label="IV %"   value={leg.sigma} step={0.5} onChange={v => upd(i, { sigma: v })} />
          </div>
        </div>
      ))}
      <button onClick={() => setLegs([...legs, { side: 1, option_type: 'call', qty: 1, K: rnd(legs[legs.length - 1]?.K ?? 100), T, sigma }])}
        disabled={legs.length >= 20} style={{
        width: '100%', background: 'transparent', border: '1px dashed var(--theme-border, rgba(255,255,255,0.2))',
        color: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.12em', textTransform: 'uppercase', padding: '8px 0', cursor: legs.length >= 20 ? 'default' : 'pointer',
      }}>+ Add Leg</button>
    </div>
  )
}

function NumCell({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', display: 'block', marginBottom: 2 }}>{label}</label>
      <input type="number" value={value} step={step} onChange={e => onChange(+e.target.value)}
        style={{ ...INPUT, padding: '5px 5px', fontSize: 11, width: '100%', boxSizing: 'border-box' }} />
    </div>
  )
}

function MultiResults({ data, view, setView }: { data: MultiData; view: '2d' | 'payoff'; setView: (v: '2d' | 'payoff') => void }) {
  const debit = data.net_price >= 0
  return (
    <>
      <div style={STRIP}>
        <KpiCell grow minWidth={130} label={`Net ${debit ? 'Debit' : 'Credit'}`} value={`$${Math.abs(data.net_price).toFixed(2)}`} color="var(--theme-primary, #c9a84c)" valueSize={16} />
        <KpiCell grow label="Max Profit" value={data.max_profit_unbounded ? 'Unbounded' : `$${data.max_profit.toFixed(2)}`} color="var(--theme-positive)" />
        <KpiCell grow label="Max Loss" value={data.max_loss_unbounded ? 'Unbounded' : `$${Math.abs(data.max_loss).toFixed(2)}`} color="var(--theme-negative)" />
        {data.breakevens.length > 0 && <KpiCell grow label="Breakeven" value={data.breakevens.map(b => `$${b.toFixed(2)}`).join(' · ')} color="var(--theme-tertiary, #60a5fa)" />}
        <KpiCell grow label="Delta"  value={gFmt(data.greeks.delta)} />
        <KpiCell grow label="Gamma"  value={gFmt(data.greeks.gamma)} />
        <KpiCell grow label="Theta"  value={gFmt(data.greeks.theta)} />
        <KpiCell grow label="Vega"   value={gFmt(data.greeks.vega)} />
        <KpiCell grow label="Vanna"  value={gFmt(data.vanna)} />
        <KpiCell grow label="Charm"  value={gFmt(data.charm)} />
        <KpiCell grow label="Lambda" value={gFmt(data.lambda)} />
      </div>
      <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
        {/* Per-leg breakdown */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 11.5 }}>
            <thead>
              <tr>{['Leg', 'Qty', 'Strike', 'Days', 'IV', 'Premium', 'Delta'].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '7px 12px', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {data.legs.map((l, i) => (
                <tr key={i} style={{ borderBottom: i < data.legs.length - 1 ? '1px solid var(--theme-border, rgba(255,255,255,0.05))' : 'none' }}>
                  <td style={{ padding: '7px 12px', color: l.side === 1 ? 'var(--theme-positive)' : 'var(--theme-negative)', fontWeight: 700 }}>
                    {l.side === 1 ? 'Long' : 'Short'} {l.option_type === 'call' ? 'Call' : 'Put'}
                  </td>
                  <td style={tdNum}>{l.qty}</td>
                  <td style={tdNum}>${l.K}</td>
                  <td style={tdNum}>{l.T}</td>
                  <td style={tdNum}>{l.sigma}%</td>
                  <td style={{ ...tdNum, color: 'var(--theme-text, #d7e3fc)' }}>${l.price.toFixed(2)}</td>
                  <td style={tdNum}>{l.greeks.delta.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
        {(['2d', 'payoff'] as const).map(t => (
          <button key={t} onClick={() => setView(t)} style={{
            padding: '7px 16px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
            background: 'none', border: 'none', cursor: 'pointer',
            color: view === t ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.18))',
            borderBottom: view === t ? '2px solid var(--theme-primary, #c9a84c)' : '2px solid transparent', marginBottom: -1,
          }}>{t === '2d' ? '2D Greeks' : 'Payoff Diagram'}</button>
        ))}
      </div>

      {view === 'payoff' && (
        <ChartPanel label="Net P&L at Expiry" height={348}>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={data.spot.map((s, i) => ({ spot: s.toFixed(1), pnl: data.payoff[i] }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
              <XAxis dataKey="spot" tick={TICK} interval="preserveStartEnd" />
              <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
              <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, 'P&L']} contentStyle={TOOLTIP_STYLE} />
              <ReferenceLine y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.15))" strokeDasharray="4 4" />
              <ReferenceLine x={String(data.current_spot.toFixed(1))} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 50%, transparent)" strokeDasharray="3 3"
                label={{ value: 'Spot', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9 }} />
              {data.breakevens.map((b, i) => (
                <ReferenceLine key={i} x={String(b.toFixed(1))} stroke="var(--theme-tertiary, #60a5fa)" strokeDasharray="2 4" />
              ))}
              <Line isAnimationActive={false} type="monotone" dataKey="pnl" stroke="var(--theme-primary, #c9a84c)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartPanel>
      )}

      {view === '2d' && (
        <div className="chart-pair">
          {(['delta', 'gamma', 'theta', 'vega'] as const).map(greek => (
            <ChartPanel key={greek} label={`Net ${greek.toUpperCase()}`} height={208}>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data.surface.spot.map((s, i) => ({ spot: s.toFixed(0), value: data.surface[greek][i] }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="spot" tick={TICK} interval="preserveStartEnd" />
                  <YAxis tick={TICK} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <ReferenceLine x={String(data.current_spot.toFixed(0))} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)" strokeDasharray="3 3" />
                  <Line isAnimationActive={false} type="monotone" dataKey="value" stroke={GREEK_COLOR[greek]} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>
          ))}
        </div>
      )}
    </>
  )
}

const tdNum: React.CSSProperties = { padding: '7px 12px', textAlign: 'right', color: 'var(--theme-secondary, #8099b0)', fontVariantNumeric: 'tabular-nums' }

export function OptionsPricerContent() {
  const [params, setParams] = useState<Params>({ S: 100, K: 100, T: 30, sigma: 20, r: 5, option_type: 'call' })
  const [view, setView] = useState<'2d' | 'payoff'>('2d')
  const [paramsOpen, setParamsOpen] = useState(true)

  // Multi-leg (theoretical) mode: legs priced from the shared spot/rate plus each
  // leg's own strike/days/IV, netted into one premium, greek set, and payoff.
  const [mode, setMode] = useState<'single' | 'multi'>('single')
  const [legs, setLegs] = useState<Leg[]>(ML_PRESETS['Bull Call Spread'](100, 20, 30))
  const { mutate: calcMulti, data: multiData, isPending: multiPending, isError: multiError } =
    useMutation<MultiData, unknown, void>({ mutationFn: () => optionMultiLeg({ S: params.S, r: params.r, legs }) })
  const runMulti = () => calcMulti()

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

  // Term-matched risk-free rate: interpolate the Treasury curve at the option's
  // tenor (days to expiry) so the rate tracks the contract instead of a fixed
  // 3M bill. Keyed on the rounded tenor so React Query caches per maturity.
  const tenorDays = Math.max(Math.round(params.T), 1)
  const rfQuery = useQuery({
    queryKey: ['risk-free', tenorDays],
    queryFn: () => fetchRiskFreeRate(tenorDays),
    staleTime: 10 * 60_000,
  })

  const runAll = (p: Params) => { calcPrice(p); calcPayoff(p); calcSurface(p) }

  // Apply the term-matched rate whenever it changes, unless the user has pinned
  // the rate by editing it themselves. Skip when it already matches to avoid a
  // redundant re-price.
  const rUserEdited = useRef(false)
  useEffect(() => {
    const rate = rfQuery.data?.rate
    if (rate == null || rUserEdited.current) return
    const rPct = Math.round(rate * 1000) / 10
    if (rPct === params.r) return
    setParams(p => ({ ...p, r: rPct }))
  }, [rfQuery.data])

  const recalc = () => runAll(params)
  const set = (k: keyof Params) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    // Hand-editing a parameter detaches the analysis from the loaded contract,
    // so drop the market-mark chip and the contract selection rather than show a
    // price tied to a strike the user has since changed.
    setLoadedMark(null)
    setSelectedIdx('')
    // A manual rate edit pins it; stop auto-tracking the curve from there on.
    if (k === 'r') rUserEdited.current = true
    setParams(p => ({ ...p, [k]: k === 'option_type' ? e.target.value : +e.target.value }))
  }

  const chain = chainMut.data
  const chainRows = chain ? (params.option_type === 'call' ? chain.calls : chain.puts) : []

  const TAB = 'Options Pricer'
  useReportCapture(() => {
    const pieces: ClipDraft[] = []
    if (mode === 'multi' && multiData) {
      const debit = multiData.net_price >= 0
      pieces.push(kpiClip(TAB, 'Multi-Leg Summary', [
        { label: debit ? 'Net Debit' : 'Net Credit', value: `$${Math.abs(multiData.net_price).toFixed(2)}` },
        { label: 'Max Profit', value: multiData.max_profit_unbounded ? 'Unbounded' : `$${multiData.max_profit.toFixed(2)}` },
        { label: 'Max Loss', value: multiData.max_loss_unbounded ? 'Unbounded' : `$${Math.abs(multiData.max_loss).toFixed(2)}` },
        { label: 'Breakeven', value: multiData.breakevens.length ? multiData.breakevens.map(b => `$${b.toFixed(2)}`).join(' · ') : '—' },
        { label: 'Delta', value: gFmt(multiData.greeks.delta) },
        { label: 'Gamma', value: gFmt(multiData.greeks.gamma) },
        { label: 'Theta', value: gFmt(multiData.greeks.theta) },
        { label: 'Vega', value: gFmt(multiData.greeks.vega) },
      ]))
      pieces.push(tableClip(TAB, 'Legs',
        ['Leg', 'Qty', 'Strike', 'Days', 'IV', 'Premium', 'Delta'],
        multiData.legs.map(l => [
          `${l.side === 1 ? 'Long' : 'Short'} ${l.option_type}`,
          l.qty, l.K, l.T, `${l.sigma}%`, l.price.toFixed(2), l.greeks.delta.toFixed(3),
        ]),
      ))
      if (multiData.spot?.length) {
        pieces.push(chartClip(TAB, 'Net P&L at Expiry', 'line', 'spot',
          multiData.spot.map((s, i) => ({ spot: +s.toFixed(1), pnl: multiData.payoff[i] })),
          [{ key: 'pnl', label: 'P&L' }],
        ))
      }
      if (multiData.surface?.spot?.length) {
        pieces.push(chartClip(TAB, 'Net Greeks vs Spot', 'line', 'spot',
          multiData.surface.spot.map((s, i) => ({
            spot: +s.toFixed(0),
            delta: multiData.surface.delta[i],
            gamma: multiData.surface.gamma[i],
            theta: multiData.surface.theta[i],
            vega: multiData.surface.vega[i],
          })),
          [
            { key: 'delta', label: 'Delta' }, { key: 'gamma', label: 'Gamma' },
            { key: 'theta', label: 'Theta' }, { key: 'vega', label: 'Vega' },
          ],
        ))
      }
      return pieces
    }
    if (mode === 'single' && priceData) {
      pieces.push(kpiClip(TAB, 'Premium & Greeks', [
        { label: 'Option Premium', value: `$${priceData.price}` },
        ...(loadedMark ? [{ label: 'Market', value: `$${loadedMark.mark.toFixed(2)}` }] : []),
        { label: 'Delta', value: gFmt(priceData.greeks.delta) },
        { label: 'Gamma', value: gFmt(priceData.greeks.gamma) },
        { label: 'Theta', value: gFmt(priceData.greeks.theta) },
        { label: 'Vega', value: gFmt(priceData.greeks.vega) },
        { label: 'Vanna', value: gFmt(priceData.vanna) },
        { label: 'Charm', value: gFmt(priceData.charm) },
        { label: 'Lambda', value: gFmt(priceData.lambda) },
      ]))
      pieces.push(kpiClip(TAB, 'Contract Assumptions', [
        { label: 'Type', value: params.option_type.toUpperCase() },
        { label: 'Spot', value: `$${params.S}` },
        { label: 'Strike', value: `$${params.K}` },
        { label: 'Days', value: String(params.T) },
        { label: 'IV', value: `${params.sigma}%` },
        { label: 'Rate', value: `${params.r}%` },
      ]))
      if (payoffData?.spot?.length) {
        pieces.push(chartClip(TAB, 'P&L at Expiry', 'line', 'spot',
          payoffData.spot.map((s: number, i: number) => ({ spot: +s.toFixed(1), pnl: payoffData.payoff[i] })),
          [{ key: 'pnl', label: 'P&L' }],
        ))
      }
      if (surfaceData?.spot?.length) {
        pieces.push(chartClip(TAB, 'Greeks vs Spot', 'line', 'spot',
          surfaceData.spot.map((s: number, i: number) => ({
            spot: +s.toFixed(0),
            delta: surfaceData.delta[i], gamma: surfaceData.gamma[i],
            theta: surfaceData.theta[i], vega: surfaceData.vega[i],
          })),
          [
            { key: 'delta', label: 'Delta' }, { key: 'gamma', label: 'Gamma' },
            { key: 'theta', label: 'Theta' }, { key: 'vega', label: 'Vega' },
          ],
        ))
      }
      return pieces
    }
    return null
  }, {
    disabled: mode === 'single' ? !priceData : !multiData,
    sourceTab: TAB,
  })

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
          <div style={{ display: 'flex', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', margin: '0 0 4px' }}>
            {(['single', 'multi'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                flex: 1, padding: '8px 0', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                fontFamily: 'var(--theme-sans)', cursor: 'pointer', border: 'none',
                borderRight: m === 'single' ? '1px solid var(--theme-border, rgba(255,255,255,0.08))' : 'none',
                background: mode === m ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                color: mode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
              }}>{m === 'single' ? 'Single' : 'Multi-Leg'}</button>
            ))}
          </div>
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
              {chainMut.isPending ? 'FETCHING…' : 'FETCH'}
            </button>
            {chainMut.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', fontFamily: 'var(--theme-sans)' }}>No chain found for that symbol.</div>}
            {chain && (
              <>
                <div>
                  <label style={LABEL}>Expiry</label>
                  <ExpirySelect ticker={chainSym} value={chainExpiry} expirations={chain.expirations}
                    autoSelect={false} style={{ ...INPUT, cursor: 'pointer' }}
                    onChange={exp => { setChainExpiry(exp); chainMut.mutate({ ticker: chainSym, expiry: exp }) }} />
                </div>
                <div>
                  <label style={LABEL}>Contract ({params.option_type === 'call' ? 'Calls' : 'Puts'})</label>
                  <Select value={selectedIdx}
                    onChange={e => applyContract(e.target.value)}>
                    <option value="" disabled>Select strike…</option>
                    {chainRows.map((r, i) => (
                      <option key={`${r.strike}-${i}`} value={i}>
                        {r.strike} · ${rowMark(r).toFixed(2)} · IV {(r.impliedVolatility * 100).toFixed(0)}%
                      </option>
                    ))}
                  </Select>
                  {chain.spot != null && <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', fontFamily: 'var(--theme-mono)', marginTop: 5 }}>Spot ${chain.spot.toFixed(2)} · {chain.dte === 0 ? `${(chain.t_days * 24).toFixed(1)}h to expiry` : `${chain.dte}d to expiry`}</div>}
                </div>
              </>
            )}
          </div>
          </RailSection>
          {mode === 'single' && (
          <RailSection title="Pricing Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {([
              { label: 'Spot Price ($)',     key: 'S',     step: 1 },
              { label: 'Strike Price ($)',   key: 'K',     step: 1 },
              { label: 'Days to Expiry',     key: 'T',     step: 1 },
              { label: 'Volatility (%)',     key: 'sigma', step: 0.5 },
              { label: 'Risk-Free Rate (%)', key: 'r',     step: 0.25, hint: 'Treasury curve, matched to expiry' },
            ] as const).map(f => (
              <div key={f.key}>
                <label style={LABEL}>{f.label}</label>
                <input type="number" value={(params as any)[f.key]} step={f.step}
                  onChange={set(f.key as any)} style={INPUT}
                  onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')}
                />
                {'hint' in f && f.hint && <div style={HINT}>{f.hint}</div>}
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
          )}

          {mode === 'multi' && (
          <RailSection title="Strategy" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={LABEL}>Spot ($)</label>
                <input type="number" value={params.S} step={1} onChange={set('S')} style={INPUT} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={LABEL}>Rate (%)</label>
                <input type="number" value={params.r} step={0.25} onChange={set('r')} style={INPUT} />
              </div>
            </div>
            <div>
              <label style={LABEL}>Preset</label>
              <Select defaultValue="" onChange={e => { const p = ML_PRESETS[e.target.value]; if (p) setLegs(p(params.S, params.sigma, params.T)) }}>
                <option value="" disabled>Load a structure…</option>
                {Object.keys(ML_PRESETS).map(name => <option key={name} value={name}>{name}</option>)}
              </Select>
            </div>
            <div>
              <label style={LABEL}>Legs</label>
              <LegEditor legs={legs} setLegs={setLegs} sigma={params.sigma} T={params.T} />
            </div>
          </div>
          </RailSection>
          )}
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(() => {
              const pending = mode === 'single' ? pricePending : multiPending
              const err = mode === 'single' ? priceError : multiError
              return <>
                <button onClick={mode === 'single' ? recalc : runMulti} disabled={pending} style={{
                  width: '100%', background: pending ? 'var(--theme-hover, rgba(255,255,255,0.04))' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
                  border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
                  fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                  textTransform: 'uppercase', padding: '8px 0', cursor: pending ? 'default' : 'pointer',
                  opacity: pending ? 0.6 : 1, transition: 'opacity 0.15s',
                }}>
                  {pending ? 'RUNNING…' : 'RUN'}
                </button>
                {err && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', textAlign: 'center', fontFamily: 'var(--theme-sans)' }}>Server unavailable. Is the backend running?</div>}
              </>
            })()}
          </div>
        </>}>

          {mode === 'single' && !priceData && !pricePending && (
            <EmptyState title="Options Pricer" hint="Set your contract assumptions or load a listed option, then calculate its premium and Greeks."
              action="RUN" />
          )}

          {mode === 'single' && priceData && (<>
          {/* Premium + Greeks */}
          {priceData && (<>
            <div style={STRIP}>
              <KpiCell grow minWidth={140} label="Option Premium" value={`$${priceData.price}`} color="var(--theme-primary, #c9a84c)" valueSize={16} />
              {loadedMark && <KpiCell grow label="Market" value={`$${loadedMark.mark.toFixed(2)}`} color="var(--theme-tertiary, #60a5fa)" />}
              <KpiCell grow label="Delta"  value={gFmt(priceData.greeks.delta)} />
              <KpiCell grow label="Gamma"  value={gFmt(priceData.greeks.gamma)} />
              <KpiCell grow label="Theta"  value={gFmt(priceData.greeks.theta)} />
              <KpiCell grow label="Vega"   value={gFmt(priceData.greeks.vega)} />
              <KpiCell grow label="Vanna"  value={gFmt(priceData.vanna)} />
              <KpiCell grow label="Charm"  value={gFmt(priceData.charm)} />
              <KpiCell grow label="Lambda" value={gFmt(priceData.lambda)} />
            </div>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', padding: '0 2px' }}>
              {params.option_type.toUpperCase()} · S={params.S} · K={params.K} · T={params.T}d · σ={params.sigma}% · r={params.r}%{loadedMark ? ` · ${loadedMark.label}` : ''}
            </div>
          </>)}

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
                  <Line isAnimationActive={false} type="monotone" dataKey="pnl" stroke="var(--theme-positive)" strokeWidth={2} dot={false} />
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
                      <Line isAnimationActive={false} type="monotone" dataKey="value" stroke={GREEK_COLOR[greek]} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartPanel>
              ))}
            </div>
          )}
          </>)}

          {mode === 'multi' && multiData && (
            <MultiResults data={multiData} view={view} setView={setView} />
          )}

          {mode === 'multi' && !multiData && !multiPending && (
            <EmptyState title="Multi-Leg Options Pricer" hint="Set the strategy legs, then calculate the combined premium, Greeks and payoff."
              action="RUN" />
          )}

        </SidebarLayout>
  )
}

export default function OptionsPricer() {
  return <PageWrapper title="Options Pricer"><OptionsPricerContent /></PageWrapper>
}
