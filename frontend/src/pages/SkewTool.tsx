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

// Convert an annualized IV into the ±1σ move expected by a date: spot × IV × √(t).
function expectedMove(ivPct: number, dte: number, spot: number) {
  const sigma = (ivPct / 100) * Math.sqrt(Math.max(dte, 0) / 365)
  const dollars = spot * sigma
  return { pct: sigma * 100, dollars, lo: spot - dollars, hi: spot + dollars }
}

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
  const [guideOpen, setGuideOpen] = useState(false)
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
              {(() => {
                const em = expectedMove(data.atm_iv, data.term_structure[0]?.dte ?? 0, data.spot)
                return <MetricCard label="Expected Move" value={`±${em.pct.toFixed(1)}%`} sub={`by ${data.front_expiry} · $${em.lo.toFixed(0)}–$${em.hi.toFixed(0)}`} help={`The ±1σ move the options market implies by ${data.front_expiry} — the stock stays in this range about 68% of the time. From ${data.atm_iv.toFixed(1)}% annualized IV scaled to this expiry. Annualized "expected swing" still shown in the table below.`} />
              })()}
              <MetricCard label="Downside Premium" value={`${data.rr_25 > 0 ? '+' : ''}${data.rr_25.toFixed(1)}`} color={skewColor(data.rr_25)} sub={data.rr_25 > 4 ? 'high crash fear' : data.rr_25 > 1.5 ? 'mild' : 'low'} help="How much more downside protection (puts) costs than upside (calls). Higher = more fear of a drop is priced in — and that's where put-selling premium is richest." />
              <MetricCard label="Tail Premium" value={`${data.bf_25 > 0 ? '+' : ''}${data.bf_25.toFixed(1)}`} sub={data.bf_25 > 6 ? 'fat tails priced' : 'normal'} help="How expensive the far edges are vs the middle. Higher = the market is paying up for a big move in either direction." />
              <MetricCard label="Near vs Far Vol" value={`${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} color={data.ts_slope < -0.5 ? 'var(--theme-negative)' : GOLD} sub={data.ts_slope < -0.5 ? 'near-term jitters' : data.ts_slope > 0.5 ? 'normal/calm' : 'flat'} help="Near-term expected vol minus longer-dated. Negative = the market expects something soon (an event) and that usually settles back down. Positive = the normal calm shape." />
            </div>

            {/* Implied move by date — the annualized IV converted to an actual ±move per expiry. */}
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                Implied Move by Date — {data.ticker} @ ${data.spot}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: 'var(--theme-surface, #142032)' }}>
                    {['Expiry', 'Days', '± Move', 'Expected Range', 'IV (annualized)'].map((h, i) => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: i === 0 ? 'left' : 'right', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.term_structure.map((t, i) => {
                    const em = expectedMove(t.atm_iv, t.dte, data.spot)
                    return (
                      <tr key={t.expiry} style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))', background: i % 2 ? 'var(--theme-hover, rgba(255,255,255,0.012))' : 'transparent' }}>
                        <td style={{ padding: '6px 10px', color: GOLD }}>{t.expiry}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--theme-secondary, #99907e)' }}>{t.dte}d</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)', fontWeight: 700 }}>±{em.pct.toFixed(1)}%</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }}>${em.lo.toFixed(0)} – ${em.hi.toFixed(0)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--theme-secondary, #99907e)' }}>{t.atm_iv.toFixed(1)}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div style={{ padding: '6px 10px', fontSize: 10, color: FAINT, lineHeight: 1.5 }}>
                ± Move is the 1-standard-deviation range (spot × IV × √(days÷365)) — the stock stays inside it roughly 68% of the time. Double it for a ~95% range.
              </div>
            </div>

            {/* Plain-language read of the current data */}
            <div style={{ fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.55, padding: '2px 2px' }}>
              {data.read}
            </div>

            {/* Collapsible learn-it guide */}
            <div style={{ border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-bg, #0a1628)' }}>
              <button onClick={() => setGuideOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: '9px 12px', color: GOLD, fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                <span style={{ transform: guideOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
                New here? How to read this
              </button>
              {guideOpen && (
                <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.6 }}>
                  {[
                    ['What this tool shows', 'Options on the same stock cost different amounts depending on the strike price and the expiry date. The "cost" is measured as implied volatility (IV) — the bigger move the option is pricing in. This tool maps that cost across strikes and dates, so you can see what the market is afraid of and where options look rich or cheap.'],
                    ['The smile chart (top)', 'Each point is the IV at a price level relative to today (0% = where it trades now). It dips in the middle and rises on the sides. The LEFT side (downside puts) sitting higher than the right (upside calls) means people pay more to protect against a fall than to bet on a rise. The steeper that left climb, the more crash fear is priced in.'],
                    ['The term-structure chart (bottom)', 'The gold line is the at-the-money IV for each expiry date; the dotted blue line is the downside premium at each date. Normally the gold line rises with time (more uncertainty further out). If the near-term (left) is higher, the market expects something soon — earnings, a Fed meeting — and that bump usually fades.'],
                    ['How you might use it', 'Selling options collects premium; the richest premium is wherever IV is highest. Steep downside premium means out-of-the-money puts pay the most — but that is also exactly where your risk is if the stock drops. When near-term vol is elevated, shorter-dated options decay that extra premium fastest. This is a read on what is expensive, not a buy/sell signal.'],
                  ].map(([h, body]) => (
                    <div key={h}>
                      <div style={{ color: GOLD, fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', marginBottom: 3 }}>{h}</div>
                      <div style={{ color: 'var(--theme-secondary, #99907e)' }}>{body}</div>
                    </div>
                  ))}
                </div>
              )}
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
            <div style={{ fontSize: 11, color: 'var(--theme-secondary, #99907e)', lineHeight: 1.5, marginTop: -4, paddingLeft: 2 }}>
              Reading it: the line climbs to the left, so downside protection (puts) costs more than upside (calls). The lowest point is roughly where the market expects the stock to trade.
            </div>

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
            <div style={{ fontSize: 11, color: 'var(--theme-secondary, #99907e)', lineHeight: 1.5, marginTop: -4, paddingLeft: 2 }}>
              Reading it: <span style={{ color: GOLD }}>gold</span> = expected vol at each expiry date, <span style={{ color: 'var(--theme-tertiary, #60a5fa)' }}>blue dashed</span> = downside premium at each. A higher near-term (left) gold line hints at an expected near-term event that usually settles down.
            </div>
          </div>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}
