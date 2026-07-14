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

type AssetClass = 'commodities' | 'rates' | 'fx' | 'indices' | 'agriculture'
type Point = { date: string; net: number; net_pct_oi: number | null; open_interest: number }
type Cohort = { label: string; long: number; short: number; net: number; net_pct_oi: number | null }
type Market = { id: string; label: string; contract: string; latest: Point; weekly_flow: number | null; open_interest_change: number | null; crowding: number | null; series: Point[]; cohorts: Cohort[] }
type CotResponse = { available: boolean; asset_label: string; family: string; as_of: string | null; markets: Market[]; source: string }

const ASSET_CLASSES: { id: AssetClass; label: string }[] = [
  { id: 'commodities', label: 'Commodities' }, { id: 'rates', label: 'Rates' }, { id: 'fx', label: 'FX' }, { id: 'indices', label: 'Equity index' }, { id: 'agriculture', label: 'Agriculture' },
]
const axisTick = { fontFamily: T.mono, fontSize: 9, fill: T.muted }
const panel: React.CSSProperties = { border: `1px solid ${T.border}`, background: T.surface }
const heading: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: T.gold }

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

  return <PageWrapper title="Trader Positioning">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...panel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 14px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>{ASSET_CLASSES.map(item => <button key={item.id} onClick={() => { setAssetClass(item.id); setSelectedId(null); setQuery('') }} style={{ border: 'none', borderBottom: assetClass === item.id ? `2px solid ${T.gold}` : '2px solid transparent', background: 'transparent', color: assetClass === item.id ? T.gold : T.muted, padding: '7px 11px', cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase' }}>{item.label}</button>)}</div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>CFTC · Updated weekly · {data?.family ?? 'Positioning'} · As of {fmtDate(data?.as_of ?? null)}</div>
      </div>

      {isLoading && <div style={{ ...panel, padding: 36, fontFamily: T.mono, fontSize: 10, color: T.muted, textAlign: 'center' }}>Loading CFTC positioning…</div>}
      {(error || (data && !data.available)) && <EmptyState title="CFTC positioning unavailable" hint="The weekly COT report could not be loaded. Try again after the next release." />}
      {selected && <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(260px, 0.31fr) minmax(0, 0.69fr)', ...panel }}>
        <aside style={{ minWidth: 0, borderRight: isMobile ? 'none' : `1px solid ${T.border}`, borderBottom: isMobile ? `1px solid ${T.border}` : 'none' }}>
          <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${T.border}` }}>
            <div style={heading}>{data?.asset_label} contracts</div>
            <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.border}`, padding: '8px 9px', color: T.muted }}><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter contracts" style={{ minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent', color: T.text, fontFamily: T.mono, fontSize: 10 }} /></label>
          </div>
          <div>{visibleMarkets.map(market => <button key={market.id} onClick={() => setSelectedId(market.id)} style={{ width: '100%', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 58px 47px', gap: 8, alignItems: 'center', border: 'none', borderBottom: `1px solid ${T.borderFaint}`, background: selected.id === market.id ? T.goldTint(12) : 'transparent', color: T.text, padding: '10px 14px', textAlign: 'left', cursor: 'pointer' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: T.label, fontSize: 10, fontWeight: selected.id === market.id ? 800 : 600 }}>{market.label}</span><span style={{ fontFamily: T.mono, fontSize: 10, color: tone(market.latest.net_pct_oi), textAlign: 'right' }}>{signed(market.latest.net_pct_oi, '%')}</span><span style={{ fontFamily: T.mono, fontSize: 9, color: T.blue, textAlign: 'right' }}>{market.crowding == null ? '—' : `${Math.round(market.crowding)}`}</span></button>)}</div>
        </aside>
        <main style={{ minWidth: 0 }}>
          <div style={{ padding: '14px 16px 11px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><div><h2 style={{ margin: 0, fontFamily: T.label, fontSize: 22, letterSpacing: '0.02em', color: T.text }}>{selected.label}</h2><div style={{ marginTop: 4, fontFamily: T.mono, fontSize: 9, color: T.muted }}>{selected.contract}</div></div><div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, textAlign: 'right' }}>POSITIONS AS OF {fmtDate(selected.latest.date)}<br />{data?.family?.toUpperCase()}</div></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', borderBottom: `1px solid ${T.border}` }}>
            <Metric label={`${data?.family?.includes('Financial') ? 'Leveraged money' : data?.family?.includes('Index') ? 'Index trader' : 'Managed money'} net`} value={signed(selected.latest.net, '')} note="contracts" color={tone(selected.latest.net)} />
            <Metric label="Net % of OI" value={signed(selected.latest.net_pct_oi, '%')} note="net contracts / total OI" color={tone(selected.latest.net_pct_oi)} />
            <Metric label="Weekly flow" value={contracts(selected.weekly_flow)} note="change in net contracts" color={tone(selected.weekly_flow)} />
            <Metric label="52W crowding" value={selected.crowding == null ? '—' : `${Math.round(selected.crowding)}`} note="percentile, 100 = most net long" color={T.blue} />
            <Metric label="Open interest" value={Math.round(selected.latest.open_interest).toLocaleString()} note={selected.open_interest_change == null ? 'contracts' : `${contracts(selected.open_interest_change)} vs prior`} color={T.text} />
          </div>
          <div style={{ padding: '13px 12px 6px' }}><div style={{ ...heading, color: T.muted, padding: '0 4px 8px' }}>Net positioning as % of open interest, 52 weeks</div><ResponsiveContainer width="100%" height={250}><LineChart data={selected.series} margin={{ top: 6, right: 18, left: 0, bottom: 0 }}><CartesianGrid strokeDasharray="2 4" stroke={T.borderFaint} vertical={false} /><XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false} minTickGap={30} tickFormatter={date => String(date).slice(5)} /><YAxis tick={axisTick} tickLine={false} axisLine={false} width={42} tickFormatter={value => `${value}%`} /><Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(value: number) => [`${value.toFixed(1)}%`, 'Net % of OI']} labelFormatter={fmtDate} /><ReferenceLine y={0} stroke={T.muted} strokeDasharray="5 4" /><Line type="monotone" dataKey="net_pct_oi" stroke={T.blue} strokeWidth={2} dot={false} connectNulls /></LineChart></ResponsiveContainer></div>
          <div style={{ margin: '4px 12px 0', borderTop: `1px solid ${T.border}` }}><div style={{ ...heading, color: T.muted, padding: '11px 4px 8px' }}>Positioning by reporting cohort</div><div style={{ overflowX: 'auto' }}><table style={{ minWidth: 540, width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}><thead><tr>{['Cohort', 'Long', 'Short', 'Net', 'Net % OI'].map((label, index) => <th key={label} style={{ padding: '7px 8px', borderBottom: `1px solid ${T.border}`, color: T.muted, fontSize: 8, letterSpacing: '0.12em', textAlign: index ? 'right' : 'left', textTransform: 'uppercase' }}>{label}</th>)}</tr></thead><tbody>{selected.cohorts.map(cohort => <tr key={cohort.label} style={{ borderBottom: `1px solid ${T.borderFaint}` }}><td style={{ padding: '9px 8px', color: T.text, fontFamily: T.label, fontWeight: 700 }}>{cohort.label}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: T.blue }}>{Math.round(cohort.long).toLocaleString()}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: T.gold }}>{Math.round(cohort.short).toLocaleString()}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: tone(cohort.net) }}>{contracts(cohort.net)}</td><td style={{ padding: '9px 8px', textAlign: 'right', color: tone(cohort.net_pct_oi) }}>{signed(cohort.net_pct_oi, '%')}</td></tr>)}</tbody></table></div></div>
          <div style={{ margin: '14px 12px 12px', paddingTop: 10, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontFamily: T.mono, fontSize: 8.5, color: T.muted }}><span>Methodology: Tuesday positions, usually released Friday at 3:30 p.m. ET.</span><span>Source: CFTC Commitments of Traders</span></div>
        </main>
      </div>}
    </div>
  </PageWrapper>
}
