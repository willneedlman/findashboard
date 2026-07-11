import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, ReferenceDot,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import { Widget, KpiCell } from '../components/mmCockpit'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

interface SmilePoint { moneyness: number; iv: number }
interface TermPoint { expiry: string; dte: number; atm_iv: number; rr_25: number; bf_25: number; smile: SmilePoint[] }
interface SkewData {
  ticker: string; spot: number; front_expiry: string
  atm_iv: number; rr_25: number; bf_25: number; ts_slope: number
  term_structure: TermPoint[]
  front_smile: SmilePoint[]
  read: string
}

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const NEG = 'var(--theme-negative)'
const POS = 'var(--theme-positive)'
const BODY = 'var(--theme-text, #d7e3fc)'
const SEC = 'var(--theme-secondary, #8099b0)'
const FAINT = 'var(--theme-text-faint, #5e768f)'
const SANS = 'var(--theme-sans, "Sora", sans-serif)'
const MONO = 'var(--theme-mono, ui-monospace, monospace)'
const HAIR = 'rgba(255,255,255,0.06)'
const SURFACE = 'var(--theme-surface, #0d1826)'
const SMILE_FILL = 'rgba(201,168,76,0.10)'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: SURFACE, border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  borderTop: `2px solid ${GOLD}`,
}

// Convert an annualized IV into the ±1σ move expected by a date: spot × IV × √(t).
function expectedMove(ivPct: number, dte: number, spot: number) {
  const sigma = (ivPct / 100) * Math.sqrt(Math.max(dte, 0) / 365)
  const dollars = spot * sigma
  return { pct: sigma * 100, dollars, lo: spot - dollars, hi: spot + dollars }
}

// Linear interpolation of IV at a given % from spot, clamped to the smile's domain.
function ivAt(smile: SmilePoint[], m: number): number {
  if (!smile.length) return 0
  if (m <= smile[0].moneyness) return smile[0].iv
  const last = smile[smile.length - 1]
  if (m >= last.moneyness) return last.iv
  for (let i = 1; i < smile.length; i++) {
    if (m <= smile[i].moneyness) {
      const a = smile[i - 1], b = smile[i]
      const t = (m - a.moneyness) / ((b.moneyness - a.moneyness) || 1)
      return a.iv + t * (b.iv - a.iv)
    }
  }
  return last.iv
}

const caption = (text: string) => <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.06em', color: SEC }}>{text}</span>

export function SkewToolContent() {
  const [sp] = useSearchParams()
  const [ticker, setTicker] = useState((sp.get('ticker') || 'SPY').toUpperCase())
  const [open, setOpen] = useState(true)
  const [expiry, setExpiry] = useState('')   // selected expiry — drives the smile, metrics, and move
  const [mny, setMny] = useState(0)          // Smile Explorer cursor (% from spot)
  // Query (not mutation) so regenerating the same ticker within the 15-min
  // staleTime serves from the react-query cache. Arriving with ?ticker= (e.g.
  // from the command palette) starts submitted, replacing the old auto-mutate.
  const [submitted, setSubmitted] = useState((sp.get('ticker') ?? '').trim().toUpperCase())
  // Same-route ?ticker= navigations change only the search string — no
  // remount, so sync from the URL when it changes.
  useEffect(() => {
    const t = (sp.get('ticker') ?? '').trim().toUpperCase()
    if (t && t !== submitted) { setTicker(t); setSubmitted(t) }
  }, [sp])  // eslint-disable-line react-hooks/exhaustive-deps
  const { data, isFetching: isPending, error, refetch } = useQuery<SkewData, Error>({
    queryKey: ['skew', submitted],
    enabled: !!submitted,
    queryFn: () => axios.get(`/api/prob/skew?ticker=${submitted}`).then(r => r.data),
  })
  // Same ticker → force a refetch (setSubmitted with an identical string is a
  // React bail-out: no re-render, no request, stuck error states).
  const generate = () => {
    const next = ticker.trim().toUpperCase()
    if (!next) return
    if (next === submitted) refetch()
    else setSubmitted(next)
  }
  const skewColor = (v: number) => (v > 4 ? NEG : v > 1.5 ? 'var(--theme-warn, #d97736)' : POS)

  // Default to the nearest expiry whenever a new skew surface lands.
  useEffect(() => { if (data) setExpiry(data.front_expiry) }, [data])

  const sel = data ? (data.term_structure.find(t => t.expiry === expiry) ?? data.term_structure[0]) : null

  // Reset the explorer to ATM whenever the selected smile changes.
  useEffect(() => { setMny(0) }, [expiry, data])

  return (
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={
        <RailSection title="Parameters" open={open} onToggle={() => setOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={LABEL}>Target Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && generate()} style={INPUT} />
            </div>
            <button onClick={generate} disabled={isPending}
              style={{ width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: `1px solid ${GOLD}`, color: GOLD, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1 }}>
              {isPending ? 'Loading…' : 'Generate'}
            </button>
            {data && sel && (
              <div>
                <label style={LABEL}>Expiry</label>
                <select value={expiry} onChange={e => setExpiry(e.target.value)} style={{ ...INPUT, cursor: 'pointer' }}>
                  {data.term_structure.map(t => (
                    <option key={t.expiry} value={t.expiry}>{t.expiry} · {t.dte}d</option>
                  ))}
                </select>
              </div>
            )}
            {data && sel && (() => {
              const dip = Math.min(...sel.smile.map(s => s.iv)) - sel.atm_iv
              const rows: [string, string, string][] = [
                ['Skew slope', sel.rr_25 > 0.5 ? 'put-rich' : sel.rr_25 < -0.5 ? 'call-rich' : 'flat', sel.rr_25 > 0.5 ? NEG : sel.rr_25 < -0.5 ? POS : BODY],
                ['Term shape', data.ts_slope > 0.5 ? 'contango' : data.ts_slope < -0.5 ? 'backwardation' : 'flat', data.ts_slope > 0.5 ? POS : data.ts_slope < -0.5 ? NEG : BODY],
                ['Front dip', `${dip > 0 ? '+' : ''}${dip.toFixed(1)} pts`, BLUE],
              ]
              return (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: SEC, fontFamily: SANS, marginBottom: 7 }}>Shape Read</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {rows.map(([k, v, c]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 10, color: SEC, fontFamily: SANS }}>{k}</span>
                        <span style={{ fontSize: 11, fontFamily: MONO, fontWeight: 700, color: c }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>
        </RailSection>
      }>
        {!data && !isPending && <EmptyState title="Volatility Skew" hint="Enter a ticker and press Generate. Reads the IV skew across strikes, term structure, and crash-fear tails."
          keys={['Enter']} kpis={['ATM IV', '25d Skew', 'Term Slope', 'Put Skew', 'Call Skew']}
          preview="chart" previewLabel="IV Skew by Strike" />}
        {isPending && <EmptyState title="Loading skew surface…" hint="Solving the IV skew across expiries." />}
        {error && !isPending && <EmptyState title="No skew data" hint="Insufficient options data for this ticker." />}
        {data && sel && (() => {
          const em = expectedMove(sel.atm_iv, sel.dte, data.spot)
          const maxDte = Math.max(...data.term_structure.map(t => t.dte))
          const termXMax = Math.min(maxDte, Math.max(Math.round(sel.dte * 4), 120))

          // Smile Explorer derived values (clamped to the smile domain).
          const mnyMin = sel.smile[0]?.moneyness ?? -8
          const mnyMax = sel.smile[sel.smile.length - 1]?.moneyness ?? 15
          const cur = Math.max(mnyMin, Math.min(mnyMax, mny))
          const curIv = ivAt(sel.smile, cur)
          const curStrike = data.spot * (1 + cur / 100)
          const vsAtm = curIv - sel.atm_iv
          const toStrike = curStrike - data.spot

          const readout: [string, string, string][] = [
            ['% From Spot', `${cur > 0 ? '+' : ''}${cur.toFixed(1)}%`, GOLD],
            ['Strike', `$${curStrike.toFixed(2)}`, BODY],
            ['Implied Vol', `${curIv.toFixed(1)}%`, BLUE],
            ['vs ATM IV', `${vsAtm >= 0 ? '+' : ''}${vsAtm.toFixed(1)} pts`, vsAtm >= 0 ? NEG : POS],
            ['To Strike', `${toStrike >= 0 ? '+' : ''}$${Math.abs(toStrike).toFixed(2)}`, BODY],
          ]

          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Answer-first skew strip */}
            <div style={STRIP}>
              <KpiCell grow align="top" minWidth={170} label="Downside Skew · 25Δ RR" value={`${sel.rr_25 > 0 ? '+' : ''}${sel.rr_25.toFixed(1)}`} valueSize={21}
                color={skewColor(sel.rr_25)} />
              <KpiCell grow align="top" minWidth={120} label="ATM IV" value={`${sel.atm_iv.toFixed(1)}%`} valueSize={21} color={BLUE} sub={sel.expiry} />
              <KpiCell grow align="top" minWidth={130} label="Implied Move" value={`±${em.pct.toFixed(1)}%`} valueSize={21} color={GOLD} sub={`$${em.lo.toFixed(0)}–$${em.hi.toFixed(0)}`} />
              <KpiCell grow align="top" minWidth={150} label="Tail Premium · 25Δ BF" value={`${sel.bf_25 > 0 ? '+' : ''}${sel.bf_25.toFixed(1)}`} valueSize={21} />
              <KpiCell grow align="top" minWidth={130} label="Near vs Far Vol" value={`${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} valueSize={21} color={data.ts_slope > 0.5 ? POS : data.ts_slope < -0.5 ? NEG : undefined} />
              <KpiCell grow align="top" minWidth={110} label="Spot" value={`$${data.spot}`} valueSize={21} sub={`${sel.dte}d to expiry`} />
            </div>

            {/* IV Smile */}
            <Widget title={`IV Skew — ${data.ticker} ${sel.expiry}`} right={caption('IV vs % from spot')} bodyStyle={{ padding: '8px' }}>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={sel.smile} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                  <XAxis dataKey="moneyness" tick={TICK} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}%`} type="number" domain={['dataMin', 'dataMax']} />
                  <YAxis tick={TICK} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v.toFixed(1)}%`, 'IV']} labelFormatter={(m) => `${Number(m) > 0 ? '+' : ''}${m}% from spot`} />
                  <ReferenceLine x={0} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)" strokeDasharray="4 4" label={{ value: 'ATM', fill: GOLD, fontSize: 9, position: 'insideTopRight' }} />
                  <ReferenceLine x={cur} stroke={BODY} strokeOpacity={0.7} strokeDasharray="4 3" />
                  <Area type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={2.2} fill={SMILE_FILL} dot={false} isAnimationActive={false} />
                  <ReferenceDot x={cur} y={curIv} r={4.5} fill={GOLD} stroke="#0a1320" strokeWidth={1.5} isFront />
                </AreaChart>
              </ResponsiveContainer>
            </Widget>

            {/* Smile Explorer */}
            <div style={{ background: SURFACE, border: '1px solid rgba(201,168,76,0.3)', padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: GOLD, fontFamily: SANS }}>Skew Explorer</span>
              </div>
              <div>
                <input type="range" min={mnyMin} max={mnyMax} step={0.1} value={cur} onChange={e => setMny(+e.target.value)}
                  style={{ width: '100%', accentColor: 'var(--theme-primary, #c9a84c)', cursor: 'pointer' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                  <span style={{ fontSize: 9, fontFamily: MONO, color: SEC }}>{mnyMin}%</span>
                  <span style={{ fontSize: 9, fontFamily: MONO, color: SEC }}>+{mnyMax}%</span>
                </div>
              </div>
              <div style={{ display: 'flex', border: `1px solid ${HAIR}` }}>
                {readout.map(([k, v, c], i) => (
                  <div key={k} style={{ flex: 1, minWidth: 0, padding: '8px 11px', borderRight: i < readout.length - 1 ? `1px solid ${HAIR}` : 'none' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: SEC, fontFamily: SANS, marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</div>
                    <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Section divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0' }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: FAINT, fontFamily: SANS }}>Term Structure &amp; Skew Decay</span>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
            </div>

            {/* ATM IV Term Structure */}
            <Widget title="ATM IV Term Structure" right={caption('ATM IV (L) · 25Δ skew (R) vs DTE')} bodyStyle={{ padding: '8px' }}>
              <ResponsiveContainer width="100%" height={238}>
                <LineChart data={data.term_structure} margin={{ top: 18, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                  <XAxis dataKey="dte" tick={TICK} tickFormatter={(v: number) => `${v}d`} type="number" domain={[0, termXMax]} allowDataOverflow />
                  <YAxis yAxisId="iv" orientation="left" tick={{ ...TICK, fill: GOLD }} tickFormatter={(v: number) => `${v}%`} width={42} domain={['auto', 'auto']} />
                  <YAxis yAxisId="rr" orientation="right" tick={{ ...TICK, fill: BLUE }} tickFormatter={(v: number) => v.toFixed(0)} width={34} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, n: string) => [`${v.toFixed(1)}${n === 'atm_iv' ? '%' : ' pts'}`, n === 'atm_iv' ? 'ATM IV' : '25Δ Put Skew']} labelFormatter={(d) => `${d} DTE`} />
                  <ReferenceLine yAxisId="iv" x={sel.dte} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 50%, transparent)" strokeDasharray="3 4" label={{ value: 'selected', fill: GOLD, fontSize: 9, position: 'top' }} />
                  <Line yAxisId="iv" type="monotone" dataKey="atm_iv" name="atm_iv" stroke={GOLD} strokeWidth={2.2} dot={{ r: 2.6 }} isAnimationActive={false} />
                  <Line yAxisId="rr" type="monotone" dataKey="rr_25" name="rr_25" stroke={BLUE} strokeWidth={1.6} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 18, paddingTop: 4 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: SEC, fontFamily: SANS }}>
                  <span style={{ width: 14, height: 2, background: GOLD }} /> ATM IV
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: SEC, fontFamily: SANS }}>
                  <span style={{ width: 14, height: 0, borderTop: `2px dashed ${BLUE}` }} /> 25Δ Put Skew
                </span>
              </div>
            </Widget>
          </div>
          )
        })()}
      </SidebarLayout>
  )
}

export default function SkewTool() {
  return <PageWrapper title="Volatility Skew"><SkewToolContent /></PageWrapper>
}
