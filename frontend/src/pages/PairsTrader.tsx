import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import TickerLink from '../components/TickerLink'
import { KpiCell } from '../components/mmCockpit'
import { INPUT, LABEL, SIDEBAR } from './valuationShared'
import { fetchPairsAnalysis } from '../hooks/useApi'
import { T } from '../lib/theme'

interface Resp {
  a: string; b: string; hedge_ratio: number; correlation: number | null
  adf: { stat: number | null; crit_5: number; stationary: boolean }
  half_life_days: number | null
  zscore: { current: number | null; entry: number; exit: number; window: number }
  signal: 'long_spread' | 'short_spread' | 'flat'
  backtest: { sharpe: number | null; total_spread_return: number; trades: number; win_rate: number | null; exposure_pct: number }
  series: { date: string; z: number | null }[]
  observations: number; lookback_days: number; source: string
}

const STRIP: React.CSSProperties = { display: 'flex', alignItems: 'stretch', overflowX: 'auto', background: T.surface, border: `1px solid ${T.border}` }
const LOOKBACKS: [string, number][] = [['1Y', 365], ['2Y', 730], ['3Y', 1095]]
const SIG_LABEL = { long_spread: 'Long spread', short_spread: 'Short spread', flat: 'In range' }

export default function PairsTrader() {
  const [a, setA] = useState('XOM')
  const [b, setB] = useState('CVX')
  const [lookback, setLookback] = useState(730)
  const [entryZ, setEntryZ] = useState('2')
  const [exitZ, setExitZ] = useState('0.5')
  const [zWindow, setZWindow] = useState('60')

  const m = useMutation<Resp>({
    mutationFn: () => fetchPairsAnalysis({
      a: a.trim().toUpperCase(), b: b.trim().toUpperCase(),
      lookback_days: lookback, entry_z: Number(entryZ) || 2, exit_z: Number(exitZ) || 0.5, z_window: Number(zWindow) || 60,
    }),
  })

  const rail = (
    <div style={SIDEBAR}>
      <div>
        <span style={LABEL}>Pair</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={a} onChange={e => setA(e.target.value.toUpperCase())} placeholder="A" style={{ ...INPUT }} />
          <input value={b} onChange={e => setB(e.target.value.toUpperCase())} placeholder="B" style={{ ...INPUT }} />
        </div>
        <p style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 5, lineHeight: 1.5 }}>Spread is log({a || 'A'}) minus the hedge ratio times log({b || 'B'}).</p>
      </div>
      <div>
        <span style={LABEL}>Window</span>
        <div style={{ display: 'flex', gap: 5 }}>
          {LOOKBACKS.map(([lbl, d]) => (
            <button key={d} onClick={() => setLookback(d)} style={{ flex: 1, padding: '5px 0', fontFamily: T.mono, fontSize: 10, cursor: 'pointer', background: lookback === d ? T.goldTint(14) : 'transparent', color: lookback === d ? T.gold : T.muted, border: `1px solid ${lookback === d ? T.gold : T.border}` }}>{lbl}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><span style={LABEL}>Entry z</span><input value={entryZ} onChange={e => setEntryZ(e.target.value)} inputMode="decimal" style={INPUT} /></div>
        <div style={{ flex: 1 }}><span style={LABEL}>Exit z</span><input value={exitZ} onChange={e => setExitZ(e.target.value)} inputMode="decimal" style={INPUT} /></div>
        <div style={{ flex: 1 }}><span style={LABEL}>z window</span><input value={zWindow} onChange={e => setZWindow(e.target.value)} inputMode="numeric" style={INPUT} /></div>
      </div>
      <button onClick={() => m.mutate()} disabled={m.isPending}
        style={{ padding: '9px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: m.isPending ? 'wait' : 'pointer', background: T.gold, color: T.bg, border: 'none' }}>
        {m.isPending ? 'Testing' : 'Test pair'}
      </button>
    </div>
  )

  return (
    <PageWrapper title="Pairs Trader">
      <SidebarLayout sidebar={rail} sidebarTitle="Pair">
        {m.isPending ? (
          <LoadingState label="Testing cointegration and backtesting the spread" />
        ) : m.error ? (
          <ErrorState message={(m.error as any)?.response?.data?.detail || 'Could not analyze this pair.'} onRetry={() => m.mutate()} />
        ) : m.data ? (
          <Results d={m.data} />
        ) : (
          <EmptyState title="Trade the spread, not the direction."
            hint="Test two names for cointegration, measure the mean-reversion half-life, and backtest a z-score entry. Enter a pair and run."
            keys={['Cointegration', 'Half-life', 'Z-score backtest']} />
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}

function Results({ d }: { d: Resp }) {
  const z = d.zscore
  const long = d.signal === 'long_spread'
  const short = d.signal === 'short_spread'
  const sigColor = d.signal === 'flat' ? T.muted : T.gold
  const cointColor = d.adf.stationary ? T.pos : T.warn

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={STRIP}>
        <KpiCell label="Correlation" value={d.correlation != null ? d.correlation.toFixed(2) : '—'} align="top" />
        <KpiCell label="Cointegration" value={d.adf.stationary ? 'Yes' : 'Weak'} sub={d.adf.stat != null ? `ADF ${d.adf.stat}` : undefined} color={cointColor} align="top" />
        <KpiCell label="Half-life" value={d.half_life_days != null ? `${d.half_life_days}d` : '—'} sub="mean reversion" align="top" />
        <KpiCell label="Current z" value={z.current != null ? z.current.toFixed(2) : '—'} color={z.current != null && Math.abs(z.current) >= z.entry ? T.gold : T.text} sub={SIG_LABEL[d.signal]} subColor={sigColor} align="top" />
        <KpiCell label="Backtest Sharpe" value={d.backtest.sharpe != null ? d.backtest.sharpe.toFixed(2) : '—'} color={(d.backtest.sharpe ?? 0) > 0 ? T.pos : T.neg} sub={`${d.backtest.trades} trades`} align="top" grow />
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: T.gold }}>SPREAD Z-SCORE</span>
          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{z.window}-day window · {d.observations} days · {d.source}</span>
        </div>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={d.series} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke={T.borderFaint} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: T.muted, fontFamily: 'var(--theme-mono)' }} minTickGap={60} />
              <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: 'var(--theme-mono)' }} domain={[-4, 4]} />
              <Tooltip contentStyle={{ background: T.bg, border: `1px solid ${T.border}`, fontFamily: 'var(--theme-mono)', fontSize: 11 }} labelStyle={{ color: T.muted }} />
              <ReferenceLine y={0} stroke={T.border} />
              <ReferenceLine y={z.entry} stroke={T.gold} strokeDasharray="4 3" />
              <ReferenceLine y={-z.entry} stroke={T.gold} strokeDasharray="4 3" />
              <ReferenceLine y={z.exit} stroke={T.borderFaint} strokeDasharray="2 4" />
              <ReferenceLine y={-z.exit} stroke={T.borderFaint} strokeDasharray="2 4" />
              <Line type="monotone" dataKey="z" stroke={T.blue} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: T.gold }}>Z-SCORE BACKTEST</span>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: T.mono, fontSize: 12 }}>
            {([['Sharpe', d.backtest.sharpe != null ? d.backtest.sharpe.toFixed(2) : '—'],
               ['Spread return', `${(d.backtest.total_spread_return * 100).toFixed(1)}%`],
               ['Trades', String(d.backtest.trades)],
               ['Win rate', d.backtest.win_rate != null ? `${d.backtest.win_rate}%` : '—'],
               ['Time in market', `${d.backtest.exposure_pct}%`]] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: T.muted }}>{k}</span><span style={{ color: T.text, fontWeight: 700 }}>{v}</span>
              </div>
            ))}
          </div>
          <p style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>Enters below -{z.entry}, exits inside {z.exit}, rolling z-window to limit lookahead. Hedge ratio is full-sample (illustrative).</p>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: T.gold }}>SUGGESTED LEGS</span>
          {d.signal === 'flat' ? (
            <p style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 12, lineHeight: 1.6 }}>Z is inside the entry band ({z.current != null ? z.current.toFixed(2) : '—'}). No pair entry right now. A signal fires when |z| reaches {z.entry}.</p>
          ) : (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: T.mono, fontSize: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: long ? T.pos : T.neg, fontWeight: 700, width: 46 }}>{long ? 'LONG' : 'SHORT'}</span>
                <TickerLink ticker={d.a} style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }} />
                <span style={{ marginLeft: 'auto', color: T.muted }}>1.00</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: long ? T.neg : T.pos, fontWeight: 700, width: 46 }}>{long ? 'SHORT' : 'LONG'}</span>
                <TickerLink ticker={d.b} style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }} />
                <span style={{ marginLeft: 'auto', color: T.muted }}>{d.hedge_ratio.toFixed(2)}</span>
              </div>
              <Link to="/paper-trading" style={{ marginTop: 4, textAlign: 'center', padding: '7px 0', fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, textDecoration: 'none' }}>
                Open in Paper Trading →
              </Link>
            </div>
          )}
          <p style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>Ratio is {d.b} units per 1 unit {d.a}, dollar-balanced at the hedge ratio.</p>
        </div>
      </div>
    </div>
  )
}
