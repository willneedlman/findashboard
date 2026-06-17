import { T } from '../lib/theme'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine, Cell,
} from 'recharts'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import PageWrapper from '../components/PageWrapper'

const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-mono)' }
const FED_TARGET = 2.0

type Pt = { d: string; v: number }
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

export function EconomyMonitorContent() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['rates-economy'],
    queryFn:  () => axios.get('/api/rates/economy').then(r => r.data as EconData),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  })

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

      {/* Inflation — multi-line vs 2% target */}
      <Panel title="Inflation — Year over Year" note="Fed target 2%">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={inf.trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke={T.border} vertical={false} />
            <XAxis dataKey="d" tick={TICK} minTickGap={28} />
            <YAxis tick={TICK} width={38} tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number, n: string) => [v != null ? `${v.toFixed(1)}%` : '—', n]} />
            <Legend wrapperStyle={{ fontFamily: T.mono, fontSize: 10 }} />
            <ReferenceLine y={FED_TARGET} stroke={T.muted} strokeDasharray="5 4" />
            <Line type="monotone" dataKey="cpi"  name="CPI"      stroke={T.gold} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="core" name="Core CPI" stroke={T.blue} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="pce"  name="PCE"      stroke={T.pos}  strokeWidth={2} dot={false} connectNulls />
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
              <Area type="monotone" dataKey="v" stroke={T.gold} strokeWidth={2} fill="url(#unFill)" />
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
              <Bar dataKey="v" radius={[2, 2, 0, 0]}>
                {p.trend.map((pt, i) => <Cell key={i} fill={pt.v >= 0 ? T.pos : T.neg} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, textAlign: 'right' }}>
        Source: FRED (St. Louis Fed) · UNRATE, PAYEMS, CPIAUCSL, CPILFESL, PCEPI
      </div>
    </div>
  )
}

export default function EconomyMonitor() {
  return <PageWrapper title="Macro Monitor"><EconomyMonitorContent /></PageWrapper>
}
