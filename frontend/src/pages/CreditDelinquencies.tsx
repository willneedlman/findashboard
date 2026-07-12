import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'

interface CreditClass {
  asset_class: string; label: string; asof: string; delinquency_rate: number; chargeoff_rate: number | null
  trend: { asof: string; delinquency_rate: number; chargeoff_rate: number | null }[]
}
interface Spend { available: boolean; source: string; as_of?: string; coverage_note?: string; reason?: string; national?: { total_spend: number; transactions: number; online_spend: number; spend_change_pct: number | null }; categories?: { category: string; total_spend: number; transactions: number; online_spend: number; spend_change_pct: number | null }[] }
interface Summary { available: boolean; as_of: string | null; asset_classes: CreditClass[]; consumer_spend: Spend; method_note: string }

const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, marginBottom: 18 }
const fmtPct = (v: number | null | undefined) => v == null ? 'data unavailable' : `${v.toFixed(2)}%`
const fmtMoney = (v: number | null | undefined) => v == null ? 'data unavailable' : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}k`

function Head({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>{children}</span>{right}
  </div>
}

function Unavailable({ text }: { text: string }) {
  return <div style={{ padding: '18px 14px', fontFamily: T.mono, fontSize: 10, color: T.muted }}>{text}</div>
}

export function CreditDelinquenciesContent() {
  const { data, isLoading, isError } = useQuery<Summary>({ queryKey: ['credit-summary'], queryFn: () => axios.get('/api/credit/summary').then(r => r.data), staleTime: 12 * 3600e3, retry: 1 })
  const classes = data?.asset_classes ?? []
  const spend = data?.consumer_spend
  const chartByDate = classes.reduce<Record<string, Record<string, string | number | null>>>((byDate, creditClass) => {
    for (const point of creditClass.trend) {
      byDate[point.asof] = { ...(byDate[point.asof] ?? { asof: point.asof }), [creditClass.asset_class]: point.delinquency_rate }
    }
    return byDate
  }, {})
  const chartRows = Object.values(chartByDate).sort((a, b) => String(a.asof).localeCompare(String(b.asof)))
  const colors = [T.gold, '#5b93c9', '#d07b34', '#c084fc', T.pos]

  return <div style={{ width: '100%' }}>
    <PageHeader title="Credit Stress" actions={data?.as_of ? <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>FRED confirmed through {data.as_of}</span> : undefined} />
    {isLoading && <Unavailable text="Loading real bank credit data…" />}
    {isError && <Unavailable text="Data unavailable. Credit sources could not be reached." />}
    {data && <>
      <div style={{ ...PANEL, padding: '10px 14px', fontFamily: T.mono, fontSize: 10, color: T.muted }}>{data.method_note}</div>
      <div style={PANEL}>
        <Head right={<span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>30+ DPD and annualized charge-offs</span>}>Bank credit stress</Head>
        {!data.available ? <Unavailable text="Data unavailable. FRED bank-loan series are not configured." /> : <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', borderBottom: `1px solid ${T.border}` }}>
            {classes.map((c, i) => <div key={c.asset_class} style={{ padding: '13px 15px', borderRight: i < classes.length - 1 ? `1px solid ${T.border}` : undefined }}>
              <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, color: T.muted, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{c.label}</div>
              <div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 19, fontWeight: 700, color: c.delinquency_rate >= 3 ? T.neg : T.text }}>{fmtPct(c.delinquency_rate)}</div>
              <div style={{ marginTop: 4, fontFamily: T.mono, fontSize: 9, color: T.muted }}>30+ DPD · C/O {fmtPct(c.chargeoff_rate)}</div>
            </div>)}
          </div>
          <div style={{ height: 240, padding: 14 }}><ResponsiveContainer width="100%" height="100%"><LineChart data={chartRows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}><CartesianGrid stroke="var(--theme-border-faint, rgba(255,255,255,0.05))" vertical={false} /><XAxis dataKey="asof" tick={{ fontFamily: T.mono, fontSize: 9, fill: T.muted }} tickFormatter={v => String(v).slice(0, 7)} tickLine={false} axisLine={false} /><YAxis tick={{ fontFamily: T.mono, fontSize: 9, fill: T.muted }} tickFormatter={v => `${v}%`} tickLine={false} axisLine={false} width={36} /><Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 10 }} formatter={(v: number, n: string) => [fmtPct(v), classes.find(c => c.asset_class === n)?.label ?? n]} />{classes.map((c, i) => <Line key={c.asset_class} type="monotone" dataKey={c.asset_class} stroke={colors[i]} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />)}</LineChart></ResponsiveContainer></div>
        </>}
      </div>
      <div style={PANEL}><Head right={spend?.as_of ? <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>snapshot {spend.as_of}</span> : undefined}>Consumer spend pulse</Head>
        {!spend?.available ? <Unavailable text="Data unavailable. SafeGraph Spend Patterns has not been ingested." /> : <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', borderBottom: `1px solid ${T.border}` }}>
            <Metric label="Merchant spend" value={fmtMoney(spend.national?.total_spend)} /><Metric label="Transactions" value={spend.national?.transactions?.toLocaleString() ?? 'data unavailable'} /><Metric label="Online spend" value={fmtMoney(spend.national?.online_spend)} /><Metric label="MoM spend" value={fmtPct(spend.national?.spend_change_pct)} />
          </div>
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Merchant category', 'Spend', 'Transactions', 'Online spend', 'MoM'].map(h => <th key={h} style={{ textAlign: h === 'Merchant category' ? 'left' : 'right', padding: '9px 14px', fontFamily: T.label, fontSize: 9, color: T.muted, letterSpacing: '0.1em', textTransform: 'uppercase', borderBottom: `1px solid ${T.border}` }}>{h}</th>)}</tr></thead><tbody>{spend.categories?.map(c => <tr key={c.category}><td style={cell('left')}>{c.category}</td><td style={cell()}>{fmtMoney(c.total_spend)}</td><td style={cell()}>{c.transactions.toLocaleString()}</td><td style={cell()}>{fmtMoney(c.online_spend)}</td><td style={{ ...cell(), color: (c.spend_change_pct ?? 0) >= 0 ? T.pos : T.neg }}>{fmtPct(c.spend_change_pct)}</td></tr>)}</tbody></table></div>
          <div style={{ padding: '9px 14px', fontFamily: T.mono, fontSize: 9, color: T.muted }}>{spend.coverage_note}</div>
        </>}
      </div>
    </>}
  </div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div style={{ padding: '13px 15px' }}><div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</div><div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text }}>{value}</div></div> }
function cell(align: 'left' | 'right' = 'right'): React.CSSProperties { return { padding: '10px 14px', textAlign: align, fontFamily: T.mono, fontSize: 11, color: T.text, borderBottom: `1px solid ${T.borderFaint}`, fontVariantNumeric: 'tabular-nums' } }
export default function CreditDelinquencies() { return <PageWrapper><CreditDelinquenciesContent /></PageWrapper> }
