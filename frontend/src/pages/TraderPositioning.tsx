import { useMemo, useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Search } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import useIsMobile from '../hooks/useIsMobile'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../components/ChartTooltip'
import { T } from '../lib/theme'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'

type AssetClass = 'commodities' | 'rates' | 'fx' | 'indices' | 'agriculture'
type Point = { date: string; net: number; net_pct_oi: number | null; open_interest: number; cohort_net?: Record<string, number> }
type Trend = { w4: number | null; w13: number | null; w26: number | null }
type Cohort = {
  label: string; long: number; short: number; net: number; net_pct_oi: number | null
  trend: Trend; derived: boolean
  long_usd: number | null; short_usd: number | null; net_usd: number | null
}
type ContractValue = { multiplier: number; unit: string; price: number | null; value_usd: number | null; basis: string }
type Market = {
  id: string; label: string; contract: string; latest: Point; weekly_flow: number | null
  open_interest_change: number | null; crowding: number | null; series: Point[]; cohorts: Cohort[]
  net_residual: number; balanced: boolean; weeks: number; primary: string
  contract_value: ContractValue | null; open_interest_usd: number | null
}
type CotResponse = { available: boolean; asset_label: string; family: string; as_of: string | null; markets: Market[]; source: string }

const ASSET_CLASSES: { id: AssetClass; label: string }[] = [
  { id: 'commodities', label: 'Commodities' }, { id: 'rates', label: 'Rates' }, { id: 'fx', label: 'FX' }, { id: 'indices', label: 'Equity index' }, { id: 'agriculture', label: 'Agriculture' },
]
const axisTick = { fontFamily: T.mono, fontSize: 9, fill: T.muted }
const panel: React.CSSProperties = { border: `1px solid ${T.border}`, background: T.surface }
const heading: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: T.gold }

/** Compact dollars: positioning runs to hundreds of billions, so full digits are noise. */
function usdCompact(value: number | null): string {
  if (value == null) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : '+'
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}tn`
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}bn`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}m`
  return `${sign}$${Math.round(abs).toLocaleString()}`
}
function contracts0(value: number | null): string {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()}`
}

function signed(value: number | null, suffix = '') {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}${suffix}`
}
function contracts(value: number | null) {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()}`
}
function fmtDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function tone(value: number | null) { return value != null && value < 0 ? T.neg : value != null && value > 0 ? T.pos : T.text }

function Metric({ label, value, note, color = T.text }: { label: string; value: string; note?: string; color?: string }) {
  return <div style={{ minWidth: 0, padding: '12px 14px', borderRight: `1px solid ${T.border}` }}>
    <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: T.muted }}>{label}</div>
    <div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 18, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {note && <div style={{ marginTop: 3, fontFamily: T.mono, fontSize: 8.5, color: T.textDim }}>{note}</div>}
  </div>
}

export default function TraderPositioning() {
  const [assetClass, setAssetClass] = useState<AssetClass>('commodities')
  const [cohortView, setCohortView] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const isMobile = useIsMobile()
  const { data, isLoading, error } = useQuery<CotResponse>({
    queryKey: ['cot-positioning', assetClass],
    queryFn: () => axios.get('/api/official/cot', { params: { asset_class: assetClass } }).then(response => response.data),
    staleTime: 6 * 3_600_000,
    retry: 1,
  })
  const markets = data?.markets ?? []
  const visibleMarkets = useMemo(() => markets.filter(market => market.label.toLowerCase().includes(query.toLowerCase())), [markets, query])
  const selected = markets.find(market => market.id === selectedId) ?? markets[0]

  const TAB = 'Trader Positioning'
  useReportCapture(() => {
    if (!selected || !data?.available) return null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, `${selected.label} · Positioning`, [
        { label: 'Net', value: signed(selected.latest.net, ''), sub: 'contracts' },
        { label: 'Net % of OI', value: signed(selected.latest.net_pct_oi, '%') },
        { label: 'Weekly Flow', value: contracts(selected.weekly_flow) },
        { label: '52W Crowding', value: selected.crowding == null ? '—' : `${Math.round(selected.crowding)}` },
        { label: 'Open Interest', value: Math.round(selected.latest.open_interest).toLocaleString() },
      ]),
    ]
    if (selected.series?.length) {
      pieces.push(chartClip(TAB, `${selected.label} · Net % of OI (52W)`, 'line', 'date',
        selected.series.map(p => ({ date: p.date, net_pct_oi: p.net_pct_oi, net: p.net })),
        [{ key: 'net_pct_oi', label: 'Net % of OI' }],
      ))
    }
    if (selected.cohorts?.length) {
      pieces.push(tableClip(TAB, 'Positioning by Cohort',
        ['Cohort', 'Long', 'Short', 'Net', 'Net % OI'],
        selected.cohorts.map(c => [
          c.label,
          Math.round(c.long),
          Math.round(c.short),
          Math.round(c.net),
          c.net_pct_oi != null ? c.net_pct_oi.toFixed(1) : null,
        ]),
      ))
    }
    if (markets.length) {
      pieces.push(tableClip(TAB, `${data.asset_label} Contracts`,
        ['Market', 'Net % OI', 'Crowding', 'Weekly Flow'],
        markets.map(m => [
          m.label,
          m.latest.net_pct_oi != null ? m.latest.net_pct_oi.toFixed(1) : null,
          m.crowding != null ? Math.round(m.crowding) : null,
          m.weekly_flow != null ? Math.round(m.weekly_flow) : null,
        ]),
      ))
    }
    return pieces
  }, { disabled: !selected || !data?.available, sourceTab: TAB })

  // Which cohort the chart and the header describe. null keeps the report's own
  // headline cohort (leveraged money, managed money or index traders).
  const view = useMemo(() => {
    if (!selected) return null
    const primaryLabel = selected.primary
    if (!cohortView) {
      return {
        label: primaryLabel,
        isDefault: true,
        series: selected.series.map(point => ({ date: point.date, value: point.net_pct_oi, net: point.net })),
        net: selected.latest.net,
        pct: selected.latest.net_pct_oi,
        flow: selected.weekly_flow,
        crowding: selected.crowding,
      }
    }
    const series = selected.series.map(point => {
      const net = point.cohort_net?.[cohortView] ?? null
      return {
        date: point.date,
        net,
        value: net != null && point.open_interest ? (net / point.open_interest) * 100 : null,
      }
    })
    const pcts = series.map(point => point.value).filter((v): v is number => v != null)
    const last = series[series.length - 1]
    const prior = series[series.length - 2]
    // Same percentile definition the backend uses for the headline cohort, so a
    // switched view stays comparable with the default one.
    const crowding = pcts.length && last?.value != null
      ? (pcts.filter(v => v <= (last.value as number)).length / pcts.length) * 100
      : null
    return {
      label: cohortView,
      isDefault: false,
      series,
      net: last?.net ?? null,
      pct: last?.value ?? null,
      flow: last?.net != null && prior?.net != null ? last.net - prior.net : null,
      crowding,
    }
  }, [selected, cohortView])

  return <PageWrapper title="Trader Positioning">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...panel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 14px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>{ASSET_CLASSES.map(item => <button key={item.id} onClick={() => { setAssetClass(item.id); setSelectedId(null); setQuery(''); setCohortView(null) }} style={{ border: 'none', borderBottom: assetClass === item.id ? `2px solid ${T.gold}` : '2px solid transparent', background: 'transparent', color: assetClass === item.id ? T.gold : T.muted, padding: '7px 11px', cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase' }}>{item.label}</button>)}</div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>CFTC · Updated weekly · {data?.family ?? 'Positioning'} · As of {fmtDate(data?.as_of ?? null)}</div>
      </div>

      {isLoading && <div style={{ ...panel, padding: 36, fontFamily: T.mono, fontSize: 10, color: T.muted, textAlign: 'center' }}>Loading CFTC positioning…</div>}
      {(error || (data && !data.available)) && <EmptyState title="CFTC positioning unavailable" hint="The weekly COT report could not be loaded. Try again after the next release." variant="unavailable" />}
      {selected && <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(260px, 0.31fr) minmax(0, 0.69fr)', ...panel }}>
        <aside style={{ minWidth: 0, borderRight: isMobile ? 'none' : `1px solid ${T.border}`, borderBottom: isMobile ? `1px solid ${T.border}` : 'none' }}>
          <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${T.border}` }}>
            <div style={heading}>{data?.asset_label} contracts</div>
            <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.border}`, padding: '8px 9px', color: T.muted }}><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter contracts" style={{ minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent', color: T.text, fontFamily: T.mono, fontSize: 10 }} /></label>
          </div>
          <div>{visibleMarkets.map(market => <button key={market.id} onClick={() => { setSelectedId(market.id); setCohortView(null) }} style={{ width: '100%', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 58px 47px', gap: 8, alignItems: 'center', border: 'none', borderBottom: `1px solid ${T.borderFaint}`, background: selected.id === market.id ? T.goldTint(12) : 'transparent', color: T.text, padding: '10px 14px', textAlign: 'left', cursor: 'pointer' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: T.label, fontSize: 10, fontWeight: selected.id === market.id ? 800 : 600 }}>{market.label}</span><span style={{ fontFamily: T.mono, fontSize: 10, color: tone(market.latest.net_pct_oi), textAlign: 'right' }}>{signed(market.latest.net_pct_oi, '%')}</span><span style={{ fontFamily: T.mono, fontSize: 9, color: T.blue, textAlign: 'right' }}>{market.crowding == null ? '—' : `${Math.round(market.crowding)}`}</span></button>)}</div>
        </aside>
        <main style={{ minWidth: 0 }}>
          <div style={{ padding: '14px 16px 11px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><div><h2 style={{ margin: 0, fontFamily: T.mono, fontSize: 20, fontWeight: 800, letterSpacing: '0.01em', color: T.text }}>{selected.label}</h2><div style={{ marginTop: 4, fontFamily: T.mono, fontSize: 9, color: T.muted }}>{selected.contract}</div></div><div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, textAlign: 'right' }}>POSITIONS AS OF {fmtDate(selected.latest.date)}<br />{data?.family?.toUpperCase()}</div></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', borderBottom: `1px solid ${T.border}` }}>
            <Metric label={`${view?.label} net`} value={signed(view?.net ?? null, '')} note={view?.isDefault ? 'contracts' : 'contracts · selected cohort'} color={tone(view?.net ?? null)} />
            <Metric label="Net % of OI" value={signed(view?.pct ?? null, '%')} note="net contracts / total OI" color={tone(view?.pct ?? null)} />
            <Metric label="Weekly flow" value={contracts(view?.flow ?? null)} note="change in net contracts" color={tone(view?.flow ?? null)} />
            <Metric label={`${selected.weeks}W crowding`} value={view?.crowding == null ? '—' : `${Math.round(view.crowding)}`} note="percentile, 100 = most net long" color={T.blue} />
            <Metric label="Open interest" value={Math.round(selected.latest.open_interest).toLocaleString()} note={selected.open_interest_change == null ? 'contracts' : `${contracts(selected.open_interest_change)} vs prior`} color={T.text} />
          </div>
          <div style={{ padding: '13px 12px 6px' }}><div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '0 4px 8px', flexWrap: 'wrap' }}><div style={{ ...heading, color: T.muted }}>{view?.label} net positioning as % of open interest, {selected.weeks} weeks</div>{!view?.isDefault && <button onClick={() => setCohortView(null)} style={{ border: `1px solid ${T.border}`, background: 'transparent', color: T.gold, cursor: 'pointer', padding: '2px 8px', fontFamily: T.mono, fontSize: 9 }}>Back to {selected.primary}</button>}</div><ResponsiveContainer width="100%" height={250}><LineChart data={view?.series ?? []} margin={{ top: 6, right: 18, left: 0, bottom: 0 }}><CartesianGrid strokeDasharray="2 4" stroke={T.borderFaint} vertical={false} /><XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false} minTickGap={30} tickFormatter={date => String(date).slice(5)} /><YAxis tick={axisTick} tickLine={false} axisLine={false} width={42} tickFormatter={value => `${value}%`} /><Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(value: number) => [`${value.toFixed(1)}%`, `${view?.label} net % of OI`]} labelFormatter={fmtDate} /><ReferenceLine y={0} stroke={T.muted} strokeDasharray="5 4" /><Line type="monotone" dataKey="value" stroke={view?.isDefault ? T.blue : T.gold} strokeWidth={2} dot={false} connectNulls /></LineChart></ResponsiveContainer></div>
          <div style={{ margin: '4px 12px 0', borderTop: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '11px 4px 8px', flexWrap: 'wrap' }}>
              <div style={{ ...heading, color: T.muted }}>Positioning by reporting cohort · click a row to chart it</div>
              <div style={{ fontFamily: T.mono, fontSize: 9, color: selected.balanced ? T.muted : T.neg }}>
                {selected.balanced
                  ? `Nets to zero${selected.net_residual ? ` (${selected.net_residual > 0 ? '+' : ''}${selected.net_residual} rounding)` : ''}`
                  : `Categories do not balance: residual ${contracts0(selected.net_residual)} contracts`}
                {selected.contract_value?.value_usd != null && (
                  <span style={{ marginLeft: 10 }}>
                    1 contract = {selected.contract_value.multiplier.toLocaleString()} {selected.contract_value.unit}
                    {' '}= ${Math.round(selected.contract_value.value_usd).toLocaleString()} ({selected.contract_value.basis})
                  </span>
                )}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}><table style={{ minWidth: 720, width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}><thead><tr>{['Cohort', 'Long', 'Short', 'Net', 'Net % OI', 'Net $', '4w', '13w', '26w'].map((label, index) => <th key={label} style={{ padding: '7px 8px', borderBottom: `1px solid ${T.border}`, color: T.muted, fontSize: 8, letterSpacing: '0.12em', textAlign: index ? 'right' : 'left', textTransform: 'uppercase' }}>{label}</th>)}</tr></thead><tbody>{selected.cohorts.map(cohort => <tr key={cohort.label}
  onClick={() => setCohortView(current => current === cohort.label ? null : cohort.label)}
  role="button" tabIndex={0} aria-pressed={view?.label === cohort.label}
  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCohortView(current => current === cohort.label ? null : cohort.label) } }}
  title={view?.label === cohort.label ? 'Showing this cohort. Click again to go back.' : `Chart ${cohort.label}`}
  style={{ borderBottom: `1px solid ${T.borderFaint}`, cursor: 'pointer', background: view?.label === cohort.label ? T.goldTint(10) : 'transparent', borderLeft: `2px solid ${view?.label === cohort.label ? T.gold : 'transparent'}` }}><td style={{ padding: '9px 8px', color: T.text, fontFamily: T.label, fontWeight: 700 }}>{cohort.label}{cohort.derived && <span title="Derived as the reportable total less the published slices; the CFTC supplemental report does not publish it directly." style={{ marginLeft: 5, fontFamily: T.mono, fontSize: 8, color: T.muted }}>derived</span>}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: T.blue }}>{Math.round(cohort.long).toLocaleString()}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: T.gold }}>{Math.round(cohort.short).toLocaleString()}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: tone(cohort.net) }}>{contracts(cohort.net)}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: tone(cohort.net_pct_oi) }}>{signed(cohort.net_pct_oi, '%')}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: tone(cohort.net_usd), fontWeight: 700 }}>{usdCompact(cohort.net_usd)}</td>{(['w4', 'w13', 'w26'] as const).map(window => <td key={window} style={{ padding: '9px 8px', textAlign: 'right', color: tone(cohort.trend[window]) }}>{contracts0(cohort.trend[window])}</td>)}</tr>)}</tbody><tfoot><tr><td style={{ padding: '8px', fontFamily: T.label, fontSize: 9, color: T.muted, fontWeight: 700 }}>All categories</td><td colSpan={2} /><td style={{ padding: '8px', textAlign: 'right', color: selected.balanced ? T.muted : T.neg, fontWeight: 700 }}>{contracts0(selected.net_residual)}</td><td /><td style={{ padding: '8px', textAlign: 'right', color: T.muted }}>{selected.open_interest_usd != null ? `${usdCompact(selected.open_interest_usd).replace('+', '')} OI` : ''}</td><td colSpan={3} /></tr></tfoot></table></div></div>
          <div style={{ margin: '14px 12px 12px', paddingTop: 10, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontFamily: T.mono, fontSize: 8.5, color: T.muted }}><span>Methodology: Tuesday positions, usually released Friday at 3:30 p.m. ET.</span><span>Source: CFTC Commitments of Traders</span></div>
        </main>
      </div>}
    </div>
  </PageWrapper>
}
