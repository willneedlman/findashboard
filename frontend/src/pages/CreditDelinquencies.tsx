import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'

// Delinquency-bucket colors (data-viz literals, per the polished handoff): benign
// green → deepening amber/orange/maroon as loans age past due.
const BUCKETS = ['current', '30-59', '60-89', '90-119', '120+'] as const
type BucketKey = typeof BUCKETS[number]
const BUCKET_COLOR: Record<BucketKey, string> = {
  'current': '#2f8a4e', '30-59': '#d8b85a', '60-89': '#d98c3a', '90-119': '#e0603a', '120+': '#b3372f',
}
const BUCKET_LABEL: Record<BucketKey, string> = {
  'current': 'Current', '30-59': '30–59 DPD', '60-89': '60–89 DPD', '90-119': '90–119 DPD', '120+': '120+ / default',
}
// The mix bar shows only the 30+ (delinquent) composition, normalized to fill.
const DELINQ_BUCKETS: BucketKey[] = ['30-59', '60-89', '90-119', '120+']

const ROLL_ORDER = ['30-59->60-89', '60-89->90-119', '90-119->120+', '120+->charge_off'] as const
const ROLL_LABEL: Record<string, string> = {
  '30-59->60-89': '30 → 60', '60-89->90-119': '60 → 90', '90-119->120+': '90 → 120+', '120+->charge_off': '120+ → C/O',
}

// Shared 8-column grid template: label / outstanding / 30+ / npa / default / Δ / trend / mix.
const GRID = '2.2fr 1fr 0.85fr 0.8fr 1fr 0.9fr 122px 190px'

interface TrendPoint { asof: string; delinquency_rate_30plus: number; npa_ratio: number }
interface Block {
  label: string
  outstanding: number
  delinquency_rate_30plus: number
  npa_ratio: number
  default_balance_rate: number
  annualized_default_rate: number
  over_threshold: boolean
  buckets: Record<string, number>
  trend: TrendPoint[]
}
interface Summary {
  asof: string
  default_threshold: number
  provenance?: { portfolios: string; benchmarks: string }
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
    trend: TrendPoint[]
  }[]
}

const AC_LABEL: Record<string, string> = {
  consumer: 'Consumer', corporate: 'Corporate', credit_card: 'Credit Cards',
  residential_re: 'Residential RE', cre: 'Commercial RE',
}

const fmtB = (m: number) => `$${(m / 1000).toFixed(1)}B`
const pct = (v: number, d = 2) => `${v.toFixed(d)}%`

// Hoverable "?" with an explanatory popup. `placement="below"` opens downward
// (used inside the scrollable table header, which would clip an upward popup).
function HelpTip({ text, placement = 'top' }: { text: string; placement?: 'top' | 'below' | 'below-left' }) {
  const [show, setShow] = useState(false)
  // 'below-left' anchors the popup's right edge to the icon (extends leftward) so
  // a rightmost-column tip doesn't overflow the panel and get clipped.
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

// 5-year monthly 30+ DPD sparkline. Min-max normalized into a 118×30 box
// (2px x-pad, 4px top/bottom y-pad); rising delinquency reads red, falling green.
function Sparkline({ series }: { series: number[] }) {
  if (!series || series.length < 2) return null
  const min = Math.min(...series), max = Math.max(...series), span = max - min || 1
  const pts = series.map((v, i) => {
    const x = 2 + 114 * (i / (series.length - 1))
    const y = 4 + 22 * (1 - (v - min) / span)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const color = series[series.length - 1] >= series[0] ? T.neg : T.pos
  return (
    <svg viewBox="0 0 118 30" width={118} height={30} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

const HLABEL: React.CSSProperties = {
  fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap',
}

interface Row {
  key: string; label: string; sub?: string
  outstanding: number; dpd30: number; npa: number; defaultAnn: number
  trend: number[]; mix: number[]; flagged: boolean
}

// The polished asset-class / portfolio grid. One row per book: balance,
// delinquency, default, a 5-year 30+ DPD trend, and the normalized 30+ mix.
function DelinqTable({ firstLabel, rows, showLegend }: { firstLabel: string; rows: Row[]; showLegend?: boolean }) {
  const num: React.CSSProperties = { fontFamily: T.mono, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: T.text }
  return (
    <div style={PANEL}>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 880 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 18, padding: '12px 22px', borderBottom: `1px solid ${T.border}` }}>
            <span style={HLABEL}>{firstLabel}</span>
            <span style={HLABEL}>Outstanding</span>
            <span style={HLABEL}>30+ DPD</span>
            <span style={HLABEL}>NPA</span>
            <span style={HLABEL}>Default (ann.)</span>
            <span style={HLABEL}>Δ 5Y</span>
            <span style={HLABEL}>Trend</span>
            <span style={{ ...HLABEL, display: 'flex', alignItems: 'center' }}>
              Delinquent mix · 30+
              <HelpTip placement="below-left" text="The 30+ delinquent dollars split by stage (30-59, 60-89, 90-119 and 120+ / default) and normalized to fill the bar. Current loans are excluded so the delinquent composition is visible." />
            </span>
          </div>
          {rows.map(r => {
            const delta = r.trend.length >= 2 ? r.trend[r.trend.length - 1] - r.trend[0] : 0
            const up = delta >= 0
            const trendColor = up ? T.neg : T.pos
            const mixTotal = r.mix.reduce((a, b) => a + b, 0) || 1
            return (
              <div key={r.key} className="fdb-credit-row" style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 18, padding: '13px 22px', borderBottom: `1px solid ${T.borderFaint}` }}>
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontFamily: T.label, fontSize: 14, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                  {r.sub && <span style={{ fontFamily: T.label, fontSize: 11, color: T.muted, textTransform: 'capitalize' }}>{r.sub}</span>}
                </span>
                <span style={num}>{fmtB(r.outstanding)}</span>
                <span style={{ ...num, fontWeight: 600 }}>{pct(r.dpd30)}</span>
                <span style={{ ...num, color: T.muted }}>{pct(r.npa)}</span>
                <span style={{ ...num, fontWeight: 700, color: r.flagged ? T.neg : T.text }}>{pct(r.defaultAnn)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: trendColor, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{up ? '↑' : '↓'}{Math.abs(delta).toFixed(2)}pp</span>
                <Sparkline series={r.trend} />
                <div style={{ display: 'flex', height: 12, width: '100%', border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                  {r.mix.map((v, i) => {
                    const w = (v / mixTotal) * 100
                    if (w <= 0) return null
                    const b = DELINQ_BUCKETS[i]
                    return <div key={b} title={`${BUCKET_LABEL[b]} · ${w.toFixed(0)}% of 30+`} style={{ width: `${w}%`, background: BUCKET_COLOR[b] }} />
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {showLegend && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', padding: '14px 22px', borderTop: `1px solid ${T.border}` }}>
          {BUCKETS.map(b => (
            <span key={b} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.label, fontSize: 10, color: T.muted }}>
              <span style={{ width: 10, height: 10, background: BUCKET_COLOR[b] }} />{BUCKET_LABEL[b]}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, sub, tone, help, last }: { label: string; value: string; sub?: string; tone?: string; help?: string; last?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 130, padding: '12px 16px', borderRight: last ? 'none' : `1px solid ${T.border}` }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 6, display: 'flex', alignItems: 'center' }}>{label}{help && <HelpTip text={help} />}</div>
      <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: tone ?? T.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function PanelHead({ title, help, right }: { title: string; help?: string; right?: React.ReactNode }) {
  return (
    <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, display: 'flex', alignItems: 'center' }}>{title}{help && <HelpTip text={help} />}</span>
      {right}
    </div>
  )
}

const PANEL: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }

export function CreditDelinquenciesContent() {
  const threshold = 5
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

  const acRows: Row[] = (data?.by_asset_class ?? []).map(b => ({
    key: b.label,
    label: AC_LABEL[b.label] ?? b.label,
    outstanding: b.outstanding,
    dpd30: b.delinquency_rate_30plus,
    npa: b.npa_ratio,
    defaultAnn: b.annualized_default_rate,
    trend: b.trend.map(t => t.delinquency_rate_30plus),
    mix: DELINQ_BUCKETS.map(bk => b.buckets[bk] ?? 0),
    flagged: b.annualized_default_rate > threshold,
  }))

  const pRows: Row[] = portfolios.map(p => ({
    key: p.portfolio_id,
    label: p.product_label,
    sub: p.region,
    outstanding: p.current.outstanding,
    dpd30: p.current.delinquency_rate_30plus,
    npa: p.current.npa_ratio,
    defaultAnn: p.annualized_default_rate,
    trend: p.trend.map(t => t.delinquency_rate_30plus),
    mix: DELINQ_BUCKETS.map(bk => p.current.buckets[bk]?.pct ?? 0),
    flagged: p.annualized_default_rate > threshold,
  }))

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
      <style>{`.fdb-credit-row:hover{background:var(--theme-hover, rgba(255,255,255,0.03))}`}</style>
      <PageHeader
        title="Credit Delinquencies"
        actions={data && (
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>as of {data.asof}</span>
        )}
      />

      {isLoading && <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>Loading portfolios…</div>}
      {isError && <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.neg, fontFamily: T.mono, fontSize: 11 }}>Failed to load credit data.</div>}

      {data?.provenance && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', marginBottom: 12, background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)', border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 10, color: T.muted }}>
          <span style={{ color: T.warn, fontWeight: 700, letterSpacing: '0.06em' }}>MODELED BOOK</span>
          <span>Portfolio-level buckets and roll rates are a modeled sample — no free public loan-servicing data exists. Industry benchmarks are real:</span>
          <span style={{ color: (data.provenance.benchmarks || '').startsWith('FRED') ? T.pos : T.warn, fontWeight: 700 }}>{data.provenance.benchmarks}</span>
        </div>
      )}

      {data?.total && (
        <>
          {/* Total-book KPI strip */}
          <div style={PANEL}>
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              <StatCell label="Total Outstanding" value={fmtB(data.total.outstanding)} sub={`${data.by_asset_class.length} asset classes`} />
              <StatCell label="30+ DPD" value={pct(data.total.delinquency_rate_30plus)} sub="delinquency rate"
                help="Share of the book at least 30 days past due (30-59, 60-89, 90-119 and 120+ combined). An early read on stress before loans default." />
              <StatCell label="NPA Ratio" value={pct(data.total.npa_ratio)} sub="90+ DPD / outstanding"
                help="Non-performing assets. Loans 90 or more days past due as a share of total outstanding. Higher means more of the book has stopped performing." />
              <StatCell label="Default (ann.)" value={pct(data.total.annualized_default_rate)} sub="annualized charge-offs" tone={data.total.annualized_default_rate > threshold ? T.neg : T.text} last />
            </div>
          </div>

          {/* Asset-class table (polished grid) */}
          <DelinqTable firstLabel="Asset Class" rows={acRows} showLegend />

          {/* Filter + roll rates */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {filterBtn('all', 'All')}
            {Object.keys(AC_LABEL).map(k => filterBtn(k, AC_LABEL[k]))}
          </div>

          <div style={PANEL}>
            <PanelHead title={`Roll Rates — ${selected === 'all' ? 'All Books' : AC_LABEL[selected]}`}
              help="The chance a balance moves to the next-worse delinquency bucket next month. Example: 30 to 60 is the share of 30-59 day balances that fall to 60-89. Higher roll rates mean delinquencies are deepening."
              right={<span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>P(transition to worse bucket, monthly)</span>} />
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

          {/* Portfolio table (same polished grid) */}
          <DelinqTable firstLabel="Portfolio" rows={pRows} />
        </>
      )}
    </div>
  )
}

export default function CreditDelinquencies() {
  return <PageWrapper><CreditDelinquenciesContent /></PageWrapper>
}
