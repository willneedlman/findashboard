import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import HelpTip from '../components/HelpTip'
import useIsMobile from '../hooks/useIsMobile'

interface CreditPoint { asof: string; delinquency_rate: number; chargeoff_rate: number | null }
interface CreditClass {
  asset_class: string
  label: string
  asof: string
  delinquency_rate: number
  chargeoff_rate: number | null
  trend: CreditPoint[]
}
interface StressPoint { asof: string; value: number }
interface StressIndicator {
  key: string
  label: string
  asof: string
  value: number
  previous: number | null
  unit: 'index' | 'percent'
  frequency: string
  interpretation: string
  trend: StressPoint[]
  source: string
}
interface Summary {
  available: boolean
  source: string
  as_of: string | null
  asset_classes: CreditClass[]
  stress_indicators: StressIndicator[]
  method_note: string
}
interface FdicBank { name: string | null; cert: string | number | null; assets: number | null; deposits: number | null; roa: number | null; nim: number | null; net_chargeoffs: number | null; as_of: string }
interface FdicResponse { available: boolean; banks?: FdicBank[]; source: string; as_of?: string | null }

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const ORANGE = '#d07b34'
const PURPLE = '#c084fc'
const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}` }
const COLORS = [GOLD, BLUE, ORANGE, PURPLE, '#34d399']
const axisTick = { fontFamily: T.mono, fontSize: 8, fill: T.muted }
const tooltipStyle: React.CSSProperties = { backgroundColor: T.bg, border: '1px solid color-mix(in srgb, var(--theme-primary) 32%, var(--theme-border))', color: T.text, boxShadow: 'none', fontFamily: T.mono, fontSize: 10, padding: '8px 10px' }

function ageLabel(date: string | null | undefined) {
  if (!date) return ''
  const days = Math.max(0, Math.floor((Date.now() - new Date(`${date}T00:00:00`).getTime()) / 86_400_000))
  return days <= 1 ? 'current' : `${days}d old`
}

function fmtPct(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`
}

function fmtBankBalance(value: number | null) {
  if (value == null) return '—'
  const billions = value / 1_000_000
  if (billions >= 1_000) return `$${(billions / 1_000).toFixed(2)}T`
  return `$${billions.toFixed(billions >= 100 ? 0 : 1)}B`
}

function indicatorValue(indicator: StressIndicator) {
  return indicator.unit === 'percent' ? fmtPct(indicator.value, 1) : indicator.value.toFixed(3)
}

function indicatorTone(indicator: StressIndicator) {
  if (indicator.unit === 'index') return indicator.value > 0 ? T.neg : T.pos
  return indicator.value > 20 ? T.neg : indicator.value > 0 ? GOLD : T.pos
}

function indicatorState(indicator: StressIndicator) {
  if (indicator.unit === 'index') return indicator.value > 0 ? 'above-average stress' : 'below-average stress'
  return indicator.value > 0 ? 'net tightening' : 'net easing'
}

function PanelHead({ title, meta, help }: { title: string; meta?: string; help?: string }) {
  return <div style={{ minHeight: 36, padding: '0 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)' }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.text }}>{title}{help && <HelpTip text={help} width={300} position="bottom" anchor="left" />}</span>
    {meta && <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{meta}</span>}
  </div>
}

function StressMetric({ indicator, last }: { indicator: StressIndicator; last: boolean }) {
  return <div style={{ minWidth: 190, padding: '14px 16px', borderRight: last ? 'none' : `1px solid ${T.border}` }}>
    <div style={{ minHeight: 24, fontFamily: T.label, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.1em', lineHeight: 1.35, textTransform: 'uppercase', color: T.muted }}>{indicator.label}</div>
    <div style={{ marginTop: 5, fontFamily: T.mono, fontSize: 22, fontWeight: 800, lineHeight: 1, color: indicatorTone(indicator), fontVariantNumeric: 'tabular-nums' }}>{indicatorValue(indicator)}</div>
    <div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{indicatorState(indicator)}</div>
    <div style={{ marginTop: 3, fontFamily: T.mono, fontSize: 8, color: T.textDim }}>{indicator.frequency} · {indicator.asof} · {ageLabel(indicator.asof)}</div>
  </div>
}

function CreditCard({ item, color }: { item: CreditClass; color: string }) {
  const previous = item.trend.length > 1 ? item.trend[item.trend.length - 2].delinquency_rate : null
  const change = previous == null ? null : item.delinquency_rate - previous
  return <div style={{ padding: '14px 15px', border: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.012)' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text }}>{item.label}</span>
      <span style={{ width: 8, height: 8, background: color }} />
    </div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 12 }}>
      <span style={{ fontFamily: T.mono, fontSize: 25, fontWeight: 800, color: item.delinquency_rate >= 3 ? T.neg : T.text }}>{fmtPct(item.delinquency_rate)}</span>
      <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>delinquent</span>
    </div>
    <div style={{ minHeight: 28, marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>
      {change != null && <span style={{ color: change > 0 ? T.neg : T.pos }}>{change >= 0 ? '+' : '-'}{Math.abs(change).toFixed(2)} pts QoQ</span>}
      {item.chargeoff_rate != null && <span>{fmtPct(item.chargeoff_rate)} charge-off</span>}
    </div>
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}`, fontFamily: T.mono, fontSize: 8, color: T.textDim }}>FRED · {item.asof}</div>
  </div>
}

function mergeSeries(indicators: StressIndicator[]) {
  const byDate: Record<string, Record<string, string | number>> = {}
  for (const indicator of indicators) {
    for (const point of indicator.trend) {
      byDate[point.asof] = { ...(byDate[point.asof] ?? { asof: point.asof }), [indicator.key]: point.value }
    }
  }
  return Object.values(byDate).sort((a, b) => String(a.asof).localeCompare(String(b.asof)))
}

export function CreditDelinquenciesContent() {
  const isMobile = useIsMobile()
  const { data, isLoading, isError } = useQuery<Summary>({ queryKey: ['credit-summary-v2'], queryFn: () => axios.get('/api/credit/summary').then(response => response.data), staleTime: 12 * 3_600_000, retry: 1 })
  const { data: fdic } = useQuery<FdicResponse>({ queryKey: ['fdic-bank-system'], queryFn: () => axios.get('/api/official/fdic').then(response => response.data), staleTime: 24 * 3_600_000, retry: 1 })
  const indicators = data?.stress_indicators ?? []
  const marketIndicators = indicators.filter(item => item.unit === 'index')
  const lendingIndicators = indicators.filter(item => item.unit === 'percent')
  const classes = data?.asset_classes ?? []
  const marketRows = mergeSeries(marketIndicators)
  const lendingRows = mergeSeries(lendingIndicators)
  const creditRows = classes.reduce<Record<string, Record<string, string | number>>>((rows, item) => {
    for (const point of item.trend) rows[point.asof] = { ...(rows[point.asof] ?? { asof: point.asof }), [item.asset_class]: point.delinquency_rate }
    return rows
  }, {})
  const creditChart = Object.values(creditRows).sort((a, b) => String(a.asof).localeCompare(String(b.asof)))

  return <div style={{ width: '100%' }}>
    <PageHeader title="Credit Stress" actions={data?.as_of ? <div style={{ display: 'flex', gap: 10, fontFamily: T.mono, fontSize: 8.5, color: T.muted }}><span style={{ color: T.pos }}>{data.source}</span><span>latest observation {data.as_of} · {ageLabel(data.as_of)}</span></div> : undefined} />

    {isLoading && <EmptyState title="Loading Credit Stress" hint="Assembling financial stress, lending standards, delinquency, and charge-off observations." kpis={['Financial Stress', 'Financial Conditions', 'C&I Standards', 'Card Standards']} preview="chart" previewLabel="Credit Conditions" />}
    {isError && <EmptyState title="Credit Stress Unavailable" hint="Federal Reserve series could not be reached. No modeled or simulated fallback is shown." kpis={['Financial Stress', 'Financial Conditions', 'C&I Standards', 'Card Standards']} preview="chart" previewLabel="Credit Conditions" />}
    {data && !data.available && <EmptyState title="Credit Stress Unavailable" hint="A FRED API key is required to load the observed Federal Reserve series." kpis={['Financial Stress', 'Financial Conditions', 'C&I Standards', 'Card Standards']} preview="chart" previewLabel="Credit Conditions" />}

    {data?.available && <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!!indicators.length && <section style={PANEL}>
        <PanelHead title="System Credit Pulse" meta="observed Federal Reserve series · positive values indicate tightening or stress" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>{indicators.map((indicator, index) => <StressMetric key={indicator.key} indicator={indicator} last={index === indicators.length - 1} />)}</div>
      </section>}

      {(marketIndicators.length > 0 || lendingIndicators.length > 0) && <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        {marketIndicators.length > 0 && <section style={PANEL}>
          <PanelHead title="Market Financial Stress" meta="weekly · zero = historical average" help="Composite Federal Reserve stress indexes. Zero is the historical average; positive values mean more stress and negative values mean less. Values are indexes, not percentages." />
          <div style={{ padding: '15px 12px 8px' }}><ResponsiveContainer width="100%" height={245}>
            <LineChart data={marketRows} margin={{ left: 2, right: 12, top: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
              <XAxis dataKey="asof" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => String(value).slice(0, 7)} interval="preserveStartEnd" minTickGap={45} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} width={38} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: GOLD }} formatter={(value: number, name: string) => [Number(value).toFixed(3), marketIndicators.find(item => item.key === name)?.label ?? name]} />
              {marketIndicators.map((indicator, index) => <Line key={indicator.key} type="monotone" dataKey={indicator.key} stroke={COLORS[index]} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} />)}
            </LineChart>
          </ResponsiveContainer></div>
          <div style={legendStyle}>{marketIndicators.map((indicator, index) => <Legend key={indicator.key} color={COLORS[index]} label={indicator.label} />)}</div>
        </section>}

        {lendingIndicators.length > 0 && <section style={PANEL}>
          <PanelHead title="Bank Lending Standards" meta="SLOOS · quarterly · net % tightening" help="Net share of surveyed banks tightening standards. Positive means more banks tightened than eased; negative means more eased. It is not a delinquency or rejection rate." />
          <div style={{ padding: '15px 12px 8px' }}><ResponsiveContainer width="100%" height={245}>
            <LineChart data={lendingRows} margin={{ left: 2, right: 12, top: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
              <XAxis dataKey="asof" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => String(value).slice(0, 7)} interval="preserveStartEnd" minTickGap={45} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => `${value}%`} width={40} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: GOLD }} formatter={(value: number, name: string) => [`${Number(value).toFixed(1)}%`, lendingIndicators.find(item => item.key === name)?.label ?? name]} />
              {lendingIndicators.map((indicator, index) => <Line key={indicator.key} type="monotone" dataKey={indicator.key} stroke={COLORS[index + 2]} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} />)}
            </LineChart>
          </ResponsiveContainer></div>
          <div style={legendStyle}>{lendingIndicators.map((indicator, index) => <Legend key={indicator.key} color={COLORS[index + 2]} label={indicator.label} />)}</div>
        </section>}
      </div>}

      {!!classes.length && <section style={PANEL}>
        <PanelHead title="Bank Credit Health" meta="all commercial banks · quarterly · 30+ days past due" />
        <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(205px, 1fr))', gap: 8 }}>{classes.map((item, index) => <CreditCard key={item.asset_class} item={item} color={COLORS[index]} />)}</div>
      </section>}

      {!!creditChart.length && <section style={PANEL}>
        <PanelHead title="Delinquency Trend by Loan Category" meta="36-month observation window" />
        <div style={{ padding: '15px 12px 8px' }}><ResponsiveContainer width="100%" height={280}>
          <LineChart data={creditChart} margin={{ left: 2, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
            <XAxis dataKey="asof" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => String(value).slice(0, 7)} interval="preserveStartEnd" minTickGap={45} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => `${value}%`} width={38} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: GOLD }} formatter={(value: number, name: string) => [fmtPct(Number(value)), classes.find(item => item.asset_class === name)?.label ?? name]} />
            {classes.map((item, index) => <Line key={item.asset_class} type="monotone" dataKey={item.asset_class} stroke={COLORS[index]} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer></div>
        <div style={legendStyle}>{classes.map((item, index) => <Legend key={item.asset_class} color={COLORS[index]} label={item.label} />)}</div>
      </section>}

      {fdic?.available && <FdicPanel data={fdic} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', padding: '0 2px', fontFamily: T.mono, fontSize: 8.5, color: T.textDim }}>
        <span>{data.method_note}</span>
        <span>Sources: St. Louis Fed · Chicago Fed · Federal Reserve Board SLOOS · FRED bank aggregates</span>
      </div>
    </div>}
  </div>
}

function FdicPanel({ data }: { data: FdicResponse }) {
  const banks = data.banks ?? []
  const totalAssets = banks.reduce((sum, bank) => sum + (bank.assets ?? 0), 0)
  const topFourAssets = banks.slice(0, 4).reduce((sum, bank) => sum + (bank.assets ?? 0), 0)
  const totalDeposits = banks.reduce((sum, bank) => sum + (bank.deposits ?? 0), 0)
  const weighted = (field: 'roa' | 'nim' | 'net_chargeoffs') => {
    const eligible = banks.filter(bank => bank.assets != null && bank[field] != null)
    const assets = eligible.reduce((sum, bank) => sum + (bank.assets ?? 0), 0)
    return assets ? eligible.reduce((sum, bank) => sum + (bank.assets ?? 0) * (bank[field] ?? 0), 0) / assets : null
  }
  const asOf = data.as_of && /^\d{8}$/.test(data.as_of) ? `${data.as_of.slice(0, 4)} Q${Math.ceil(Number(data.as_of.slice(4, 6)) / 3)}` : data.as_of ?? 'latest filing'
  const nco = weighted('net_chargeoffs')
  const crossSection = [...banks].sort((a, b) => (b.net_chargeoffs ?? -Infinity) - (a.net_chargeoffs ?? -Infinity)).map(bank => ({
    ...bank,
    short_name: (bank.name ?? '—').replace(' NATIONAL ASSN', '').replace(' BANK NA', '').replace(' BANK USA', '').replace(' BANK&TRUST CO', ''),
  }))
  const summary = [
    { label: 'Asset-weighted NCO', value: nco == null ? '—' : `${nco.toFixed(2)}%`, note: 'credit-loss rate in tracked group', tone: nco != null && nco > 1 ? T.neg : T.text },
    { label: 'Asset-weighted ROA', value: weighted('roa') == null ? '—' : `${weighted('roa')!.toFixed(2)}%`, note: 'reported profitability', tone: T.pos },
    { label: 'Deposit funding', value: totalAssets ? `${(totalDeposits / totalAssets * 100).toFixed(1)}%` : '—', note: 'deposits as share of assets', tone: T.blue },
    { label: 'Top-four concentration', value: totalAssets ? `${(topFourAssets / totalAssets * 100).toFixed(1)}%` : '—', note: 'assets in tracked group', tone: T.text },
  ]
  const columns = [
    { label: 'Institution' },
    { label: 'Total deposits' },
    { label: 'Total assets' },
    { label: 'NCO', help: 'Net charge-offs. Loans written off after recoveries.' },
    { label: 'ROA', help: 'Return on assets. Annualized profitability.' },
    { label: 'NIM', help: 'Net interest margin. Annualized net interest income.' },
  ]
  return <section style={PANEL}>
    <PanelHead title="FDIC credit stress cross-section" meta={`Call Reports · ${asOf}`} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', borderBottom: `1px solid ${T.border}` }}>{summary.map((item, index) => <div key={item.label} style={{ minHeight: 76, padding: '11px 14px', borderRight: index === summary.length - 1 ? 'none' : `1px solid ${T.border}` }}><div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>{item.label}</div><div style={{ marginTop: 5, fontFamily: T.mono, fontSize: 17, fontWeight: 800, color: item.tone, fontVariantNumeric: 'tabular-nums' }}>{item.value}</div><div style={{ marginTop: 4, fontFamily: T.mono, fontSize: 8, color: T.textDim }}>{item.note}</div></div>)}</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))' }}>
      <div style={{ minWidth: 0, padding: '12px 8px 8px', borderRight: `1px solid ${T.border}` }}><div style={{ padding: '0 6px 8px', fontFamily: T.label, fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>Net charge-off dispersion</div><ResponsiveContainer width="100%" height={290}><BarChart layout="vertical" data={crossSection} margin={{ top: 4, right: 18, left: 2, bottom: 2 }}><CartesianGrid strokeDasharray="2 4" stroke={T.borderFaint} horizontal={false} /><XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={value => `${Number(value).toFixed(1)}%`} /><YAxis type="category" dataKey="short_name" tick={axisTick} tickLine={false} axisLine={false} width={122} /><Tooltip contentStyle={tooltipStyle} labelStyle={{ color: GOLD }} formatter={(value: number, name: string) => [name === 'net_chargeoffs' ? `${value.toFixed(2)}%` : value, name === 'net_chargeoffs' ? 'Net charge-offs' : name]} /><ReferenceLine x={nco ?? 0} stroke={T.gold} strokeDasharray="4 3" /><Bar dataKey="net_chargeoffs" radius={[0, 2, 2, 0]}>{crossSection.map(bank => <Cell key={bank.cert} fill={(bank.net_chargeoffs ?? 0) > (nco ?? Infinity) ? T.neg : T.blue} />)}</Bar></BarChart></ResponsiveContainer><div style={{ padding: '4px 6px 0', fontFamily: T.mono, fontSize: 8, color: T.textDim }}>Gold marker: asset-weighted NCO for the tracked group.</div></div>
      <div style={{ minWidth: 0, overflowX: 'auto' }}><div style={{ minWidth: 680 }}><div style={{ padding: '12px 14px 8px', fontFamily: T.label, fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>Institutional stress matrix</div><table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 9.5 }}><thead><tr>{columns.map((column, index) => <th key={column.label} style={{ padding: '7px 14px', color: T.muted, fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', textAlign: index === 0 ? 'left' : 'right', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}><span style={{ display: 'inline-flex', alignItems: 'center' }}>{column.label}{column.help && <HelpTip text={column.help} width={180} position="bottom" anchor="right" />}</span></th>)}</tr></thead><tbody>{crossSection.map(bank => <tr key={`${bank.cert}-${bank.name}`} style={{ borderBottom: `1px solid ${T.borderFaint}` }}><td style={{ padding: '8px 14px', color: T.text, fontWeight: 700, whiteSpace: 'nowrap' }}>{bank.short_name}</td><td style={{ padding: '8px 14px', color: T.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtBankBalance(bank.deposits)}</td><td style={{ padding: '8px 14px', color: T.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtBankBalance(bank.assets)}</td><td style={{ padding: '8px 14px', color: bank.net_chargeoffs != null && bank.net_chargeoffs > (nco ?? Infinity) ? T.neg : T.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{bank.net_chargeoffs == null ? '—' : `${bank.net_chargeoffs.toFixed(2)}%`}</td><td style={{ padding: '8px 14px', color: T.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{bank.roa == null ? '—' : `${bank.roa.toFixed(2)}%`}</td><td style={{ padding: '8px 14px', color: T.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{bank.nim == null ? '—' : `${bank.nim.toFixed(2)}%`}</td></tr>)}</tbody></table></div></div>
    </div>
  </section>
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 2, background: color }} /><span>{label}</span></span>
}

const legendStyle: React.CSSProperties = { minHeight: 34, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', borderTop: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 8.5 }

export default function CreditDelinquencies() {
  return <PageWrapper><CreditDelinquenciesContent /></PageWrapper>
}
