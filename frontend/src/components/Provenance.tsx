import { T } from '../lib/theme'

// Shared data-provenance chip. Tells the user, at a glance, whether the numbers
// on a tool are live market data, a model/derivation, or illustrative sample —
// the durable fix for "is this real?" ambiguity across the terminal.
//
//   <Provenance kind="live"   source="yfinance" asOf="15:42" />
//   <Provenance kind="model"  source="ETF-derived · not a live print" />
//   <Provenance kind="sample" source="illustrative" />

export type ProvenanceKind = 'live' | 'model' | 'derived' | 'cached' | 'fallback' | 'sample' | 'unavailable'

const META: Record<ProvenanceKind, { label: string; color: string }> = {
  live:        { label: 'LIVE',        color: T.pos },
  model:       { label: 'MODEL',       color: T.gold },
  derived:     { label: 'DERIVED',     color: T.blue },
  cached:      { label: 'CACHED',      color: T.muted },
  fallback:    { label: 'FALLBACK',    color: T.warn },
  sample:      { label: 'SAMPLE',      color: T.warn },
  unavailable: { label: 'UNAVAILABLE', color: T.neg },
}

const TITLE: Record<ProvenanceKind, string> = {
  live:        'Live data from the named source.',
  model:       'AI or statistical model output, not a direct market print.',
  derived:     'Calculated from named inputs.',
  cached:      'Previously fetched data retained for continuity.',
  fallback:    'Fallback source or estimation used because the primary input was unavailable.',
  sample:      'Illustrative sample data, not a live feed.',
  unavailable: 'The expected source did not return usable data.',
}

export interface ProvenanceItem {
  kind: ProvenanceKind
  source: string
  asOf?: string
  fetchedAt?: string
  confidence?: string | number
  method?: string
  detail?: string
}

export default function Provenance({
  kind, source, asOf, fetchedAt, confidence, method, detail, style,
}: ProvenanceItem & { style?: React.CSSProperties }) {
  const m = META[kind]
  const confidenceLabel = typeof confidence === 'number'
    ? `${Math.round(confidence * (confidence <= 1 ? 100 : 1))}% confidence`
    : confidence
      ? (confidence.toLowerCase().includes('confidence') ? confidence : `${confidence} confidence`)
      : undefined
  const title = [
    TITLE[kind],
    source ? `Source: ${source}.` : '',
    asOf ? `As of ${asOf}.` : '',
    fetchedAt ? `Fetched ${fetchedAt}.` : '',
    confidenceLabel ? `Confidence: ${confidenceLabel}.` : '',
    method ? `Method: ${method}.` : '',
    detail || '',
  ].filter(Boolean).join(' ')
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'help',
        fontFamily: T.mono, fontSize: 9, whiteSpace: 'nowrap',
        padding: '2px 7px', border: `1px solid color-mix(in srgb, ${m.color} 40%, transparent)`,
        background: `color-mix(in srgb, ${m.color} 8%, transparent)`, ...style,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, flex: 'none' }} />
      <span style={{ fontWeight: 700, letterSpacing: '0.08em', color: m.color }}>{m.label}</span>
      <span style={{ color: T.muted }}>{source}</span>
      {asOf && <span style={{ color: T.muted }}>· {asOf}</span>}
      {confidenceLabel && <span style={{ color: T.muted }}>· {confidenceLabel}</span>}
    </span>
  )
}

export function ProvenanceGroup({
  items, label = 'Data lineage', style,
}: { items: ProvenanceItem[]; label?: string; style?: React.CSSProperties }) {
  if (!items.length) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', ...style }}>
      <span style={{
        fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: T.muted,
      }}>{label}</span>
      {items.map((item, index) => (
        <Provenance key={`${item.kind}-${item.source}-${index}`} {...item} />
      ))}
    </div>
  )
}
