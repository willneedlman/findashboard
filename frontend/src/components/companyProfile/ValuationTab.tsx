import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import EmptyState from '../EmptyState'
import { Panel, MONO, SANS, BRIGHT, ROW_LINE, STRIP } from './ui'
import { DASH, compact, multiple, pct } from './format'

interface ValRow { key: string; label: string; unit: string; value: number | null }
interface Valuation { available?: boolean; reason?: string; rows?: ValRow[]; source?: string }
interface MedianStat { median?: number | null; n?: number | null; p25?: number | null; p75?: number | null }
interface SectorMedians { sectors?: Record<string, Record<string, MedianStat>> }

// Each valuation row against the sector field that measures the same thing.
// Market cap and enterprise value have no median: a sector median market cap is
// a fact about company size, not about how this one is priced.
const MEDIAN_FOR: Record<string, string | null> = {
  marketCap: null,
  enterpriseValue: null,
  trailingPE: 'peRatio',
  forwardPE: null,
  pegRatio: 'pegRatio',
  priceToSalesTrailing12Months: 'psRatio',
  priceToBook: 'pbRatio',
  enterpriseToRevenue: null,
  enterpriseToEbitda: 'evEbitda',
}

export default function ValuationTab({ ticker }: { ticker: string }) {
  const val = useQuery<Valuation>({
    queryKey: ['cp-valuation', ticker],
    queryFn: () => axios.get(`/api/corporate/valuation-measures?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const profile = useQuery<{ sector?: string }>({
    queryKey: ['cp-profile', ticker],
    queryFn: () => axios.get(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const medians = useQuery<SectorMedians>({
    queryKey: ['cp-sector-medians'],
    queryFn: () => axios.get('/api/screener/sector-medians').then(r => r.data),
    staleTime: Infinity, retry: 0,
  })

  const rows = val.data?.rows ?? []
  const sectorMed = profile.data?.sector ? medians.data?.sectors?.[profile.data.sector] : undefined

  if (!val.isLoading && !val.data?.available) {
    return (
      <EmptyState
        title="Valuation"
        hint="No valuation multiples published for this symbol. Expected for an ETF, a fund, or a name with no earnings basis."
      />
    )
  }

  return (
    <Panel
      title="Valuation measures"
      meta={profile.data?.sector
        ? `Current, against ${profile.data.sector} medians`
        : 'Current'}
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 200 }}>Measure</th>
              <th style={th}>Current</th>
              <th style={th}>Sector median</th>
              <th style={{ ...th, textAlign: 'left', width: '34%' }}>Position in sector</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const medKey = MEDIAN_FOR[r.key]
              const stat = medKey ? sectorMed?.[medKey] : undefined
              const med = typeof stat?.median === 'number' ? stat.median : null
              const isMoney = r.unit === '$'
              const fmt = (v: number | null) => (v == null ? DASH : isMoney ? compact(v) : multiple(v, 1))
              const delta = r.value != null && med != null ? r.value - med : null
              // Rich is not good and cheap is not bad, but a multiple above its
              // sector median is the expensive side, and that is what the colour
              // says. The delta is printed beside it either way.
              const rich = delta != null && delta > 0
              const lo = Math.min(stat?.p25 ?? med ?? 0, r.value ?? med ?? 0)
              const hi = Math.max(stat?.p75 ?? med ?? 1, r.value ?? med ?? 1)
              const span = hi - lo || 1
              const at = (v: number | null) => (v == null ? null : Math.max(0, Math.min(100, ((v - lo) / span) * 100)))

              return (
                <tr key={r.key} style={{ borderBottom: ROW_LINE }}>
                  <td style={{ ...td, textAlign: 'left', fontFamily: SANS, fontWeight: 600, color: BRIGHT }}>
                    {r.label}
                  </td>
                  <td style={{ ...td, fontWeight: 700, color: T.gold }}>{fmt(r.value)}</td>
                  <td style={{ ...td, color: T.muted }}>{med == null ? DASH : fmt(med)}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    {med == null ? (
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted }}>
                        No sector median for this measure
                      </span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{
                          position: 'relative', flex: 1, minWidth: 70, height: 6,
                          background: 'rgba(255,255,255,0.05)', border: `1px solid ${T.borderFaint}`,
                        }}>
                          <div style={{
                            width: `${at(r.value) ?? 0}%`, height: '100%',
                            background: rich ? 'var(--theme-negative)' : 'var(--theme-positive)',
                          }} />
                          <div style={{
                            position: 'absolute', left: `${at(med) ?? 0}%`, top: -3, bottom: -3,
                            width: 2, background: BRIGHT,
                          }} />
                        </div>
                        <span style={{
                          fontFamily: MONO, fontSize: 10.5, color: T.muted,
                          minWidth: 96, textAlign: 'right',
                        }}>
                          {delta == null ? DASH : `${delta > 0 ? '+' : ''}${multiple(delta, 1)} vs median`}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{
        padding: '10px 16px', borderTop: `1px solid ${T.borderFaint}`,
        fontFamily: MONO, fontSize: 10, color: T.muted,
      }}>
        {val.data?.source ?? 'Vendor'} · sector medians carry their own sample size.
        Market cap, enterprise value, forward P/E and EV to revenue have no comparable median here.
      </div>
    </Panel>
  )
}

const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.muted, textAlign: 'right',
  padding: '11px 16px', whiteSpace: 'nowrap',
  background: STRIP, borderBottom: `1px solid ${T.border}`,
}

const td: React.CSSProperties = {
  padding: '10px 16px', textAlign: 'right', whiteSpace: 'nowrap',
  fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: T.text,
}
