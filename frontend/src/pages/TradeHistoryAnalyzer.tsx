import { useCallback, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  ScatterChart, Scatter, ComposedChart,
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Cell,
} from 'recharts'
import { Upload, AlertTriangle } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import LoadingState from '../components/LoadingState'
import { T } from '../lib/theme'
import { MONO, SANS, Panel, KpiStrip } from './cockpitKit'

// Import a brokerage transaction export and measure what the account actually
// did. The statistics are computed server-side from a reconstructed equity
// curve; this page chooses the file, the broker and the account, then reads.

type Broker = 'auto' | 'fidelity' | 'robinhood'

interface Metrics {
  totalReturnPct: number; annualizedReturnPct: number; benchmarkReturnPct: number
  volPct: number; sharpe: number; sortino: number; calmar: number
  maxDrawdownPct: number; alphaPct: number; beta: number
  alphaJensenPct: number; alphaRegressionPct: number | null
  riskFreePct: number; benchmark: string
}
interface Regression {
  sufficient: boolean; observations: number
  beta?: number; alphaJensenPct?: number; alphaRegressionPct?: number
  tStat?: number; pValue?: number; rSquared?: number; significant?: boolean
  portfolioAnnPct?: number; benchmarkAnnPct?: number
  points?: { x: number; y: number }[]
  line?: { x: number; y: number }[]
}
interface Account {
  startDate: string; endDate: string; ledgerStartDate?: string; days: number
  endingValue: number; netContributions: number; netGain: number
  realisedPnl: number; optionRealised: number; tradeCount: number; symbols: string[]
}
interface Point { d: string; v: number }
interface Analysis {
  metrics: Metrics
  account: Account
  series: { equity: Point[]; drawdown: Point[]; benchmark: Point[] }
  regression: Regression
  allocation: { symbol: string; value: number; weightPct: number }[]
  monthly: { month: string; returnPct: number }[]
  caveats: string[]
  returnMethod: string
  source: string
  accounts: string[]
  parsed: { transactions: number; skippedCount: number; skipped: string[] }
}

const BROKERS: { id: Broker; label: string; hint: string }[] = [
  { id: 'auto', label: 'Detect', hint: 'Read the broker from the file header' },
  { id: 'fidelity', label: 'Fidelity', hint: 'Accounts > History > Download' },
  { id: 'robinhood', label: 'Robinhood', hint: 'Account > Statements > Reports' },
]

const money = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`

export default function TradeHistoryAnalyzer() {
  const [broker, setBroker] = useState<Broker>('auto')
  const [file, setFile] = useState<File | null>(null)
  const [accounts, setAccounts] = useState<string[]>([])
  const [account, setAccount] = useState('')
  const [benchmark, setBenchmark] = useState('SPY')
  const [data, setData] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
    setBusy(true); setError(''); setData(null)
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

  const curve = useMemo(() => {
    if (!data) return []
    const bench = new Map(data.series.benchmark.map(p => [p.d, p.v]))
    return data.series.equity.map(p => ({ d: p.d, equity: p.v, benchmark: bench.get(p.d) ?? null }))
  }, [data])

  const m = data?.metrics
  const a = data?.account

  return (
    <PageWrapper title="Trade History Analyzer"
      meta={<span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted }}>
        Import a Fidelity or Robinhood export and measure what the account actually did
      </span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        <Panel label="Import">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 18, padding: 12 }}>
            <Field label="Broker">
              <div style={{ display: 'flex' }}>
                {BROKERS.map(b => (
                  <button key={b.id} onClick={() => setBroker(b.id)} title={b.hint}
                    style={{
                      fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                      textTransform: 'uppercase', padding: '7px 13px', cursor: 'pointer',
                      background: broker === b.id ? T.gold : 'transparent',
                      color: broker === b.id ? T.bg : T.muted,
                      border: `1px solid ${broker === b.id ? T.gold : T.border}`,
                    }}>{b.label}</button>
                ))}
              </div>
            </Field>

            <Field label="File">
              <input ref={inputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                onChange={e => onPick(e.target.files?.[0] ?? null)} />
              <button onClick={() => inputRef.current?.click()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 11,
                  padding: '7px 13px', background: 'transparent', color: T.text,
                  border: `1px solid ${T.border}`, cursor: 'pointer', maxWidth: 320,
                }}>
                <Upload size={13} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file ? file.name : 'Choose a CSV export'}
                </span>
              </button>
            </Field>

            {accounts.length > 1 && (
              <Field label="Account">
                <select value={account} onChange={e => setAccount(e.target.value)}
                  style={{ fontFamily: MONO, fontSize: 11, padding: '7px 9px', background: T.bg, color: T.text, border: `1px solid ${T.border}` }}>
                  <option value="">All accounts</option>
                  {accounts.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </Field>
            )}

            <Field label="Benchmark">
              <input value={benchmark} onChange={e => setBenchmark(e.target.value)}
                style={{ fontFamily: MONO, fontSize: 11, padding: '7px 9px', width: 78, background: T.bg, color: T.text, border: `1px solid ${T.border}` }} />
            </Field>

            <button onClick={run} disabled={!file || busy}
              style={{
                fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', padding: '9px 20px',
                background: file && !busy ? T.gold : 'transparent',
                color: file && !busy ? T.bg : T.muted,
                border: `1px solid ${file && !busy ? T.gold : T.border}`,
                cursor: file && !busy ? 'pointer' : 'default',
              }}>{busy ? 'Analyzing' : 'Analyze'}</button>
          </div>

          <div style={{ padding: '0 12px 12px', fontFamily: MONO, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            Nothing is stored. The file is parsed, measured and discarded inside the request.
            Returns are time-weighted, so contributions and transfers are removed rather than
            counted as gains.
          </div>
        </Panel>

        {error && (
          <div role="alert" style={{ display: 'flex', gap: 9, border: `1px solid ${T.neg}`, color: T.neg, fontFamily: MONO, fontSize: 11, padding: '10px 12px', lineHeight: 1.5 }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        {busy && <LoadingState label="Rebuilding the equity curve from the ledger" />}

        {data && m && a && (
          <>
            <KpiStrip cells={[
              { label: 'Total return', value: pct(m.totalReturnPct), vc: m.totalReturnPct >= 0 ? T.pos : T.neg,
                sub: `${m.benchmark} ${pct(m.benchmarkReturnPct)}` },
              { label: 'Max drawdown', value: `${m.maxDrawdownPct.toFixed(2)}%`, vc: T.neg,
                sub: `over ${a.days} days` },
              { label: 'Sharpe', value: m.sharpe.toFixed(2), sub: `vol ${m.volPct.toFixed(1)}%` },
              { label: 'Sortino', value: m.sortino.toFixed(2), sub: `calmar ${m.calmar.toFixed(2)}` },
              { label: 'Alpha (Jensen)', value: pct(m.alphaJensenPct), vc: m.alphaJensenPct >= 0 ? T.pos : T.neg,
                sub: `beta ${m.beta.toFixed(2)}` },
              { label: 'Alpha (regression)',
                value: m.alphaRegressionPct == null ? '—' : pct(m.alphaRegressionPct),
                vc: (m.alphaRegressionPct ?? 0) >= 0 ? T.pos : T.neg,
                sub: data.regression.sufficient
                  ? `t ${data.regression.tStat?.toFixed(2)} · ${data.regression.significant ? 'significant' : 'not significant'}`
                  : 'too few days' },
              { label: 'Net gain', value: money(a.netGain), vc: a.netGain >= 0 ? T.pos : T.neg,
                sub: `on ${money(a.netContributions)} in` },
            ]} />

            <Panel label="Account value" meta={
              <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>
                {a.startDate} to {a.endDate} · {data.source} · {a.tradeCount} trades · {data.returnMethod}
              </span>
            }>
              <div style={{ height: 300, padding: '10px 8px 4px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curve}>
                    <defs>
                      <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.gold} stopOpacity={0.30} />
                        <stop offset="100%" stopColor={T.gold} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={T.borderFaint} vertical={false} />
                    <XAxis dataKey="d" tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }} minTickGap={44} />
                    <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }} width={62}
                      tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`} />
                    <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 11 }}
                      formatter={(v: number, n: string) => [money(v), n === 'equity' ? 'Account' : m.benchmark]} />
                    <Legend wrapperStyle={{ fontFamily: MONO, fontSize: 10 }} />
                    <Area name="Account" type="monotone" dataKey="equity" stroke={T.gold} fill="url(#eq)" strokeWidth={1.8} dot={false} />
                    <Line name={m.benchmark} type="monotone" dataKey="benchmark" stroke={T.muted}
                      strokeWidth={1.2} strokeDasharray="4 3" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
              <Panel label="Drawdown">
                <div style={{ height: 210, padding: '10px 8px 4px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.series.drawdown}>
                      <CartesianGrid stroke={T.borderFaint} vertical={false} />
                      <XAxis dataKey="d" tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }} minTickGap={44} />
                      <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }} width={46}
                        tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                      <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 11 }}
                        formatter={(v: number) => [`${v.toFixed(2)}%`, 'Drawdown']} />
                      <Area type="monotone" dataKey="v" stroke={T.neg} fill={T.neg} fillOpacity={0.16} strokeWidth={1.4} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Panel>

              <Panel label="Monthly return">
                <div style={{ height: 210, padding: '10px 8px 4px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.monthly}>
                      <CartesianGrid stroke={T.borderFaint} vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }} />
                      <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }} width={46}
                        tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                      <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 11 }}
                        formatter={(v: number) => [`${v.toFixed(2)}%`, 'Return']} />
                      <ReferenceLine y={0} stroke={T.border} />
                      <Bar dataKey="returnPct">
                        {data.monthly.map(r => (
                          <Cell key={r.month} fill={r.returnPct >= 0 ? T.pos : T.neg} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            </div>

            <Panel label={`Daily return against ${m.benchmark}`} meta={
              data.regression.sufficient ? (
                <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>
                  {data.regression.observations} days · beta {data.regression.beta?.toFixed(2)} ·
                  R² {data.regression.rSquared?.toFixed(3)} ·
                  alpha {pct(data.regression.alphaRegressionPct ?? 0)} (t {data.regression.tStat?.toFixed(2)},
                  p {data.regression.pValue?.toFixed(3)})
                </span>
              ) : (
                <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>
                  {data.regression.observations} overlapping days, too few to fit
                </span>
              )
            }>
              {data.regression.sufficient ? (
                <>
                  <div style={{ height: 320, padding: '10px 8px 4px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart margin={{ top: 8, right: 16, bottom: 26, left: 4 }}>
                        <CartesianGrid stroke={T.borderFaint} />
                        <XAxis type="number" dataKey="x" name={m.benchmark}
                          tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }}
                          tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                          label={{ value: `${m.benchmark} daily excess return`, position: 'insideBottom',
                                   offset: -14, fill: T.muted, fontFamily: MONO, fontSize: 10 }} />
                        <YAxis type="number" dataKey="y" name="Account" width={52}
                          tick={{ fontSize: 9, fill: T.muted, fontFamily: MONO }}
                          tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                        <ZAxis range={[26, 26]} />
                        <ReferenceLine x={0} stroke={T.border} />
                        <ReferenceLine y={0} stroke={T.border} />
                        <Tooltip cursor={{ strokeDasharray: '3 3' }}
                          contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 11 }}
                          formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]} />
                        <Scatter name="Daily" data={data.regression.points ?? []} fill={T.blue} fillOpacity={0.55} />
                        <Line name="Fit" data={data.regression.line ?? []} dataKey="y" stroke={T.gold}
                          strokeWidth={1.8} dot={false} isAnimationActive={false} legendType="none" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ padding: '2px 12px 12px', fontFamily: MONO, fontSize: 10, color: T.muted, lineHeight: 1.65 }}>
                    Each point is one day: {m.benchmark}&apos;s excess return across, the account&apos;s up.
                    The slope is beta, the intercept is alpha.
                    {' '}
                    <strong style={{ color: T.text }}>Jensen {pct(m.alphaJensenPct)}</strong> applies CAPM to the
                    compounded returns; <strong style={{ color: T.text }}>regression {pct(m.alphaRegressionPct ?? 0)}</strong>
                    {' '}is the intercept of this fit and carries a standard error, so it can be tested.
                    {' '}
                    {data.regression.significant
                      ? `At p ${data.regression.pValue?.toFixed(3)} this alpha is distinguishable from zero.`
                      : `At p ${data.regression.pValue?.toFixed(3)} this alpha is not distinguishable from zero: on ${data.regression.observations} days a gap this size is what noise looks like.`}
                  </div>
                </>
              ) : (
                <div style={{ padding: 14, fontFamily: MONO, fontSize: 11, color: T.muted }}>
                  A regression needs at least 20 overlapping days.
                </div>
              )}
            </Panel>

            <Panel label="Holdings at the end of the period">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                <thead>
                  <tr>
                    {['Symbol', 'Value', 'Weight'].map((h, i) => (
                      <th key={h} style={{
                        padding: '7px 12px', textAlign: i ? 'right' : 'left', color: T.muted,
                        fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.allocation.map(h => (
                    <tr key={h.symbol}>
                      <td style={{ padding: '6px 12px', color: T.text, borderBottom: `1px solid ${T.borderFaint}` }}>{h.symbol}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: T.text, borderBottom: `1px solid ${T.borderFaint}` }}>{money(h.value)}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted, borderBottom: `1px solid ${T.borderFaint}` }}>{h.weightPct.toFixed(1)}%</td>
                    </tr>
                  ))}
                  {data.allocation.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: '12px', color: T.muted }}>No open positions at the end of the period.</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ padding: '9px 12px', fontFamily: MONO, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
                Ending value {money(a.endingValue)} · realised {money(a.realisedPnl)}
                {a.optionRealised !== 0 && <> · options {money(a.optionRealised)}</>}
                {data.parsed.skippedCount > 0 && <> · {data.parsed.skippedCount} row(s) not recognised</>}
              </div>
            </Panel>
          </>
        )}
      </div>
    </PageWrapper>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>{label}</span>
      {children}
    </div>
  )
}
