import { useMemo, useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import { KpiCell } from '../components/mmCockpit'
import useIsMobile from '../hooks/useIsMobile'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip, textClip } from '../lib/reportCaptureRegistry'

interface Trend { mom: number | null; yoy: number | null }
interface RegionRow {
  region: string
  region_label: string
  asof: string
  median_price: number
  price_per_sqft: number
  median_income: number
  price_to_income: number
  sales_volume: number
  days_on_market: number
  active_listings: number
  months_of_supply: number
  affordability_index: number
  market: string
  rate_30y: number
  sf_default_rate: number
  mf_default_rate: number
  serious_delinquency: number
  foreclosure_rate: number
  negative_equity: number
  avg_ltv: number
  avg_fico: number
  trends: {
    median_price: Trend
    sales_volume: Trend
    affordability_index: Trend
    months_of_supply: Trend
    sf_default_rate: Trend
    mf_default_rate: Trend
    serious_delinquency: Trend
  }
  history: { asof: string; median_price: number; sales_volume: number; months_of_supply: number; sf_default_rate: number; mf_default_rate: number; affordability_index: number }[]
}
interface Report {
  available?: boolean
  asof: string | null
  rates: { rate_30y: number; rate_15y: number; rate_arm: number } | null
  by_region: RegionRow[]
  flags: { region: string; kind: string; detail: string; value: number }[]
  source?: string
}
interface RatesResp { history: { asof: string; rate_30y: number; rate_15y: number; rate_arm: number }[] }
interface RentState { state: string; listings: number | null; median_rent: number | null; median_rent_per_sqft: number | null; median_rent_1br: number | null; median_rent_2br: number | null }
interface RentResp {
  available: boolean
  source: string
  as_of?: string
  reason?: string
  partitions?: number
  state_count?: number
  covered_state_count?: number
  national?: Omit<RentState, 'state'>
  states?: RentState[]
}
interface ConstructionResp { region: string; history: { asof: string; housing_starts: number; building_permits: number; completions: number }[] }

type RentSort = 'listings' | 'rent' | 'psf'

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const ORANGE = '#d07b34'
const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}` }
const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const MARKET_COLOR: Record<string, string> = { seller: '#34d399', balanced: GOLD, buyer: BLUE }
const money = (value: number | null | undefined) => value == null ? 'Data unavailable' : MONEY.format(value)
const number = (value: number | null | undefined) => value == null ? 'Data unavailable' : NUMBER.format(value)
const pct = (value: number | null | undefined, digits = 2) => value == null || value <= 0 ? 'Data unavailable' : `${value.toFixed(digits)}%`
const signed = (value: number | null) => value == null ? 'trend unavailable' : `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(1)}% YoY`

function ageLabel(date?: string) {
  if (!date) return 'date unavailable'
  const days = Math.max(0, Math.floor((Date.now() - new Date(`${date}T00:00:00`).getTime()) / 86_400_000))
  return days <= 1 ? 'current' : `${days}d old`
}

function PanelHead({ title, meta, children }: { title: string; meta?: string; children?: React.ReactNode }) {
  return <div style={{ minHeight: 36, padding: '0 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)', flexWrap: 'wrap' }}>
    <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.text }}>{title}</span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{meta && <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{meta}</span>}{children}</span>
  </div>
}

function metricColor(value: string, tone?: string) {
  return value === 'Data unavailable' ? 'var(--theme-secondary, #8099b0)' : tone
}

function SortButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ padding: '5px 9px', border: 'none', borderLeft: `1px solid ${T.border}`, background: active ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent', boxShadow: active ? `inset 0 -2px ${GOLD}` : 'none', color: active ? T.text : T.muted, fontFamily: T.mono, fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>{children}</button>
}

function RentalMarket({ rent, loading }: { rent?: RentResp; loading: boolean }) {
  const [sort, setSort] = useState<RentSort>('listings')
  const states = useMemo(() => [...(rent?.states ?? [])].sort((a, b) => {
    if (sort === 'rent') return (b.median_rent ?? -1) - (a.median_rent ?? -1)
    if (sort === 'psf') return (b.median_rent_per_sqft ?? -1) - (a.median_rent_per_sqft ?? -1)
    return (b.listings ?? -1) - (a.listings ?? -1)
  }), [rent?.states, sort])

  return <section style={PANEL}>
    <PanelHead title="Rental Market" meta={rent?.as_of ? `RentHub · ${rent.as_of} · ${ageLabel(rent.as_of)} · ${rent.covered_state_count ?? states.filter(state => state.listings != null).length} of ${rent.state_count ?? states.length} reporting` : 'RentHub'}>
      <span style={{ display: 'flex', border: `1px solid ${T.border}` }}>
        <SortButton active={sort === 'listings'} onClick={() => setSort('listings')}>LISTINGS</SortButton>
        <SortButton active={sort === 'rent'} onClick={() => setSort('rent')}>RENT</SortButton>
        <SortButton active={sort === 'psf'} onClick={() => setSort('psf')}>$/SQ FT</SortButton>
      </span>
    </PanelHead>
    {loading ? <div style={{ padding: 22, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Loading rental listings…</div> : !rent?.available ? <div style={{ padding: 22, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Data unavailable. RentHub snapshot has not been ingested.</div> : <>
      {(() => {
        const listings = number(rent.national?.listings)
        const medianRent = money(rent.national?.median_rent)
        const psf = rent.national?.median_rent_per_sqft != null ? `$${rent.national.median_rent_per_sqft.toFixed(2)}` : 'Data unavailable'
        const rent1br = money(rent.national?.median_rent_1br)
        const rent2br = money(rent.national?.median_rent_2br)
        return <div className="housing-metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(145px, 1fr))', borderBottom: `1px solid ${T.border}` }}>
          <KpiCell label="Active Listings" value={listings} color={metricColor(listings)} valueSize={20} sub="snapshot coverage" />
          <KpiCell label="Median Asking Rent" value={medianRent} color={metricColor(medianRent)} valueSize={20} sub="all unit types" />
          <KpiCell label="Rent / Sq Ft" value={psf} color={metricColor(psf)} valueSize={20} sub="where square feet reported" />
          <KpiCell label="One Bedroom" value={rent1br} color={metricColor(rent1br)} valueSize={20} sub="median asking rent" />
          <KpiCell label="Two Bedroom" value={rent2br} color={metricColor(rent2br)} valueSize={20} sub="median asking rent" />
        </div>
      })()}
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: T.surface }}><tr>
            {['#', 'State', 'Listings', 'Median asking rent', 'Rent / sq ft', '1 bedroom', '2 bedroom', '2BR premium'].map((label, index) => <th key={label} style={{ padding: '9px 12px', textAlign: index < 2 ? 'left' : 'right', borderBottom: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</th>)}
          </tr></thead>
          <tbody>{states.map((state, index) => {
            const premium = state.median_rent_1br != null && state.median_rent_2br != null ? state.median_rent_2br - state.median_rent_1br : null
            return <tr key={state.state} style={{ background: index % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
              <td style={{ padding: '9px 12px', borderBottom: `1px solid ${T.borderFaint}`, color: T.textDim, fontFamily: T.mono, fontSize: 9 }}>{state.listings == null ? '—' : String(index + 1).padStart(2, '0')}</td>
              <td style={{ padding: '9px 12px', borderBottom: `1px solid ${T.borderFaint}`, color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 800 }}>{state.state}</td>
              <td style={rentCell}>{number(state.listings)}</td>
              <td style={{ ...rentCell, color: GOLD, fontWeight: 800 }}>{money(state.median_rent)}</td>
              <td style={rentCell}>{state.median_rent_per_sqft != null ? `$${state.median_rent_per_sqft.toFixed(2)}` : 'Data unavailable'}</td>
              <td style={rentCell}>{money(state.median_rent_1br)}</td>
              <td style={rentCell}>{money(state.median_rent_2br)}</td>
              <td style={{ ...rentCell, color: premium != null && premium >= 0 ? T.muted : T.pos }}>{premium == null ? 'Data unavailable' : `${premium >= 0 ? '+' : '-'}${money(Math.abs(premium))}`}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </>}
  </section>
}

const rentCell: React.CSSProperties = { padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${T.borderFaint}`, color: T.text, fontFamily: T.mono, fontSize: 10.5, whiteSpace: 'nowrap' }

function HousingMarketContent() {
  const isMobile = useIsMobile()
  const { data, isLoading, isError } = useQuery<Report>({ queryKey: ['housing-report'], queryFn: () => axios.get('/api/housing/report').then(r => r.data), staleTime: 3_600_000, retry: 1 })
  const { data: rates } = useQuery<RatesResp>({ queryKey: ['housing-rates'], queryFn: () => axios.get('/api/housing/rates').then(r => r.data), staleTime: 3_600_000, retry: 1 })
  const { data: rent, isLoading: rentLoading } = useQuery<RentResp>({ queryKey: ['housing-rent-full'], queryFn: () => axios.get('/api/housing/rent?limit=51').then(r => r.data), staleTime: 12 * 3_600_000, retry: 1 })
  const { data: construction } = useQuery<ConstructionResp>({ queryKey: ['housing-construction'], queryFn: () => axios.get('/api/housing/construction?region=national').then(r => r.data), staleTime: 3_600_000, retry: 1 })
  const national = data?.by_region.find(region => region.region === 'national')
  const constructionHistory = construction?.history.filter(row => row.housing_starts > 0 || row.building_permits > 0 || row.completions > 0) ?? []

  const TAB = 'Housing Market'
  useReportCapture(() => {
    if (!national) return null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, 'National Housing Pulse', [
        { label: 'Median Home Price', value: money(national.median_price), sub: signed(national.trends.median_price.yoy) },
        { label: '30Y Fixed', value: pct(national.rate_30y) },
        { label: 'Affordability Index', value: national.affordability_index.toFixed(1), sub: national.affordability_index >= 100 ? 'affordable' : 'stretched' },
        { label: 'Months of Supply', value: national.months_of_supply.toFixed(2), sub: `${national.market} market` },
        { label: 'Days on Market', value: `${national.days_on_market.toFixed(1)} days` },
        { label: 'List Price / Sq Ft', value: national.price_per_sqft > 0 ? money(national.price_per_sqft) : '—' },
      ]),
      kpiClip(TAB, 'Market Balance', [
        { label: 'Active Listings', value: number(national.active_listings) },
        { label: 'Monthly Sales', value: number(national.sales_volume) },
        { label: 'Median Income', value: money(national.median_income) },
        { label: 'Price / Income', value: `${national.price_to_income.toFixed(3)}x` },
      ]),
      kpiClip(TAB, 'Mortgage Credit Risk', [
        { label: 'SF Delinquency', value: pct(national.sf_default_rate) },
        { label: '90+ Days Past Due', value: pct(national.serious_delinquency) },
        { label: 'Multifamily Default', value: pct(national.mf_default_rate) },
        { label: 'Foreclosure Rate', value: pct(national.foreclosure_rate) },
      ]),
    ]
    if (rates?.history?.length) {
      pieces.push(chartClip(TAB, 'Mortgage Rate Curve · 3Y', 'line', 'asof',
        rates.history.map(r => ({ asof: r.asof, rate_30y: r.rate_30y, rate_15y: r.rate_15y, rate_arm: r.rate_arm })),
        [
          { key: 'rate_30y', label: '30Y fixed' },
          { key: 'rate_15y', label: '15Y fixed' },
          { key: 'rate_arm', label: '5/1 ARM' },
        ],
      ))
    }
    if (constructionHistory.length) {
      pieces.push(chartClip(TAB, 'Residential Construction Pipeline', 'line', 'asof',
        constructionHistory.map(r => ({
          asof: r.asof,
          housing_starts: r.housing_starts,
          building_permits: r.building_permits,
          completions: r.completions,
        })),
        [
          { key: 'housing_starts', label: 'Starts' },
          { key: 'building_permits', label: 'Permits' },
          { key: 'completions', label: 'Completions' },
        ],
      ))
    }
    if (rent?.available && rent.national) {
      pieces.push(kpiClip(TAB, 'Rental Market (National)', [
        { label: 'Active Listings', value: number(rent.national.listings) },
        { label: 'Median Asking Rent', value: money(rent.national.median_rent) },
        { label: 'Rent / Sq Ft', value: rent.national.median_rent_per_sqft != null ? `$${rent.national.median_rent_per_sqft.toFixed(2)}` : '—' },
        { label: 'One Bedroom', value: money(rent.national.median_rent_1br) },
        { label: 'Two Bedroom', value: money(rent.national.median_rent_2br) },
      ]))
    }
    if (rent?.available && rent.states?.length) {
      pieces.push(tableClip(TAB, 'Rental Market by State',
        ['State', 'Listings', 'Median Rent', 'Rent/SqFt', '1BR', '2BR'],
        rent.states.slice(0, 30).map(s => [
          s.state,
          s.listings,
          s.median_rent != null ? Math.round(s.median_rent) : null,
          s.median_rent_per_sqft != null ? s.median_rent_per_sqft.toFixed(2) : null,
          s.median_rent_1br != null ? Math.round(s.median_rent_1br) : null,
          s.median_rent_2br != null ? Math.round(s.median_rent_2br) : null,
        ]),
      ))
    }
    if (data?.flags?.length) {
      pieces.push(textClip(TAB, 'Conditions to Watch',
        data.flags.map(f => `${f.region.toUpperCase()}: ${f.detail}`).join('\n'),
      ))
    }
    return pieces
  }, { disabled: !national, sourceTab: TAB })

  return <div style={{ width: '100%' }}>
    <PageHeader title="Housing Market" actions={data && <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>
      <span style={{ color: data.source?.startsWith('FRED') ? T.pos : T.warn }}>{data.source ?? 'Source unavailable'}</span>
      <span>{data.asof ? `${data.asof} · ${ageLabel(data.asof)}` : 'date unavailable'}</span>
    </div>} />

    {isLoading && <EmptyState title="Loading Housing Market" hint="Assembling prices, affordability, mortgage rates, inventory, rentals, and construction activity." variant="loading" />}
    {isError && <EmptyState title="Housing Data Unavailable" hint="The free FRED and RentHub sources could not be reached. No fallback or simulated values are shown." variant="unavailable" />}
    {!isLoading && !isError && !national && <EmptyState title="Housing Data Unavailable" hint="FRED has not returned the national series required to calculate the housing pulse." variant="unavailable" />}

    {national && <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={PANEL}>
        <PanelHead title="National Housing Pulse" meta={`FRED · ${national.asof} · observed public series`} />
        <div className="housing-metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(145px, 1fr))' }}>
          <KpiCell label="Median Home Price" value={money(national.median_price)} valueSize={20} sub={signed(national.trends.median_price.yoy)} color={metricColor(money(national.median_price), (national.trends.median_price.yoy ?? 0) >= 0 ? T.pos : T.neg)} />
          <KpiCell label="30Y Fixed" value={pct(national.rate_30y)} valueSize={20} color={metricColor(pct(national.rate_30y))} sub="prevailing mortgage rate" />
          <KpiCell label="Affordability Index" value={national.affordability_index.toFixed(1)} valueSize={20} sub={national.affordability_index >= 100 ? 'affordable' : 'stretched'} color={national.affordability_index >= 100 ? T.pos : T.neg} help="100 means a median-income household earns exactly enough to qualify for the median-priced home under the model assumptions." />
          <KpiCell label="Months of Supply" value={national.months_of_supply.toFixed(2)} valueSize={20} sub={`${national.market} market`} color={MARKET_COLOR[national.market]} help="Active inventory divided by the current monthly sales pace. Under four months generally favors sellers." />
          <KpiCell label="Days on Market" value={`${national.days_on_market.toFixed(1)} days`} valueSize={20} color={metricColor(`${national.days_on_market.toFixed(1)} days`)} sub="median listing time" />
          <KpiCell label="List Price / Sq Ft" value={national.price_per_sqft > 0 ? money(national.price_per_sqft) : 'Data unavailable'} valueSize={20} color={metricColor(national.price_per_sqft > 0 ? money(national.price_per_sqft) : 'Data unavailable')} sub="national median" />
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.8fr) minmax(280px, 0.7fr)', gap: 16 }}>
        <section style={PANEL}>
          <PanelHead title="Mortgage Rate Curve · 3 Years" meta="30Y fixed · 15Y fixed · 5/1 ARM" />
          {rates?.history.length ? <div style={{ padding: '16px 12px 8px' }}><ResponsiveContainer width="100%" height={250}>
            <LineChart data={rates.history} margin={{ left: 2, right: 12, top: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
              <XAxis dataKey="asof" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => value.slice(0, 7)} interval="preserveStartEnd" minTickGap={45} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => `${value}%`} width={38} domain={['dataMin - 0.3', 'dataMax + 0.3']} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: GOLD }} formatter={(value: number, name: string) => [`${Number(value).toFixed(2)}%`, name]} />
              <Line type="monotone" dataKey="rate_30y" name="30Y fixed" stroke={GOLD} strokeWidth={1.8} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="rate_15y" name="15Y fixed" stroke={BLUE} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="rate_arm" name="5/1 ARM" stroke={ORANGE} strokeWidth={1.3} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer></div> : <Unavailable text="Mortgage-rate history unavailable." />}
        </section>

        <section style={PANEL}>
          <PanelHead title="Market Balance" meta={national.market.toUpperCase()} />
          <div style={{ padding: '18px 18px 16px' }}>
            <div style={{ fontFamily: T.mono, fontSize: 34, fontWeight: 800, color: MARKET_COLOR[national.market], lineHeight: 1 }}>{national.months_of_supply.toFixed(2)}</div>
            <div style={{ marginTop: 6, fontFamily: T.label, fontSize: 10, color: T.muted }}>months of supply</div>
            <div style={{ height: 5, margin: '18px 0 16px', display: 'grid', gridTemplateColumns: '4fr 2fr 4fr', gap: 2 }}><span style={{ background: '#34d399' }} /><span style={{ background: GOLD }} /><span style={{ background: BLUE }} /></div>
            {[['Active listings', number(national.active_listings)], ['Monthly sales pace', number(national.sales_volume)], ['Median household income', money(national.median_income)], ['Price / income', `${national.price_to_income.toFixed(3)}x`]].map(([label, value]) => <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: `1px solid ${T.borderFaint}` }}><span style={{ fontFamily: T.label, fontSize: 10, color: T.muted }}>{label}</span><span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 800, color: T.text }}>{value}</span></div>)}
          </div>
        </section>
      </div>

      <RentalMarket rent={rent} loading={rentLoading} />

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.35fr) minmax(360px, 0.65fr)', gap: 16 }}>
        <section style={PANEL}>
          <PanelHead title="Residential Construction Pipeline" meta="FRED · seasonally adjusted annual rate" />
          {constructionHistory.length ? <div style={{ padding: '16px 12px 8px' }}><ResponsiveContainer width="100%" height={230}>
            <LineChart data={constructionHistory} margin={{ left: 2, right: 12, top: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
              <XAxis dataKey="asof" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => value.slice(0, 7)} interval="preserveStartEnd" minTickGap={45} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => `${(value / 1_000_000).toFixed(1)}m`} width={42} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: GOLD }} formatter={(value: number, name: string) => [number(Number(value)), name]} />
              <Line type="monotone" dataKey="housing_starts" name="Starts" stroke={GOLD} strokeWidth={1.7} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="building_permits" name="Permits" stroke={BLUE} strokeWidth={1.4} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="completions" name="Completions" stroke="#34d399" strokeWidth={1.4} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer></div> : <Unavailable text="Construction history unavailable." />}
        </section>

        <section style={PANEL}>
          <PanelHead title="Mortgage Credit Risk" meta="national" />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
            <KpiCell label="SF Delinquency" value={pct(national.sf_default_rate)} valueSize={20} sub={signed(national.trends.sf_default_rate.yoy)} color={metricColor(pct(national.sf_default_rate), national.sf_default_rate > 2 ? T.neg : T.text)} />
            <KpiCell label="90+ Days Past Due" value={pct(national.serious_delinquency)} valueSize={20} color={metricColor(pct(national.serious_delinquency))} sub="serious delinquency" />
            <KpiCell label="Multifamily Default" value={pct(national.mf_default_rate)} valueSize={20} color={metricColor(pct(national.mf_default_rate))} sub="FRED series unavailable" />
            <KpiCell label="Foreclosure Rate" value={pct(national.foreclosure_rate)} valueSize={20} color={metricColor(pct(national.foreclosure_rate))} sub="FRED series unavailable" />
            <KpiCell label="Negative Equity" value={pct(national.negative_equity, 1)} valueSize={20} color={metricColor(pct(national.negative_equity, 1))} sub="FRED series unavailable" />
            <KpiCell label="Origination FICO / LTV" value={national.avg_fico > 0 ? `${national.avg_fico.toFixed(0)} / ${national.avg_ltv.toFixed(1)}%` : 'Data unavailable'} valueSize={20} color={metricColor(national.avg_fico > 0 ? `${national.avg_fico.toFixed(0)} / ${national.avg_ltv.toFixed(1)}%` : 'Data unavailable')} sub="lending standards" />
          </div>
        </section>
      </div>

      {!!data?.flags.length && <section style={PANEL}>
        <PanelHead title="Conditions to Watch" meta={`${data.flags.length} signals`} />
        <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 7 }}>{data.flags.map((flag, index) => <div key={`${flag.kind}-${index}`} style={{ padding: '9px 10px', border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8, color: T.muted, fontFamily: T.mono, fontSize: 9.5 }}><span style={{ width: 6, height: 6, background: T.neg, flex: 'none' }} /><span style={{ color: T.text }}>{flag.region.toUpperCase()}</span><span>{flag.detail}</span></div>)}</div>
      </section>}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', padding: '0 2px', color: T.textDim, fontFamily: T.mono, fontSize: 8.5 }}>
        <span>Home prices, rates, inventory, construction, and delinquency: FRED · St. Louis Fed</span>
        <span>Rental listings: RentHub snapshot · exact medians shown · no simulated values</span>
      </div>
    </div>}
  </div>
}

const axisTick = { fontFamily: T.mono, fontSize: 8, fill: T.muted }
const tooltipStyle = { ...TOOLTIP_STYLE }
const Unavailable = ({ text }: { text: string }) => <div style={{ minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.mono, fontSize: 10 }}>{text}</div>

export { HousingMarketContent }

export default function HousingMarket() {
  return <PageWrapper><HousingMarketContent /></PageWrapper>
}
