import { useState, useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, type UseMutationResult } from '@tanstack/react-query'
import axios from 'axios'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { ChevronUp, ChevronDown, Play, Plus, Send, Repeat } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { KpiCell } from '../components/mmCockpit'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK } from './valuationShared'
import CustomStrategyModal, { type CustomStrategyDef, DEFAULT_RISK, rulesForTicker, usesNonDailyTimeframe } from '../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy, deleteCustomStrategy, duplicateCustomStrategy } from '../utils/customStrategies'
import { PRESETS, PRESET_GROUPS, type Leg } from './strategy-builder/shared'
import { ReturnsScatter, quickRegression } from './regressionShared'
import { readPMPortfolios, normalizeTicker, type PMPortfolio } from '../lib/pmImport'
import { SCREENER_ALGO_HANDOFF_KEY, type ScreenerAlgoHandoff } from './StockScreener'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip, textClip } from '../lib/reportCaptureRegistry'

// Backend combo-instrument leg shape (mirrors strategy-builder's Leg but strike
// is a moneyness ratio — spot-relative, not a dollar strike — since the combo
// engine re-derives strikes from the spot at each historical entry).
export type ComboLeg = { type: 'call' | 'put'; side: 'buy' | 'sell'; moneyness: number; qty: number }
export const legsToCombo = (legs: Leg[]): ComboLeg[] =>
  legs.map(l => ({ type: l.option_type, side: l.action, moneyness: l.K / 100, qty: l.quantity }))
export const mkComboLeg = (): ComboLeg => ({ type: 'call', side: 'buy', moneyness: 1, qty: 1 })
// Strike entered as % out-of-the-money (negative = in-the-money) converts to the
// backend's moneyness multiplier per option side: call OTM = strike above spot,
// put OTM = strike below spot.
export const otmToMoneyness = (optType: 'call' | 'put', otmPct: number) =>
  optType === 'call' ? 1 + otmPct / 100 : 1 - otmPct / 100
export const singleOptionLeg = (optType: 'call' | 'put', side: 'long' | 'short', otmPct: number): ComboLeg =>
  ({ type: optType, side: side === 'short' ? 'sell' : 'buy', moneyness: otmToMoneyness(optType, otmPct), qty: 1 })
// paper_engine.place_multileg_order only accepts 2-4 legs — capping here keeps a
// backtested combo executable live instead of silently failing to open.
export const MAX_COMBO_LEGS = 4
export const ALGO_MC_HANDOFF_KEY = 'fdb_algo_universe_monte_carlo_handoff'
export type AlgoMonteCarloHandoff = {
  version: 1
  createdAt: string
  start: string
  end?: string
  timeframe: string
  strategy: CustomStrategyDef
  tradeSizePct: number
  leverage: number
  effectiveAnnualRate: number
  positions: Array<Pick<PortfolioPos, 'ticker' | 'instMode' | 'optType' | 'otmPct' | 'dte' | 'comboLegs' | 'comboDte' | 'side' | 'tradeSize'>>
}

// An option/combo position has no analog in the portfolio GBM/bootstrap
// simulator (it treats every leg as plain weighted equity — no strike, no
// premium decay, no options awareness at all) or in "Exact Algo Replay"
// (that's the buy/sell-RULE-driven historical backtest; this handoff carries
// a structural snapshot instead, since the options Monte Carlo tab has no
// rule-evaluation concept — it's "enter this structure now, simulate to
// DTE"). Routes to the Options Strategy tab, not the Portfolio tab. A single
// position uses `ticker`; a portfolio where every position runs the same
// combo across many symbols uses `tickers` — the SAME legs applied to each
// one's own spot/IV, equal-weighted, summed into one basket distribution.
export const ALGO_MC_OPTIONS_HANDOFF_KEY = 'fdb_algo_options_monte_carlo_handoff'
export type AlgoOptionsMonteCarloHandoff = {
  version: 1
  createdAt: string
  ticker: string
  tickers?: string[]
  legs: ComboLeg[]
  dte: number
  takeProfitPct?: number
  stopLossPct?: number
  maxHoldDays?: number
  positionSizePct: number
  leverage: number
  effectiveAnnualRate: number
  strategyName?: string
  strategyRules?: { buy: any; sell: any }
}

// The Screener owns SCREENER_ALGO_HANDOFF_KEY/ScreenerAlgoHandoff (it's the
// producer — "Send to Algo Builder" on a screen result). Consumed here and
// cleared immediately, unlike ALGO_MC_HANDOFF_KEY above: that handoff seeds
// ephemeral Monte Carlo state that's fully replaced on each read; this one
// APPENDS into `positions`, which is itself independently persisted to
// PF_KEY — leaving the key around would re-append the same tickers every
// time this page remounts.
function consumeScreenerAlgoHandoff(): ScreenerAlgoHandoff | null {
  try {
    const raw = localStorage.getItem(SCREENER_ALGO_HANDOFF_KEY)
    if (!raw) return null
    localStorage.removeItem(SCREENER_ALGO_HANDOFF_KEY)
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.tickers) || !parsed.tickers.length) return null
    return parsed
  } catch {
    return null
  }
}
// A combo's real direction lives per-leg (side: 'buy'|'sell'), not in the
// position's own top-level `side` field — that field is hidden/unused once
// instMode is 'combo' (see the Instrument toggle), so it's stale leftover
// data, not a reliable label.
const comboNetSide = (legs: ComboLeg[]): 'long' | 'short' | 'mixed' => {
  if (legs.every(l => l.side === 'buy')) return 'long'
  if (legs.every(l => l.side === 'sell')) return 'short'
  return 'mixed'
}

// One leg per card (type/side row, then strike%/qty row) rather than cramming
// five fields into one row — the combo editor lives in narrow rails/cards
// (as narrow as 166px) where a single-row grid truncates every field's text.
// Shared by the Algo Strategy Builder (single + portfolio mode) and the
// Portfolio Backtester's combo holdings.
// A plain controlled number input can't be cleared to type a fresh value —
// the moment the field goes empty, onChange fires with '', the handler falls
// back to a default/min, and the forced re-render snaps digits back before the
// user can type a replacement. Local text state lets the field sit empty while
// typing; clamp + commit only on blur (or Enter). While focused, external
// value changes do not overwrite in-progress edits.
const _numInputDefaultStyle: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 10, padding: '4px 5px', outline: 'none', width: '100%', boxSizing: 'border-box' }
export function NumInput({ value, min, max, onCommit, title, style }: {
  value: number; min: number; max?: number; onCommit: (v: number) => void; title?: string; style?: React.CSSProperties
}) {
  const [text, setText] = useState(String(value))
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setText(String(value))
  }, [value])

  const commit = () => {
    const raw = text.trim()
    const n = Number(raw)
    if (raw === '' || !Number.isFinite(n)) {
      setText(String(value))
      return
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min, n))
    onCommit(clamped)
    setText(String(clamped))
  }

  return (
    <input type="number" step="any" min={min} max={max} title={title} value={text}
      onFocus={() => { focusedRef.current = true }}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        focusedRef.current = false
        commit()
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      style={style ?? _numInputDefaultStyle} />
  )
}

export function ComboLegEditor({ legs, onUpdate, onRemove, onAdd, horizontal }: {
  legs: ComboLeg[]
  onUpdate: (i: number, patch: Partial<ComboLeg>) => void
  onRemove: (i: number) => void
  onAdd: () => void
  horizontal?: boolean
}) {
  const sel: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 10, padding: '4px 5px', outline: 'none', cursor: 'pointer', width: '100%', boxSizing: 'border-box' }
  const fieldLabel: React.CSSProperties = { fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', marginBottom: 2 }
  const atCap = legs.length >= MAX_COMBO_LEGS
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>Legs ({legs.length})</span>
        <button type="button" onClick={onAdd} disabled={atCap}
          title={atCap ? `Live paper trading supports at most ${MAX_COMBO_LEGS} legs` : undefined}
          style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: atCap ? 'var(--theme-text-faint, rgba(255,255,255,0.3))' : 'var(--theme-primary, #c9a84c)', background: 'none', border: 'none', cursor: atCap ? 'default' : 'pointer' }}>+ ADD</button>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: horizontal ? `repeat(auto-fit, minmax(200px, 1fr))` : '1fr',
        gap: 6
      }}>
        {legs.map((leg, i) => (
          <div key={i} style={{ background: 'var(--theme-bg, #0a1628)', border: `1px solid ${leg.side === 'sell' ? 'var(--theme-negative)' : 'var(--theme-positive)'}44`, padding: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: leg.side === 'sell' ? 'var(--theme-negative)' : 'var(--theme-positive)', textTransform: 'uppercase' }}>Leg {i + 1}</span>
              <button type="button" onClick={() => onRemove(i)} disabled={legs.length <= 1} title="Remove leg"
                style={{ background: 'none', border: 'none', fontSize: 13, lineHeight: 1, cursor: legs.length <= 1 ? 'default' : 'pointer', color: legs.length <= 1 ? 'var(--theme-text-faint, rgba(255,255,255,0.2))' : 'var(--theme-negative)' }}>×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              <select value={leg.type} onChange={e => onUpdate(i, { type: e.target.value as ComboLeg['type'] })} style={sel}>
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
              <select value={leg.side} onChange={e => onUpdate(i, { side: e.target.value as ComboLeg['side'] })} style={sel}>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              <div>
                <div style={fieldLabel}>Strike %</div>
                <NumInput value={Math.round(leg.moneyness * 100)} min={1}
                  title="Strike as % of spot (100 = at the money)"
                  onCommit={pct => onUpdate(i, { moneyness: Math.max(0.01, pct / 100) })} />
              </div>
              <div>
                <div style={fieldLabel}>Qty</div>
                <NumInput value={leg.qty} min={1}
                  onCommit={q => onUpdate(i, { qty: Math.max(1, Math.round(q)) })} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const POS = 'var(--theme-positive)', NEG = 'var(--theme-negative)'

interface BacktestResult {
  equity_curve: { date: string; strategy: number; benchmark: number }[]
  metrics: {
    total_return: number; ann_return: number; max_drawdown: number; sharpe: number
    num_trades: number; win_rate: number; initial_capital: number; final_capital: number; total_pnl: number; interest_paid?: number; leverage?: number; effective_annual_rate?: number; blown_up_at?: string | null
  }
  trades: BacktestTrade[]
  instrument?: { kind: string; type?: string; moneyness?: number; dte: number; iv: number; direction?: string; modeled: boolean; legs?: ComboLeg[] }
  bars?: number
  span?: { start: string; end: string }
  buy_reason?: string
  sell_reason?: string
}

// A single fill. Combo trades share a date+direction across legs (one row per
// leg) — the chart groups those back into one hover marker per date+side.
interface BacktestTrade {
  date: string; action: string; price: number; leg?: string
  is_entry?: boolean; exit_kind?: string | null; reason?: string; ticker?: string; settlement?: string
}

// A portfolio is a book of positions, each pairing a saved rule-set with its own
// ticker, instrument, side, and capital weight. Composition persists locally.
interface PortfolioPos {
  id: string; strategy: string; ticker: string
  instMode: 'underlying' | 'option' | 'combo'; optType: 'call' | 'put'; otmPct: number; dte: number
  comboLegs: ComboLeg[]; comboDte: number
  side: 'long' | 'short'; tradeSize?: number
}
interface PortfolioResult {
  equity_curve: { date: string; strategy: number; benchmark: number }[]
  metrics: BacktestResult['metrics']
  positions: { ticker: string; side: string; instrument: string; opt_type?: string | null; weight_pct: number; return_pct: number; pnl: number; num_trades: number }[]
  trades?: BacktestTrade[]
  bars?: number
  span?: { start: string; end: string }
}
// Entry/exit markers on the equity curve — same triangle-dot shapes as the
// Portfolio Backtester's replay chart (BacktestSignalChart), so both tools'
// trade markers read as one visual language. Sized up from the replay
// chart's originals, and clickable: years of daily bars can pack trades
// close enough together that hovering the exact one you want is fiddly, so
// a click pins the detail panel open instead of requiring the mouse to stay
// put (see pinnedTrade / PinnedTradePanel below).
type MarkerPoint = { date: string; strategy: number; benchmark: number; buyTrades?: BacktestTrade[]; sellTrades?: BacktestTrade[] }
const EqBuyDot = (props: { cx?: number; cy?: number; value?: number; payload?: MarkerPoint; onSelect?: (p: MarkerPoint) => void }) => {
  const { cx = 0, cy = 0, value, payload, onSelect } = props
  if (value == null) return null
  return <polygon points={`${cx},${cy - 10} ${cx - 7},${cy + 2} ${cx + 7},${cy + 2}`} style={{ fill: 'var(--theme-positive)', cursor: 'pointer' }} stroke="none"
    onClick={() => payload && onSelect?.(payload)} />
}
const EqSellDot = (props: { cx?: number; cy?: number; value?: number; payload?: MarkerPoint; onSelect?: (p: MarkerPoint) => void }) => {
  const { cx = 0, cy = 0, value, payload, onSelect } = props
  if (value == null) return null
  return <polygon points={`${cx},${cy + 10} ${cx - 7},${cy - 2} ${cx + 7},${cy - 2}`} style={{ fill: 'var(--theme-negative)', cursor: 'pointer' }} stroke="none"
    onClick={() => payload && onSelect?.(payload)} />
}

// Shared by the hover tooltip and the click-pinned panel so the two always
// agree on content. Headed "ENTRY"/"EXIT" rather than "BUY"/"SELL": is_entry
// tracks whether the POSITION opened or closed, not the direction of any one
// leg — a short straddle's entry SELLS both legs, so labeling that section
// "BUY" would say the opposite of what actually happened. Each row states
// its own action explicitly (e.g. "SELL call 3.97 @ $1.41") so there's no
// guessing.
function TradeDetailBody({ pt, label }: { pt: MarkerPoint; label?: string }) {
  const rows = (trades?: BacktestTrade[]) => trades?.map((t, i) => (
    <div key={i} style={{ marginTop: 2 }}>
      <span style={{ color: t.action === 'EXPIRE' ? 'var(--theme-primary)' : t.action === 'SELL' ? 'var(--theme-negative)' : 'var(--theme-positive)', fontWeight: 700 }}>{t.action}</span>
      {' ' + (t.ticker ? `${t.ticker} ` : '') + (t.leg ? `${t.leg} ` : '') + `@ $${t.price}`}
      <div style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.45))', fontSize: 9 }}>{[t.reason, t.settlement?.replace(/_/g, ' ')].filter(Boolean).join(' · ')}</div>
    </div>
  ))
  return (
    <>
      <div style={{ ...TOOLTIP_LABEL, marginBottom: 3 }}>{label ?? pt.date}</div>
      <div style={TOOLTIP_ITEM}>Strategy: ${pt.strategy?.toLocaleString()}</div>
      {pt.buyTrades && (
        <div style={{ marginTop: 5, color: 'var(--theme-positive)', fontWeight: 700, fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          ENTRY
          <div style={{ color: 'var(--theme-text, #d7e3fc)', fontWeight: 400, textTransform: 'none' }}>{rows(pt.buyTrades)}</div>
        </div>
      )}
      {pt.sellTrades && (
        <div style={{ marginTop: 5, color: 'var(--theme-negative)', fontWeight: 700, fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          EXIT
          <div style={{ color: 'var(--theme-text, #d7e3fc)', fontWeight: 400, textTransform: 'none' }}>{rows(pt.sellTrades)}</div>
        </div>
      )}
    </>
  )
}

// Default formatter+labelFormatter can't show a variable number of
// conditional trade-detail rows, so trade dates get a custom tooltip instead.
function EquityTradeTooltip({ active, payload, label }: {
  active?: boolean; label?: string
  payload?: { payload: MarkerPoint }[]
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: '6px 10px', fontSize: 11, fontFamily: 'var(--theme-mono)', maxWidth: 260 }}>
      <TradeDetailBody pt={payload[0].payload} label={label} />
    </div>
  )
}

// Persists after a click (unlike the hover tooltip) so a trade packed tightly
// against its neighbors stays readable without having to hold the mouse
// steady on its exact pixel.
function PinnedTradePanel({ pt, onClose }: { pt: MarkerPoint; onClose: () => void }) {
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: '6px 10px', paddingRight: 22, fontSize: 11, fontFamily: 'var(--theme-mono)', maxWidth: 260, position: 'relative' }}>
      <button onClick={onClose} title="Close"
        style={{ position: 'absolute', top: 3, right: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>×</button>
      <TradeDetailBody pt={pt} />
    </div>
  )
}

const PF_KEY = 'fdb_algo_portfolio'
const AI_CHAT_KEY = 'fdb_algo_strategy_ai_chat'
const rid = () => Math.random().toString(36).slice(2, 8)

// Surface the backend's real reason (FastAPI `detail`) instead of axios's generic
// "Request failed with status code NNN".
function errMsg(e: unknown, fallback = 'Request failed'): string {
  const d = (e as { response?: { data?: { detail?: unknown } }; message?: string })?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map((x: { msg?: string }) => x?.msg ?? String(x)).join(' · ') || fallback
  return (e as { message?: string })?.message ?? fallback
}

// Exact dollars, not K-abbreviated — rounding e.g. $9,974 to "$10.0K" reads as
// "unchanged from $10K starting capital" right next to a P&L tile that (being
// under $1,000) already shows the real, non-zero number, which looks like a bug.
const fmtCap = (n: number) => `$${Math.round(n).toLocaleString()}`
const countConds = (def: CustomStrategyDef) => ({
  buy: def.buy.groups.reduce((s, g) => s + g.conditions.length, 0),
  sell: def.sell.groups.reduce((s, g) => s + g.conditions.length, 0),
})

// Allocation-bar tint sequence — mirrors ConfigHeader.tsx's shade(i) (Portfolio
// Backtester) so both tools' multi-position color coding reads the same way.
const PF_SHADES = [
  'var(--theme-primary, #c9a84c)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 76%, #000)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 70%, #fff)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 52%, #000)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 88%, #000)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 58%, #fff)',
]
const pfShade = (i: number) => PF_SHADES[i % PF_SHADES.length]

// Both cards below are declared at module scope (not nested inside
// AlgoStrategyBuilderContent) and take every dependency as an explicit prop —
// a component *defined* inside a parent's render body gets a new function
// identity every render, so React treats each one as a brand-new component
// type and remounts it, which drops focus out of whatever input the user is
// mid-keystroke in. Module scope keeps one stable identity across renders.

function SavedStrategyRow({ def, active, onSelect, onEdit, onDuplicate, onDelete }: {
  def: CustomStrategyDef; active: boolean
  onSelect: () => void; onEdit: () => void; onDuplicate: () => void; onDelete: () => void
}) {
  const c = countConds(def)
  return (
    <div onClick={onSelect}
      style={{ cursor: 'pointer', padding: '7px 9px', border: `1px solid ${active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
        background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.name}</span>
        <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={e => { e.stopPropagation(); onEdit() }} title="Edit"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #8099b0)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em' }}>EDIT</button>
          <button onClick={e => { e.stopPropagation(); onDuplicate() }} title="Duplicate this strategy under a new name"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #8099b0)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em' }}>DUP</button>
          <button onClick={e => { e.stopPropagation(); onDelete() }} title="Delete"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-negative)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em' }}>DEL</button>
        </span>
      </div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginTop: 2, letterSpacing: '0.06em' }}>
        BUY {c.buy} · SELL {c.sell}{def.perTicker?.length ? ` · ${def.perTicker.length} ticker${def.perTicker.length === 1 ? '' : 's'}` : ''}
      </div>
    </div>
  )
}

// One position, as a grid card (Portfolio-mode Controls panel) rather than a
// stacked sidebar block — same fields/behavior as before, just laid out to
// wrap into a responsive multi-column grid instead of running down a fixed
// 230px rail.
function PositionCard({ p, index, tradeSize, strategyName, saved, patchPosition, removePosition, patchComboLeg,
  addComboLegToPosition, removeComboLegFromPosition, cloningId, setCloningId, cloneInput, setCloneInput,
  cloneToTickers, pmBooks, applyInstrumentToAll, otherPositionCount }: {
  p: PortfolioPos; index: number; tradeSize: number; strategyName: string; saved: CustomStrategyDef[]
  patchPosition: (id: string, patch: Partial<PortfolioPos>) => void
  removePosition: (id: string) => void
  patchComboLeg: (posId: string, i: number, patch: Partial<ComboLeg>) => void
  addComboLegToPosition: (posId: string) => void
  removeComboLegFromPosition: (posId: string, i: number) => void
  cloningId: string | null; setCloningId: (id: string | null) => void
  cloneInput: string; setCloneInput: (s: string) => void
  cloneToTickers: (template: PortfolioPos) => void
  pmBooks: PMPortfolio[]
  applyInstrumentToAll: (sourceId: string) => void
  otherPositionCount: number
}) {
  const [hover, setHover] = useState(false)
  const [justApplied, setJustApplied] = useState(false)
  const effectiveTradeSize = p.tradeSize ?? tradeSize
  const barPct = Math.max(0, Math.min(100, effectiveTradeSize))
  const btn = (on: boolean): React.CSSProperties => ({
    flex: 1, padding: '3px 0', fontFamily: 'inherit', fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
    background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
    border: `1px solid ${on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
    color: on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
  })
  const def = saved.find(s => s.name === strategyName)
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 100%, #000 8%)',
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)' : 'var(--theme-border, rgba(255,255,255,0.08))'}`,
        padding: '8px 9px', boxShadow: '0 1px 5px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: 6,
      }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input value={p.ticker} placeholder="TICKER"
          onChange={e => patchPosition(p.id, { ticker: e.target.value.toUpperCase() })}
          style={{ ...INPUT, flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, padding: '3px 6px' }} />
        <button onClick={() => removePosition(p.id)} title="Remove"
          style={{ background: 'none', border: 'none', color: 'var(--theme-negative)', cursor: 'pointer', fontSize: 14, display: 'flex', flexShrink: 0, padding: 0 }}>×</button>
      </div>
      <div title={p.tradeSize === undefined ? `Uses the ${tradeSize}% master trade size.` : `This position overrides the ${tradeSize}% master trade size.`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ width: 62, flexShrink: 0 }}>
          <NumInput value={effectiveTradeSize} min={1} max={100}
            onCommit={v => patchPosition(p.id, { tradeSize: v })}
            title="Percentage of the total portfolio used when this position is admitted" style={{ ...INPUT, fontSize: 10, textAlign: 'center', padding: '3px 4px' }} />
          <div style={{ fontSize: 7, color: p.tradeSize === undefined ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-primary, #c9a84c)', textAlign: 'center', marginTop: 2 }}>{p.tradeSize === undefined ? 'MASTER %' : 'OVERRIDE %'}</div>
        </div>
        <div style={{ flex: 1, height: 4, background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 10%, transparent)' }}>
          <div style={{ width: `${barPct}%`, height: '100%', background: pfShade(index) }} />
        </div>
        {p.tradeSize !== undefined && <button onClick={() => patchPosition(p.id, { tradeSize: undefined })} title={`Use the ${tradeSize}% master trade size`} style={{ background: 'none', border: 'none', color: 'var(--theme-secondary, #8099b0)', cursor: 'pointer', fontFamily: 'var(--theme-mono)', fontSize: 8, padding: 0 }}>MASTER</button>}
      </div>
      <div title="The selected algorithm is applied universally to every symbol in this universe" style={{ ...INPUT, fontSize: 10, color: strategyName ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)', padding: '5px 6px' }}>
        {strategyName || '— select a strategy from the saved list —'}
      </div>
      {def?.perTicker?.length ? (() => {
        const hit = def.perTicker.some(r => r.ticker.toUpperCase().trim() === p.ticker.toUpperCase().trim())
        return (
          <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: hit ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
            {hit ? `${p.ticker.toUpperCase()}-specific signal` : 'default signal (no rule for this ticker)'}
          </div>
        )
      })() : null}
      {p.instMode !== 'combo' && (
        <div>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 3 }}>On BUY signal, open</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {([['long', 'Buy / Long'], ['short', 'Sell / Short']] as const).map(([sd, lbl]) => (
              <button key={sd} title={sd === 'long' ? 'BUY signal opens a long; SELL signal closes it.' : 'BUY signal opens a short; SELL signal covers it.'}
                onClick={() => patchPosition(p.id, { side: sd })} style={btn(p.side === sd)}>{lbl}</button>
            ))}
          </div>
        </div>
      )}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>Instrument</div>
          {otherPositionCount > 0 && (
            <button
              onClick={() => { applyInstrumentToAll(p.id); setJustApplied(true); setTimeout(() => setJustApplied(false), 1400) }}
              title={`Replicate this instrument (and side/strikes/legs) onto all ${otherPositionCount} other position${otherPositionCount === 1 ? '' : 's'} in the portfolio`}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: justApplied ? POS : 'var(--theme-primary, #c9a84c)',
              }}>
              <Repeat size={9} />{justApplied ? `Applied to ${otherPositionCount}` : 'Apply to All'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {([['shares', 'Shares'], ['call', 'Call'], ['put', 'Put'], ['combo', 'Combo']] as const).map(([kind, lbl]) => {
            const on = kind === 'shares' ? p.instMode === 'underlying' : kind === 'combo' ? p.instMode === 'combo' : p.instMode === 'option' && p.optType === kind
            return (
              <button key={kind} onClick={() => patchPosition(p.id, kind === 'shares' ? { instMode: 'underlying' }
                // Seed comboLegs/comboDte here, not just at read sites — a position
                // saved before this feature existed has neither field, and toggling
                // to Combo without seeding them would silently drop the position
                // from the backtest.
                : kind === 'combo' ? { instMode: 'combo', comboLegs: p.comboLegs?.length ? p.comboLegs : legsToCombo(PRESETS['Short Straddle']), comboDte: p.comboDte ?? 30 }
                : { instMode: 'option', optType: kind })} style={btn(on)}>{lbl}</button>
            )
          })}
        </div>
      </div>
      {p.instMode === 'option' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <div>
            <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>% OTM (neg = ITM)</div>
            <NumInput value={p.otmPct} min={-50} max={50}
              onCommit={v => patchPosition(p.id, { otmPct: Math.round(v) })}
              style={{ ...INPUT, fontSize: 10 }} />
          </div>
          <div>
            <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>DTE (days)</div>
            <NumInput value={p.dte} min={1} max={365}
              onCommit={v => patchPosition(p.id, { dte: Math.round(v) })}
              style={{ ...INPUT, fontSize: 10 }} />
          </div>
        </div>
      )}
      {p.instMode === 'combo' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <select value="" onChange={e => e.target.value && patchPosition(p.id, { comboLegs: legsToCombo(PRESETS[e.target.value] ?? []) })}
            style={{ ...INPUT, fontSize: 10, cursor: 'pointer' }}>
            <option value="">Load preset…</option>
            {PRESET_GROUPS.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.keys.map(k => <option key={k} value={k}>{k}</option>)}
              </optgroup>
            ))}
          </select>
          <ComboLegEditor legs={p.comboLegs} onUpdate={(i, patch) => patchComboLeg(p.id, i, patch)}
            onRemove={i => removeComboLegFromPosition(p.id, i)} onAdd={() => addComboLegToPosition(p.id)} />
          <div>
            <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>DTE (days)</div>
            <NumInput value={p.comboDte} min={1} max={365}
              onCommit={v => patchPosition(p.id, { comboDte: Math.round(v) })}
              style={{ ...INPUT, fontSize: 10 }} />
          </div>
        </div>
      )}
      <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: p.instMode === 'combo' ? 'var(--theme-primary, #c9a84c)' : p.side === 'short' ? NEG : POS }}>
        {p.instMode === 'combo' ? `${p.comboLegs.length}-leg combo · ${p.comboDte ?? 30}d`
          : p.instMode === 'option'
          ? `${p.side === 'short' ? 'Short' : 'Long'} ${p.otmPct === 0 ? 'ATM' : p.otmPct > 0 ? `${p.otmPct}% OTM` : `${-p.otmPct}% ITM`} ${p.optType} · ${p.dte}d`
          : `${p.side === 'short' ? 'Short' : 'Long'} shares`}
        {p.instMode === 'option' && p.side === 'short' && <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}> · written</span>}
      </div>
      <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 5 }}>
        <button onClick={() => { setCloningId(cloningId === p.id ? null : p.id); setCloneInput('') }}
          style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          {cloningId === p.id ? '× Cancel' : 'Copy to other tickers…'}
        </button>
        {cloningId === p.id && (
          <>
            {pmBooks.length > 0 && (
              <select value="" onChange={e => {
                const book = pmBooks.find(b => b.id === e.target.value)
                if (!book) return
                const tickers = [...new Set(book.holdings.map(h => normalizeTicker(h.ticker)).filter(Boolean))]
                  .filter(t => t !== p.ticker.toUpperCase())
                setCloneInput(tickers.join(', '))
              }} style={{ ...INPUT, fontSize: 9, cursor: 'pointer', marginTop: 4 }}>
                <option value="">Load from Portfolio Manager…</option>
                {pmBooks.map(b => <option key={b.id} value={b.id}>{b.name} ({b.holdings.length})</option>)}
              </select>
            )}
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input value={cloneInput} onChange={e => setCloneInput(e.target.value)} placeholder="MSFT, NVDA, TSLA…"
                onKeyDown={e => e.key === 'Enter' && cloneToTickers(p)}
                autoFocus style={{ ...INPUT, fontSize: 9, flex: 1, textTransform: 'uppercase' }} />
              <button onClick={() => cloneToTickers(p)} disabled={!cloneInput.trim()} style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 8px',
                color: cloneInput.trim() ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.3))',
                background: 'none', border: `1px solid ${cloneInput.trim() ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
                cursor: cloneInput.trim() ? 'pointer' : 'default',
              }}>Add</button>
            </div>
            <div style={{ fontSize: 7, color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', lineHeight: '10px', marginTop: 3 }}>
              Same strategy, side, and instrument (legs included) as one new position per ticker.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SinglePositionCard({
  ticker, setTicker,
  strategy, setStrategy,
  saved,
  side, setSide,
  instMode, setInstMode,
  optType, setOptType,
  otmPct, setOtmPct,
  dte, setDte,
  comboLegs, setComboLegs, updateComboLeg, addComboLeg, removeComboLeg,
  comboDte, setComboDte,
  onRunBacktest
}: {
  ticker: string
  setTicker: (t: string) => void
  strategy: string
  setStrategy: (s: string) => void
  saved: CustomStrategyDef[]
  side: 'long' | 'short'
  setSide: (s: 'long' | 'short') => void
  instMode: 'underlying' | 'option' | 'combo'
  setInstMode: (m: 'underlying' | 'option' | 'combo') => void
  optType: 'call' | 'put'
  setOptType: (t: 'call' | 'put') => void
  otmPct: number
  setOtmPct: (v: number) => void
  dte: number
  setDte: (v: number) => void
  comboLegs: ComboLeg[]
  setComboLegs: React.Dispatch<React.SetStateAction<ComboLeg[]>>
  updateComboLeg: (i: number, patch: Partial<ComboLeg>) => void
  addComboLeg: () => void
  removeComboLeg: (i: number) => void
  comboDte: number; setComboDte: (v: number) => void
  onRunBacktest?: () => void
}) {
  const btn = (on: boolean): React.CSSProperties => ({
    padding: '3px 6px', fontFamily: 'inherit', fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
    background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
    border: `1px solid ${on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
    color: on ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
  })
  const def = saved.find(s => s.name === strategy)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100dvh - 230px)', minHeight: 420 }}>
      
      {/* Row 1: Ticker, Strategy, Instrument Select */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ width: 100 }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>Ticker</div>
          <TickerInput value={ticker} onChange={setTicker} onEnter={onRunBacktest} style={{ ...INPUT, fontSize: 11, fontWeight: 700, padding: '4px 6px' }} placeholder="TICKER" />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>Strategy</div>
          <select value={strategy} onChange={e => setStrategy(e.target.value)}
            style={{ ...INPUT, fontSize: 11, cursor: 'pointer', height: 25, boxSizing: 'border-box', padding: '3px 24px 3px 6px' }}>
            {saved.length === 0 && <option value="">— build a strategy first —</option>}
            {saved.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 3 }}>Instrument</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {([['shares', 'Shares'], ['call', 'Call'], ['put', 'Put'], ['combo', 'Combo']] as const).map(([kind, lbl]) => {
              const on = kind === 'shares' ? instMode === 'underlying' : kind === 'combo' ? instMode === 'combo' : instMode === 'option' && optType === kind
              return (
                <button key={kind} onClick={() => {
                  if (kind === 'shares') {
                    setInstMode('underlying')
                  } else if (kind === 'combo') {
                    setInstMode('combo')
                    setComboLegs(legsToCombo(PRESETS['Short Straddle']))
                  } else {
                    setInstMode('option')
                    setOptType(kind)
                  }
                }} style={btn(on)}>{lbl}</button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Row 2: Direction, Option/Combo details */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.05))', paddingTop: 8 }}>
        {instMode !== 'combo' && (
          <div>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 3 }}>On BUY signal, open</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['long', 'Buy / Long'], ['short', 'Sell / Short']] as const).map(([sd, lbl]) => (
                <button key={sd} title={sd === 'long' ? 'BUY signal opens a long; SELL signal closes it.' : 'BUY signal opens a short; SELL signal covers it.'}
                  onClick={() => setSide(sd)} style={btn(side === sd)}>{lbl}</button>
              ))}
            </div>
          </div>
        )}

        {instMode === 'option' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 120 }}>
              <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>% OTM (neg = ITM)</div>
              <NumInput value={otmPct} min={-50} max={50} onCommit={v => setOtmPct(Math.round(v))} style={{ ...INPUT, fontSize: 10, height: 23 }} />
            </div>
            <div style={{ width: 80 }}>
              <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>DTE (days)</div>
              <NumInput value={dte} min={1} max={365} onCommit={v => setDte(Math.round(v))} style={{ ...INPUT, fontSize: 10, height: 23 }} />
            </div>
            <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: side === 'short' ? NEG : POS, marginLeft: 8 }}>
              {side === 'short' ? 'Short' : 'Long'} {otmPct === 0 ? 'ATM' : otmPct > 0 ? `${otmPct}% OTM` : `${-otmPct}% ITM`} {optType} · {dte}d
            </div>
          </div>
        )}

        {instMode === 'combo' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
            <div style={{ width: 150 }}>
              <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>Preset</div>
              <select value="" onChange={e => e.target.value && setComboLegs(legsToCombo(PRESETS[e.target.value] ?? []))}
                style={{ ...INPUT, fontSize: 10, cursor: 'pointer', height: 23 }}>
                <option value="">Load preset…</option>
                {PRESET_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.keys.map(k => <option key={k} value={k}>{k}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div style={{ width: 80 }}>
              <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', marginBottom: 2 }}>DTE</div>
              <NumInput value={comboDte} min={1} max={365} onCommit={v => setComboDte(Math.round(v))} style={{ ...INPUT, fontSize: 10, height: 23 }} />
            </div>
            <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-primary, #c9a84c)', marginLeft: 8 }}>
              {comboLegs.length}-leg combo · {comboDte ?? 30}d
            </div>
          </div>
        )}

        {instMode === 'underlying' && (
          <div style={{ fontSize: 8, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: side === 'short' ? NEG : POS }}>
            {side === 'short' ? 'Short' : 'Long'} shares
          </div>
        )}
      </div>

      {/* Row 3: Combo Legs Editor */}
      {instMode === 'combo' && (
        <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.05))', paddingTop: 8 }}>
          <ComboLegEditor legs={comboLegs} onUpdate={updateComboLeg} onRemove={removeComboLeg} onAdd={addComboLeg} horizontal />
        </div>
      )}
    </div>
  )
}

// The unified strategy controls surface: a horizontal panel that handles
// both single-position and portfolio-position backtests.
function StrategyControlsPanel({
  mode, setMode, positions, saved, addPosition,
  patchPosition, removePosition, patchComboLeg, addComboLegToPosition, removeComboLegFromPosition, applyInstrumentToAll,
  portfolioTradeSize, setPortfolioTradeSize,
  portfolioLeverage, setPortfolioLeverage, effectiveAnnualRate, setEffectiveAnnualRate,
  cloningId, setCloningId, cloneInput, setCloneInput, cloneToTickers, pmBooks,
  start, setStart, end, setEnd, timeframe, setTimeframe,
  activeName, setActiveName, onEditStrategy, onDuplicateStrategy, onDeleteStrategy, onNewStrategy,
  runPortfolio, sendPortfolioToPaper, exportToMonteCarlo, exportSingleToMonteCarlo, collapsed, onToggleCollapsed,
  // Single mode additions:
  ticker, setTicker,
  side, setSide,
  instMode, setInstMode,
  optType, setOptType,
  otmPct, setOtmPct,
  dte, setDte,
  comboLegs, setComboLegs, updateComboLeg, addComboLeg, removeComboLeg,
  comboDte, setComboDte,
  runBacktest, isPending, isError, error,
  sendToPaper,
}: {
  mode: 'single' | 'portfolio'; setMode: (m: 'single' | 'portfolio') => void
  positions: PortfolioPos[]; saved: CustomStrategyDef[]; addPosition: () => void
  patchPosition: (id: string, patch: Partial<PortfolioPos>) => void
  portfolioTradeSize: number; setPortfolioTradeSize: (value: number) => void
  portfolioLeverage: number; setPortfolioLeverage: (value: number) => void
  effectiveAnnualRate: number; setEffectiveAnnualRate: (value: number) => void
  removePosition: (id: string) => void
  patchComboLeg: (posId: string, i: number, patch: Partial<ComboLeg>) => void
  addComboLegToPosition: (posId: string) => void
  removeComboLegFromPosition: (posId: string, i: number) => void
  applyInstrumentToAll: (sourceId: string) => void
  cloningId: string | null; setCloningId: (id: string | null) => void
  cloneInput: string; setCloneInput: (s: string) => void
  cloneToTickers: (template: PortfolioPos) => void
  pmBooks: PMPortfolio[]
  start: string; setStart: (s: string) => void
  end: string; setEnd: (s: string) => void
  timeframe: string; setTimeframe: (s: string) => void
  activeName: string; setActiveName: (n: string) => void
  onEditStrategy: (def: CustomStrategyDef) => void
  onDuplicateStrategy: (name: string) => void
  onDeleteStrategy: (name: string) => void
  onNewStrategy: () => void
  runPortfolio: UseMutationResult<PortfolioResult, Error, void>
  sendPortfolioToPaper: UseMutationResult<{ created: number }, Error, void>
  exportToMonteCarlo: () => void
  exportSingleToMonteCarlo: () => void
  collapsed: boolean; onToggleCollapsed: () => void

  ticker: string; setTicker: (t: string) => void
  side: 'long' | 'short'; setSide: (s: 'long' | 'short') => void
  instMode: 'underlying' | 'option' | 'combo'; setInstMode: (m: 'underlying' | 'option' | 'combo') => void
  optType: 'call' | 'put'; setOptType: (t: 'call' | 'put') => void
  otmPct: number; setOtmPct: (v: number) => void
  dte: number; setDte: (v: number) => void
  comboLegs: ComboLeg[]; setComboLegs: React.Dispatch<React.SetStateAction<ComboLeg[]>>
  updateComboLeg: (i: number, patch: Partial<ComboLeg>) => void
  addComboLeg: () => void
  removeComboLeg: (i: number) => void
  comboDte: number; setComboDte: (v: number) => void
  runBacktest: () => void
  isPending: boolean
  isError: boolean
  error: unknown
  sendToPaper: UseMutationResult<{ name: string }, Error, void>
}) {

  // Portfolio mode runs every position against the one shared activeName
  // strategy (posToPayload), not each position's own (stale, unused) .strategy
  // field — so the timeframe check has to look at activeName too, or a
  // position created under an earlier strategy selection could mask a real
  // non-daily warning for whatever's actually running now.
  const anyNonDaily = activeName ? usesNonDailyTimeframe(saved.find(s => s.name === activeName)!) : false
  const headerBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontFamily: 'inherit', fontSize: 9.5, fontWeight: 700,
    letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap',
  }
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px',
        background: 'var(--theme-surface, #142032)', borderBottom: collapsed ? 'none' : '1px solid var(--theme-border, rgba(255,255,255,0.08))',
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['single', 'portfolio'] as const).map(md => (
            <button key={md} onClick={() => setMode(md)} style={{
              padding: '5px 9px', fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
              background: mode === md ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
              border: `1px solid ${mode === md ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
              color: mode === md ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
            }}>{md === 'single' ? 'Position' : 'Portfolio'}</button>
          ))}
        </div>

        {mode === 'portfolio' ? (
          <span style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-secondary, #8099b0)' }}>
            {positions.length} symbol{positions.length === 1 ? '' : 's'} · one shared strategy
          </span>
        ) : (
          <span style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-secondary, #8099b0)' }}>
            {ticker.toUpperCase()} · {instMode === 'underlying' ? 'Shares' : instMode === 'option' ? `${optType.toUpperCase()} Option` : 'Combo'}
          </span>
        )}
        {mode === 'portfolio' && <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #8099b0)' }}>
          <span>Trade size</span>
          <NumInput value={portfolioTradeSize} min={1} max={100} onCommit={setPortfolioTradeSize} title="Every admitted trade uses this percentage of the total portfolio"
            style={{ ...INPUT, width: 46, textAlign: 'center', color: 'var(--theme-primary, #c9a84c)', fontWeight: 700, padding: '3px 4px' }} />
          <span>%</span>
        </div>}
        {mode === 'portfolio' && <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #8099b0)' }}>
          <span>Leverage</span>
          <NumInput value={portfolioLeverage} min={1} onCommit={setPortfolioLeverage} title="Gross-notional multiplier; 1x is unlevered. No ceiling — high leverage can wipe the account out on a modest adverse move."
            style={{ ...INPUT, width: 42, textAlign: 'center', color: 'var(--theme-primary, #c9a84c)', fontWeight: 700, padding: '3px 4px' }} />
          <span>x</span>
          <span>EAR</span>
          <NumInput value={effectiveAnnualRate} min={0} max={100} onCommit={setEffectiveAnnualRate} title="Effective annual borrowing rate, compounded into a daily financing rate"
            style={{ ...INPUT, width: 46, textAlign: 'center', color: 'var(--theme-primary, #c9a84c)', fontWeight: 700, padding: '3px 4px' }} />
          <span>%</span>
        </div>}
        <div style={{ flex: 1, minWidth: 8 }} />
        {mode === 'portfolio' ? (
          <button onClick={() => runPortfolio.mutate()} disabled={positions.length === 0 || runPortfolio.isPending} style={{
            ...headerBtn, background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
            color: positions.length ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)',
            opacity: (positions.length === 0 || runPortfolio.isPending) ? 0.6 : 1,
          }}><Play size={10} />{runPortfolio.isPending ? 'Running…' : 'Run Portfolio'}</button>
        ) : (
          <button onClick={() => runBacktest()} disabled={!activeName || isPending} style={{
            ...headerBtn, background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
            color: activeName ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)',
            opacity: (!activeName || isPending) ? 0.6 : 1,
          }}><Play size={10} />{isPending ? 'Running…' : 'Run Backtest'}</button>
        )}
        {mode === 'portfolio' ? (
          <button onClick={() => sendPortfolioToPaper.mutate()} disabled={positions.length === 0 || sendPortfolioToPaper.isPending} title="Send to Paper Trader" style={{
            ...headerBtn, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
            color: positions.length ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
            opacity: (positions.length === 0 || sendPortfolioToPaper.isPending) ? 0.6 : 1,
          }}><Send size={10} />{sendPortfolioToPaper.isPending ? 'Sending…' : 'Send to Paper'}</button>
        ) : (
          <button onClick={() => sendToPaper.mutate()} disabled={!activeName || sendToPaper.isPending} title="Send to Paper Trader" style={{
            ...headerBtn, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
            color: activeName ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
            opacity: (!activeName || sendToPaper.isPending) ? 0.6 : 1,
          }}><Send size={10} />{sendToPaper.isPending ? 'Sending…' : 'Send to Paper'}</button>
        )}
        {mode === 'portfolio' ? (
          <button onClick={exportToMonteCarlo} disabled={positions.length === 0 || !activeName} title="Open this shared algo universe in Monte Carlo" style={{
            ...headerBtn, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
            color: activeName ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
            opacity: (positions.length === 0 || !activeName) ? 0.6 : 1,
          }}>↗ Monte Carlo</button>
        ) : (
          <button onClick={exportSingleToMonteCarlo} disabled={!activeName} title={instMode === 'underlying' ? 'Open this position in Monte Carlo' : 'Open this options structure in the Monte Carlo Options Strategy tab'} style={{
            ...headerBtn, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
            color: activeName ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-text-faint, rgba(255,255,255,0.35))',
            opacity: !activeName ? 0.6 : 1,
          }}>↗ Monte Carlo</button>
        )}
        <button onClick={onNewStrategy} title="Create a new strategy" style={{
          ...headerBtn, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
          color: 'var(--theme-primary, #c9a84c)',
        }}>
          <Plus size={10} />New Strategy
        </button>
        <button onClick={onToggleCollapsed} title={collapsed ? 'Expand' : 'Collapse'} style={{
          display: 'flex', padding: 6, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-secondary, #8099b0)', cursor: 'pointer',
        }}>{collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}</button>
      </div>

      {!collapsed && (
        <>
          {mode === 'portfolio' && positions.length > 0 && (
            <div style={{ display: 'flex', height: 5 }}>
              {positions.map((p, i) => (
                <div key={p.id} title={`${p.ticker || '—'} · ${portfolioTradeSize}% per admitted trade`} style={{ flex: 1, background: pfShade(i) }} />
              ))}
            </div>
          )}
          {mode === 'portfolio' && runPortfolio.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', padding: '4px 10px' }}>{errMsg(runPortfolio.error, 'Backtest failed')}</div>}
          {mode === 'portfolio' && <div style={{ fontSize: 8, color: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-mono)', lineHeight: '12px', padding: '4px 10px' }}>One algorithm is applied to every symbol. The master size is {portfolioTradeSize}% of total portfolio; each position can optionally override it. New entries wait when combined open exposure reaches 100%.</div>}
          {mode === 'portfolio' && sendPortfolioToPaper.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', padding: '4px 10px' }}>{errMsg(sendPortfolioToPaper.error, 'Import failed')}</div>}
          {mode === 'portfolio' && sendPortfolioToPaper.isSuccess && <div style={{ fontSize: 9, color: 'var(--theme-positive)', fontFamily: 'var(--theme-sans)', padding: '4px 10px' }}>Created {sendPortfolioToPaper.data?.created} job{sendPortfolioToPaper.data?.created === 1 ? '' : 's'} · enable in Paper Trading</div>}
          {mode === 'single' && isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', padding: '4px 10px' }}>{errMsg(error, 'Backtest failed')}</div>}
          {mode === 'single' && sendToPaper.isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', padding: '4px 10px' }}>{errMsg(sendToPaper.error, 'Import failed')}</div>}
          {mode === 'single' && sendToPaper.isSuccess && <div style={{ fontSize: 9, color: 'var(--theme-positive)', fontFamily: 'var(--theme-sans)', padding: '4px 10px' }}>Imported · enable in Paper Trading</div>}
          {anyNonDaily && (
            <div style={{ fontSize: 8, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', lineHeight: '12px', padding: '4px 10px' }}>
              Some strategies use non-daily timeframes. Live paper runs indicators on daily bars. Timeframes apply to backtests only.
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 250px', gap: 16, padding: 10, alignItems: 'stretch' }}>
            <div style={{ borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingRight: 16 }}>
              {mode === 'portfolio' ? (
                <>
                  {positions.length === 0 && (
                    <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.45))', lineHeight: '14px', marginBottom: 8 }}>
                      Add eligible symbols to the universe. The shared algorithm runs against each symbol, and every admitted entry uses the global trade-size percentage of the portfolio.
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
                    {positions.map((p, i) => (
                      <PositionCard key={p.id} p={p} index={i} tradeSize={portfolioTradeSize} strategyName={activeName} saved={saved}
                        patchPosition={patchPosition} removePosition={removePosition} patchComboLeg={patchComboLeg}
                        addComboLegToPosition={addComboLegToPosition} removeComboLegFromPosition={removeComboLegFromPosition}
                        cloningId={cloningId} setCloningId={setCloningId} cloneInput={cloneInput} setCloneInput={setCloneInput}
                        cloneToTickers={cloneToTickers} pmBooks={pmBooks}
                        applyInstrumentToAll={applyInstrumentToAll} otherPositionCount={positions.length - 1} />
                    ))}
                    <button onClick={addPosition} style={{
                      minHeight: 60, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
                      border: '1px dashed var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
                      fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
                    }}>+ Add Position</button>
                  </div>
                </>
              ) : (
                <SinglePositionCard
                  ticker={ticker} setTicker={setTicker}
                  strategy={activeName} setStrategy={setActiveName}
                  saved={saved}
                  side={side} setSide={setSide}
                  instMode={instMode} setInstMode={setInstMode}
                  optType={optType} setOptType={setOptType}
                  otmPct={otmPct} setOtmPct={setOtmPct}
                  dte={dte} setDte={setDte}
                  comboLegs={comboLegs} setComboLegs={setComboLegs}
                  updateComboLeg={updateComboLeg} addComboLeg={addComboLeg} removeComboLeg={removeComboLeg}
                  comboDte={comboDte} setComboDte={setComboDte}
                  onRunBacktest={runBacktest}
                />
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 5 }}>Backtest Parameters</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>
                    <label style={LABEL}>Start</label>
                    <input type="date" value={start} onChange={e => setStart(e.target.value)} style={INPUT} />
                  </div>
                  <div>
                    <label style={LABEL}>End</label>
                    <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={INPUT} />
                  </div>
                  <div>
                    <label style={LABEL}>Timeframe</label>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {(['1d', '1h', '30m', '15m', '5m'] as const).map(tf => (
                        <button key={tf} onClick={() => setTimeframe(tf)}
                          title={tf === '1d' ? 'Daily bars (full history)' : 'Intraday bars — US equities/ETFs, recent window'}
                          style={{ flex: '1 0 auto', fontFamily: 'var(--theme-mono)', fontSize: 9.5, fontWeight: 700, padding: '5px 0', cursor: 'pointer',
                            border: timeframe === tf ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
                            background: timeframe === tf ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                            color: timeframe === tf ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)' }}>
                          {tf.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 5 }}>Saved Strategies · {saved.length}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                  {saved.length === 0 && (
                    <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', lineHeight: '14px' }}>No strategies yet. Build one to get started.</div>
                  )}
                  {saved.map(def => (
                    <SavedStrategyRow key={def.name} def={def} active={def.name === activeName}
                      onSelect={() => setActiveName(def.name)} onEdit={() => onEditStrategy(def)}
                      onDuplicate={() => onDuplicateStrategy(def.name)} onDelete={() => onDeleteStrategy(def.name)} />
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 8, color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', lineHeight: '13px' }}>
                Saved strategies also appear under "Custom Rule Strategy" in Monte Carlo and the Backtester.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function AlgoStrategyBuilderContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [start, setStart] = useState('2022-01-01')
  const [end, setEnd] = useState('')
  const [timeframe, setTimeframe] = useState('1d')   // base bar size; intraday via Alpaca (equities)
  // Instrument: trade the underlying (default), a modeled single call/put, or a
  // modeled multi-leg combo (straddle/strangle/spread/condor/... — same preset
  // table as the Options Strategy Builder).
  const [instMode, setInstMode] = useState<'underlying' | 'option' | 'combo'>('underlying')
  const [optType, setOptType] = useState<'call' | 'put'>('call')
  // Strike entered as % out-of-the-money (negative = in-the-money); converted to
  // the backend's moneyness multiplier per the option side. Call OTM = strike
  // above spot; put OTM = strike below spot.
  const [otmPct, setOtmPct] = useState(0)
  const optMoneyness = otmToMoneyness(optType, otmPct)
  const [dte, setDte] = useState(30)
  // Combo legs start from a preset but are then freely editable — add/remove/
  // retype/reweight any leg, same as the Options Strategy Builder.
  const [comboLegs, setComboLegs] = useState<ComboLeg[]>(() => legsToCombo(PRESETS['Short Straddle']))
  const [comboDte, setComboDte] = useState(30)
  const comboInstrument = () => ({ kind: 'combo', dte: comboDte, legs: comboLegs })
  const loadComboPreset = (name: string) => setComboLegs(legsToCombo(PRESETS[name] ?? []))
  const addComboLeg = () => setComboLegs(l => l.length >= MAX_COMBO_LEGS ? l : [...l, mkComboLeg()])
  const removeComboLeg = (i: number) => setComboLegs(l => l.length > 1 ? l.filter((_, j) => j !== i) : l)
  const updateComboLeg = (i: number, patch: Partial<ComboLeg>) => setComboLegs(l => l.map((leg, j) => j === i ? { ...leg, ...patch } : leg))
  // Direction the BUY signal opens (single mode): long buys, short sells/writes.
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [paramsOpen, setParamsOpen] = useState(true)
  const [saved, setSaved] = useState<CustomStrategyDef[]>(() => loadCustomStrategies())
  const [activeName, setActiveName] = useState<string>(() => loadCustomStrategies()[0]?.name ?? '')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CustomStrategyDef | null>(null)
  const [aiMessages, setAiMessages] = useState<AlgoChatMsg[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(AI_CHAT_KEY) || '[]')
      return Array.isArray(saved)
        ? saved.filter((m): m is AlgoChatMsg => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
          .slice(-80)
          .map(message => message.role === 'assistant' ? { ...message, content: removeLegacyScreenCaps(message.content) } : message)
        : []
    } catch { return [] }
  })
  const [aiPrompt, setAiPrompt] = useState<AlgoChatPrompt | null>(null)
  const [reviewTargetNames, setReviewTargetNames] = useState<string[]>([])
  // Read once per mount, before mode/positions below use it to seed their
  // own initial state — see consumeScreenerAlgoHandoff for why this one
  // clears itself immediately rather than persisting like the MC handoff.
  const [screenerHandoff] = useState<ScreenerAlgoHandoff | null>(consumeScreenerAlgoHandoff)
  const [mode, setMode] = useState<'single' | 'portfolio'>(screenerHandoff ? 'portfolio' : 'single')
  const [portfolioTradeSize, setPortfolioTradeSize] = useState(10)
  const [portfolioLeverage, setPortfolioLeverage] = useState(1)
  const [effectiveAnnualRate, setEffectiveAnnualRate] = useState(0)
  const [positions, setPositions] = useState<PortfolioPos[]>(() => {
    let loaded: PortfolioPos[]
    try {
      const raw: any[] = JSON.parse(localStorage.getItem(PF_KEY) || '[]')
      // Migrate positions saved before combo legs became editable — they only
      // have a `comboPreset` name, not a legs array. Drop that name once migrated;
      // nothing reads it anymore.
      loaded = raw.map(({ comboPreset, ...p }) => ({
        ...p,
        comboLegs: Array.isArray(p.comboLegs) && p.comboLegs.length ? p.comboLegs : legsToCombo(PRESETS[comboPreset ?? 'Short Straddle'] ?? PRESETS['Short Straddle']),
      }))
    } catch { loaded = [] }
    if (!screenerHandoff) return loaded
    const existingTickers = new Set(loaded.map(p => p.ticker.toUpperCase()))
    const defaultStrategy = loadCustomStrategies()[0]?.name ?? ''
    const fresh: PortfolioPos[] = []
    for (const raw of screenerHandoff.tickers) {
      const ticker = normalizeTicker(raw)
      if (!ticker || existingTickers.has(ticker)) continue
      existingTickers.add(ticker)
      fresh.push({
        id: rid(), strategy: defaultStrategy, ticker,
        instMode: 'underlying', optType: 'call', otmPct: 0, dte: 30,
        comboLegs: legsToCombo(PRESETS['Short Straddle']), comboDte: 30, side: 'long',
      })
    }
    return [...loaded, ...fresh]
  })
  // Debounced: combo-leg edits call setPositions on every keystroke, and writing
  // the whole array to localStorage on each one is wasted work mid-typing.
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(PF_KEY, JSON.stringify(positions)), 400)
    return () => clearTimeout(t)
  }, [positions])
  useEffect(() => {
    localStorage.setItem(AI_CHAT_KEY, JSON.stringify(aiMessages.slice(-80)))
  }, [aiMessages])
  useEffect(() => {
    setAiMessages(messages => messages.map(message => message.role === 'assistant'
      ? { ...message, content: removeLegacyScreenCaps(message.content) }
      : message))
  }, [])
  const addPosition = () => setPositions(p => [...p, {
    id: rid(), strategy: loadCustomStrategies()[0]?.name ?? '', ticker: 'AAPL',
    instMode: 'underlying', optType: 'call', otmPct: 0, dte: 30,
    comboLegs: legsToCombo(PRESETS['Short Straddle']), comboDte: 30, side: 'long',
  }])
  const patchPosition = (id: string, patch: Partial<PortfolioPos>) =>
    setPositions(p => p.map(x => x.id === id ? { ...x, ...patch } : x))
  const removePosition = (id: string) => setPositions(p => p.filter(x => x.id !== id))
  // Clone one position's full config (strategy, side, instrument, combo legs —
  // everything but ticker/id) onto a batch of other tickers, so building a
  // strategy once (e.g. a short straddle) doesn't mean rebuilding it per ticker.
  const [cloningId, setCloningId] = useState<string | null>(null)
  const [cloneInput, setCloneInput] = useState('')
  const pmBooks = useMemo(() => readPMPortfolios().filter(b => b.holdings.length), [])
  const cloneToTickers = (template: PortfolioPos) => {
    const tickers = [...new Set(cloneInput.split(/[,\s]+/).map(t => normalizeTicker(t)).filter(Boolean))]
      .filter(t => t !== template.ticker.toUpperCase())
    if (!tickers.length) return
    setPositions(p => [...p, ...tickers.map(t => ({ ...template, id: rid(), ticker: t }))])
    setCloneInput('')
    setCloningId(null)
  }
  const patchComboLeg = (posId: string, i: number, patch: Partial<ComboLeg>) =>
    setPositions(p => p.map(x => x.id !== posId ? x : { ...x, comboLegs: x.comboLegs.map((l, j) => j === i ? { ...l, ...patch } : l) }))
  const addComboLegToPosition = (posId: string) =>
    setPositions(p => p.map(x => x.id !== posId || x.comboLegs.length >= MAX_COMBO_LEGS ? x : { ...x, comboLegs: [...x.comboLegs, mkComboLeg()] }))
  const removeComboLegFromPosition = (posId: string, i: number) =>
    setPositions(p => p.map(x => x.id !== posId || x.comboLegs.length <= 1 ? x : { ...x, comboLegs: x.comboLegs.filter((_, j) => j !== i) }))
  // Broadcast one position's instrument config (shares/call/put/combo, its
  // strike/DTE or leg structure, and side) to every OTHER position already in
  // the grid — a universe strategy is one shared algorithm across many
  // symbols, but the instrument itself still defaults per-position and has to
  // be built once and replicated, same idea as "copy to other tickers" but
  // for tickers ALREADY in the portfolio instead of a typed-in list, and
  // instrument-only so it doesn't clobber each position's own trade-size
  // override or ticker-specific signal.
  const applyInstrumentToAll = (sourceId: string) =>
    setPositions(p => {
      const src = p.find(x => x.id === sourceId)
      if (!src) return p
      const { instMode, optType, otmPct, dte, comboLegs, comboDte, side } = src
      return p.map(x => x.id === sourceId ? x : {
        ...x, instMode, optType, otmPct, dte, comboDte, side,
        comboLegs: comboLegs.map(l => ({ ...l })),
      })
    })

  const posToPayload = (p: PortfolioPos) => {
    const def = saved.find(s => s.name === activeName)
    if (!def) throw new Error(`Strategy "${activeName}" not found`)
    const money = otmToMoneyness(p.optType, p.otmPct)
    const r = def.risk
    const rules = rulesForTicker(def, p.ticker)   // per-ticker override, else default
    const instrument = p.instMode === 'option' ? { kind: 'option', type: p.optType, moneyness: money, dte: p.dte }
      : p.instMode === 'combo' ? { kind: 'combo', dte: p.comboDte ?? 30, legs: p.comboLegs?.length ? p.comboLegs : legsToCombo(PRESETS['Short Straddle']) }
      : undefined
    return {
      ticker: p.ticker, side: p.side,
      rules: { buy: rules.buy, sell: rules.sell },
      instrument,
      position_size: p.tradeSize ?? portfolioTradeSize,
      stop_loss: r?.stopLossPct || undefined, take_profit: r?.takeProfitPct || undefined,
      trailing_stop: r?.trailingStopPct || undefined, max_hold_bars: r?.maxHoldBars || undefined,
    }
  }

  const activeDef = saved.find(s => s.name === activeName) ?? null
  const refresh = () => setSaved(loadCustomStrategies())
  // A universe of option/combo positions (e.g. one shared short-straddle
  // template cloned across 60 symbols) has no representation in the
  // portfolio GBM/bootstrap simulator — it silently flattens every leg to
  // plain weighted equity, losing the whole structure. Route those to the
  // options-basket handoff instead, using the FIRST option/combo position's
  // legs as the shared template (the universe-strategy model clones one
  // structure across tickers, so they're expected to match) applied across
  // every option/combo-typed ticker. A mixed portfolio's plain-share
  // positions aren't representable here either, so they're left out of this
  // view — the portfolio handoff below remains the right tool for those.
  const exportToMonteCarlo = () => {
    if (!activeDef || positions.length === 0) return
    const optionPositions = positions.filter(p => p.instMode === 'option' || p.instMode === 'combo')
    if (optionPositions.length > 0) {
      const template = optionPositions[0]
      const legs: ComboLeg[] = template.instMode === 'option'
        ? [singleOptionLeg(template.optType, template.side, template.otmPct)]
        : (template.comboLegs?.length ? template.comboLegs : legsToCombo(PRESETS['Short Straddle']))
      const r = activeDef.risk ?? DEFAULT_RISK
      const handoff: AlgoOptionsMonteCarloHandoff = {
        version: 1,
        createdAt: new Date().toISOString(),
        ticker: optionPositions[0].ticker,
        tickers: optionPositions.map(p => p.ticker),
        legs,
        dte: template.instMode === 'option' ? template.dte : (template.comboDte ?? 30),
        takeProfitPct: r.takeProfitPct || undefined,
        stopLossPct: r.stopLossPct || undefined,
        maxHoldDays: r.maxHoldBars || undefined,
        positionSizePct: portfolioTradeSize,
        leverage: portfolioLeverage,
        effectiveAnnualRate,
        strategyName: activeDef.name,
        strategyRules: { buy: activeDef.buy, sell: activeDef.sell },
      }
      localStorage.removeItem(ALGO_MC_HANDOFF_KEY)
      localStorage.setItem(ALGO_MC_OPTIONS_HANDOFF_KEY, JSON.stringify(handoff))
      window.location.assign('/montecarlo')
      return
    }
    const handoff: AlgoMonteCarloHandoff = {
      version: 1,
      createdAt: new Date().toISOString(),
      start,
      end: end || undefined,
      timeframe,
      strategy: activeDef,
      tradeSizePct: portfolioTradeSize,
      leverage: portfolioLeverage,
      effectiveAnnualRate,
      positions: positions.map(({ ticker, instMode, optType, otmPct, dte, comboLegs, comboDte, side, tradeSize }) => ({ ticker, instMode, optType, otmPct, dte, comboLegs, comboDte, side, tradeSize })),
    }
    localStorage.removeItem(ALGO_MC_OPTIONS_HANDOFF_KEY)
    localStorage.setItem(ALGO_MC_HANDOFF_KEY, JSON.stringify(handoff))
    window.location.assign('/montecarlo')
  }

  // Single mode: shares route through the same portfolio-shaped handoff as a
  // one-position "portfolio" (the GBM/bootstrap simulator and Exact Replay
  // both already handle that fine); a single option/combo position instead
  // goes to the Options Strategy handoff, since that's the only MC tool that
  // actually models options rather than silently treating the leg as equity.
  const exportSingleToMonteCarlo = () => {
    if (!activeDef) return
    const r = activeDef.risk ?? DEFAULT_RISK
    if (instMode === 'underlying') {
      const handoff: AlgoMonteCarloHandoff = {
        version: 1,
        createdAt: new Date().toISOString(),
        start, end: end || undefined, timeframe,
        strategy: activeDef,
        tradeSizePct: r.sizingPct || 100,
        leverage: r.leverage || 1,
        effectiveAnnualRate: r.effectiveAnnualRate || 0,
        positions: [{ ticker, instMode, optType, otmPct, dte, comboLegs, comboDte, side, tradeSize: undefined }],
      }
      localStorage.removeItem(ALGO_MC_OPTIONS_HANDOFF_KEY)
      localStorage.setItem(ALGO_MC_HANDOFF_KEY, JSON.stringify(handoff))
    } else {
      const legs: ComboLeg[] = instMode === 'option'
        ? [singleOptionLeg(optType, side, otmPct)]
        : (comboLegs?.length ? comboLegs : legsToCombo(PRESETS['Short Straddle']))
      const handoff: AlgoOptionsMonteCarloHandoff = {
        version: 1,
        createdAt: new Date().toISOString(),
        ticker, legs,
        dte: instMode === 'option' ? dte : (comboDte ?? 30),
        takeProfitPct: r.takeProfitPct || undefined,
        stopLossPct: r.stopLossPct || undefined,
        maxHoldDays: r.maxHoldBars || undefined,
        positionSizePct: r.sizingPct || 100,
        leverage: r.leverage || 1,
        effectiveAnnualRate: r.effectiveAnnualRate || 0,
        strategyName: activeDef?.name || undefined,
        strategyRules: activeDef ? { buy: activeDef.buy, sell: activeDef.sell } : undefined,
      }
      localStorage.removeItem(ALGO_MC_HANDOFF_KEY)
      localStorage.setItem(ALGO_MC_OPTIONS_HANDOFF_KEY, JSON.stringify(handoff))
    }
    window.location.assign('/montecarlo')
  }

  const handleAiDraftAccept = (draft: AlgoStrategyDraft): string | undefined => {
    const candidateTickers = draft.mode === 'portfolio'
      ? (draft.positions ?? []).map(position => position.ticker)
      : draft.ticker ? [draft.ticker] : []
    const universeLabels = new Set(['ALL', 'NASDAQ', 'NASDAQ100', 'NASDAQ-100', 'SP500', 'S&P500', 'SPX'])
    const invalidTickers = candidateTickers
      .map(ticker => ticker.trim().toUpperCase())
      .filter(ticker => universeLabels.has(ticker) || ticker.includes('PLACEHOLDER') || ticker === 'TICKER' || ticker === 'SYMBOL' || ticker === 'TECH_HIGH_BETA' || !/^[A-Z]{1,6}(?:[.-][A-Z]{1,2})?$/.test(ticker))
    if (invalidTickers.length) {
      return `This draft contains unresolved ticker placeholders (${[...new Set(invalidTickers)].join(', ')}). Ask the assistant to run a screen and use real ticker symbols before applying it.`
    }

    const isCompleteRuleSet = (strategy: CustomStrategyDef | undefined): strategy is CustomStrategyDef => Boolean(strategy?.name && strategy.buy && strategy.sell)
    if (draft.mode === 'single' && !isCompleteRuleSet(draft.strategy)) {
      return 'This draft only changes the position parameters. Ask the assistant to return the complete buy and sell rules before applying it.'
    }
    if (draft.mode === 'portfolio') {
      const completeStrategies = (draft.strategies ?? []).filter(isCompleteRuleSet)
      const ruleNames = new Set(completeStrategies.map(strategy => strategy.name))
      const missingRules = [...new Set((draft.positions ?? [])
        .map(position => position.strategy_name)
        .filter(name => !name || !ruleNames.has(name)))]
      if (!completeStrategies.length || missingRules.length) {
        return `This portfolio draft does not include complete rule definitions for ${missingRules.length ? missingRules.join(', ') : 'its positions'}. Ask the assistant to return the strategy rules as well as the positions.`
      }
    }

    const toSave: CustomStrategyDef[] = []
    const revisedStrategy = draft.mode === 'single' && draft.strategy && reviewTargetNames[0]
      ? { ...draft.strategy, name: reviewTargetNames[0] }
      : draft.strategy
    if (draft.mode === 'single' && draft.strategy) {
      toSave.push(revisedStrategy!)
    } else if (draft.mode === 'portfolio' && draft.strategies) {
      toSave.push(...draft.strategies)
    }

    if (toSave.length > 0) {
      toSave.forEach(s => saveCustomStrategy(s))
      setSaved(loadCustomStrategies())
    }

    if (draft.mode === 'single') {
      setMode('single')
      if (draft.ticker) setTicker(draft.ticker.toUpperCase())
      if (draft.side) setSide(draft.side)
      if (draft.instrument) setInstMode(draft.instrument)
      if (draft.opt_type) setOptType(draft.opt_type)
      if (draft.otm_pct !== undefined) setOtmPct(draft.otm_pct)
      if (draft.dte !== undefined) setDte(draft.dte)
      if (draft.combo_legs) setComboLegs(draft.combo_legs)
      if (draft.combo_dte !== undefined) setComboDte(draft.combo_dte)
      if (revisedStrategy?.name) {
        setActiveName(revisedStrategy.name)
      }
    } else {
      setMode('portfolio')
      if (draft.position_size_pct !== undefined) setPortfolioTradeSize(Math.min(100, Math.max(1, draft.position_size_pct)))
      if (draft.leverage !== undefined) setPortfolioLeverage(Math.max(1, draft.leverage))
      if (draft.effective_annual_rate !== undefined) setEffectiveAnnualRate(Math.min(100, Math.max(0, draft.effective_annual_rate)))
      if (draft.strategies?.[0]?.name) setActiveName(draft.strategies[0].name)
      const loaded: PortfolioPos[] = (draft.positions ?? []).map(pos => {
        const matching = loadCustomStrategies().find(s => s.name === pos.strategy_name)
        const stratName = matching ? matching.name : (pos.strategy_name || loadCustomStrategies()[0]?.name || '')
        
        return {
          id: rid(),
          ticker: pos.ticker.toUpperCase(),
          tradeSize: pos.weight_pct,
          strategy: stratName,
          instMode: pos.instrument ?? 'underlying',
          optType: pos.opt_type ?? 'call',
          otmPct: pos.otm_pct ?? 0,
          dte: pos.dte ?? 30,
          comboLegs: pos.combo_legs ?? legsToCombo(PRESETS['Short Straddle']),
          comboDte: pos.combo_dte ?? 30,
          side: pos.side ?? 'long'
        }
      })
      setPositions(loaded)
    }
    setReviewTargetNames([])
    return undefined
  }

  const onModalSave = (def: CustomStrategyDef) => {
    saveCustomStrategy(def)
    refresh()
    setActiveName(def.name)
  }
  const onDelete = (name: string) => {
    deleteCustomStrategy(name)
    const next = loadCustomStrategies()
    setSaved(next)
    if (activeName === name) setActiveName(next[0]?.name ?? '')
  }
  const onDuplicate = (name: string) => {
    const clone = duplicateCustomStrategy(name)
    if (!clone) return
    setSaved(loadCustomStrategies())
    setActiveName(clone.name)
  }

  const { mutate: runBacktest, data, isPending, isError, error } = useMutation<BacktestResult>({
    mutationFn: async () => {
      if (!activeDef) throw new Error('Select or build a strategy first.')
      const r = activeDef.risk ?? DEFAULT_RISK
      const rules = rulesForTicker(activeDef, ticker)   // per-ticker override, else default
      const { data } = await axios.post('/api/strategy/custom-backtest', {
        ticker, start, end: end || undefined, side, timeframe,
        rules: { buy: rules.buy, sell: rules.sell },
        position_size: r.sizingPct || 100,
        stop_loss: r.stopLossPct || undefined,
        take_profit: r.takeProfitPct || undefined,
        trailing_stop: r.trailingStopPct || undefined,
        max_hold_bars: r.maxHoldBars || undefined,
        leverage: r.leverage || 1,
        effective_annual_rate: r.effectiveAnnualRate || 0,
        instrument: instMode === 'option'
          ? { kind: 'option', type: optType, moneyness: optMoneyness, dte }
          : instMode === 'combo' ? comboInstrument()
          : undefined,
      })
      return data
    },
  })

  const sendToPaper = useMutation<{ name: string }, Error>({
    mutationFn: async () => {
      if (!activeDef) throw new Error('Select a strategy first.')
      const rules = rulesForTicker(activeDef, ticker)   // resolve for the current ticker
      const { data } = await axios.post('/api/paper/strategies/custom', {
        name: activeDef.name, side,
        rules: { buy: rules.buy, sell: rules.sell },
        bull_drift: activeDef.bull_drift ?? 0,
        bear_drift: activeDef.bear_drift ?? 0,
        instrument: instMode === 'option'
          ? { kind: 'option', type: optType, moneyness: optMoneyness, dte }
          : instMode === 'combo' ? comboInstrument()
          : undefined,
      })
      return data
    },
  })

  const runPortfolio = useMutation<PortfolioResult, Error>({
    mutationFn: async () => {
      if (positions.length === 0) throw new Error('Add at least one position.')
      const { data } = await axios.post('/api/strategy/portfolio-backtest', {
        positions: positions.map(posToPayload), start, end: end || undefined, timeframe, initial_capital: 10000, position_size: portfolioTradeSize, leverage: portfolioLeverage, effective_annual_rate: effectiveAnnualRate,
      })
      return data
    },
  })

  const sendPortfolioToPaper = useMutation<{ created: number }, Error>({
    mutationFn: async () => {
      if (positions.length === 0) throw new Error('Add at least one position.')
      const { data } = await axios.post('/api/paper/strategies/portfolio', {
        name: 'portfolio', positions: positions.map(posToPayload), position_size: portfolioTradeSize,
      })
      return data
    },
  })

  const m = data?.metrics
  const pf = runPortfolio.data
  const R = mode === 'portfolio' ? pf : data          // active result for the current mode
  const mR = R?.metrics

  const TAB = 'Algorithmic Strategy Builder'
  useReportCapture(() => {
    if (!mR || !R) return null
    const label = mode === 'portfolio'
      ? `Portfolio · ${pf?.positions.length ?? positions.length} legs`
      : `${ticker.toUpperCase()} · ${activeName || 'Strategy'}`
    const pieces: ClipDraft[] = [
      kpiClip(TAB, `Backtest · ${label}`, [
        { label: 'Total Return', value: `${mR.total_return.toFixed(2)}%` },
        { label: 'Ann. Return', value: `${mR.ann_return.toFixed(2)}%` },
        { label: 'Max DD', value: `${mR.max_drawdown.toFixed(2)}%` },
        { label: 'Sharpe', value: mR.sharpe.toFixed(2) },
        { label: 'Trades', value: String(mR.num_trades) },
        { label: 'Win Rate', value: `${mR.win_rate.toFixed(1)}%` },
        { label: 'P&L', value: mR.total_pnl.toFixed(2) },
        { label: 'Final Capital', value: mR.final_capital.toFixed(0) },
      ]),
    ]
    if (R.equity_curve?.length) {
      const step = Math.max(1, Math.ceil(R.equity_curve.length / 80))
      pieces.push(chartClip(TAB, 'Equity Curve', 'line', 'date',
        R.equity_curve
          .filter((_, i) => i % step === 0 || i === R.equity_curve.length - 1)
          .map(p => ({ date: p.date, strategy: p.strategy, benchmark: p.benchmark })),
        [{ key: 'strategy', label: 'Strategy' }, { key: 'benchmark', label: 'Benchmark' }],
      ))
    }
    if (mode === 'portfolio' && pf?.positions?.length) {
      pieces.push(tableClip(TAB, 'Position Attribution',
        ['Ticker', 'Side', 'Instrument', 'Weight %', 'Return %', 'P&L', 'Trades'],
        pf.positions.slice(0, 20).map(p => [
          p.ticker, p.side, p.instrument,
          p.weight_pct?.toFixed?.(1) ?? p.weight_pct,
          p.return_pct?.toFixed?.(2) ?? p.return_pct,
          p.pnl?.toFixed?.(2) ?? p.pnl,
          p.num_trades,
        ]),
      ))
    }
    if (R.trades?.length) {
      pieces.push(tableClip(TAB, 'Trades',
        ['Date', 'Action', 'Price', 'Ticker', 'Reason'],
        R.trades.slice(0, 20).map(t => [
          t.date, t.action, t.price, t.ticker || '—',
          (t.exit_kind || t.reason || '—').slice(0, 40),
        ]),
      ))
    }
    pieces.push(textClip(TAB, 'Run Spec',
      mode === 'portfolio'
        ? `Portfolio backtest · ${start} → ${end || 'latest'} · tf=${timeframe} · size=${portfolioTradeSize} · lev=${portfolioLeverage}`
        : `Single ${side} ${instMode} ${ticker.toUpperCase()} · strategy=${activeName || '—'} · ${start} → ${end || 'latest'} · tf=${timeframe}`))
    return pieces
  }, { disabled: !mR, sourceTab: TAB })

  const [pinnedTrade, setPinnedTrade] = useState<MarkerPoint | null>(null)
  const [selectedPortfolioTicker, setSelectedPortfolioTicker] = useState<string | null>(null)
  const [tradeEventFilter, setTradeEventFilter] = useState<'all' | 'buy' | 'sell' | 'expired'>('all')
  const [pfCollapsed, setPfCollapsed] = useState(false)
  // Collapse the per-ticker attribution grid under portfolio backtest results
  const [tickerGridCollapsed, setTickerGridCollapsed] = useState(false)
  const askAiToImproveBacktest = () => {
    if (!mR) return
    const traded = mode === 'portfolio'
      ? `${pf?.positions.length ?? positions.length} position portfolio`
      : `${side} ${instMode === 'underlying' ? 'shares' : instMode === 'option' ? `${optType} options` : 'option combo'} in ${ticker.toUpperCase()} using ${activeDef?.name ?? 'the current rules'}`
    const exits = (R?.trades ?? []).reduce<Record<string, number>>((counts, trade) => {
      const key = trade.exit_kind || trade.reason || 'signal exit'
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {})
    const exitSummary = Object.entries(exits).slice(0, 4).map(([kind, count]) => `${kind}: ${count}`).join(', ')
    // Leverage/EAR live outside the strategy definition (portfolio-level state
    // for portfolio mode, risk.leverage for single mode) — pull the values the
    // backtest actually ran with from its own result metrics rather than
    // current UI state, since that's the only value guaranteed to match what
    // produced these outcomes (UI state can drift after Run if the user tweaks
    // the controls before asking for a review).
    const leverage = mR.leverage ?? 1
    const financingSummary = leverage > 1
      ? ` Leverage ${leverage}x, ${(mR.effective_annual_rate ?? 0).toFixed(2)}% borrowing EAR, interest paid ${(mR.interest_paid ?? 0).toFixed(2)}.`
      : ' Unlevered (1x).'
    // Portfolio mode's positions each carry a `strategy` field, but it's stale —
    // posToPayload actually runs every position against the one shared
    // activeName strategy — so the review has to target that, not whatever
    // per-position value was set when each position was created.
    const reviewStrategies = activeDef ? [activeDef] : []
    const currentRules = reviewStrategies.length
      ? `\nCurrent strategy definitions to revise. Preserve these exact names in the returned strategy objects: ${JSON.stringify(reviewStrategies.map(strategy => ({ name: strategy.name, buy: strategy.buy, sell: strategy.sell, risk: strategy.risk ?? DEFAULT_RISK })))} `
      : ''
    setAiPrompt({
      id: rid(),
      content: `BACKTEST REVIEW\nSetup: ${traded}.\nWindow: ${R?.span?.start ?? start} to ${R?.span?.end ?? (end || 'latest')}; ${R?.bars ?? 0} bars.\nOutcomes: total return ${mR.total_return.toFixed(2)}%, annualized return ${mR.ann_return.toFixed(2)}%, max drawdown ${mR.max_drawdown.toFixed(2)}%, Sharpe ${mR.sharpe.toFixed(2)}, ${mR.num_trades} trades, win rate ${mR.win_rate.toFixed(1)}%, P&L ${mR.total_pnl.toFixed(2)}.${financingSummary}${exitSummary ? ` Exit mix: ${exitSummary}.` : ''}${currentRules}\nPlease review these outcomes and help me improve this strategy. Start with the single most important adjustment or clarification.`,
    })
    setReviewTargetNames(reviewStrategies.map(strategy => strategy.name))
    setEditing(null)
    setModalOpen(true)
  }
  useEffect(() => { setPinnedTrade(null); setSelectedPortfolioTicker(null) }, [data, pf])
  // Regression dotplot: strategy vs the broad MARKET (SPY), not vs buy & hold of
  // the traded ticker — the equity curve's own "benchmark" field is buy & hold of
  // whatever's being traded, which answers a different question ("did I beat just
  // holding this stock") than systematic market exposure. Needs its own fetch
  // since the backtest response doesn't carry SPY's price series.
  const spyHist = useQuery<{ date: string; value: number }[]>({
    queryKey: ['algo-regression-spy', R?.span?.start, R?.span?.end],
    queryFn: () => axios.get(`/api/market/history?ticker=SPY&start=${R!.span!.start}&end=${R!.span!.end}`).then(r => r.data.price ?? []),
    enabled: !!R?.span,
    staleTime: 5 * 60_000,
  })
  const reg = useMemo(() => {
    if (!R || !spyHist.data?.length) return null
    const spyByDate = new Map(spyHist.data.map(p => [p.date, p.value]))
    const curve = R.equity_curve
      .map(pt => ({ x: spyByDate.get(pt.date), y: pt.strategy }))
      .filter((pt): pt is { x: number; y: number } => typeof pt.x === 'number')
    return curve.length > 1 ? quickRegression(curve) : null
  }, [R, spyHist.data])
  const formatPValue = (value: number | null) => value === null ? '—' : value < 0.001 ? '<0.001' : value.toFixed(3)

  // One hover marker per date+direction — a combo trade posts one row per leg
  // on the same date, so those collapse into a single BUY/SELL marker whose
  // tooltip lists every leg (see EquityTradeTooltip).
  const markerData = useMemo(() => {
    const curve = R?.equity_curve ?? []
    const tickerTrades = selectedPortfolioTicker
      ? R?.trades?.filter(trade => trade.ticker?.toUpperCase() === selectedPortfolioTicker)
      : R?.trades
    const trades = tickerTrades?.filter(trade => {
      if (tradeEventFilter === 'all') return true
      if (tradeEventFilter === 'expired') return trade.action === 'EXPIRE'
      return trade.action === tradeEventFilter.toUpperCase()
    })
    if (!curve.length || !trades?.length) return curve
    const byDate = new Map<string, { buy: BacktestTrade[]; sell: BacktestTrade[] }>()
    for (const t of trades) {
      const bucket = byDate.get(t.date) ?? { buy: [], sell: [] }
      bucket[t.is_entry ? 'buy' : 'sell'].push(t)
      byDate.set(t.date, bucket)
    }
    return curve.map(pt => {
      const b = byDate.get(pt.date)
      if (!b) return pt
      return {
        ...pt,
        buyMarker: b.buy.length ? pt.strategy : undefined,
        sellMarker: b.sell.length ? pt.strategy : undefined,
        buyTrades: b.buy.length ? b.buy : undefined,
        sellTrades: b.sell.length ? b.sell : undefined,
      }
    })
  }, [R, selectedPortfolioTicker, tradeEventFilter])

  // Shared between single-position mode (SidebarLayout's children) and
  // portfolio mode (full-width stack below PortfolioControlsPanel) — the
  // content itself already branches on `mode` throughout, so the same tree
  // renders correctly regardless of which layout wraps it.
  const resultsSection = (
    <>
      {!R && (mode === 'portfolio' ? runPortfolio.isPending : isPending) && (
        <EmptyState title={mode === 'portfolio' ? 'Running Portfolio…' : 'Running Backtest…'}
          hint="Fetching price history and evaluating the rules across the date range."
          variant="loading" />
      )}

      {!R && !(mode === 'portfolio' ? runPortfolio.isPending : isPending) && (
        <EmptyState title="Algorithmic Strategy Builder"
          hint={mode === 'portfolio'
            ? 'Add positions (each = a saved rule-set + ticker + weight + the trade its BUY signal opens), then Run Portfolio. Long/short shares and long/short modeled options aggregate into one book.'
            : 'Build a strategy from entry/exit rules, pick a ticker, then Run Backtest. Saved strategies import into Monte Carlo and the Backtester.'}
          action={mode === 'portfolio' ? 'Run Portfolio' : 'Run Backtest'} />
      )}

      {R && mR && (
        <>
          {mR.blown_up_at && (
            <div style={{ marginBottom: 8, padding: '8px 10px', border: `1px solid ${NEG}`, background: 'rgba(220,60,60,0.08)', fontFamily: 'var(--theme-mono)', fontSize: 10, color: NEG }}>
              Account wiped out on {mR.blown_up_at}. Leveraged losses exceeded the capital allocated to this {mode === 'portfolio' ? 'portfolio' : 'position'}, so it was force-liquidated and held at zero for the rest of the window. Lower leverage or trade size to avoid this.
            </div>
          )}
          <div style={STRIP}>
            <KpiCell grow minWidth={150} label="Total Return" value={`${mR.total_return > 0 ? '+' : ''}${mR.total_return.toFixed(2)}%`} valueSize={16} color={mR.total_return >= 0 ? POS : NEG} sub={mode === 'portfolio' ? `${pf?.positions.length ?? 0} positions` : activeDef?.name} />
            <KpiCell grow label="Ann. Return" value={`${mR.ann_return > 0 ? '+' : ''}${mR.ann_return.toFixed(2)}%`} color={mR.ann_return >= 0 ? POS : NEG} />
            <KpiCell grow label="Max Drawdown" value={`${mR.max_drawdown.toFixed(2)}%`} color={NEG} />
            <KpiCell grow label="Sharpe" value={mR.sharpe.toFixed(3)} color={mR.sharpe >= 1 ? POS : undefined} />
            <KpiCell grow label="Trades" value={String(mR.num_trades)} />
            <KpiCell grow label="Win Rate" value={`${mR.win_rate.toFixed(1)}%`} color={mR.win_rate >= 50 ? POS : NEG} />
            <KpiCell grow label="Final Capital" value={fmtCap(mR.final_capital)} />
            <KpiCell grow label="P&L" value={`${mR.total_pnl >= 0 ? '+' : ''}${fmtCap(mR.total_pnl)}`} color={mR.total_pnl >= 0 ? POS : NEG} />
          </div>
          {(mR.leverage ?? 1) > 1 && (
            <div style={{ marginTop: 6, fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>
              {mR.leverage}x leverage · {(mR.effective_annual_rate ?? 0).toFixed(2)}% borrowing EAR · interest charged: {fmtCap(mR.interest_paid ?? 0)}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={askAiToImproveBacktest} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
            }}>Ask AI to improve this backtest</button>
          </div>

          {R.bars && R.span && (
            <div style={{ fontSize: 9, color: 'var(--theme-text-faint, #5e768f)', fontFamily: 'var(--theme-sans)', marginTop: 6, letterSpacing: '0.04em' }}>
              Window used: {R.span.start} → {R.span.end} · {R.bars.toLocaleString()} daily bars{R.bars < 250 ? ' — short history; indicators needing a long lookback (e.g. SMA200) warm up slowly here' : ''}
            </div>
          )}

          {mR.num_trades === 0 && (() => {
            const usesTickerRule = mode === 'single' && !!activeDef?.perTicker?.some(r => r.ticker.toUpperCase().trim() === ticker.toUpperCase().trim())
            const ruleNote = mode === 'single' && activeDef?.perTicker?.length
              ? ` This ticker uses ${usesTickerRule ? 'its ticker-specific rules' : 'the default rules'}.`
              : ''
            return (
              <div style={{ fontSize: 11, fontFamily: 'var(--theme-mono)', lineHeight: 1.55, color: 'var(--theme-text, #d7e3fc)',
                border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
                background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)', padding: '9px 12px' }}>
                <span style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.06em' }}>NO TRADES.</span>{' '}
                {mode === 'single'
                  ? `"${activeDef?.name}" never entered on ${ticker.toUpperCase()} over this range, so it stayed in cash.`
                  : 'No position entered over this range, so the book stayed in cash.'}
                {' '}The metrics are zero because nothing traded (not a load error). On the chart the flat filled line is the strategy sitting at its starting capital. Check the buy rules, ticker, and date range.{ruleNote}
              </div>
            )
          })()}

          {mode === 'portfolio' && pf && (
            <div style={{ border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setTickerGridCollapsed(c => !c)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  padding: '8px 12px', background: 'var(--theme-surface, #0d1826)', border: 'none', cursor: 'pointer',
                  borderBottom: tickerGridCollapsed ? 'none' : '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                }}
              >
                <span style={{
                  fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)',
                }}>
                  Positions · {pf.positions.length} tickers · {pf.positions.reduce((s, p) => s + (p.num_trades || 0), 0)} trades
                  {selectedPortfolioTicker ? ` · filter ${selectedPortfolioTicker}` : ''}
                </span>
                <span style={{
                  fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  color: 'var(--theme-secondary, #8099b0)', display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  {tickerGridCollapsed ? 'Expand' : 'Collapse'}
                  {tickerGridCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </span>
              </button>
              {!tickerGridCollapsed && (
                <div style={{ ...STRIP, flexWrap: 'wrap', border: 'none' }}>
                  {pf.positions.map((p, i) => {
                    const comboSide = p.instrument === 'combo'
                      ? comboNetSide((positions.find(x => x.instMode === 'combo' && x.ticker.toUpperCase() === p.ticker.toUpperCase())?.comboLegs) ?? [])
                      : null
                    const badgeLabel = p.instrument === 'option' ? (p.opt_type ? p.opt_type.toUpperCase() : 'OPT')
                      : p.instrument === 'combo' ? (comboSide === 'mixed' ? 'MIXED COMBO' : comboSide ? `${comboSide.toUpperCase()} COMBO` : 'COMBO')
                      : 'SHR'
                    const badgeColor = p.instrument === 'combo' ? (comboSide === 'short' ? NEG : comboSide === 'long' ? POS : 'var(--theme-secondary, #8099b0)')
                      : (p.side === 'short' ? NEG : POS)
                    const isSelected = selectedPortfolioTicker === p.ticker.toUpperCase()
                    return (
                    <button key={i} onClick={() => setSelectedPortfolioTicker(current => current === p.ticker.toUpperCase() ? null : p.ticker.toUpperCase())}
                      title={isSelected ? `Show every position's trades` : `Show only ${p.ticker}'s trades on the equity curve`}
                      style={{ flex: '1 1 140px', minWidth: 140, padding: '6px 10px', border: `1px solid ${isSelected ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.06))'}`, background: isSelected ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                      <div style={{ fontSize: 10, fontFamily: 'var(--theme-mono)', fontWeight: 700, color: 'var(--theme-text, #d7e3fc)' }}>
                        {p.ticker} <span style={{ fontSize: 8, color: badgeColor, letterSpacing: '0.06em' }}>{p.instrument === 'combo' ? badgeLabel : `${p.side.toUpperCase()} ${badgeLabel}`}</span>
                      </div>
                      <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #8099b0)', marginTop: 2 }}>
                        {p.weight_pct}% / trade · <span style={{ color: p.return_pct >= 0 ? POS : NEG }}>{p.return_pct >= 0 ? '+' : ''}{p.return_pct}%</span> · {p.num_trades} trades
                      </div>
                    </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {mode === 'single' && data?.instrument?.modeled && data.instrument.kind === 'combo' && (() => {
            const im = data!.instrument!
            return (
            <div style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', border: '1px solid var(--theme-primary, #c9a84c)', padding: '1px 5px' }}>MODELED COMBO</span>
                {(im.legs ?? comboLegs).length}-leg combo · {im.dte} DTE · IV {im.iv}% (Black-Scholes per leg on underlying, not real option prices)
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 9 }}>
                {(im.legs ?? []).map((l, i) => (
                  <span key={i} style={{ color: l.side === 'sell' ? NEG : POS }}>
                    {l.side === 'sell' ? 'SHORT' : 'LONG'} {l.qty}x {l.type} @ {(l.moneyness * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
            </div>
            )
          })()}
          {mode === 'single' && data?.instrument?.modeled && data.instrument.kind !== 'combo' && (() => {
            const im = data!.instrument!
            const otm = Math.round((im.type === 'call' ? im.moneyness! - 1 : 1 - im.moneyness!) * 100)
            const strikeLbl = otm === 0 ? 'ATM' : otm > 0 ? `${otm}% OTM` : `${-otm}% ITM`
            return (
            <div style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', border: '1px solid var(--theme-primary, #c9a84c)', padding: '1px 5px' }}>MODELED</span>
              <span style={{ color: im.direction === 'short' ? NEG : POS, fontWeight: 700 }}>{im.direction === 'short' ? 'SHORT' : 'LONG'}</span>
              {im.type!.toUpperCase()} · {strikeLbl} · {im.dte} DTE · IV {im.iv}% (Black-Scholes on underlying, not real option prices)
              {im.direction === 'short' && <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>· written, mirror of the long leg</span>}
            </div>
            )
          })()}
          {mode === 'single' && instMode === 'underlying' && (
            <div style={{ fontSize: 10, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: side === 'short' ? NEG : POS }}>
              {side === 'short' ? 'Short' : 'Long'} {ticker.toUpperCase()} shares
            </div>
          )}
          {mode === 'single' && activeDef?.risk && (() => {
            const r = activeDef.risk
            const parts = [`size ${r.sizingPct}%`]
            if (r.leverage > 1) parts.push(`${r.leverage}x leverage`)
            if (r.leverage > 1 && r.effectiveAnnualRate > 0) parts.push(`${r.effectiveAnnualRate}% EAR`)
            if (r.stopLossPct) parts.push(`SL ${r.stopLossPct}%`)
            if (r.takeProfitPct) parts.push(`TP ${r.takeProfitPct}%`)
            if (r.trailingStopPct) parts.push(`trail ${r.trailingStopPct}%`)
            if (r.maxHoldBars) parts.push(`max ${r.maxHoldBars} bars`)
            return <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em' }}>Risk applied · {parts.join(' · ')}</div>
          })()}

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, #142032)', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
              Equity Curve — {selectedPortfolioTicker ? `${selectedPortfolioTicker} Trades` : 'Strategy'}
            </div>
            {selectedPortfolioTicker && (
              <button onClick={() => setSelectedPortfolioTicker(null)} style={{ position: 'absolute', top: 3, right: 4, zIndex: 12, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', color: 'var(--theme-secondary, #8099b0)', cursor: 'pointer', fontFamily: 'var(--theme-mono)', fontSize: 8, padding: '3px 6px' }}>
                Show all trades
              </button>
            )}
            <div style={{ position: 'absolute', top: 3, right: selectedPortfolioTicker ? 92 : 4, zIndex: 12, display: 'flex', gap: 3, alignItems: 'center' }}>
              {(['all', 'buy', 'sell', 'expired'] as const).map(filter => {
                const active = tradeEventFilter === filter
                return <button key={filter} onClick={() => setTradeEventFilter(filter)} style={{ background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent', border: `1px solid ${active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`, color: active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)', cursor: 'pointer', fontFamily: 'var(--theme-mono)', fontSize: 8, padding: '3px 5px', textTransform: 'uppercase' }}>
                  {filter}
                </button>
              })}
            </div>
            {pinnedTrade && (
              <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 20 }}>
                <PinnedTradePanel pt={pinnedTrade} onClose={() => setPinnedTrade(null)} />
              </div>
            )}
            <div style={{ paddingTop: 30, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={markerData}>
                  <defs>
                    <linearGradient id="algoEq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={cc.primary} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={cc.primary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                  <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" minTickGap={48} />
                  <YAxis tick={TICK} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} orientation="right" domain={['auto', 'auto']} />
                  <Tooltip content={<EquityTradeTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 10 }} payload={[
                    { value: 'Strategy', type: 'line', id: 's', color: cc.primary },
                    { value: 'Entry (click for detail)', type: 'triangle', id: 'buy', color: 'var(--theme-positive)' },
                    { value: 'Exit (click for detail)', type: 'triangle', id: 'sell', color: 'var(--theme-negative)' },
                  ]} />
                  <Area type="monotone" dataKey="strategy" stroke={cc.primary} strokeWidth={2} fill="url(#algoEq)" name="strategy" dot={false} />
                  <Line dataKey="buyMarker" stroke="transparent" dot={<EqBuyDot onSelect={setPinnedTrade} />} activeDot={false} isAnimationActive={false} legendType="none" />
                  <Line dataKey="sellMarker" stroke="transparent" dot={<EqSellDot onSelect={setPinnedTrade} />} activeDot={false} isAnimationActive={false} legendType="none" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {reg && reg.observations >= 3 && (
            <div style={{ ...STRIP, flexWrap: 'wrap', marginTop: 8 }}>
              <KpiCell grow minWidth={135} label="Market Corr. (r)" value={reg.correlation.toFixed(3)} color={Math.abs(reg.correlation) < 0.35 ? POS : undefined} sub="daily returns vs SPY" />
              <KpiCell grow label="R²" value={reg.rSquared.toFixed(3)} sub="market explained" />
              <KpiCell grow label="Beta" value={reg.beta.toFixed(3)} sub={`p ${formatPValue(reg.betaPValue)}`} />
              <KpiCell grow label="Daily Alpha" value={`${reg.alpha >= 0 ? '+' : ''}${(reg.alpha * 100).toFixed(3)}%`} color={reg.alpha >= 0 ? POS : NEG} sub={`p ${formatPValue(reg.alphaPValue)}`} />
              <KpiCell grow label="Observations" value={String(reg.observations)} sub="daily return pairs" />
            </div>
          )}

          {reg && reg.x.length > 1 && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative', marginTop: 12 }}>
              <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, #142032)', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
                Regression — Strategy vs Market (SPY) Daily Returns
              </div>
              <div style={{ paddingTop: 30, paddingLeft: 8, paddingRight: 8, paddingBottom: 8 }}>
                <ReturnsScatter x={reg.x} y={reg.y} line={reg.line} xLabel="SPY" height={280} />
                <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', textAlign: 'center', marginTop: 6 }}>
                  OLS line · two-sided p-values test beta and alpha against zero
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <StrategyControlsPanel
          mode={mode} setMode={setMode}
          positions={positions} saved={saved} addPosition={addPosition}
          patchPosition={patchPosition} removePosition={removePosition} patchComboLeg={patchComboLeg}
          portfolioTradeSize={portfolioTradeSize} setPortfolioTradeSize={setPortfolioTradeSize}
          portfolioLeverage={portfolioLeverage} setPortfolioLeverage={setPortfolioLeverage} effectiveAnnualRate={effectiveAnnualRate} setEffectiveAnnualRate={setEffectiveAnnualRate}
          addComboLegToPosition={addComboLegToPosition} removeComboLegFromPosition={removeComboLegFromPosition}
          applyInstrumentToAll={applyInstrumentToAll}
          cloningId={cloningId} setCloningId={setCloningId} cloneInput={cloneInput} setCloneInput={setCloneInput}
          cloneToTickers={cloneToTickers} pmBooks={pmBooks}
          start={start} setStart={setStart} end={end} setEnd={setEnd} timeframe={timeframe} setTimeframe={setTimeframe}
          activeName={activeName} setActiveName={setActiveName}
          onEditStrategy={def => { setEditing(def); setReviewTargetNames([]); setAiPrompt(null); setModalOpen(true) }}
          onDuplicateStrategy={onDuplicate}
          onDeleteStrategy={onDelete}
          onNewStrategy={() => { setEditing(null); setReviewTargetNames([]); setAiPrompt(null); setModalOpen(true) }}
          runPortfolio={runPortfolio} sendPortfolioToPaper={sendPortfolioToPaper}
          exportToMonteCarlo={exportToMonteCarlo}
          exportSingleToMonteCarlo={exportSingleToMonteCarlo}
          collapsed={pfCollapsed} onToggleCollapsed={() => setPfCollapsed(c => !c)}
          ticker={ticker} setTicker={setTicker}
          side={side} setSide={setSide}
          instMode={instMode} setInstMode={setInstMode}
          optType={optType} setOptType={setOptType}
          otmPct={otmPct} setOtmPct={setOtmPct}
          dte={dte} setDte={setDte}
          comboLegs={comboLegs} setComboLegs={setComboLegs}
          updateComboLeg={updateComboLeg} addComboLeg={addComboLeg} removeComboLeg={removeComboLeg}
          comboDte={comboDte} setComboDte={setComboDte}
          runBacktest={runBacktest} isPending={isPending} isError={isError} error={error}
          sendToPaper={sendToPaper}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: 'var(--theme-bg, #101c2e)' }}>
          {resultsSection}
        </div>
      </div>

    {modalOpen && (
      <CustomStrategyModal
        open
        onClose={() => { setModalOpen(false); setReviewTargetNames([]); setAiPrompt(null) }}
        onSave={onModalSave}
        initialDef={editing}
        allowAiAssist={false}
        initialTab={aiPrompt ? 'describe' : 'manual'}
        aiAssistant={<AiAlgoStrategyChat
          messages={aiMessages}
          setMessages={setAiMessages}
          pendingPrompt={aiPrompt}
          onPromptConsumed={() => setAiPrompt(null)}
          reviewTargetNames={reviewTargetNames}
          onAccept={draft => {
            if (reviewTargetNames.length) {
              const revised = draft.mode === 'single' ? (draft.strategy ? [draft.strategy.name] : []) : (draft.strategies ?? []).map(strategy => strategy.name)
              const missing = reviewTargetNames.filter(name => !revised.includes(name))
              if (missing.length) return `This revision is missing updated rules for ${missing.join(', ')}. Ask the assistant to return the complete revised strategy definitions before applying.`
            }
            const issue = handleAiDraftAccept(draft)
            if (issue) return issue
            setModalOpen(false)
            return undefined
          }}
        />}
      />
    )}
    </>
  )
}

export default function AlgoStrategyBuilder() {
  return <PageWrapper title="Algorithmic Strategy Builder"><AlgoStrategyBuilderContent /></PageWrapper>
}

interface AlgoStrategyDraft {
  summary: string
  mode: 'single' | 'portfolio'
  ticker?: string
  side?: 'long' | 'short'
  instrument?: 'underlying' | 'option' | 'combo'
  opt_type?: 'call' | 'put'
  otm_pct?: number
  dte?: number
  combo_legs?: ComboLeg[]
  combo_dte?: number
  strategy?: CustomStrategyDef
  position_size_pct?: number
  leverage?: number
  effective_annual_rate?: number
  positions?: {
    ticker: string
    side: 'long' | 'short'
    instrument: 'underlying' | 'option' | 'combo'
    opt_type?: 'call' | 'put'
    otm_pct?: number
    dte?: number
    combo_legs?: ComboLeg[]
    combo_dte?: number
    weight_pct?: number
    strategy_name: string
  }[]
  strategies?: CustomStrategyDef[]
}

interface AlgoChatMsg {
  role: 'user' | 'assistant'
  content: string
}

interface AlgoChatPrompt {
  id: string
  content: string
}

function removeLegacyScreenCaps(content: string): string {
  return content
    .replace(/\s*\(max\s+\d+\s+results?\)/gi, '')
    .replace(/\s*and\s+increase\s+the\s+result\s+limit\s+beyond\s+\d+/gi, '')
    .replace(/\s*\(the\s+system\s+will\s+return\s+up\s+to\s+\d+\s+tickers?\s+per\s+screen\)/gi, '')
}

function AiAlgoStrategyChat({ messages, setMessages, pendingPrompt, onPromptConsumed, reviewTargetNames, onAccept }: {
  messages: AlgoChatMsg[]
  setMessages: React.Dispatch<React.SetStateAction<AlgoChatMsg[]>>
  pendingPrompt: AlgoChatPrompt | null
  onPromptConsumed: () => void
  reviewTargetNames: string[]
  onAccept: (draft: AlgoStrategyDraft) => string | undefined
}) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<AlgoStrategyDraft | null>(null)
  const [isReview, setIsReview] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  const handledPromptRef = useRef<string | null>(null)

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, pending, draft])

  const T = {
    bg:      'var(--theme-bg, #101c2e)',
    surface: 'var(--theme-surface, #0d1826)',
    border:  'var(--theme-border, rgba(255,255,255,0.10))',
    text:    'var(--theme-text, #d7e3fc)',
    muted:   'var(--theme-secondary, #99907e)',
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
  const draftUsesNonDailyTimeframe = !!draft && [draft.strategy, ...(draft.strategies ?? [])]
    .some((strategy): strategy is CustomStrategyDef => !!strategy && usesNonDailyTimeframe(strategy))

  const sendMessage = async (text: string) => {
    if (!text || pending) return
    if (text.startsWith('BACKTEST REVIEW')) setIsReview(true)
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setError('')
    setPending(true)
    try {
      const { data } = await axios.post('/api/ai/strategy-chat', { messages: next, scope: 'full' })
      if (data?.type === 'draft') {
        setDraft(data)
        setMessages(m => [...m, { role: 'assistant', content: data.summary || "Draft ready." }])
      } else {
        setDraft(null)
        setMessages(m => [...m, { role: 'assistant', content: data?.text || "Could you say a bit more about that?" }])
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Request failed')
    } finally {
      setPending(false)
    }
  }

  const send = () => {
    const text = input.trim()
    if (!text || pending) return
    void sendMessage(text)
  }

  useEffect(() => {
    if (!pendingPrompt || handledPromptRef.current === pendingPrompt.id || pending) return
    handledPromptRef.current = pendingPrompt.id
    onPromptConsumed()
    void sendMessage(pendingPrompt.content)
  }, [pendingPrompt, pending, messages, onPromptConsumed])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100dvh - 230px)', minHeight: 420 }}>
      <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: 1.4 }}>
        Describe the market idea you want to capture. The assistant can screen the market for real candidate tickers, then clarify your horizon, trade expression, signals, sizing, and risk before building the assets, legs, weights, and algorithmic rules together.
      </div>

      <div ref={listRef} style={{
        display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, overflowY: 'auto',
        padding: messages.length ? 8 : 0, background: messages.length ? T.surface : 'transparent',
        border: messages.length ? `1px solid ${T.border}` : 'none',
      }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono, lineHeight: 1.6, fontStyle: 'italic' }}>
            e.g. "Sell a 30-day ATM straddle on SPY with weight 50% using RSI mean reversion" or "Make a portfolio: 60% AAPL shares and 40% TSLA call options"
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
            {isReview ? 'Revision Ready' : 'Draft Ready'} ({draft.mode === 'portfolio' ? `${draft.positions?.length ?? 0} Position Portfolio` : 'Single Position Mode'})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, maxHeight: 120, overflowY: 'auto' }}>
            {draft.mode === 'single' ? (
              <div style={{ fontSize: 9, fontFamily: T.mono, color: T.text }}>
                Ticker: {draft.ticker} · Side: {draft.side?.toUpperCase()} · Instrument: {draft.instrument?.toUpperCase()}
                {draft.instrument === 'option' && ` (${draft.opt_type?.toUpperCase()}, ${draft.otm_pct}% OTM, ${draft.dte} DTE)`}
                {draft.instrument === 'combo' && ` (${draft.combo_legs?.length} legs, ${draft.combo_dte} DTE)`}
                {draft.strategy && ` · Custom Rules: "${draft.strategy.name}"`}
              </div>
            ) : (
              (draft.positions ?? []).map((pos, idx) => (
                <div key={idx} style={{ fontSize: 9, fontFamily: T.mono, color: T.text, borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: 2 }}>
                  {pos.ticker} ({draft.position_size_pct ?? pos.weight_pct ?? 10}% / trade) · {pos.side?.toUpperCase()} {pos.instrument?.toUpperCase()}
                  {pos.instrument === 'option' && ` (${pos.opt_type?.toUpperCase()}, ${pos.otm_pct}% OTM)`}
                  {pos.instrument === 'combo' && ` (${pos.combo_legs?.length} legs)`}
                  {` · Rules: ${pos.strategy_name}`}
                </div>
              ))
            )}
          </div>

          {draftUsesNonDailyTimeframe && (
            <div style={{ fontSize: 9, color: T.gold, fontFamily: T.mono, lineHeight: 1.45, marginBottom: 8 }}>
              Backtest-only timeframe: live paper trading evaluates these rules on daily bars. Confirm this is intended before loading the setup.
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => {
              const issue = onAccept(draft)
              if (issue) setError(issue)
            }}
              style={{ ...btn, background: T.gold, border: 'none', color: T.bg, fontWeight: 700, letterSpacing: '0.08em', padding: '4px 8px' }}>
              {isReview ? 'Apply Revision' : 'Load Setup'}
            </button>
            <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>{isReview ? reviewTargetNames.length ? `Updates ${reviewTargetNames.join(', ')} in the builder` : 'Applies the revised setup to the builder' : 'Click to apply to builder'}</span>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 9, color: T.neg, fontFamily: T.mono }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>{messages.length ? `${messages.length} messages saved` : 'History is saved on this device'}</span>
        {messages.length > 0 && <button onClick={() => { setMessages([]); setDraft(null); setError('') }} style={{ ...btn, padding: '3px 7px' }}>Clear history</button>}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={messages.length ? 'Reply…' : 'Describe setup…'}
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
