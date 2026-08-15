import { T } from '../lib/theme'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine, Cell,
} from 'recharts'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import PageWrapper from '../components/PageWrapper'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, chartClip } from '../lib/reportCaptureRegistry'

const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #8099b0)', fontFamily: 'var(--theme-mono)' }
const FED_TARGET = 2.0

type Pt = { d: string; v: number }
type SpfResponse = { available: boolean; forecasts?: { key: string; label: string; description: string; unit: string; median: number; horizon: string }[]; horizon?: string; survey_period?: string; forecast_period?: string; source: string }
type EconData = {
  unemployment: { value: number | null; prev: number | null; date: string | null; trend: Pt[] }
  payrolls:     { value: number | null; date: string | null; trend: Pt[] }
  inflation: {
    cpi: number | null; core: number | null; pce: number | null; date: string | null
    trend: { d: string; cpi: number | null; core: number | null; pce: number | null }[]
  }
}

function fmtMonth(d: string | null) {
  if (!d) return '—'
  const dt = new Date(d + (d.length === 7 ? '-01' : '') + 'T00:00:00')
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'pos' | 'neg' | 'warn' }) {
  const color = tone === 'pos' ? T.pos : tone === 'neg' ? T.neg : tone === 'warn' ? T.gold : T.text
  return (
    <div style={{ flex: 1, padding: '14px 18px', borderRight: `1px solid ${T.border}` }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontFamily: T.label, fontSize: 10, color: T.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.surface }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.gold }}>{title}</span>
        {note && <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>{note}</span>}
      </div>
      <div style={{ padding: '12px 8px 8px' }}>{children}</div>
    </div>
  )
}

interface CycleComponent {
  key: string; label: string; value: number; unit: string
  as_of: string; score: number; reading: string; rule: string
}
interface Cycle {
  available: boolean; reason?: string
  composite: number; phase: string; blurb: string
  components: CycleComponent[]; resolved: number; expected: number
  weakest: string; strongest: string
}

// Where the cycle stands, from the series this page already plots.
//
// Deliberately not a recession probability. A single percentage implies a
// calibrated model, and there isn't one here: this is five well-known
// indicators scored against published rules of thumb. So the panel shows every
// component, its level and the threshold it is being judged against, and the
// composite is just their mean. A reader who disagrees with a component can see
// exactly which one to discount.
function CyclePanel() {
  const { data } = useQuery<Cycle>({
    queryKey: ['macro-cycle'],
    queryFn: () => axios.get('/api/rates/cycle').then(r => r.data),
    staleTime: 60 * 60_000,
    retry: 0,
  })
  if (!data?.available) return null

  const tone = (score: number) => (score >= 0.35 ? T.pos : score <= -0.35 ? T.neg : T.warn)
  const phaseColor = tone(data.composite)
  // The composite runs -1 to +1; place it on a 0-100 track for the marker.
  const pos = ((data.composite + 1) / 2) * 100

  return (
    <Panel title="Cycle Position" note={`${data.resolved} of ${data.expected} indicators reporting`}>
      <div style={{ padding: '4px 8px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontFamily: T.label, fontSize: 17, fontWeight: 700, color: phaseColor }}>{data.phase}</span>
          <span style={{ fontFamily: T.label, fontSize: 11.5, color: T.muted, lineHeight: 1.5, flex: 1, minWidth: 220 }}>{data.blurb}</span>
        </div>

        <div style={{ position: 'relative', height: 4, background: T.borderFaint, marginBottom: 6 }}>
          <div style={{ position: 'absolute', inset: 0, left: '50%', width: 1, background: T.muted }} />
          <div style={{ position: 'absolute', top: -4, left: `${Math.max(0, Math.min(100, pos))}%`, width: 2, height: 12, background: phaseColor, transform: 'translateX(-1px)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.label, fontSize: 9.5, color: T.muted, marginBottom: 14 }}>
          <span>Contraction</span><span>Neutral</span><span>Expansion</span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
            <tbody>
              {data.components.map(c => (
                <tr key={c.key} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                  <td style={{ fontFamily: T.label, fontSize: 11, color: T.text, padding: '7px 10px 7px 0', whiteSpace: 'nowrap' }}>{c.label}</td>
                  <td style={{ fontFamily: T.mono, fontSize: 11.5, fontWeight: 700, color: T.text, padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {c.value}{c.unit ? ` ${c.unit}` : ''}
                  </td>
                  <td style={{ fontFamily: T.mono, fontSize: 10, color: tone(c.score), padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>{c.reading}</td>
                  <td style={{ padding: '7px 0 7px 10px', width: 90 }}>
                    <div style={{ position: 'relative', height: 4, background: T.borderFaint }}>
                      <div style={{ position: 'absolute', inset: 0, left: '50%', width: 1, background: T.muted }} />
                      <div style={{
                        position: 'absolute', top: 0, height: 4, background: tone(c.score),
                        left: c.score >= 0 ? '50%' : `${50 + c.score * 50}%`,
                        width: `${Math.abs(c.score) * 50}%`,
                      }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.borderFaint}`, fontFamily: T.label, fontSize: 10.5, lineHeight: 1.6, color: T.muted }}>
          {data.components.map(c => `${c.label}: ${c.rule}`).join(' ')}
          {' '}The composite is the mean of the components above, not a fitted probability, and no recession odds
          are claimed from it.
        </div>
      </div>
    </Panel>
  )
}

export function EconomyMonitorContent() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['rates-economy'],
    queryFn:  () => axios.get('/api/rates/economy').then(r => r.data as EconData),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const { data: spf } = useQuery<SpfResponse>({
    queryKey: ['spf-forecasts'],
    queryFn: () => axios.get('/api/official/spf').then(r => r.data),
    staleTime: 24 * 3_600_000,
    retry: 1,
  })

  const TAB = 'Macro Monitor'
  useReportCapture(() => {
    if (!data) return null
    const { unemployment: u, payrolls: p, inflation: inf } = data
    const pieces: ClipDraft[] = [
      kpiClip(TAB, 'Macro Pulse', [
        { label: 'Unemployment', value: u.value != null ? `${u.value.toFixed(1)}%` : '—', sub: fmtMonth(u.date) },
        { label: 'Payrolls (MoM)', value: p.value != null ? `${p.value >= 0 ? '+' : ''}${Math.round(p.value)}K` : '—', sub: fmtMonth(p.date) },
        { label: 'CPI (YoY)', value: inf.cpi != null ? `${inf.cpi.toFixed(1)}%` : '—', sub: fmtMonth(inf.date) },
        { label: 'Core CPI (YoY)', value: inf.core != null ? `${inf.core.toFixed(1)}%` : '—' },
        { label: 'PCE (YoY)', value: inf.pce != null ? `${inf.pce.toFixed(1)}%` : '—' },
      ]),
    ]
    if (inf.trend?.length) {
      pieces.push(chartClip(TAB, 'Inflation — Year over Year', 'line', 'd',
        inf.trend.map(t => ({ d: t.d, cpi: t.cpi, core: t.core, pce: t.pce })),
        [
          { key: 'cpi', label: 'CPI' },
          { key: 'core', label: 'Core CPI' },
          { key: 'pce', label: 'PCE' },
        ],
      ))
    }
    if (u.trend?.length) {
      pieces.push(chartClip(TAB, 'Unemployment Rate', 'area', 'd',
        u.trend.map(t => ({ d: t.d, v: t.v })),
        [{ key: 'v', label: 'Unemployment' }],
      ))
    }
    if (p.trend?.length) {
      pieces.push(chartClip(TAB, 'Nonfarm Payrolls', 'bar', 'd',
        p.trend.map(t => ({ d: t.d, v: t.v })),
        [{ key: 'v', label: 'Payrolls (K)' }],
      ))
    }
    if (spf?.available && spf.forecasts?.length) {
      pieces.push(kpiClip(TAB, 'SPF Professional Forecasts',
        spf.forecasts.map(f => ({ label: f.label, value: `${f.median.toFixed(1)}%` })),
      ))
    }
    return pieces
  }, { disabled: !data, sourceTab: TAB })

  if (isLoading) {
    return <div style={{ padding: 40, textAlign: 'center', fontFamily: T.mono, fontSize: 11, color: T.muted }}>Loading economic data…</div>
  }
  if (error || !data) {
    return <div style={{ padding: 40, textAlign: 'center', fontFamily: T.mono, fontSize: 11, color: T.neg }}>Could not load economic data. The FRED feed may be unavailable.</div>
  }

  const { unemployment: u, payrolls: p, inflation: inf } = data
  const unChange = u.value != null && u.prev != null ? +(u.value - u.prev).toFixed(1) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stat strip */}
      <div style={{ display: 'flex', border: `1px solid ${T.border}`, background: T.surface, flexWrap: 'wrap' }}>
        <Stat label="Unemployment" value={u.value != null ? `${u.value.toFixed(1)}%` : '—'}
          sub={unChange != null ? `${unChange > 0 ? '+' : ''}${unChange} pp vs prior · ${fmtMonth(u.date)}` : fmtMonth(u.date)}
          tone={unChange == null ? undefined : unChange > 0 ? 'neg' : unChange < 0 ? 'pos' : undefined} />
        <Stat label="Payrolls (MoM)" value={p.value != null ? `${p.value >= 0 ? '+' : ''}${Math.round(p.value)}K` : '—'}
          sub={`Nonfarm · ${fmtMonth(p.date)}`} tone={p.value == null ? undefined : p.value >= 0 ? 'pos' : 'neg'} />
        <Stat label="CPI (YoY)" value={inf.cpi != null ? `${inf.cpi.toFixed(1)}%` : '—'}
          sub={`Headline · ${fmtMonth(inf.date)}`} tone={inf.cpi == null ? undefined : inf.cpi > FED_TARGET ? 'warn' : 'pos'} />
        <Stat label="Core CPI (YoY)" value={inf.core != null ? `${inf.core.toFixed(1)}%` : '—'}
          sub="Ex food & energy" tone={inf.core == null ? undefined : inf.core > FED_TARGET ? 'warn' : 'pos'} />
        <Stat label="PCE (YoY)" value={inf.pce != null ? `${inf.pce.toFixed(1)}%` : '—'}
          sub="Fed's preferred gauge" tone={inf.pce == null ? undefined : inf.pce > FED_TARGET ? 'warn' : 'pos'} />
      </div>

      <CyclePanel />

      {/* Inflation — multi-line vs 2% target */}
      <Panel title="Inflation. Year over Year" note="Fed target 2%">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={inf.trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke={T.border} vertical={false} />
            <XAxis dataKey="d" tick={TICK} minTickGap={28} />
            <YAxis tick={TICK} width={38} tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number, n: string) => [v != null ? `${v.toFixed(1)}%` : '—', n]} />
            <Legend wrapperStyle={{ fontFamily: T.mono, fontSize: 10 }} />
            <ReferenceLine y={FED_TARGET} stroke={T.muted} strokeDasharray="5 4" />
            <Line isAnimationActive={false} type="monotone" dataKey="cpi"  name="CPI"      stroke={T.gold} strokeWidth={2} dot={false} />
            <Line isAnimationActive={false} type="monotone" dataKey="core" name="Core CPI" stroke={T.blue} strokeWidth={2} dot={false} />
            <Line isAnimationActive={false} type="monotone" dataKey="pce"  name="PCE"      stroke={T.pos}  strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      {/* Unemployment + payrolls side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Panel title="Unemployment Rate" note="24-month">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={u.trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="unFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={T.gold} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={T.gold} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke={T.border} vertical={false} />
              <XAxis dataKey="d" tick={TICK} minTickGap={28} />
              <YAxis tick={TICK} width={38} domain={['auto', 'auto']} tickFormatter={(v) => `${v}%`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Unemployment']} />
              <Area isAnimationActive={false} type="monotone" dataKey="v" stroke={T.gold} strokeWidth={2} fill="url(#unFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Nonfarm Payrolls" note="MoM change, thousands">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={p.trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke={T.border} vertical={false} />
              <XAxis dataKey="d" tick={TICK} minTickGap={28} />
              <YAxis tick={TICK} width={38} tickFormatter={(v) => `${v}K`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={BAR_CURSOR} formatter={(v: number) => [`${v >= 0 ? '+' : ''}${Math.round(v)}K`, 'Payrolls']} />
              <ReferenceLine y={0} stroke={T.muted} />
              <Bar isAnimationActive={false} dataKey="v" radius={[2, 2, 0, 0]}>
                {p.trend.map((pt, i) => <Cell key={i} fill={pt.v >= 0 ? T.pos : T.neg} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {spf?.available && <Panel title="Professional Forecast Baseline" note={`Philadelphia Fed SPF · ${spf.horizon ?? 'annualized % change'}`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', margin: '-12px -8px -8px' }}>
          {(spf.forecasts ?? []).map((forecast, index) => <div key={forecast.key} style={{ minHeight: 62, padding: '13px 16px', borderRight: index === (spf.forecasts?.length ?? 0) - 1 ? 'none' : `1px solid ${T.border}`, borderTop: `1px solid ${T.borderFaint}` }}>
            <div style={{ fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>{forecast.label}</div>
            <div style={{ marginTop: 7, fontFamily: T.mono, fontSize: 20, fontWeight: 700, lineHeight: 1, color: T.blue, fontVariantNumeric: 'tabular-nums' }}>{forecast.median.toFixed(1)}%</div>
          </div>)}
        </div>
        <div style={{ padding: '9px 8px 1px', fontFamily: T.mono, fontSize: 8.5, lineHeight: 1.45, color: T.textDim }}>Latest survey: {spf.survey_period ?? 'latest quarter'} · Forecast period: {spf.forecast_period ?? 'four quarters ahead'}. Annualized % change expresses the pace that a quarter's change would imply if sustained for a full year. These are forecasts, not observed releases.</div>
      </Panel>}

      <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, textAlign: 'right' }}>
        Source: FRED (St. Louis Fed) · UNRATE, PAYEMS, CPIAUCSL, CPILFESL, PCEPI
      </div>
    </div>
  )
}

export default function EconomyMonitor() {
  return <PageWrapper title="Macro Monitor"><EconomyMonitorContent /></PageWrapper>
}
