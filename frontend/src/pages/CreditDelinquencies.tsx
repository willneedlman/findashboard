import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'

// Delinquency-bucket severity ramp (data-viz, not themed): benign green →
// deepening amber/maroon as loans age past due.
const BUCKETS = ['current', '30-59', '60-89', '90-119', '120+'] as const
type BucketKey = typeof BUCKETS[number]
const BUCKET_COLOR: Record<BucketKey, string> = {
  'current': '#2e6b4b', '30-59': '#c9a84c', '60-89': '#d98b3a', '90-119': '#c65b3a', '120+': '#8c2e36',
}
const BUCKET_LABEL: Record<BucketKey, string> = {
  'current': 'Current', '30-59': '30–59 DPD', '60-89': '60–89 DPD', '90-119': '90–119 DPD', '120+': '120+ / default',
}

const ROLL_ORDER = ['30-59->60-89', '60-89->90-119', '90-119->120+', '120+->charge_off'] as const
const ROLL_LABEL: Record<string, string> = {
  '30-59->60-89': '30 → 60', '60-89->90-119': '60 → 90', '90-119->120+': '90 → 120+', '120+->charge_off': '120+ → C/O',
}

interface Block {
  label: string
  outstanding: number
  delinquency_rate_30plus: number
  npa_ratio: number
  default_balance_rate: number
  annualized_default_rate: number
  over_threshold: boolean
  buckets: Record<string, number>
}
interface Summary {
  asof: string
  default_threshold: number
  total: Block | null
  by_asset_class: Block[]
  flags: { asset_class: string; annualized_default_rate: number; threshold: number }[]
  portfolios: {
    portfolio_id: string; name: string; product: string; product_label: string
    asset_class: string; region: string
    annualized_default_rate: number
    current: {
      outstanding: number; delinquency_rate_30plus: number; npa_ratio: number
      default_balance_rate: number; buckets: Record<string, { balance: number; pct: number }>
    }
    roll_rates: Record<string, number>
  }[]
}

const AC_LABEL: Record<string, string> = {
  consumer: 'Consumer', corporate: 'Corporate', credit_card: 'Credit Cards',
  residential_re: 'Residential RE', cre: 'Commercial RE',
}

const fmtB = (m: number) => `$${(m / 1000).toFixed(1)}B`
const pct = (v: number, d = 2) => `${v.toFixed(d)}%`

// Stacked severity bar from a bucket→pct map.
function BucketBar({ buckets, height = 12 }: { buckets: Record<string, number>; height?: number }) {
  return (
    <div style={{ display: 'flex', width: '100%', height, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
      {BUCKETS.map(b => {
        const w = buckets[b] ?? 0
        if (w <= 0) return null
        return <div key={b} title={`${BUCKET_LABEL[b]} · ${w.toFixed(2)}%`}
          style={{ width: `${w}%`, background: BUCKET_COLOR[b] }} />
      })}
    </div>
  )
}

function StatCell({ label, value, sub, tone, last }: { label: string; value: string; sub?: string; tone?: string; last?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 130, padding: '12px 16px', borderRight: last ? 'none' : `1px solid ${T.border}` }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: tone ?? T.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function PanelHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>{title}</span>
      {right}
    </div>
  )
}

const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }
const th: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, padding: '9px 12px', textAlign: 'right', borderBottom: `1px solid ${T.border}` }
const td: React.CSSProperties = { fontFamily: T.mono, fontSize: 12, padding: '9px 12px', textAlign: 'right', color: T.text, borderBottom: `1px solid var(--theme-border-faint, rgba(255,255,255,0.05))` }

export function CreditDelinquenciesContent() {
  const [threshold, setThreshold] = useState(5)
  const [selected, setSelected] = useState<string>('all')

  const { data, isLoading, isError } = useQuery<Summary>({
    queryKey: ['credit-summary', threshold],
    queryFn: () => axios.get(`/api/credit/summary?threshold=${threshold}`).then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  const { data: roll } = useQuery<{ roll_rates: Record<string, number> }>({
    queryKey: ['credit-roll', selected],
    queryFn: () => axios.get(`/api/credit/roll-rates${selected === 'all' ? '' : `?asset_class=${selected}`}`).then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  const portfolios = (data?.portfolios ?? [])
    .filter(p => selected === 'all' || p.asset_class === selected)
    .sort((a, b) => b.annualized_default_rate - a.annualized_default_rate)

  const filterBtn = (key: string, label: string) => {
    const on = selected === key
    return (
      <button key={key} onClick={() => setSelected(key)} style={{
        fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
        padding: '4px 12px', cursor: 'pointer',
        background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
        border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.muted,
      }}>{label}</button>
    )
  }

  return (
    <div style={{ width: '100%' }}>
      <PageHeader
        title="Credit Delinquencies"
        actions={data && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>as of {data.asof}</span>
            <label style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
              Default flag
              <input type="number" step={0.5} min={0} value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                style={{ width: 56, fontFamily: T.mono, fontSize: 12, textAlign: 'right', padding: '3px 6px', background: 'var(--theme-bg, #0a1628)', border: `1px solid ${T.border}`, color: T.gold }} />
              %
            </label>
          </div>
        )}
      />

      {isLoading && <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>Loading portfolios…</div>}
      {isError && <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.neg, fontFamily: T.mono, fontSize: 11 }}>Failed to load credit data.</div>}

      {data?.total && (
        <>
          {/* Total-book KPI strip */}
          <div style={PANEL}>
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              <StatCell label="Total Outstanding" value={fmtB(data.total.outstanding)} sub={`${data.by_asset_class.length} asset classes`} />
              <StatCell label="30+ DPD" value={pct(data.total.delinquency_rate_30plus)} sub="delinquency rate" />
              <StatCell label="NPA Ratio" value={pct(data.total.npa_ratio)} sub="90+ DPD / outstanding" />
              <StatCell label="Default (ann.)" value={pct(data.total.annualized_default_rate)} sub="annualized charge-offs" tone={data.total.annualized_default_rate > threshold ? T.neg : T.text} />
              <StatCell label="Over Threshold" value={`${data.flags.length}`} sub={`> ${threshold}% default`} tone={data.flags.length ? T.neg : T.pos} last />
            </div>
          </div>

          {/* Asset-class risk table */}
          <div style={PANEL}>
            <PanelHead title="Risk Posture by Asset Class" right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>rows over {threshold}% default flagged</span>} />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Asset Class</th>
                  <th style={th}>Outstanding</th>
                  <th style={th}>30+ DPD</th>
                  <th style={th}>NPA</th>
                  <th style={th}>Default (ann.)</th>
                  <th style={{ ...th, textAlign: 'left', width: '26%' }}>Bucket mix</th>
                </tr></thead>
                <tbody>
                  {data.by_asset_class.map(b => {
                    const over = b.annualized_default_rate > threshold
                    return (
                      <tr key={b.label} style={{ background: over ? 'color-mix(in srgb, var(--theme-negative, #ef4444) 8%, transparent)' : 'transparent' }}>
                        <td style={{ ...td, textAlign: 'left', fontWeight: 700, borderLeft: over ? `3px solid ${T.neg}` : '3px solid transparent' }}>
                          {AC_LABEL[b.label] ?? b.label}
                          {over && <span style={{ marginLeft: 8, fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: T.neg, border: `1px solid ${T.neg}`, padding: '1px 5px' }}>OVER {threshold}%</span>}
                        </td>
                        <td style={td}>{fmtB(b.outstanding)}</td>
                        <td style={td}>{pct(b.delinquency_rate_30plus)}</td>
                        <td style={td}>{pct(b.npa_ratio)}</td>
                        <td style={{ ...td, color: over ? T.neg : T.text, fontWeight: 700 }}>{pct(b.annualized_default_rate)}</td>
                        <td style={{ ...td, textAlign: 'left' }}><BucketBar buckets={b.buckets} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', padding: '10px 14px', borderTop: `1px solid ${T.border}` }}>
              {BUCKETS.map(b => (
                <span key={b} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.mono, fontSize: 9, color: T.muted }}>
                  <span style={{ width: 10, height: 10, background: BUCKET_COLOR[b] }} />{BUCKET_LABEL[b]}
                </span>
              ))}
            </div>
          </div>

          {/* Filter + roll rates */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {filterBtn('all', 'All')}
            {Object.keys(AC_LABEL).map(k => filterBtn(k, AC_LABEL[k]))}
          </div>

          <div style={PANEL}>
            <PanelHead title={`Roll Rates — ${selected === 'all' ? 'All Books' : AC_LABEL[selected]}`} right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>P(transition to worse bucket, monthly)</span>} />
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              {ROLL_ORDER.map((k, i) => {
                const v = roll?.roll_rates?.[k]
                return (
                  <div key={k} style={{ flex: 1, minWidth: 130, padding: '14px 16px', borderRight: i === ROLL_ORDER.length - 1 ? 'none' : `1px solid ${T.border}` }}>
                    <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>{ROLL_LABEL[k]}</div>
                    <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: v == null ? T.muted : v > 0.6 ? T.neg : v > 0.4 ? T.gold : T.text }}>
                      {v == null ? '—' : `${(v * 100).toFixed(0)}%`}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Portfolio detail table */}
          <div style={PANEL}>
            <PanelHead title="Portfolios" right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>{portfolios.length} books · sorted by default rate</span>} />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Portfolio</th>
                  <th style={th}>Outstanding</th>
                  <th style={th}>30+ DPD</th>
                  <th style={th}>NPA</th>
                  <th style={th}>Default (ann.)</th>
                  <th style={{ ...th, textAlign: 'left', width: '22%' }}>Bucket mix</th>
                </tr></thead>
                <tbody>
                  {portfolios.map(p => {
                    const over = p.annualized_default_rate > threshold
                    const bucketPct = Object.fromEntries(BUCKETS.map(b => [b, p.current.buckets[b]?.pct ?? 0]))
                    return (
                      <tr key={p.portfolio_id}>
                        <td style={{ ...td, textAlign: 'left' }}>
                          <span style={{ fontWeight: 700 }}>{p.product_label}</span>
                          <span style={{ color: T.muted, marginLeft: 8, textTransform: 'capitalize' }}>{p.region}</span>
                        </td>
                        <td style={td}>{fmtB(p.current.outstanding)}</td>
                        <td style={td}>{pct(p.current.delinquency_rate_30plus)}</td>
                        <td style={td}>{pct(p.current.npa_ratio)}</td>
                        <td style={{ ...td, color: over ? T.neg : T.text, fontWeight: over ? 700 : 400 }}>{pct(p.annualized_default_rate)}</td>
                        <td style={{ ...td, textAlign: 'left' }}><BucketBar buckets={bucketPct} height={10} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default function CreditDelinquencies() {
  return <PageWrapper><CreditDelinquenciesContent /></PageWrapper>
}
