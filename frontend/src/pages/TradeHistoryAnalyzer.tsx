import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import {
  ResponsiveContainer, AreaChart, Area, Line, BarChart, Bar,
  ComposedChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, Cell,
} from 'recharts'
import { Upload, AlertTriangle } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import LoadingState from '../components/LoadingState'
import HelpTip from '../components/HelpTip'
import { T } from '../lib/theme'
import { MONO, SANS } from './cockpitKit'

// One frame, not a stack of cards: the outer border is the only box and the
// bands inside are divided by hairlines, so the page reads as one instrument
// rather than six panels that happen to be adjacent. Data fetching, the Broker
// type, money/pct and the response interfaces are unchanged; this file owns the
// render tree.

type Broker = 'auto' | 'fidelity' | 'robinhood'

interface Metrics {
  totalReturnPct: number; annualizedReturnPct: number; benchmarkReturnPct: number
  volPct: number; sharpe: number; sortino: number; calmar: number
  maxDrawdownPct: number; alphaPct: number; beta: number
  alphaRegressionPct: number | null; alphaDirectPct: number | null
  riskFreePct: number; benchmark: string
}
interface Account {
  startDate: string; endDate: string; ledgerStartDate?: string; days: number
  endingValue: number; netContributions: number; netGain: number
  realisedPnl: number; optionRealised: number; tradeCount: number; symbols: string[]
}
interface DirectAlpha {
  available: boolean
  alphaPct?: number; contributed?: number; endingValue?: number
  benchmarkValue?: number; dollarsVsBenchmark?: number; flowCount?: number
}
interface RegPoint { x: number; y: number; d?: string }
interface Regression {
  sufficient: boolean; observations: number
  beta?: number; alphaRegressionPct?: number
  tStat?: number; pValue?: number; rSquared?: number; significant?: boolean
  portfolioAnnPct?: number; benchmarkAnnPct?: number
  points?: RegPoint[]
  line?: { x: number; y: number }[]
}
interface Point { d: string; v: number }
interface DrawdownPoint extends Point { equity?: number; peak?: number }
interface MonthPoint { month: string; returnPct: number; benchmarkReturnPct?: number }
interface Position { symbol: string; pct: number; value?: number }
interface Trade {
  symbol: string; contract?: string; isOption: boolean
  opened: string; closed: string | null; open: boolean
  heldDays: number; fills: number
  invested: number; returned: number; income: number; openValue: number
  pnl: number; returnPct: number
  benchmarkPct?: number | null; shareOfGainsPct?: number | null
  label?: string; tags?: string[]
  signals?: {
    daysSinceListing?: number | null; bestDayShare?: number | null
    entryDrawdownPct?: number | null; exitPlacement?: number | null
    earningsInWindow?: number | null; edgePts?: number | null
  }
}
interface Analysis {
  metrics: Metrics
  account: Account
  series: { equity: Point[]; drawdown: DrawdownPoint[]; benchmark: Point[] }
  regression: Regression
  directAlpha: DirectAlpha
  dailyBook?: Record<string, Position[]>
  bestTrades?: Trade[]
  marks?: { troughDate?: string; peakDate?: string; peakValue?: number; benchmarkAnnualizedPct?: number }
  allocation: { symbol: string; value: number; weightPct: number }[]
  monthly: MonthPoint[]
  caveats: string[]
  returnMethod: string
  source: string
  accounts: string[]
  parsed: {
    transactions: number; skippedCount: number; skipped: string[]
    skippedKinds?: { kind: string; count: number }[]
  }
}

const BROKERS: { id: Broker; label: string; hint: string }[] = [
  { id: 'auto', label: 'Detect', hint: 'Read the broker from the file header' },
  { id: 'fidelity', label: 'Fidelity', hint: 'Accounts > History > Download' },
  { id: 'robinhood', label: 'Robinhood', hint: 'Account > Statements > Reports' },
]

// The design system's heatmap convention: zero-anchored forest and maroon, not
// the bright positive/negative pair, so a row of months reads as one scale.
const UP = 'rgba(47,107,75,0.9)'
const DOWN = 'rgba(140,46,54,0.9)'

const money = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
const tone = (n: number) => (n >= 0 ? T.pos : T.neg)

// TODO: the interpretation copy for direct alpha, sortino, calmar and the
// p-value is the product owner's to write. These are working bodies.
type Tip = { title: string; body: string }

const TIPS: Record<string, Tip> = {
  direct: { title: 'Direct alpha', body: 'Money-weighted. Every contribution is carried forward at the benchmark\'s own return, and the IRR of that scaled series is the excess rate earned over the index.' },
  regression: { title: 'Regression alpha', body: 'The intercept of the daily fit. It carries a standard error, so unlike a ratio it can be tested against zero.' },
  sortino: { title: 'Sortino', body: 'Sharpe measured against downside deviation only.' },
  calmar: { title: 'Calmar', body: 'Annualized return divided by the worst drawdown.' },
  pvalue: { title: 'Alpha p-value', body: 'The chance of an alpha this size arising from noise alone.' },
}

// Two of them only mean something against this account's own benchmark and its
// own length, so they are written with both in hand.
function contextTips(bench: string, days: number): Record<string, Tip> {
  return {
    ...TIPS,
    r2: {
      title: 'R squared',
      body: `The share of your daily moves that ${bench} explains. High and you are holding a version of the index, so the beta above describes your risk well and the alpha is what you added on top. Low and ${bench} is the wrong yardstick for this book, which makes both figures weak.`,
    },
    tstat: {
      title: 'Alpha t-statistic',
      body: `Your alpha divided by its own standard error over ${days} days. Around 2 is where a result stops looking like luck. Below that the daily scatter is wide enough to produce this alpha on its own, so read it as unproven rather than as an edge.`,
    },
  }
}

export default function TradeHistoryAnalyzer() {
  const [broker, setBroker] = useState<Broker>('auto')
  const [file, setFile] = useState<File | null>(null)
  const [accounts, setAccounts] = useState<string[]>([])
  const [account, setAccount] = useState('')
  const [benchmark, setBenchmark] = useState('SPY')
  const [data, setData] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The pinned day is held by date rather than by row index: a hover-opened
  // card on a 3px target was more miss than hit, so the card is a click and
  // the identity has to survive whatever recharts hands back from the event.
  const [pinnedDay, setPinnedDay] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const detail = (e: unknown) =>
    (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    || (e as Error)?.message || 'That did not work.'

  // A Fidelity export holds several accounts, and blending a taxable book with
  // an IRA measures neither, so the file is inspected before it is analysed.
  const onPick = useCallback(async (picked: File | null) => {
    setFile(picked); setData(null); setError(''); setAccounts([]); setAccount('')
    if (!picked) return
    const form = new FormData()
    form.append('file', picked)
    if (broker !== 'auto') form.append('source', broker)
    try {
      const { data: info } = await axios.post('/api/trade-history/inspect', form)
      setAccounts(info.accounts ?? [])
      if ((info.accounts ?? []).length === 1) setAccount(info.accounts[0])
      if (info.source && broker === 'auto') setBroker(info.source as Broker)
    } catch (e) {
      setError(detail(e))
    }
  }, [broker])

  const run = useCallback(async () => {
    if (!file) return
    setBusy(true); setError(''); setData(null); setPinnedDay(null)
    const form = new FormData()
    form.append('file', file)
    if (broker !== 'auto') form.append('source', broker)
    if (account) form.append('account', account)
    form.append('benchmark', benchmark.trim().toUpperCase() || 'SPY')
    try {
      const { data: result } = await axios.post('/api/trade-history/analyze', form)
      setData(result)
    } catch (e) {
      setError(detail(e))
    }
    setBusy(false)
  }, [file, broker, account, benchmark])

  // A pinned card is dismissable by Escape as well as by clicking away.
  useEffect(() => {
    if (pinnedDay === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinnedDay(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinnedDay])

  const m = data?.metrics
  const a = data?.account
  const reg = data?.regression

  const curve = useMemo(() => {
    if (!data) return []
    const bench = new Map(data.series.benchmark.map(p => [p.d, p.v]))
    return data.series.equity.map(p => ({ d: p.d, equity: p.v, benchmark: bench.get(p.d) ?? null }))
  }, [data])

  // Exact bounds, not a nice-rounded pair: the account line has to leave the
  // bottom-left corner and reach the top-right one, or the tile spends a third
  // of its height on an empty band under a curve that never goes there.
  const valueDomain = useMemo<[number, number]>(() => {
    const vs = curve.flatMap(p => [p.equity, p.benchmark]).filter((v): v is number => v != null)
    if (!vs.length) return [0, 1]
    const lo = Math.min(...vs), hi = Math.max(...vs)
    return [lo, hi + (hi - lo) * 0.04]
  }, [curve])

  const tips = useMemo(
    () => contextTips(data?.metrics.benchmark ?? 'the benchmark', data?.regression.observations ?? 0),
    [data],
  )

  const monthStats = useMemo(() => {
    if (!data) return { up: 0, down: 0, ranked: new Map<string, number>() }
    const sorted = [...data.monthly].sort((x, y) => y.returnPct - x.returnPct)
    return {
      up: data.monthly.filter(r => r.returnPct >= 0).length,
      down: data.monthly.filter(r => r.returnPct < 0).length,
      ranked: new Map(sorted.map((r, i) => [r.month, i + 1])),
    }
  }, [data])

  return (
    <PageWrapper
      title="Trade Analyzer"
      meta={
        <span style={{
          fontFamily: MONO, fontSize: 10.5, lineHeight: 1.6, maxWidth: '96ch', color: T.muted,
        }}>
          Import a Fidelity or Robinhood export and measure what the account actually did.
          Returns are time-weighted, so contributions and transfers are removed rather than
          counted as gains.
        </span>
      }
    >
      <div className="tha-frame">

        {/* ── Import ─────────────────────────────────────────────────────── */}
        <div className="tha-import tha-band">
          <div className="tha-controls">
            <div className="tha-field">
              <label>Broker</label>
              <div style={{ display: 'flex' }}>
                {BROKERS.map(b => (
                  <button key={b.id} onClick={() => setBroker(b.id)} title={b.hint}
                    aria-pressed={broker === b.id}
                    style={{
                      fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                      textTransform: 'uppercase', padding: '7px 13px', cursor: 'pointer',
                      background: broker === b.id ? T.gold : 'transparent',
                      color: broker === b.id ? T.bg : T.muted,
                      border: `1px solid ${broker === b.id ? T.gold : T.border}`,
                    }}>{b.label}</button>
                ))}
              </div>
            </div>

            <div className="tha-field">
              <label>File</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input ref={inputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                  onChange={e => onPick(e.target.files?.[0] ?? null)} />
                <button onClick={() => inputRef.current?.click()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7, height: 32, maxWidth: 280,
                    fontFamily: MONO, fontSize: 11, padding: '0 13px', background: 'transparent',
                    color: T.text, border: `1px solid ${T.border}`, cursor: 'pointer',
                  }}>
                  <Upload size={13} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file ? file.name : 'Choose a CSV export'}
                  </span>
                </button>
                {file && <button onClick={() => inputRef.current?.click()} style={ghost}>Replace</button>}
              </div>
            </div>

            {accounts.length > 1 && (
              <div className="tha-field">
                <label>Account</label>
                <select value={account} onChange={e => setAccount(e.target.value)}
                  style={{ height: 32, fontFamily: MONO, fontSize: 11, padding: '0 9px', background: T.bg, color: T.text, border: `1px solid ${T.border}` }}>
                  <option value="">All accounts</option>
                  {accounts.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
            )}

            <div className="tha-field">
              <label>Benchmark</label>
              <input value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())}
                style={{ height: 32, width: 88, fontFamily: MONO, fontSize: 11, padding: '0 9px', background: T.bg, color: T.text, border: `1px solid ${T.border}` }} />
            </div>

            <button onClick={run} disabled={!file || busy}
              style={{
                marginLeft: 'auto', height: 32, fontFamily: SANS, fontSize: 10, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0 20px',
                background: file && !busy ? T.gold : 'transparent',
                color: file && !busy ? T.bg : T.muted,
                border: `1px solid ${file && !busy ? T.gold : T.border}`,
                cursor: file && !busy ? 'pointer' : 'default',
              }}>{busy ? 'Analyzing' : 'Analyze'}</button>
          </div>

          <div className="tha-note">
            <span>
              {data ? `${data.parsed.transactions} rows read. ` : ''}
              Nothing is stored: the file is parsed, measured and discarded inside the request.
            </span>
            {!!data?.parsed.skippedCount && (
              <span className="dim">
                {data.parsed.skippedCount} rows were not recognised and are excluded from every
                figure below
                {/* The codes matter more than the total. Option trades change
                    the answer, a margin-rate notice does not. */}
                {data.parsed.skippedKinds?.length
                  ? `: ${data.parsed.skippedKinds.slice(0, 6).map(k => `${k.kind} ${k.count}`).join(', ')}`
                  : ''}.
              </span>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" className="tha-band" style={{
            display: 'flex', gap: 9, padding: '10px 22px', color: T.neg,
            fontFamily: MONO, fontSize: 11, lineHeight: 1.5,
          }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        {busy && (
          <div className="tha-band" style={{ padding: '28px 22px' }}>
            <LoadingState label="Rebuilding the equity curve from the ledger" />
          </div>
        )}

        {data && m && a && reg && (
          <>
            {/* ── KPI band ───────────────────────────────────────────────── */}
            <div className="tha-kpis">
              <Kpi label="Total return" value={pct(m.totalReturnPct)} color={tone(m.totalReturnPct)}
                sub={`${m.benchmark} ${pct(m.benchmarkReturnPct)}`} />
              <Kpi label="Max drawdown" value={`${m.maxDrawdownPct.toFixed(2)}%`} color={T.neg}
                sub={`over ${a.days} days`} />
              <Kpi label={`Beta vs ${m.benchmark}`} value={m.beta.toFixed(2)} color={T.text}
                sub={reg.rSquared != null ? `R² ${reg.rSquared.toFixed(3)}` : undefined} />
              <Kpi label="Alpha (direct)" tip={tips.direct}
                value={data.directAlpha.available ? pct(m.alphaDirectPct ?? 0) : '—'}
                color={data.directAlpha.available ? tone(m.alphaDirectPct ?? 0) : T.muted}
                sub={data.directAlpha.available
                  ? `${money(data.directAlpha.dollarsVsBenchmark ?? 0)} vs ${m.benchmark}`
                  : 'no dated flows'} />
              <Kpi label="Alpha (regression)" tip={tips.regression}
                value={reg.sufficient ? pct(m.alphaRegressionPct ?? 0) : '—'}
                color={!reg.sufficient ? T.muted : reg.significant ? tone(m.alphaRegressionPct ?? 0) : T.warn}
                sub={reg.sufficient
                  ? `t ${reg.tStat?.toFixed(2)} · p ${reg.pValue?.toFixed(3)}`
                  : 'too few days'} />
            </div>

            {/* ── Account value + Run summary ────────────────────────────── */}
            <div className="tha-split tha-split-2-1">
              <div>
                <Strip label="Account value" meta={[`${a.startDate} to ${a.endDate}`, data.returnMethod]} />
                <div className="tha-section tha-fill">
                  <div className="tha-plot">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={curve} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={T.gold} stopOpacity={0.30} />
                            <stop offset="100%" stopColor={T.gold} stopOpacity={0.01} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke={T.borderFaint} vertical={false} />
                        <XAxis dataKey="d" tick={axisTick} minTickGap={44} />
                        <YAxis tick={axisTick} width={58} domain={valueDomain} allowDecimals
                          tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`} />
                        <Tooltip contentStyle={tipBox} labelStyle={tipLabel}
                          formatter={(v: number, n: string) => [money(v), n]} />
                        <Area name="Account" type="monotone" dataKey="equity" stroke={T.gold}
                          fill="url(#eq)" strokeWidth={1.8} dot={false} />
                        <Line name={`${m.benchmark}, same deposits`} type="monotone" dataKey="benchmark"
                          stroke={T.muted} strokeWidth={1.2} strokeDasharray="4 3" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="tha-plot-legend">
                    <span><i className="tha-swatch" style={{ background: T.gold }} />Account</span>
                    {/* Not the index rebased: every deposit is bought into the
                        benchmark on its own day, so the gap is return. */}
                    <span><i className="tha-swatch" style={{ background: T.muted }} />
                      {m.benchmark}, same deposits</span>
                    {data.marks?.peakValue != null && (
                      <span>Peak {money(data.marks.peakValue)}{data.marks.peakDate ? ` on ${data.marks.peakDate}` : ''}</span>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <Strip label="Run summary" meta={[`${a.days} days`]} />
                <div className="tha-section-tight">
                  <Stat k="Period" v={`${a.startDate} to ${a.endDate}`} />
                  <Stat k="Trading days" v={String(a.days)} />
                  <Stat k="Annualized return" v={pct(m.annualizedReturnPct)} c={tone(m.annualizedReturnPct)} />
                  {data.marks?.benchmarkAnnualizedPct != null && (
                    <Stat k={`Benchmark annualized (${m.benchmark})`} v={pct(data.marks.benchmarkAnnualizedPct)} />
                  )}
                  <Stat k="Net gain" v={money(a.netGain)} c={tone(a.netGain)} />
                  <Stat k="Sharpe" v={m.sharpe.toFixed(2)} />
                  <Stat k="Volatility (annualized)" v={`${m.volPct.toFixed(1)}%`} />
                  <Stat k="Sortino" v={m.sortino.toFixed(2)} tip={tips.sortino} />
                  <Stat k="Calmar" v={m.calmar.toFixed(2)} tip={tips.calmar} />
                  {reg.rSquared != null && <Stat k="R squared" v={reg.rSquared.toFixed(3)} tip={tips.r2} />}
                  {reg.tStat != null && <Stat k="Alpha t-statistic" v={reg.tStat.toFixed(2)} tip={tips.tstat} />}
                  {reg.pValue != null && (
                    <Stat k="Alpha p-value" tip={tips.pvalue}
                      v={`${reg.pValue.toFixed(3)} · ${reg.significant ? 'significant' : 'not significant'}`}
                      c={reg.significant ? undefined : T.warn} />
                  )}
                </div>
              </div>
            </div>

            {/* ── Drawdown + Monthly ─────────────────────────────────────── */}
            <div className="tha-split tha-split-1-1">
              <div>
                <Strip label="Drawdown" meta={[
                  `worst ${m.maxDrawdownPct.toFixed(2)}%${data.marks?.troughDate ? ` on ${data.marks.troughDate}` : ''}`,
                ]} />
                <div className="tha-section">
                  <div style={{ height: 186 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.series.drawdown}>
                        <CartesianGrid stroke={T.borderFaint} vertical={false} />
                        <XAxis dataKey="d" tick={axisTick} minTickGap={44} />
                        <YAxis tick={axisTick} width={46} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                        <Tooltip cursor={{ stroke: T.border }} content={DrawdownTip} />
                        <Area type="monotone" dataKey="v" stroke={T.neg} fill="rgba(140,46,54,0.42)"
                          strokeWidth={1.4} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              <div>
                <Strip label="Monthly return" meta={[
                  `${data.monthly.length} months · ${monthStats.up} up · ${monthStats.down} down`,
                ]} />
                <div className="tha-section">
                  <div style={{ height: 186 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.monthly}>
                        <CartesianGrid stroke={T.borderFaint} vertical={false} />
                        <XAxis dataKey="month" tick={axisTick} minTickGap={10} />
                        <YAxis tick={axisTick} width={46} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                        {/* The whole month column is the hit area, not just the bar. */}
                        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                          content={props => (
                            <MonthTip {...props} benchmark={m.benchmark}
                              rank={monthStats.ranked} total={data.monthly.length} />
                          )} />
                        <ReferenceLine y={0} stroke={T.border} />
                        <Bar dataKey="returnPct" activeBar={{ fillOpacity: 1 }}>
                          {data.monthly.map(r => (
                            <Cell key={r.month} fill={r.returnPct >= 0 ? UP : DOWN} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Daily return + Holdings ────────────────────────────────── */}
            <div className="tha-split tha-split-5-4">
              <DailyReturn data={data} m={m} reg={reg}
                pinned={pinnedDay} onPin={setPinnedDay} />

              <div>
                <Strip label="Holdings at the end of the period"
                  meta={[`${data.allocation.length} positions`]} />
                {/* The list is as long as the book is, and 21 names ran the tile
                    off the bottom of the frame. The scroll area fills whatever
                    height the row already has, so the column ends level with
                    the scatter beside it however many positions there are. */}
                <div className="tha-holdbody">
                  <div className="tha-holdscroll">
                    <div className="tha-holdrow tha-holdhead">
                      <span>Symbol</span><span /><span style={{ textAlign: 'right' }}>Value</span>
                      <span style={{ textAlign: 'right' }}>Weight</span>
                    </div>
                  {data.allocation.map(h => {
                    // Scaled to the largest weight in the list, not to the first
                    // row: a list that arrives in any order but weight-descending
                    // made every bar hundreds of times too long.
                    const max = Math.max(...data.allocation.map(x => x.weightPct), 0.01)
                    const width = Math.min(100, Math.max(2, (h.weightPct / max) * 100))
                    return (
                      <div key={h.symbol} className="tha-holdrow">
                        <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: T.text }}>{h.symbol}</span>
                        <span className="tha-weightbar">
                          <i style={{ width: `${width}%` }} />
                        </span>
                        <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: 12, fontWeight: 600, color: T.text }}>
                          {money(h.value)}
                        </span>
                        <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: 11, color: T.muted }}>
                          {h.weightPct.toFixed(1)}%
                        </span>
                      </div>
                    )
                  })}
                    {data.allocation.length === 0 && (
                      <div style={{ padding: '12px 0', fontFamily: MONO, fontSize: 11, color: T.muted }}>
                        No open positions at the end of the period.
                      </div>
                    )}
                    <div className="tha-holdfoot">
                      Ending value {money(a.endingValue)} · realised {money(a.realisedPnl)}
                      {a.optionRealised !== 0 && <> · options {money(a.optionRealised)}</>}
                      {data.parsed.skippedCount > 0 && <> · {data.parsed.skippedCount} rows not recognised</>}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Best trades ────────────────────────────────────────────── */}
            <BestTrades trades={data.bestTrades ?? []} benchmark={m.benchmark} />
          </>
        )}
      </div>
    </PageWrapper>
  )
}

// ── Best trades ──────────────────────────────────────────────────────────────
// A trade is a position episode: from opening a name to closing it out, with
// every fill in between. Ranked by dollars, because a $40 position that doubled
// is a better story than the $4,000 one that actually moved the account.

function BestTrades({ trades, benchmark }: { trades: Trade[]; benchmark: string }) {
  const best = trades[0]?.pnl ?? 1
  // The tile is complete before this arrives and stays complete if it never
  // does, so the read is fetched after the page has already drawn.
  const [read, setRead] = useState<Record<string, string>>({})
  useEffect(() => {
    setRead({})
    if (!trades.length) return
    let live = true
    axios.post('/api/trade-history/explain', { trades })
      .then(r => { if (live) setRead(r.data?.notes ?? {}) })
      .catch(() => { /* a sentence is not worth an error */ })
    return () => { live = false }
  }, [trades])

  return (
    <div>
      <Strip label="Best trades" meta={[
        trades.length ? `top ${trades.length} by profit` : undefined,
        'return is measured against every dollar put in',
      ]} />
      <div className="tha-section">
        {!trades.length ? (
          <div style={{ padding: '10px 0 14px', fontFamily: MONO, fontSize: 11, color: T.muted }}>
            No position finished ahead over this period.
          </div>
        ) : (
          <div className="tha-trades">
            {trades.map((t, i) => (
              <div key={`${t.symbol}-${t.opened}`} className="tha-trade">
                <span className="tha-trade-rank">{i + 1}</span>
                <div className="tha-trade-name">
                  <span className="sym">{t.isOption && t.contract ? t.contract : t.symbol}</span>
                  {t.label && <span className="tha-kind">{t.label}</span>}
                </div>
                <div className="tha-trade-when">
                  {t.opened} → {t.closed ?? 'now'}
                  <i />
                  {t.heldDays === 0 ? 'same day' : `${t.heldDays} days`}
                </div>
                <div className="tha-trade-num">
                  <span>In</span><strong>{money(t.invested)}</strong>
                </div>
                <div className="tha-trade-num">
                  <span>Profit</span>
                  <strong style={{ color: T.pos }}>{money(t.pnl)}</strong>
                </div>
                <div className="tha-trade-num">
                  <span>Return</span>
                  <strong style={{ color: T.pos }}>{pct(t.returnPct)}</strong>
                </div>
                <div className="tha-trade-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(3, (t.pnl / best) * 100)}%` }} />
                </div>
                <div className="tha-trade-note">
                  {!!t.tags?.length && (
                    <div className="tha-trade-tags">
                      {t.tags.map(tag => <span key={tag} className="tha-tag">{tag}</span>)}
                    </div>
                  )}
                  <p>{tradeNote(t, benchmark)}</p>
                  {/* Tagged, because a measured sentence and a written one are
                      not the same kind of claim and the reader should be able
                      to tell which is which. */}
                  {read[String(i)] && (
                    <p className="tha-trade-read">
                      <span className="tha-tag">ai read</span>{read[String(i)]}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// What made it a good trade, in facts rather than adjectives. Every clause is
// read off the numbers, so nothing here is an opinion about the position.
function tradeNote(t: Trade, benchmark: string): string {
  const parts: string[] = []
  if (t.benchmarkPct != null) {
    const edge = t.returnPct - t.benchmarkPct
    parts.push(
      `${benchmark} returned ${pct(t.benchmarkPct)} over the same window, so you finished `
      + `${Math.abs(edge).toFixed(1)} points ${edge >= 0 ? 'ahead of' : 'behind'} the index.`,
    )
  }
  const dd = t.signals?.entryDrawdownPct
  if (dd != null && dd <= -8) {
    parts.push(`You started buying with the stock ${Math.abs(dd).toFixed(0)}% off its high.`)
  }
  const share = t.signals?.bestDayShare
  if (share != null && share >= 0.4) {
    parts.push(`One session produced ${Math.round(share * 100)}% of the move.`)
  }
  if (t.income > 0) parts.push(`${money(t.income)} of it was dividends.`)
  // Fills and open state are on the tag row above, so repeating them here would
  // just be the same row twice.
  parts.push(t.fills > 2
    ? `Built across ${t.fills} orders.`
    : 'One buy and one sell.')
  if (t.shareOfGainsPct != null) {
    parts.push(`${t.shareOfGainsPct}% of everything your winners made.`)
  }
  return parts.join(' ')
}

// ── Daily return against the benchmark ───────────────────────────────────────
// The page's only bespoke interaction. Click a day and its figures open, with
// the book that was held that day beside them.

function DailyReturn({ data, m, reg, pinned, onPin }: {
  data: Analysis; m: Metrics; reg: Regression
  pinned: string | null; onPin: (d: string | null) => void
}) {
  const points = reg.points ?? []
  const point = pinned ? points.find(p => p.d === pinned) : undefined
  const book = point?.d ? data.dailyBook?.[point.d] : undefined
  const maxAbs = book?.length ? Math.max(...book.map(b => Math.abs(b.pct))) : 1

  // Where every dot ended up on screen, filled in as they draw. Hit testing
  // against these beats per-dot handlers: 220 days overlap heavily, and a stack
  // of transparent targets hands the click to whichever drew last rather than
  // to the one under the cursor.
  const dots = useRef(new Map<string, { cx: number; cy: number }>())
  const place = useCallback((d: string, cx: number, cy: number) => {
    dots.current.set(d, { cx, cy })
  }, [])

  // Click the plot, get the nearest day within reach. Further out than that is
  // a click at nothing, which closes the card.
  const onPlotClick = useCallback((state: { chartX?: number; chartY?: number }) => {
    const { chartX, chartY } = state ?? {}
    if (chartX == null || chartY == null) return
    let nearest: string | null = null
    let best = Infinity
    dots.current.forEach((p, d) => {
      const dist = (p.cx - chartX) ** 2 + (p.cy - chartY) ** 2
      if (dist < best) { best = dist; nearest = d }
    })
    const within = nearest != null && best <= 26 ** 2
    onPin(within && nearest !== pinned ? nearest : null)
  }, [onPin, pinned])

  const beta = reg.beta ?? 0
  const implied = point ? beta * point.x : 0

  // The card sits in the corner furthest from the point rather than beside it.
  // Following the cursor put the card on top of the very dot it was explaining,
  // and near the axes it had nowhere to go: a scatter this dense has no free
  // space around a point, but it always has a free corner.
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const spanX = Math.max(...xs) - Math.min(...xs) || 1
  const spanY = Math.max(...ys) - Math.min(...ys) || 1
  const fx = point ? (point.x - Math.min(...xs)) / spanX : 0.5
  const fy = point ? 1 - (point.y - Math.min(...ys)) / spanY : 0.5

  // Bounded to the days that exist. Left to itself the axis rounded out to a
  // tidy 18% on the x and a symmetric 14% on the y, so a quarter of the plot
  // held no data and the cloud was pushed into one corner.
  const bounds = (vs: number[]): [number, number] => {
    const lo = Math.min(...vs), hi = Math.max(...vs)
    const pad = ((hi - lo) || 1) * 0.04
    return [lo - pad, hi + pad]
  }
  const fit = reg.line ?? []
  const xDomain = points.length ? bounds([...xs, ...fit.map(p => p.x)]) : undefined
  const yDomain = points.length ? bounds([...ys, ...fit.map(p => p.y)]) : undefined
  const corner: React.CSSProperties = {
    [fy < 0.5 ? 'bottom' : 'top']: 10,
    [fx < 0.5 ? 'right' : 'left']: 10,
  }

  return (
    <div>
      <Strip label={`Daily return against ${m.benchmark}`} meta={[
        `${reg.observations} days`,
        reg.sufficient ? `beta ${reg.beta?.toFixed(2)} · R² ${reg.rSquared?.toFixed(3)}` : undefined,
        reg.sufficient ? 'click a day' : undefined,
      ]} />
      <div className="tha-section">
        {!reg.sufficient ? (
          <div style={{ padding: '24px 0', fontFamily: MONO, fontSize: 11, color: T.muted }}>
            A regression needs at least 20 overlapping days.
          </div>
        ) : (
          <div className="tha-plot" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart margin={{ top: 8, right: 16, bottom: 26, left: 4 }}
                onClick={onPlotClick} style={{ cursor: 'pointer' }}>
                <CartesianGrid stroke={T.borderFaint} />
                <XAxis type="number" dataKey="x" name={m.benchmark} tick={axisTick}
                  domain={xDomain} tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  label={{
                    value: `${m.benchmark} daily excess return`, position: 'insideBottom',
                    offset: -14, fill: T.muted, fontFamily: MONO, fontSize: 10,
                  }} />
                <YAxis type="number" dataKey="y" name="Account" width={52} tick={axisTick}
                  domain={yDomain} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                <ReferenceLine x={0} stroke={T.border} />
                <ReferenceLine y={0} stroke={T.border} />
                {/* The fit is drawn under the points and takes no pointer
                    events: on top it swallowed the click for every day sitting
                    near the line, which is most of them. */}
                <Line data={reg.line ?? []} dataKey="y" stroke={T.gold} strokeWidth={1.8}
                  dot={false} isAnimationActive={false} legendType="none"
                  style={{ pointerEvents: 'none' }} />
                <Scatter data={points} isAnimationActive={false}
                  shape={<DayDot pinned={pinned} place={place} benchmark={m.benchmark} />} />
              </ComposedChart>
            </ResponsiveContainer>

            {point && (
              <div className="tha-daycard" style={corner}>
                <div className="tha-daycard-col">
                  <div className="tha-daycard-date">{point.d ?? '—'}</div>
                  <Line2 k="Account" v={pct(point.y)} c={tone(point.y)} />
                  <Line2 k={m.benchmark} v={pct(point.x)} c={tone(point.x)} />
                  <Line2 k="Excess" v={pct(point.y - point.x)} c={tone(point.y - point.x)} />
                  <div className="tha-daycard-rule" />
                  <Line2 k="Beta-implied" v={pct(implied)} />
                  <Line2 k="Residual" v={pct(point.y - implied)} c={tone(point.y - implied)} />
                  <div className="tha-daycard-hint">Click the day again to close</div>
                </div>

                {/* Always the second column, even with nothing to put in it. A
                    card that silently loses half its width reads as a bug, and
                    "no open positions" is itself the answer on a day the book
                    was in cash. */}
                <div className="tha-daycard-col">
                  <div className="tha-posrow tha-poshead">
                    <span>Positions</span><span /><span style={{ textAlign: 'right' }}>1D</span>
                  </div>
                  {!book?.length ? (
                    <div className="tha-daycard-none">
                      No open equity positions on this day. The move came from
                      cash, options or something the import did not recognise.
                    </div>
                  ) : (
                    book.map(b => {
                      const w = Math.max(2, (Math.abs(b.pct) / (maxAbs || 1)) * 50)
                      const up = b.pct >= 0
                      return (
                        <div key={b.symbol} className="tha-posrow">
                          <span className="sym">{b.symbol}</span>
                          <span className="tha-divbar">
                            <i style={{
                              left: up ? '50%' : `${50 - w}%`, right: up ? `${50 - w}%` : '50%',
                              background: up ? UP : DOWN,
                            }} />
                          </span>
                          <span className="val" style={{ color: tone(b.pct) }}>{pct(b.pct)}</span>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Draws one day and reports where it landed, so the plot can hit test against
// the real screen positions rather than guessing from an axis value.
function DayDot({ cx, cy, payload, pinned, place, benchmark }: {
  cx?: number; cy?: number; payload?: RegPoint
  pinned?: string | null; place?: (d: string, cx: number, cy: number) => void
  benchmark?: string
}) {
  if (cx == null || cy == null || !payload?.d) return null
  place?.(payload.d, cx, cy)
  const on = pinned === payload.d
  return (
    <g role="img"
      aria-label={`${payload.d} account ${pct(payload.y)}, ${benchmark ?? 'benchmark'} ${pct(payload.x)}`}>
      {on && <circle cx={cx} cy={cy} r={8} fill="none" stroke={T.gold} strokeOpacity={0.4} />}
      <circle cx={cx} cy={cy} r={on ? 4.5 : 3}
        fill={on ? T.gold : T.blue} fillOpacity={on ? 1 : 0.55} />
    </g>
  )
}

// ── Small parts ──────────────────────────────────────────────────────────────

const axisTick = { fontSize: 9, fill: T.muted, fontFamily: MONO }
const tipBox: React.CSSProperties = {
  background: T.surface, border: `1px solid ${T.border}`, borderRadius: 0,
  fontFamily: MONO, fontSize: 11, padding: '6px 9px', lineHeight: 1.6,
}
const tipLabel: React.CSSProperties = { color: T.muted, fontSize: 9, letterSpacing: '0.1em' }
const ghost: React.CSSProperties = {
  height: 32, padding: '0 10px', background: 'transparent', color: T.muted,
  border: `1px solid ${T.border}`, cursor: 'pointer',
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
}

function DrawdownTip({ active, payload, label }: {
  active?: boolean; payload?: { payload?: unknown }[]; label?: unknown
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload as DrawdownPoint | undefined
  if (!p) return null
  return (
    <div style={tipBox}>
      <div style={tipLabel}>{String(label ?? '')}</div>
      <div>Drawdown <span style={{ color: T.neg }}>{p.v.toFixed(2)}%</span></div>
      {p.equity != null && p.peak != null && (
        <div style={{ color: T.muted }}>Value {money(p.equity)} · peak {money(p.peak)}</div>
      )}
    </div>
  )
}

function MonthTip({ active, payload, label, benchmark, rank, total }: {
  active?: boolean; payload?: { payload?: unknown }[]; label?: unknown
  benchmark: string; rank: Map<string, number>; total: number
}) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload as MonthPoint | undefined
  if (!r) return null
  return (
    <div style={tipBox}>
      <div style={tipLabel}>{String(label ?? '')}</div>
      <div>Return <span style={{ color: tone(r.returnPct) }}>{pct(r.returnPct)}</span></div>
      <div style={{ color: T.muted }}>
        {r.benchmarkReturnPct != null ? `${benchmark} ${pct(r.benchmarkReturnPct)} · ` : ''}
        rank {rank.get(r.month)} of {total}
      </div>
    </div>
  )
}

function Line2({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div className="tha-daycard-row">
      <span>{k}</span><span style={c ? { color: c } : undefined}>{v}</span>
    </div>
  )
}

function Strip({ label, meta }: { label: string; meta?: (string | null | undefined)[] }) {
  const parts = (meta ?? []).filter(Boolean) as string[]
  return (
    <div className="tha-strip">
      <span>{label}</span>
      {parts.length > 0 && (
        <span className="tha-strip-meta">
          {parts.map((p, i) => (
            <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {i > 0 && <i />}{p}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

function Kpi({ label, value, color, sub, tip }: {
  label: string; value: string; color?: string; sub?: string
  tip?: { title: string; body: string }
}) {
  return (
    <div className="tha-kpi">
      <div className="tha-kpi-label">
        <span>{label}</span>
        {tip && <HelpTip title={tip.title} body={tip.body} />}
      </div>
      <div className="tha-kpi-value" style={{ color: color ?? T.text }}>{value}</div>
      {/* Always present, empty or not: the row has to exist for the subgrid to
          keep the five cells on one baseline. */}
      <div className="tha-kpi-sub">{sub ?? ''}</div>
    </div>
  )
}

function Stat({ k, v, c, tip }: {
  k: string; v: string; c?: string; tip?: { title: string; body: string }
}) {
  return (
    <div className="tha-stat">
      <span>{k}{tip && <HelpTip title={tip.title} body={tip.body} />}</span>
      <strong style={c ? { color: c } : undefined}>{v}</strong>
    </div>
  )
}
