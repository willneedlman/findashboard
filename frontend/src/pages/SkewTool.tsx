import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

interface TermPoint { expiry: string; dte: number; atm_iv: number; rr_25: number; bf_25: number }
interface SkewData {
  ticker: string; spot: number; front_expiry: string
  atm_iv: number; rr_25: number; bf_25: number; ts_slope: number
  term_structure: TermPoint[]
  front_smile: { moneyness: number; iv: number }[]
  read: string
}

const GOLD = 'var(--theme-primary, #c9a84c)'
const FAINT = 'var(--theme-text-faint, rgba(255,255,255,0.22))'

function MetricCard({ label, value, help, sub, color }: { label: string; value: string; help?: string; sub?: string; color?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ background: 'var(--theme-surface, #142032)', border: '1px solid var(--theme-border, rgba(255,255,255,0.07))', borderTop: `3px solid ${color ?? GOLD}`, padding: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>{label}</span>
        {help && <span style={{ fontSize: 10, color: FAINT, cursor: 'help' }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>ⓘ</span>}
        {show && help && (
          <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6, background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', padding: '6px 8px', width: 190, fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '15px', zIndex: 50, pointerEvents: 'none' }}>{help}</div>
        )}
      </div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: color ?? 'var(--theme-text, #d7e3fc)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: FAINT, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function ChartPanel({ label, height, note, children }: { label: string; height: number; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>{label}</div>
      {note && <div style={{ position: 'absolute', top: 0, right: 0, padding: '3px 8px', fontSize: 10, color: FAINT, letterSpacing: '0.06em', zIndex: 10 }}>{note}</div>}
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

export default function SkewTool() {
  const [ticker, setTicker] = useState('SPY')
  const [open, setOpen] = useState(true)
  const { mutate, data, isPending, error } = useMutation<SkewData, Error, void>({
    mutationFn: () => axios.get(`/api/prob/skew?ticker=${ticker.trim().toUpperCase()}`).then(r => r.data),
  })
  const skewColor = (v: number) => (v > 4 ? 'var(--theme-negative)' : v > 1.5 ? 'var(--theme-warn, #d97736)' : 'var(--theme-positive)')

  return (
    <PageWrapper title="Vol Skew & Term Structure" subtitle="Where premium-selling edge lives: put/call skew, wing convexity, and the IV term structure across expiries.">
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={
        <RailSection title="Parameters" open={open} onToggle={() => setOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={LABEL}>Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && mutate()} style={INPUT} />
            </div>
            <button onClick={() => mutate()} disabled={isPending}
              style={{ width: '100%', background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1 }}>
              {isPending ? 'Loading…' : 'Generate'}
            </button>
            <div style={{ fontSize: 10, color: FAINT, lineHeight: '14px' }}>
              25Δ-style skew read off a smoothed IV smile. Positive risk reversal = puts richer than calls (downside fear). Indices skew steeper than single names.
            </div>
            <div style={{ fontSize: 9, color: FAINT, lineHeight: '13px', marginTop: 4 }}>
              Trial · EOD chains via yfinance; intraday precision improves on live (Tradier) data.
            </div>
          </div>
        </RailSection>
      }>
        {!data && !isPending && <EmptyState title="Vol Skew" hint="Enter a ticker and press Generate." />}
        {isPending && <EmptyState title="Loading skew surface…" hint="Solving the IV smile across expiries." />}
        {error && !isPending && <EmptyState title="No skew data" hint="Insufficient options data for this ticker." />}
        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <MetricCard label="ATM IV" value={`${data.atm_iv.toFixed(1)}%`} sub={`${data.front_expiry} · spot $${data.spot}`} help="At-the-money implied vol for the front expiry." />
              <MetricCard label="Put Skew (10%)" value={`${data.rr_25 > 0 ? '+' : ''}${data.rr_25.toFixed(1)}`} color={skewColor(data.rr_25)} sub="vol pts, 10% P−C" help="IV of the 10%-OTM put minus 10%-OTM call. Positive = downside richly bid; the put wing is where selling edge concentrates." />
              <MetricCard label="Butterfly (10%)" value={`${data.bf_25 > 0 ? '+' : ''}${data.bf_25.toFixed(1)}`} sub="wing convexity" help="Average wing IV minus ATM IV. High = both tails bid (fat-tail premium)." />
              <MetricCard label="Term Slope" value={`${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} color={data.ts_slope < -0.5 ? 'var(--theme-negative)' : GOLD} sub="front→back ATM" help="Back-month ATM IV minus front. Positive = contango (normal). Negative = backwardation (front-end stress, often mean-reverts)." />
            </div>

            <div style={{ background: 'var(--theme-surface, #142032)', border: '1px solid var(--theme-border, rgba(255,255,255,0.07))', borderLeft: `3px solid ${skewColor(data.rr_25)}`, padding: '10px 12px', fontSize: 12, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.55 }}>
              {data.read}
            </div>

            <ChartPanel label={`IV Smile — ${data.ticker} ${data.front_expiry}`} height={300} note="IV vs % moneyness">
              <ResponsiveContainer width="100%" height={272}>
                <LineChart data={data.front_smile} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.08)" />
                  <XAxis dataKey="moneyness" tick={TICK} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}%`} type="number" domain={['dataMin', 'dataMax']} />
                  <YAxis tick={TICK} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v.toFixed(1)}%`, 'IV']} labelFormatter={(m) => `${Number(m) > 0 ? '+' : ''}${m}% moneyness`} />
                  <ReferenceLine x={0} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)" strokeDasharray="4 4" label={{ value: 'ATM', fill: GOLD, fontSize: 9, position: 'insideTopRight' }} />
                  <Line type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel label="ATM IV Term Structure" height={260} note="ATM IV vs days to expiry">
              <ResponsiveContainer width="100%" height={232}>
                <LineChart data={data.term_structure} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.08)" />
                  <XAxis dataKey="dte" tick={TICK} tickFormatter={(v: number) => `${v}d`} type="number" domain={['dataMin', 'dataMax']} />
                  <YAxis tick={TICK} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, n: string) => [`${v.toFixed(1)}${n === 'atm_iv' ? '%' : ''}`, n === 'atm_iv' ? 'ATM IV' : 'Put Skew']} labelFormatter={(d) => `${d} DTE`} />
                  <Line type="monotone" dataKey="atm_iv" name="atm_iv" stroke={GOLD} strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="rr_25" name="rr_25" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}
