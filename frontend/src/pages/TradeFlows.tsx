import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import { SELECT, LABEL } from './valuationShared'
import { fetchTradeFlows } from '../hooks/useApi'
import { T } from '../lib/theme'
import { MONO, SANS, mix, seg, KpiStrip } from './cockpitKit'

interface Partner { partner: string | null; iso: string | null; value: number | null; net_wgt: number | null; qty: number | null; unit: string | null }
interface Resp {
  available: boolean; reporter?: string; commodity?: string; cmd_code?: string; flow?: string; period?: string
  total?: { value: number | null; net_wgt: number | null }; world_share?: number | null
  partners?: Partner[]; partner_count?: number; source?: string
}

const COUNTRIES: [number, string][] = [
  [842, 'United States'], [156, 'China'], [276, 'Germany'], [392, 'Japan'], [826, 'United Kingdom'],
  [250, 'France'], [699, 'India'], [528, 'Netherlands'], [682, 'Saudi Arabia'], [643, 'Russia'],
  [124, 'Canada'], [76, 'Brazil'], [410, 'South Korea'], [36, 'Australia'], [484, 'Mexico'],
  [380, 'Italy'], [702, 'Singapore'], [784, 'United Arab Emirates'], [724, 'Spain'], [578, 'Norway'],
  [634, 'Qatar'], [364, 'Iran'], [566, 'Nigeria'], [458, 'Malaysia'], [360, 'Indonesia'], [704, 'Viet Nam'],
]
const COMMODITIES: [string, string][] = [
  ['TOTAL', 'All commodities'], ['2709', 'Crude oil'], ['2710', 'Refined petroleum'], ['2711', 'Petroleum gas / LNG'],
  ['2701', 'Coal'], ['2601', 'Iron ore'], ['7403', 'Refined copper'], ['7108', 'Gold'], ['7601', 'Aluminium'],
  ['1001', 'Wheat'], ['1005', 'Maize (corn)'], ['1201', 'Soybeans'], ['8542', 'Semiconductors (ICs)'],
  ['8703', 'Cars'], ['3004', 'Pharmaceuticals'], ['7208', 'Flat-rolled steel'], ['8471', 'Computers'],
]
const YEARS = Array.from({ length: 10 }, (_, i) => String(2025 - i))

const fmtUsd = (v: number | null | undefined) => {
  if (v == null) return '—'
  const a = Math.abs(v)
  return a >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${v.toFixed(0)}`
}
const fmtWt = (kg: number | null | undefined) => {
  if (kg == null || kg === 0) return '—'
  const t = kg / 1000
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)}Mt` : t >= 1e3 ? `${(t / 1e3).toFixed(0)}kt` : `${t.toFixed(0)}t`
}

export default function TradeFlows() {
  const [reporter, setReporter] = useState(842)
  const [cmd, setCmd] = useState('2709')
  const [year, setYear] = useState('2024')
  const [flow, setFlow] = useState<'X' | 'M'>('X')

  const cmdLabel = COMMODITIES.find(c => c[0] === cmd)?.[1] ?? cmd
  const countryLabel = COUNTRIES.find(c => c[0] === reporter)?.[1] ?? String(reporter)

  const m = useMutation<Resp>({
    mutationFn: () => fetchTradeFlows({ reporter, period: year, cmd, flow }),
  })

  const rail = (
    <div style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Reporter country</div>
        <select value={reporter} onChange={e => setReporter(Number(e.target.value))} style={SELECT}>
          {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
      </div>
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Commodity</div>
        <select value={cmd} onChange={e => setCmd(e.target.value)} style={SELECT}>
          {COMMODITIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
      </div>
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Year</div>
        <select value={year} onChange={e => setYear(e.target.value)} style={SELECT}>
          {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Flow</div>
        <div style={{ display: 'flex', gap: 5 }}>
          <button onClick={() => setFlow('X')} style={seg(flow === 'X')}>Exports</button>
          <button onClick={() => setFlow('M')} style={seg(flow === 'M')}>Imports</button>
        </div>
      </div>
      <div style={{ padding: '13px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button onClick={() => m.mutate()} disabled={m.isPending} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, background: mix(T.gold, 8), padding: '9px 8px', cursor: m.isPending ? 'wait' : 'pointer' }}>{m.isPending ? 'Loading' : 'Show flows'}</button>
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, lineHeight: 1.5 }}>UN Comtrade, one commodity and year per query.</div>
      </div>
    </div>
  )

  return (
    <PageWrapper title="Trade Flows">
      <SidebarLayout sidebar={rail} sidebarTitle="Query">
        {m.isPending ? <LoadingState label="Fetching bilateral trade from UN Comtrade" />
          : m.error ? <ErrorState message={(m.error as any)?.response?.data?.detail || 'Could not load trade flows.'} onRetry={() => m.mutate()} />
          : m.data ? (m.data.available ? <Results d={m.data} cmdLabel={cmdLabel} countryLabel={countryLabel} /> : <NoData countryLabel={countryLabel} cmdLabel={cmdLabel} year={year} flow={flow} />)
          : <EmptyState title="Who trades what, with whom." hint="Pick a country, commodity, and year to see its top trading partners by value and tonnage, with its share of world trade. UN Comtrade, free tier." keys={['Bilateral flows', 'By commodity', 'World share']} />}
      </SidebarLayout>
    </PageWrapper>
  )
}

function NoData({ countryLabel, cmdLabel, year, flow }: { countryLabel: string; cmdLabel: string; year: string; flow: string }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 12, color: T.muted, background: T.surface, border: `1px solid ${T.border}`, padding: '18px 20px', lineHeight: 1.6 }}>
      No Comtrade data for {countryLabel} · {cmdLabel} · {year} · {flow === 'X' ? 'exports' : 'imports'}. Not every
      country reports every commodity each year. Try a nearby year, All commodities, or a major reporter.
    </div>
  )
}

function Results({ d, cmdLabel, countryLabel }: { d: Resp; cmdLabel: string; countryLabel: string }) {
  const partners = d.partners ?? []
  const maxVal = useMemo(() => Math.max(1, ...partners.map(p => p.value ?? 0)), [partners])
  const kpis = [
    { label: 'Total ' + (d.flow?.toLowerCase() ?? 'flow'), value: fmtUsd(d.total?.value), vc: T.gold, sub: fmtWt(d.total?.net_wgt) },
    { label: 'World trade share', value: d.world_share != null ? `${(d.world_share * 100).toFixed(1)}%` : '—', sub: `${countryLabel}, all goods` },
    { label: 'Trading partners', value: String(d.partner_count ?? partners.length), sub: 'reporting counterparties' },
    { label: 'Top partner', value: partners[0]?.partner ?? '—', color: T.blue, sub: partners[0] ? fmtUsd(partners[0].value) : undefined },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontFamily: SANS, fontSize: 12.5, color: T.text, margin: 0 }}>
        <span style={{ color: T.gold, fontWeight: 700 }}>{countryLabel}</span> {d.flow?.toLowerCase()} of{' '}
        <span style={{ fontWeight: 700 }}>{cmdLabel}</span>, {d.period}. Values are USD, tonnage is net weight.
      </p>
      <KpiStrip cells={kpis} />
      <div style={{ background: T.surface, border: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.gold }}>Top trading partners</span>
          <span style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted }}>{d.source}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11.5 }}>
            <thead>
              <tr>{['#', 'Partner', 'Value', '', 'Tonnage', 'Share'].map((h, i) => (
                <th key={i} style={{ textAlign: i === 1 || i === 3 ? 'left' : i === 0 ? 'left' : 'right', padding: '7px 12px', fontSize: 8.5, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {partners.map((p, i) => {
                const share = d.total?.value ? (p.value ?? 0) / d.total.value * 100 : null
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${mix(T.text, 4)}` }}>
                    <td style={{ padding: '6px 12px', color: T.textDim }}>{i + 1}</td>
                    <td style={{ padding: '6px 12px', color: T.text, fontWeight: 700, whiteSpace: 'nowrap' }}>{p.partner ?? p.iso ?? '?'}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap' }}>{fmtUsd(p.value)}</td>
                    <td style={{ padding: '6px 12px', width: '30%', minWidth: 120 }}>
                      <div style={{ height: 7, background: T.bg }}><div style={{ height: '100%', width: `${((p.value ?? 0) / maxVal) * 100}%`, background: T.gold, opacity: 0.8 }} /></div>
                    </td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted, whiteSpace: 'nowrap' }}>{fmtWt(p.net_wgt)}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted }}>{share != null ? `${share.toFixed(1)}%` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
