import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection, MetricCard } from './valuationShared'

interface TermPoint { expiry: string; dte: number; atm_iv: number; rr_25: number; bf_25: number; smile: { moneyness: number; iv: number }[] }
interface SkewData {
  ticker: string; spot: number; front_expiry: string
  atm_iv: number; rr_25: number; bf_25: number; ts_slope: number
  term_structure: TermPoint[]
  front_smile: { moneyness: number; iv: number }[]
  read: string
}

const GOLD = 'var(--theme-primary, #c9a84c)'
const FAINT = 'var(--theme-text-faint, rgba(255,255,255,0.22))'

// Convert an annualized IV into the ±1σ move expected by a date: spot × IV × √(t).
function expectedMove(ivPct: number, dte: number, spot: number) {
  const sigma = (ivPct / 100) * Math.sqrt(Math.max(dte, 0) / 365)
  const dollars = spot * sigma
  return { pct: sigma * 100, dollars, lo: spot - dollars, hi: spot + dollars }
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
  const [expiry, setExpiry] = useState('')   // selected expiry — drives the smile, metrics, and move
  const { mutate, data, isPending, error } = useMutation<SkewData, Error, void>({
    mutationFn: () => axios.get(`/api/prob/skew?ticker=${ticker.trim().toUpperCase()}`).then(r => r.data),
    onSuccess: (d) => setExpiry(d.front_expiry),   // default to the nearest expiry
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
            {data && (
              <div>
                <label style={LABEL}>Expiry</label>
                <select value={expiry} onChange={e => setExpiry(e.target.value)} style={{ ...INPUT, cursor: 'pointer' }}>
                  {data.term_structure.map(t => (
                    <option key={t.expiry} value={t.expiry}>{t.expiry} · {t.dte}d</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </RailSection>
      }>
        {!data && !isPending && <EmptyState title="Vol Skew" hint="Enter a ticker and press Generate." />}
        {isPending && <EmptyState title="Loading skew surface…" hint="Solving the IV smile across expiries." />}
        {error && !isPending && <EmptyState title="No skew data" hint="Insufficient options data for this ticker." />}
        {data && (() => {
          const sel = data.term_structure.find(t => t.expiry === expiry) ?? data.term_structure[0]
          const em = expectedMove(sel.atm_iv, sel.dte, data.spot)
          // Default the term-structure x-axis to a realistic window around the
          // selected expiry instead of the full LEAPS range (which dwarfs it).
          const maxDte = Math.max(...data.term_structure.map(t => t.dte))
          const termXMax = Math.min(maxDte, Math.max(Math.round(sel.dte * 4), 120))
          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <MetricCard label="ATM IV (annualized)" value={`${sel.atm_iv.toFixed(1)}%`} sub={`${sel.expiry} · spot $${data.spot}`} help="The market's expected volatility for this expiry, annualized. Roughly 15-20% is calm, 30%+ is nervous." />
              <MetricCard label="Downside Premium" value={`${sel.rr_25 > 0 ? '+' : ''}${sel.rr_25.toFixed(1)}`} color={skewColor(sel.rr_25)} sub={sel.rr_25 > 4 ? 'high crash fear' : sel.rr_25 > 1.5 ? 'mild' : 'low'} help="How much more downside protection (puts) costs than upside (calls). Higher = more fear of a drop is priced in — and that's where put-selling premium is richest." />
              <MetricCard label="Tail Premium" value={`${sel.bf_25 > 0 ? '+' : ''}${sel.bf_25.toFixed(1)}`} sub={sel.bf_25 > 6 ? 'fat tails priced' : 'normal'} help="How expensive the far edges are vs the middle. Higher = the market is paying up for a big move in either direction." />
              <MetricCard label="Near vs Far Vol" value={`${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} color={data.ts_slope < -0.5 ? 'var(--theme-negative)' : GOLD} sub={data.ts_slope < -0.5 ? 'near-term jitters' : data.ts_slope > 0.5 ? 'normal/calm' : 'flat'} help="Near-term expected vol minus longer-dated. Negative = the market expects something soon (an event) and that usually settles back down. Positive = the normal calm shape." />
            </div>

            {/* Implied move for the selected expiry. */}
            <div style={{ background: 'var(--theme-surface, #142032)', border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`, padding: '14px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 22px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', width: '100%', marginBottom: 4 }}>
                Implied Move by {sel.expiry}
              </div>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 30, fontWeight: 700, color: GOLD }}>±{em.pct.toFixed(1)}%</div>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, color: 'var(--theme-text, #d7e3fc)' }}>${em.lo.toFixed(0)} – ${em.hi.toFixed(0)}</div>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: 'var(--theme-secondary, #99907e)' }}>
                {sel.dte} day{sel.dte === 1 ? '' : 's'} · IV {sel.atm_iv.toFixed(1)}% · ±{em.dollars.toFixed(2)}
              </div>
            </div>

            <ChartPanel label={`IV Smile — ${data.ticker} ${sel.expiry}`} height={300} note="IV vs % moneyness">
              <ResponsiveContainer width="100%" height={272}>
                <LineChart data={sel.smile} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
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
                  <XAxis dataKey="dte" tick={TICK} tickFormatter={(v: number) => `${v}d`} type="number" domain={[0, termXMax]} allowDataOverflow />
                  <YAxis tick={TICK} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, n: string) => [`${v.toFixed(1)}${n === 'atm_iv' ? '%' : ''}`, n === 'atm_iv' ? 'ATM IV' : 'Put Skew']} labelFormatter={(d) => `${d} DTE`} />
                  <Line type="monotone" dataKey="atm_iv" name="atm_iv" stroke={GOLD} strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="rr_25" name="rr_25" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>
          )
        })()}
      </SidebarLayout>
    </PageWrapper>
  )
}
