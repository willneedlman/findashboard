import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import { SELECT, LABEL } from './valuationShared'
import { fetchTradeFlows } from '../hooks/useApi'
import { T } from '../lib/theme'
import { MONO, SANS, mix, seg, Panel, KpiStrip } from './cockpitKit'

interface Partner { partner: string | null; iso: string | null; value: number | null; net_wgt: number | null; qty: number | null; unit: string | null }
interface Resp {
  available: boolean; reporter?: string; reporter_iso?: string; commodity?: string; cmd_code?: string; flow?: string; period?: string
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
  const [request, setRequest] = useState({ reporter: 842, cmd: '2709', year: '2024', flow: 'X' as 'X' | 'M' })

  const cmdLabel = COMMODITIES.find(c => c[0] === request.cmd)?.[1] ?? request.cmd
  const countryLabel = COUNTRIES.find(c => c[0] === request.reporter)?.[1] ?? String(request.reporter)
  const dirty = reporter !== request.reporter || cmd !== request.cmd || year !== request.year || flow !== request.flow

  const q = useQuery<Resp>({
    queryKey: ['trade-flows', request],
    queryFn: () => fetchTradeFlows({ reporter: request.reporter, period: request.year, cmd: request.cmd, flow: request.flow }),
    staleTime: 300_000,
  })

  const run = () => dirty ? setRequest({ reporter, cmd, year, flow }) : q.refetch()

  return (
    <PageWrapper title="Trade Flows">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <QueryBar reporter={reporter} setReporter={setReporter} cmd={cmd} setCmd={setCmd} year={year} setYear={setYear} flow={flow} setFlow={setFlow} run={run} loading={q.isFetching} dirty={dirty} />
        {q.isLoading ? <LoadingState label="Fetching bilateral trade from UN Comtrade" />
          : q.error ? <ErrorState message={(q.error as any)?.response?.data?.detail || 'Could not load trade flows.'} onRetry={() => q.refetch()} />
          : q.data?.available ? <Results d={q.data} cmdLabel={cmdLabel} countryLabel={countryLabel} />
          : <NoData countryLabel={countryLabel} cmdLabel={cmdLabel} year={request.year} flow={request.flow} />}
      </div>
    </PageWrapper>
  )
}

function QueryBar({ reporter, setReporter, cmd, setCmd, year, setYear, flow, setFlow, run, loading, dirty }: {
  reporter: number; setReporter: (v: number) => void; cmd: string; setCmd: (v: string) => void
  year: string; setYear: (v: string) => void; flow: 'X' | 'M'; setFlow: (v: 'X' | 'M') => void
  run: () => void; loading: boolean; dirty: boolean
}) {
  return (
    <Panel label="Trade Query" meta="UN Comtrade · annual bilateral flows" style={{ padding: '36px 12px 10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1.35fr 0.6fr 1fr auto', alignItems: 'end', gap: 8 }}>
        <label><span style={{ ...LABEL, display: 'block', marginBottom: 5 }}>Reporter country</span><select value={reporter} onChange={e => setReporter(Number(e.target.value))} style={{ ...SELECT, width: '100%' }}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label><span style={{ ...LABEL, display: 'block', marginBottom: 5 }}>Commodity</span><select value={cmd} onChange={e => setCmd(e.target.value)} style={{ ...SELECT, width: '100%' }}>{COMMODITIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label><span style={{ ...LABEL, display: 'block', marginBottom: 5 }}>Year</span><select value={year} onChange={e => setYear(e.target.value)} style={{ ...SELECT, width: '100%' }}>{YEARS.map(y => <option key={y} value={y}>{y}</option>)}</select></label>
        <div><div style={{ ...LABEL, marginBottom: 5 }}>Flow</div><div style={{ display: 'flex', gap: 5 }}><button onClick={() => setFlow('X')} style={seg(flow === 'X')}>Exports</button><button onClick={() => setFlow('M')} style={seg(flow === 'M')}>Imports</button></div></div>
        <button onClick={run} disabled={loading} style={{ height: 30, minWidth: 112, fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, background: mix(T.gold, dirty ? 12 : 6), padding: '0 14px', cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1 }}>{loading ? 'Loading' : dirty ? 'Update flows' : 'Refresh'}</button>
      </div>
    </Panel>
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
  const [selected, setSelected] = useState(0)
  const topFive = d.total?.value ? partners.slice(0, 5).reduce((s, p) => s + (p.value ?? 0), 0) / d.total.value * 100 : null
  const selectedPartner = partners[Math.min(selected, Math.max(0, partners.length - 1))]
  const kpis = [
    { label: 'Total ' + (d.flow?.toLowerCase() ?? 'flow'), value: fmtUsd(d.total?.value), vc: T.gold, sub: fmtWt(d.total?.net_wgt), tip: { title: 'Total declared flow', body: `${countryLabel} reported ${fmtUsd(d.total?.value)} of ${cmdLabel.toLowerCase()} ${d.flow?.toLowerCase()} in ${d.period}.`, source: 'UN Comtrade' } },
    { label: 'World trade share', value: d.world_share != null ? `${(d.world_share * 100).toFixed(1)}%` : '—', sub: `${countryLabel}, all goods`, tip: { title: 'World trade share', body: `The reporter's share of total world merchandise trade across all goods for ${d.period}.`, source: 'UN Comtrade' } },
    { label: 'Trading partners', value: String(d.partner_count ?? partners.length), sub: 'reporting counterparties' },
    { label: 'Top partner', value: partners[0]?.partner ?? '—', vc: T.blue, sub: partners[0] ? fmtUsd(partners[0].value) : undefined },
    { label: 'Top 5 concentration', value: topFive != null ? `${topFive.toFixed(1)}%` : '—', sub: 'share of reported value' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KpiStrip cells={kpis} />
      <div style={{ display: 'flex', gap: 10 }}>
        <FlowOverview d={d} partners={partners} selected={selected} onSelect={setSelected} countryLabel={countryLabel} cmdLabel={cmdLabel} />
        {selectedPartner && <PartnerDock partner={selectedPartner} rank={selected + 1} total={d.total?.value} flow={d.flow} countryLabel={countryLabel} />}
      </div>
      <PartnerTable partners={partners} total={d.total?.value} maxVal={maxVal} selected={selected} onSelect={setSelected} source={d.source} />
    </div>
  )
}

function FlowOverview({ d, partners, selected, onSelect, countryLabel, cmdLabel }: { d: Resp; partners: Partner[]; selected: number; onSelect: (i: number) => void; countryLabel: string; cmdLabel: string }) {
  const shown = partners.slice(0, 6)
  const max = Math.max(1, ...shown.map(p => p.value ?? 0))
  return (
    <Panel label="Bilateral Flow Map" meta="click a partner to drill it" style={{ flex: 1, minWidth: 0, height: 386, padding: '38px 14px 12px', boxSizing: 'border-box' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', height: '100%', alignItems: 'center', gap: 16 }}>
        <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingRight: 14, borderRight: `1px solid ${T.borderFaint}` }}>
          <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>{d.reporter_iso ?? 'Reporter'}</div>
          <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: T.gold, marginTop: 5 }}>{countryLabel}</div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: T.muted, lineHeight: 1.5, marginTop: 6 }}>{d.flow} · {cmdLabel}<br />{d.period}</div>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: T.text, marginTop: 15 }}>{fmtUsd(d.total?.value)}</div>
          <div style={{ fontFamily: MONO, fontSize: 8.5, color: T.textDim }}>reported total value</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 7, minWidth: 0 }}>
          {shown.map((p, i) => {
            const on = i === selected
            const width = Math.max(4, ((p.value ?? 0) / max) * 100)
            const share = d.total?.value ? (p.value ?? 0) / d.total.value * 100 : null
            return <button key={`${p.iso ?? p.partner}-${i}`} onClick={() => onSelect(i)} style={{ display: 'grid', gridTemplateColumns: '112px 1fr 74px', alignItems: 'center', gap: 9, width: '100%', padding: '4px 6px', background: on ? mix(T.gold, 7) : 'transparent', color: T.text, border: `1px solid ${on ? mix(T.gold, 55) : 'transparent'}`, cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ minWidth: 0 }}><span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 10, fontWeight: 700 }}>{p.partner ?? p.iso ?? '?'}</span><span style={{ fontFamily: MONO, fontSize: 8, color: T.textDim }}>{p.iso ?? '—'}</span></span>
              <span style={{ display: 'block', position: 'relative', height: 8, background: mix(T.text, 6) }}><span style={{ display: 'block', width: `${width}%`, height: '100%', background: on ? T.gold : mix(T.blue, 65) }} /></span>
              <span style={{ textAlign: 'right' }}><span style={{ display: 'block', fontFamily: MONO, fontSize: 10, fontWeight: 700 }}>{fmtUsd(p.value)}</span><span style={{ fontFamily: MONO, fontSize: 8, color: T.muted }}>{share != null ? `${share.toFixed(1)}%` : '—'}</span></span>
            </button>
          })}
        </div>
      </div>
    </Panel>
  )
}

function PartnerDock({ partner, rank, total, flow, countryLabel }: { partner: Partner; rank: number; total: number | null | undefined; flow?: string; countryLabel: string }) {
  const share = total ? (partner.value ?? 0) / total * 100 : null
  const valuePerTonne = partner.value && partner.net_wgt ? partner.value / (partner.net_wgt / 1000) : null
  const stats: [string, string][] = [['Rank', `#${rank}`], ['Trade value', fmtUsd(partner.value)], ['Share of flow', share != null ? `${share.toFixed(2)}%` : '—'], ['Net weight', fmtWt(partner.net_wgt)], ['Value / tonne', valuePerTonne != null ? fmtUsd(valuePerTonne) : '—']]
  return (
    <div style={{ width: 302, flexShrink: 0, boxSizing: 'border-box', background: T.surface, border: `1px solid ${mix(T.gold, 35)}`, padding: '12px 14px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.gold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{partner.partner ?? partner.iso ?? 'Partner'}</span><span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, color: T.blue, border: `1px solid ${T.blue}`, padding: '2px 6px' }}>{partner.iso ?? `#${rank}`}</span></div>
      <div style={{ marginTop: 12, padding: '13px 0', borderTop: `1px solid ${T.borderFaint}`, borderBottom: `1px solid ${T.borderFaint}` }}><div style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted }}>{countryLabel} {flow?.toLowerCase()} with selected partner</div><div style={{ fontFamily: MONO, fontSize: 25, fontWeight: 700, color: T.text, marginTop: 4 }}>{fmtUsd(partner.value)}</div><div style={{ height: 6, background: mix(T.text, 7), marginTop: 9 }}><div style={{ height: '100%', width: `${Math.min(100, share ?? 0)}%`, background: T.gold }} /></div></div>
      <div style={{ marginTop: 8 }}>{stats.map(([k, v]) => <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${T.borderFaint}` }}><span style={{ fontFamily: MONO, fontSize: 9.5, color: T.muted }}>{k}</span><span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: T.text }}>{v}</span></div>)}</div>
      <div style={{ marginTop: 'auto', fontFamily: MONO, fontSize: 8.5, color: T.textDim, lineHeight: 1.5 }}>Declared bilateral value and net weight. Quantity units vary by commodity and reporter.</div>
    </div>
  )
}

function PartnerTable({ partners, total, maxVal, selected, onSelect, source }: { partners: Partner[]; total: number | null | undefined; maxVal: number; selected: number; onSelect: (i: number) => void; source?: string }) {
  return (
    <Panel label="Top Trading Partners" meta={`${source ?? 'UN Comtrade'} · click a row to drill it`} style={{ padding: '30px 0 0' }}>
      <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11.5 }}><thead><tr>{['#', 'Partner', 'ISO', 'Value', '', 'Tonnage', 'Share'].map((h, i) => <th key={i} style={{ position: 'sticky', top: 0, zIndex: 1, background: T.surface, textAlign: i >= 3 && i !== 4 ? 'right' : 'left', padding: '7px 12px', fontSize: 8.5, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>{partners.map((p, i) => { const share = total ? (p.value ?? 0) / total * 100 : null; const on = i === selected; return <tr key={`${p.iso ?? p.partner}-${i}`} onClick={() => onSelect(i)} style={{ borderBottom: `1px solid ${mix(T.text, 4)}`, background: on ? mix(T.gold, 6) : 'transparent', cursor: 'pointer' }}><td style={{ padding: '6px 12px', color: T.textDim }}>{String(i + 1).padStart(2, '0')}</td><td style={{ padding: '6px 12px', color: on ? T.gold : T.text, fontWeight: 700, whiteSpace: 'nowrap' }}>{p.partner ?? p.iso ?? '?'}</td><td style={{ padding: '6px 12px', color: T.muted }}>{p.iso ?? '—'}</td><td style={{ padding: '6px 12px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap' }}>{fmtUsd(p.value)}</td><td style={{ padding: '6px 12px', width: '30%', minWidth: 120 }}><div style={{ height: 7, background: T.bg }}><div style={{ height: '100%', width: `${((p.value ?? 0) / maxVal) * 100}%`, background: on ? T.gold : mix(T.blue, 70) }} /></div></td><td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted, whiteSpace: 'nowrap' }}>{fmtWt(p.net_wgt)}</td><td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted }}>{share != null ? `${share.toFixed(1)}%` : '—'}</td></tr> })}</tbody>
      </table></div>
    </Panel>
  )
}
