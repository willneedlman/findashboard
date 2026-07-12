import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'

interface Trend { mom: number | null; yoy: number | null }
interface RegionRow {
  region: string; region_label: string; asof: string
  median_price: number; price_per_sqft: number; median_income: number; price_to_income: number
  sales_volume: number; days_on_market: number; active_listings: number; months_of_supply: number
  affordability_index: number; sell_through: number; market: string; rate_30y: number
  sf_default_rate: number; mf_default_rate: number; serious_delinquency: number
  foreclosure_rate: number; negative_equity: number; avg_ltv: number; avg_fico: number
  trends: { median_price: Trend; sales_volume: Trend; affordability_index: Trend; months_of_supply: Trend; sf_default_rate: Trend; mf_default_rate: Trend; serious_delinquency: Trend }
  history: { asof: string; median_price: number; sales_volume: number; months_of_supply: number; sf_default_rate: number; mf_default_rate: number; affordability_index: number }[]
}
interface Report {
  asof: string
  rates: { rate_30y: number; rate_15y: number; rate_arm: number } | null
  by_region: RegionRow[]
  flags: { region: string; kind: string; detail: string; value: number }[]
  source?: string
}
interface RatesResp { history: { asof: string; rate_30y: number; rate_15y: number; rate_arm: number }[] }
interface RentResp { available: boolean; source: string; as_of?: string; reason?: string; national?: { listings: number; median_rent: number; median_rent_per_sqft: number | null; median_rent_1br: number | null; median_rent_2br: number | null }; states?: { state: string; listings: number; median_rent: number; median_rent_per_sqft: number | null; median_rent_1br: number | null; median_rent_2br: number | null }[] }

const MARKET_COLOR: Record<string, string> = { seller: '#2f8a4e', balanced: T.gold, buyer: '#5b93c9' }
const fmtK = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`
const pct = (v: number, d = 2) => `${v.toFixed(d)}%`
// FRED does not publish some fields (foreclosure, negative equity, FICO/LTV);
// they arrive as 0 and should read as "no data", not a real zero.
const pctOrDash = (v: number, d = 2) => (v && v > 0 ? `${v.toFixed(d)}%` : '—')
const signed = (v: number | null) => v == null ? 'n/a' : `${v >= 0 ? '↑' : '↓'}${Math.abs(v).toFixed(1)}%`

const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }
const th: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, padding: '9px 14px', textAlign: 'right', borderBottom: `1px solid ${T.border}` }
const td: React.CSSProperties = { fontFamily: T.mono, fontSize: 12, padding: '10px 14px', textAlign: 'right', color: T.text, fontVariantNumeric: 'tabular-nums', borderBottom: `1px solid ${T.borderFaint}` }

function Sparkline({ series, up }: { series: number[]; up: boolean }) {
  if (!series || series.length < 2) return null
  const min = Math.min(...series), max = Math.max(...series), span = max - min || 1
  const w = 74, h = 22
  const pts = series.map((v, i) => `${(2 + (w - 4) * i / (series.length - 1)).toFixed(1)},${(3 + (h - 6) * (1 - (v - min) / span)).toFixed(1)}`).join(' ')
  return <svg width={w} height={h} style={{ display: 'block' }}><polyline points={pts} fill="none" stroke={up ? T.pos : T.neg} strokeWidth={1.4} strokeLinejoin="round" /></svg>
}

// Hoverable "?" with an explanatory popup. `below`/`below-left` open downward
// (used in scrollable table headers, which would clip an upward popup); the
// left variant anchors the popup's right edge to the icon for rightmost columns.
function HelpTip({ text, placement = 'top' }: { text: string; placement?: 'top' | 'below' | 'below-left' }) {
  const [show, setShow] = useState(false)
  const pos: React.CSSProperties = placement === 'below'
    ? { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }
    : placement === 'below-left'
      ? { top: 'calc(100% + 6px)', right: 0 }
      : { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }
  return (
    <span style={{ position: 'relative', display: 'inline-flex', marginLeft: 5, verticalAlign: 'middle' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, borderRadius: '50%', border: `1px solid ${T.muted}`, color: T.muted, fontSize: 8, fontWeight: 700, lineHeight: 1, cursor: 'help' }}>?</span>
      {show && (
        <span style={{ position: 'absolute', ...pos, width: 230, background: 'var(--theme-bg, #0a1628)', border: `1px solid ${T.border}`, boxShadow: '0 4px 14px rgba(0,0,0,0.45)', padding: '9px 11px', fontFamily: T.label, fontSize: 10, lineHeight: 1.5, fontWeight: 400, letterSpacing: 0, textTransform: 'none', color: T.text, zIndex: 100, pointerEvents: 'none', whiteSpace: 'normal' }}>{text}</span>
      )}
    </span>
  )
}

function StatCell({ label, value, sub, tone, help, last }: { label: string; value: string; sub?: string; tone?: string; help?: string; last?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 128, padding: '12px 16px', borderRight: last ? 'none' : `1px solid ${T.border}` }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 6, display: 'flex', alignItems: 'center' }}>{label}{help && <HelpTip text={help} />}</div>
      <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: tone ?? T.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function PanelHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, display: 'flex', alignItems: 'center' }}>{title}</span>
      {right}
    </div>
  )
}

function RentalMarket({ rent }: { rent?: RentResp }) {
  return <div style={PANEL}>
    <PanelHead title="Rental Market" right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>{rent?.as_of ? `RentHub snapshot ${rent.as_of}` : 'RentHub'}</span>} />
    {!rent?.available ? <div style={{ padding: '18px 14px', fontFamily: T.mono, fontSize: 10, color: T.muted }}>Data unavailable. RentHub snapshot has not been ingested.</div> : <>
      <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${T.border}` }}>
        <StatCell label="Active Listings" value={rent.national?.listings.toLocaleString() ?? '—'} sub="snapshot coverage" />
        <StatCell label="Median Asking Rent" value={rent.national ? fmtK(rent.national.median_rent) : '—'} sub="all units" />
        <StatCell label="Median Rent / Sq Ft" value={rent.national?.median_rent_per_sqft ? `$${rent.national.median_rent_per_sqft.toFixed(2)}` : '—'} sub="where reported" />
        <StatCell label="One Bedroom" value={rent.national?.median_rent_1br ? fmtK(rent.national.median_rent_1br) : '—'} sub="median asking rent" />
        <StatCell label="Two Bedroom" value={rent.national?.median_rent_2br ? fmtK(rent.national.median_rent_2br) : '—'} sub="median asking rent" last />
      </div>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={{ ...th, textAlign: 'left' }}>State</th><th style={th}>Listings</th><th style={th}>Median rent</th><th style={th}>Rent / sq ft</th><th style={th}>1BR</th><th style={th}>2BR</th></tr></thead><tbody>{rent.states?.map(s => <tr key={s.state}><td style={{ ...td, textAlign: 'left', fontFamily: T.label, fontWeight: 700 }}>{s.state}</td><td style={td}>{s.listings.toLocaleString()}</td><td style={td}>{fmtK(s.median_rent)}</td><td style={td}>{s.median_rent_per_sqft ? `$${s.median_rent_per_sqft.toFixed(2)}` : '—'}</td><td style={td}>{s.median_rent_1br ? fmtK(s.median_rent_1br) : '—'}</td><td style={td}>{s.median_rent_2br ? fmtK(s.median_rent_2br) : '—'}</td></tr>)}</tbody></table></div>
    </>}
  </div>
}

export function HousingMarketContent() {
  const { data, isLoading, isError } = useQuery<Report>({
    queryKey: ['housing-report'],
    queryFn: () => axios.get('/api/housing/report').then(r => r.data),
    staleTime: 3_600_000, retry: 1,
  })
  const { data: rates } = useQuery<RatesResp>({
    queryKey: ['housing-rates'],
    queryFn: () => axios.get('/api/housing/rates').then(r => r.data),
    staleTime: 3_600_000, retry: 1,
  })
  const { data: rent } = useQuery<RentResp>({
    queryKey: ['housing-rent'], queryFn: () => axios.get('/api/housing/rent').then(r => r.data), staleTime: 12 * 3600e3, retry: 1,
  })

  const national = data?.by_region.find(r => r.region === 'national')

  return (
    <div style={{ width: '100%' }}>
      <PageHeader
        title="Housing Market"
        actions={data && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: T.mono, fontSize: 9, color: T.muted }}>
            {data.source && <span style={{ color: data.source.startsWith('FRED') ? T.pos : T.warn }}>{data.source.startsWith('FRED') ? 'FRED · St. Louis Fed' : data.source}</span>}
            <span>as of {data.asof}</span>
            {data.rates && <span>30Y {pct(data.rates.rate_30y)} · 15Y {pct(data.rates.rate_15y)} · ARM {pct(data.rates.rate_arm)}</span>}
          </div>
        )}
      />

      {isLoading && <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>Loading housing data…</div>}
      {isError && <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.neg, fontFamily: T.mono, fontSize: 11 }}>Failed to load housing data.</div>}
      {!isLoading && !isError && <RentalMarket rent={rent} />}
      {data && !national && <div style={{ ...PANEL, padding: '18px 14px', fontFamily: T.mono, fontSize: 10, color: T.muted }}>Data unavailable. FRED housing series could not be loaded.</div>}

      {data && national && (
        <>
          {/* National KPI strip */}
          <div style={PANEL}>
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              <StatCell label="30Y Fixed" value={pct(national.rate_30y)} sub="prevailing mortgage" />
              <StatCell label="Median Price" value={fmtK(national.median_price)} sub={`${signed(national.trends.median_price.yoy)} YoY`} tone={(national.trends.median_price.yoy ?? 0) >= 0 ? T.pos : T.neg} />
              <StatCell label="National HAI" value={national.affordability_index.toFixed(0)} sub={national.affordability_index >= 100 ? 'affordable' : 'stretched'} tone={national.affordability_index >= 100 ? T.pos : T.neg}
                help="Housing Affordability Index. 100 means a median-income household earns exactly enough to qualify for the median-priced home at current rates. Above 100 is affordable, below is stretched." />
              <StatCell label="Months of Supply" value={`${national.months_of_supply.toFixed(1)}`} sub={national.market} tone={MARKET_COLOR[national.market]}
                help="Months to sell every active listing at the current sales pace. Under about 6 favors sellers, over 6 favors buyers, under 3 is very tight." />
              <StatCell label="Days on Market" value={`${national.days_on_market.toFixed(0)}d`} sub={`${signed(national.trends.sales_volume.yoy)} sales YoY`}
                help="Median days a listing sits before going under contract. Rising days-on-market means demand is cooling." last />
            </div>
          </div>

          {/* Mortgage-rate history */}
          {rates && rates.history.length > 0 && (
            <div style={PANEL}>
              <PanelHead title="Mortgage Rates · 3-Year" right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, display: 'inline-flex', alignItems: 'center' }}>30Y · 15Y · 5/1 ARM<HelpTip placement="below-left" text="5/1 ARM is an adjustable-rate mortgage fixed for 5 years, then it resets annually. It often starts below the 30-year fixed but carries reset risk when rates rise." /></span>} />
              <div style={{ padding: 14 }}>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={rates.history} margin={{ left: 0, right: 12, top: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
                    <XAxis dataKey="asof" tick={{ fontFamily: T.mono, fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => v.slice(0, 7)} interval="preserveStartEnd" minTickGap={40} />
                    <YAxis tick={{ fontFamily: T.mono, fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} width={34} domain={['dataMin - 0.3', 'dataMax + 0.3']} />
                    <Tooltip contentStyle={{ background: T.surface, border: `1px solid color-mix(in srgb, var(--theme-primary) 25%, transparent)`, fontFamily: T.mono, fontSize: 10, padding: '8px 10px' }} labelStyle={{ color: T.gold, fontFamily: T.label, fontWeight: 700 }} formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]} />
                    <Line type="monotone" dataKey="rate_30y" name="30Y" stroke={T.gold} strokeWidth={1.6} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="rate_15y" name="15Y" stroke="#5b93c9" strokeWidth={1.4} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="rate_arm" name="ARM" stroke="#d07b34" strokeWidth={1.2} dot={false} strokeDasharray="4 3" isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Mortgage credit risk */}
          <div style={PANEL}>
            <PanelHead title="Mortgage Credit Risk" right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>national · by property type</span>} />
            <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${T.border}` }}>
              <StatCell label="Single-Family Default" value={pct(national.sf_default_rate)} sub={`${signed(national.trends.sf_default_rate.yoy)} YoY`} tone={national.sf_default_rate > 1 ? T.neg : T.text}
                help="Share of single-family home mortgages in serious delinquency or default (90+ days past due). Low and resilient historically, but ticks up as rates rise and equity thins." />
              <StatCell label="Multifamily Default" value={pctOrDash(national.mf_default_rate)} sub={`${signed(national.trends.mf_default_rate.yoy)} YoY`} tone={national.mf_default_rate > 1.5 ? T.neg : T.text}
                help="Share of multifamily (apartment) mortgages in default. More cyclical than single-family and sensitive to rising rates and refinancing stress on commercial-style loans." />
              <StatCell label="Serious Delinquency" value={pct(national.serious_delinquency)} sub="90+ days past due"
                help="All mortgages 90 or more days past due, as a share of loans outstanding. An early warning that leads foreclosures." />
              <StatCell label="Foreclosure Rate" value={pctOrDash(national.foreclosure_rate)} sub="in process"
                help="Mortgages actively in the foreclosure process. Lags delinquency and reflects deeper distress." />
              <StatCell label="Negative Equity" value={pctOrDash(national.negative_equity, 1)} sub="underwater"
                help="Mortgaged homes worth less than the loan balance. Rises when prices fall, and limits selling or refinancing." />
              <StatCell label="Orig. FICO / LTV" value={national.avg_fico > 0 ? `${national.avg_fico.toFixed(0)} / ${national.avg_ltv.toFixed(0)}%` : '—'} sub="lending standards"
                help="Average origination credit score and loan-to-value. Rising FICO with falling LTV means tighter lending standards." last />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Region</th>
                  <th style={th}>SF Default</th>
                  <th style={th}>MF Default</th>
                  <th style={th}>90+ DPD</th>
                  <th style={th}>Foreclosure</th>
                  <th style={th}>Neg. Equity</th>
                </tr></thead>
                <tbody>
                  {data.by_region.map(r => (
                    <tr key={r.region}>
                      <td style={{ ...td, textAlign: 'left', fontFamily: T.label, fontWeight: 700, color: r.region === 'national' ? T.gold : T.text }}>{r.region_label}</td>
                      <td style={{ ...td, color: r.sf_default_rate > 1 ? T.neg : T.text }}>{pct(r.sf_default_rate)}</td>
                      <td style={{ ...td, color: r.mf_default_rate > 1.5 ? T.neg : T.text }}>{pct(r.mf_default_rate)}</td>
                      <td style={td}>{pct(r.serious_delinquency)}</td>
                      <td style={td}>{pct(r.foreclosure_rate)}</td>
                      <td style={td}>{pct(r.negative_equity, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Regional table */}
          <div style={PANEL}>
            <PanelHead title="Regional Detail" />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Region</th>
                  <th style={th}>Median Price</th>
                  <th style={th}>Price / Income<HelpTip placement="below" text="Median home price divided by median household income. Higher means homes cost more years of income, a more stretched market." /></th>
                  <th style={th}>Supply (mo)<HelpTip placement="below" text="Months to sell every active listing at the current sales pace. Under about 6 favors sellers, over 6 favors buyers, under 3 is very tight." /></th>
                  <th style={th}>DoM<HelpTip placement="below" text="Days on Market. Median days a listing sits before going under contract. Rising DoM means demand is cooling." /></th>
                  <th style={th}>HAI<HelpTip placement="below-left" text="Housing Affordability Index. 100 means a median-income household earns exactly enough to qualify for the median-priced home at current rates. Above 100 is affordable, below is stretched." /></th>
                  <th style={{ ...th, textAlign: 'center' }}>Market<HelpTip placement="below-left" text="Buyer, seller, or balanced, read from months of supply. Tight supply favors sellers, ample supply favors buyers." /></th>
                  <th style={{ ...th, textAlign: 'left' }}>Price Trend</th>
                </tr></thead>
                <tbody>
                  {data.by_region.map(r => {
                    return (
                      <tr key={r.region}>
                        <td style={{ ...td, textAlign: 'left', fontFamily: T.label, fontWeight: 700, color: r.region === 'national' ? T.gold : T.text }}>{r.region_label}</td>
                        <td style={td}>{fmtK(r.median_price)}</td>
                        <td style={td}>{r.price_to_income.toFixed(2)}x</td>
                        <td style={{ ...td, color: r.months_of_supply < 3 ? T.neg : T.text }}>{r.months_of_supply.toFixed(1)}</td>
                        <td style={td}>{r.days_on_market.toFixed(0)}d</td>
                        <td style={{ ...td, fontWeight: 700, color: r.affordability_index >= 100 ? T.pos : T.neg }}>{r.affordability_index.toFixed(0)}</td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: MARKET_COLOR[r.market], border: `1px solid ${MARKET_COLOR[r.market]}`, padding: '2px 7px' }}>{r.market}</span>
                        </td>
                        <td style={{ ...td, textAlign: 'left' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Sparkline series={r.history.map(h => h.median_price)} up={(r.trends.median_price.yoy ?? 0) >= 0} />
                            <span style={{ fontFamily: T.mono, fontSize: 9, color: (r.trends.median_price.yoy ?? 0) >= 0 ? T.pos : T.neg }}>{signed(r.trends.median_price.yoy)}</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {data.flags.length > 0 && (
              <div style={{ padding: '12px 14px', borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.flags.map((f, i) => (
                  <div key={i} style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 6, height: 6, background: T.neg, flex: 'none' }} />
                    <span style={{ color: T.text, textTransform: 'capitalize' }}>{f.region}</span> · {f.detail}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function HousingMarket() {
  return <PageWrapper><HousingMarketContent /></PageWrapper>
}
