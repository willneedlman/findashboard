import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import { Widget, KpiCell } from '../components/mmCockpit'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

interface TermPoint { expiry: string; dte: number; atm_iv: number; rr_25: number; bf_25: number; smile: { moneyness: number; iv: number }[] }
interface SkewData {
  ticker: string; spot: number; front_expiry: string
  atm_iv: number; rr_25: number; bf_25: number; ts_slope: number
  term_structure: TermPoint[]
  front_smile: { moneyness: number; iv: number }[]
  read: string
}

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const NEG = 'var(--theme-negative)'
const FAINT = 'var(--theme-text-faint, rgba(255,255,255,0.4))'
const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

// Convert an annualized IV into the ±1σ move expected by a date: spot × IV × √(t).
function expectedMove(ivPct: number, dte: number, spot: number) {
  const sigma = (ivPct / 100) * Math.sqrt(Math.max(dte, 0) / 365)
  const dollars = spot * sigma
  return { pct: sigma * 100, dollars, lo: spot - dollars, hi: spot + dollars }
}

const caption = (text: string) => <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--theme-secondary, #8099b0)' }}>{text}</span>

export default function SkewTool() {
  const [ticker, setTicker] = useState('SPY')
  const [open, setOpen] = useState(true)
  const [expiry, setExpiry] = useState('')   // selected expiry — drives the smile, metrics, and move
  const { mutate, data, isPending, error } = useMutation<SkewData, Error, void>({
    mutationFn: () => axios.get(`/api/prob/skew?ticker=${ticker.trim().toUpperCase()}`).then(r => r.data),
    onSuccess: (d) => setExpiry(d.front_expiry),   // default to the nearest expiry
  })
  const skewColor = (v: number) => (v > 4 ? NEG : v > 1.5 ? 'var(--theme-warn, #d97736)' : 'var(--theme-positive)')

  return (
    <PageWrapper title="Volatility Skew">
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
        {!data && !isPending && <EmptyState title="Volatility Skew" hint="Enter a ticker and press Generate. Reads the IV smile, term structure, and crash-fear skew." />}
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
          <>
            {/* Answer-first skew strip */}
            <div style={STRIP}>
              <KpiCell grow minWidth={165} label="Downside Skew · 25Δ RR" value={`${sel.rr_25 > 0 ? '+' : ''}${sel.rr_25.toFixed(1)}`} valueSize={16}
                color={skewColor(sel.rr_25)} sub={sel.rr_25 > 4 ? 'high crash fear' : sel.rr_25 > 1.5 ? 'mild fear' : 'low fear'} />
              <KpiCell grow label="ATM IV" value={`${sel.atm_iv.toFixed(1)}%`} color={BLUE} sub={sel.expiry} />
              <KpiCell grow label="Implied Move" value={`±${em.pct.toFixed(1)}%`} color={GOLD} sub={`$${em.lo.toFixed(0)}–$${em.hi.toFixed(0)}`} />
              <KpiCell grow label="Tail Premium · 25Δ BF" value={`${sel.bf_25 > 0 ? '+' : ''}${sel.bf_25.toFixed(1)}`} sub={sel.bf_25 > 6 ? 'fat tails priced' : 'normal'} />
              <KpiCell grow label="Near vs Far Vol" value={`${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} color={data.ts_slope < -0.5 ? NEG : undefined} sub={data.ts_slope < -0.5 ? 'near-term jitters' : data.ts_slope > 0.5 ? 'calm shape' : 'flat'} />
              <KpiCell grow label="Spot" value={`$${data.spot}`} sub={`${sel.dte}d to expiry`} />
            </div>

            {data.read && (
              <div style={{ fontSize: 10, color: FAINT, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', lineHeight: 1.5 }}>{data.read}</div>
            )}

            <Widget title={`IV Smile — ${data.ticker} ${sel.expiry}`} right={caption('IV vs % moneyness')} bodyStyle={{ padding: '8px' }}>
              <ResponsiveContainer width="100%" height={272}>
                <LineChart data={sel.smile} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                  <XAxis dataKey="moneyness" tick={TICK} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}%`} type="number" domain={['dataMin', 'dataMax']} />
                  <YAxis tick={TICK} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v.toFixed(1)}%`, 'IV']} labelFormatter={(mny) => `${Number(mny) > 0 ? '+' : ''}${mny}% moneyness`} />
                  <ReferenceLine x={0} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)" strokeDasharray="4 4" label={{ value: 'ATM', fill: GOLD, fontSize: 9, position: 'insideTopRight' }} />
                  <Line type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Widget>

            <Widget title="ATM IV Term Structure" right={caption('ATM IV + put skew vs DTE')} bodyStyle={{ padding: '8px' }}>
              <ResponsiveContainer width="100%" height={232}>
                <LineChart data={data.term_structure} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                  <XAxis dataKey="dte" tick={TICK} tickFormatter={(v: number) => `${v}d`} type="number" domain={[0, termXMax]} allowDataOverflow />
                  <YAxis tick={TICK} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, n: string) => [`${v.toFixed(1)}${n === 'atm_iv' ? '%' : ''}`, n === 'atm_iv' ? 'ATM IV' : 'Put Skew']} labelFormatter={(d) => `${d} DTE`} />
                  <ReferenceLine x={sel.dte} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)" strokeDasharray="3 4" label={{ value: 'selected', fill: GOLD, fontSize: 9 }} />
                  <Line type="monotone" dataKey="atm_iv" name="atm_iv" stroke={GOLD} strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="rr_25" name="rr_25" stroke={BLUE} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Widget>
          </>
          )
        })()}
      </SidebarLayout>
    </PageWrapper>
  )
}
