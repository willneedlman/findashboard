import { useQuery } from '@tanstack/react-query'
import { fetchMarketSize } from '../hooks/useApi'
import { T } from '../lib/theme'

interface Headline { from: string | null; to: string | null; to_year: string | null; cagr: number | null }
interface Report { report_code: string; heading: string; category: string; published: string; url: string; highlights: string; headline: Headline | null }
interface Resp { query: string; count: number; reports: Report[]; source: string }

const MONO = 'var(--theme-mono)'
const LABEL = 'var(--theme-sans)'

// BCC Research market sizing for the company's industry. Auto-queries by
// industry/sector; renders only when a report with a size headline comes back.
export default function IndustryMarketSize({ sector, industry }: { sector?: string; industry?: string }) {
  const topic = (industry || sector || '').trim()
  const q = useQuery<Resp>({
    queryKey: ['market-size', topic],
    queryFn: () => fetchMarketSize(`${topic} market size and forecast`, 4),
    enabled: !!topic,
    staleTime: 24 * 3600_000,
    retry: 0,
  })
  const reports = q.data?.reports ?? []
  const lead = reports.find(r => r.headline && (r.headline.from || r.headline.to))
  if (!lead && reports.length === 0) return null

  return (
    <div className="ft-panel">
      <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Industry Market Size</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>BCC Research · {industry || sector}</span>
      </div>
      <div style={{ padding: '16px 20px' }}>
        {lead?.headline && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: T.text }}>
              {lead.headline.from || '—'} <span style={{ color: T.muted, fontSize: 16 }}>→</span> {lead.headline.to || '—'}
            </span>
            {lead.headline.to_year && <span style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>by {lead.headline.to_year}</span>}
            {lead.headline.cagr != null && (
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: T.pos }}>{lead.headline.cagr}% CAGR</span>
            )}
          </div>
        )}
        {lead && (
          <a href={lead.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: LABEL, fontSize: 12, color: T.muted, textDecoration: 'none', lineHeight: 1.5 }}>
            {lead.heading} <span style={{ color: T.gold }}>↗</span>
          </a>
        )}
        {reports.length > 1 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontFamily: LABEL, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>Related reports</div>
            {reports.filter(r => r !== lead).slice(0, 3).map(r => (
              <a key={r.report_code} href={r.url} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontFamily: MONO, fontSize: 10.5, color: T.text, textDecoration: 'none' }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.heading}</span>
                <span style={{ color: T.muted, whiteSpace: 'nowrap' }}>{r.headline?.cagr != null ? `${r.headline.cagr}% CAGR` : r.category}</span>
              </a>
            ))}
          </div>
        )}
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, marginTop: 12, lineHeight: 1.5 }}>
          Third-party market-research estimates, matched to this company's industry. Not company revenue.
        </div>
      </div>
    </div>
  )
}
