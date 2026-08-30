import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import { Panel, MONO, SANS, BRIGHT, DIM } from './ui'
import { DASH, compact, count, pct, ratePct, tone } from './format'

// `pct` is already computed by the endpoint. Recomputing it from the values
// would disagree with the source whenever a segment is netted or eliminated.
interface Segment { name?: string; value?: number | null; pct?: number | null }
interface SegmentBlock { fiscalYear?: string; currency?: string; latest?: Segment[] }

interface Profile {
  name?: string; description?: string; sector?: string; industry?: string
  city?: string; country?: string; employees?: number | null
  gross_margin?: number | null; operating_margin?: number | null; net_margin?: number | null
  roe?: number | null; roa?: number | null; current_ratio?: number | null
  product_segments?: SegmentBlock; geo_segments?: SegmentBlock
  profile_sources?: unknown
}

interface MedianStat { median?: number | null; n?: number | null; p25?: number | null; p75?: number | null }
interface SectorMedians {
  fields?: string[]
  sectors?: Record<string, Record<string, MedianStat>>
}

// Categorical series, in row order, from the design system.
const SERIES = [
  'var(--theme-primary)',
  'var(--theme-tertiary)',
  '#2f6b4b',
  '#d97736',
  '#7b5ea7',
  '#1f5673',
]

// The profile and the medians BOTH arrive already expressed as percentages
// (55.7 means 55.7%), so nothing here multiplies by 100. Median keys are
// camelCase on that endpoint and snake_case on this one, so the mapping is
// explicit rather than derived.
const METRICS: { key: keyof Profile; label: string; medianKey: string; ratio?: boolean }[] = [
  { key: 'gross_margin', label: 'Gross margin', medianKey: 'grossMargin' },
  { key: 'operating_margin', label: 'Operating margin', medianKey: 'operatingMargin' },
  { key: 'net_margin', label: 'Net margin', medianKey: 'netMargin' },
  { key: 'roe', label: 'Return on equity', medianKey: 'roe' },
  { key: 'roa', label: 'Return on assets', medianKey: 'roa' },
  { key: 'current_ratio', label: 'Current ratio', medianKey: 'currentRatio', ratio: true },
]

export default function SummaryTab({ ticker }: { ticker: string }) {
  const profile = useQuery<Profile>({
    queryKey: ['cp-profile', ticker],
    queryFn: () => axios.get(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const medians = useQuery<SectorMedians>({
    queryKey: ['cp-sector-medians'],
    queryFn: () => axios.get('/api/screener/sector-medians').then(r => r.data),
    staleTime: Infinity, retry: 0,
  })

  const p = profile.data ?? {}
  const sectorMed = p.sector ? medians.data?.sectors?.[p.sector] : undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Panel title="About the business" meta="via yfinance">
        <div style={{ padding: '16px 18px' }}>
          <p style={{
            fontFamily: SANS, fontSize: 12.5, lineHeight: 1.75, color: T.text,
            maxWidth: '110ch', margin: 0, textWrap: 'pretty',
          }}>
            {p.description ?? (profile.isLoading ? '' : 'No business description published for this symbol.')}
          </p>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 1, background: T.borderFaint, border: `1px solid ${T.borderFaint}`,
            marginTop: 16,
          }}>
            <Fact label="Sector" value={p.sector ?? DASH} />
            <Fact label="Industry" value={p.industry ?? DASH} />
            <Fact label="Headquarters" value={[p.city, p.country].filter(Boolean).join(', ') || DASH} />
            <Fact label="Employees" value={count(p.employees)} />
          </div>
        </div>
      </Panel>

      <Panel
        title="Profitability against the sector median"
        meta={p.sector ? `${p.sector}${sectorMed ? '' : ', medians unavailable'}` : undefined}
      >
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 1, background: T.borderFaint,
        }}>
          {METRICS.map(m => (
            <MedianRow
              key={m.key as string}
              label={m.label}
              value={p[m.key] as number | null | undefined}
              stat={sectorMed?.[m.medianKey]}
              isRatio={!!m.ratio}
            />
          ))}
        </div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        <SegmentPanel title="Revenue by segment" block={p.product_segments} />
        <SegmentPanel title="Revenue by geography" block={p.geo_segments} />
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: T.bg, padding: '9px 12px',
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
    }}>
      <span style={{
        fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: DIM,
      }}>
        {label}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: T.text, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

/** A metric against its sector median. The delta is printed next to the bar, so
 *  colour never carries the meaning alone, and the bar is positioned against the
 *  sector's REAL interquartile span rather than an invented one. */
function MedianRow({ label, value, stat, isRatio }: {
  label: string; value?: number | null; stat?: MedianStat; isRatio?: boolean
}) {
  const shown = typeof value === 'number' && Number.isFinite(value) ? value : null
  const med = typeof stat?.median === 'number' ? stat.median : null
  const delta = shown != null && med != null ? shown - med : null
  const fmt = (v: number) => (isRatio ? v.toFixed(2) : pct(v))

  // p25 and p75 come from the same endpoint, so the track is the sector's own
  // middle half, widened to hold this name when it sits outside it.
  const lo = Math.min(stat?.p25 ?? med ?? 0, shown ?? med ?? 0)
  const hi = Math.max(stat?.p75 ?? med ?? 1, shown ?? med ?? 1)
  const span = hi - lo || 1
  const at = (v: number | null) => (v == null ? null : Math.max(0, Math.min(100, ((v - lo) / span) * 100)))
  const barPct = at(shown) ?? 0
  const medPct = at(med)

  return (
    <div style={{ background: T.bg, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span style={{
          fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.muted,
        }}>
          {label}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: BRIGHT }}>
          {shown == null ? DASH : fmt(shown)}
        </span>
      </div>

      <div style={{
        position: 'relative', height: 6, marginTop: 10,
        background: 'rgba(255,255,255,0.05)', border: `1px solid ${T.borderFaint}`,
      }}>
        <div style={{
          width: `${barPct}%`, height: '100%',
          background: delta == null ? T.muted : (delta >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)'),
        }} />
        {medPct != null && (
          <div style={{
            position: 'absolute', left: `${medPct}%`, top: -3, bottom: -3,
            width: 2, background: BRIGHT,
          }} />
        )}
      </div>

      <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 10, color: T.muted }}>
        {med == null
          ? 'No sector median available'
          : `Median ${fmt(med)}${stat?.n ? `, n=${stat.n}` : ''}, this name ${delta! >= 0 ? '+' : ''}${isRatio ? delta!.toFixed(2) : delta!.toFixed(1)} ${delta! >= 0 ? 'above' : 'below'}`}
      </div>
    </div>
  )
}

function SegmentPanel({ title, block }: { title: string; block?: SegmentBlock }) {
  const rows = block?.latest ?? []
  const total = rows.reduce((s, r) => s + Math.abs(r.value ?? 0), 0)
  const max = Math.max(...rows.map(r => Math.abs(r.value ?? 0)), 1)

  return (
    <Panel
      title={title}
      meta={block?.fiscalYear ? `FY${block.fiscalYear}, via SEC EDGAR` : undefined}
    >
      <div style={{ padding: '14px 18px 16px' }}>
        {rows.length === 0 && (
          <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>
            No segment breakdown filed for this name.
          </div>
        )}
        {rows.map((r, i) => (
          <div key={r.name ?? i} style={{
            padding: '9px 0',
            borderBottom: i === rows.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.04)',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, color: BRIGHT, flex: 1, minWidth: 0 }}>
                {r.name ?? DASH}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: T.text }}>{compact(r.value)}</span>
              <span style={{
                fontFamily: MONO, fontSize: 12, fontWeight: 700, color: T.gold,
                minWidth: 46, textAlign: 'right',
              }}>
                {r.pct != null ? pct(r.pct) : (total > 0 ? pct((Math.abs(r.value ?? 0) / total) * 100) : DASH)}
              </span>
            </div>
            <div style={{ height: 5, marginTop: 7, background: 'rgba(255,255,255,0.05)' }}>
              <div style={{
                width: `${(Math.abs(r.value ?? 0) / max) * 100}%`, height: '100%',
                background: SERIES[i % SERIES.length],
              }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}
