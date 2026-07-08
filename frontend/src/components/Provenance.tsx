import { T } from '../lib/theme'

// Shared data-provenance chip. Tells the user, at a glance, whether the numbers
// on a tool are live market data, a model/derivation, or illustrative sample —
// the durable fix for "is this real?" ambiguity across the terminal.
//
//   <Provenance kind="live"   source="yfinance" asOf="15:42" />
//   <Provenance kind="model"  source="ETF-derived · not a live print" />
//   <Provenance kind="sample" source="illustrative" />

export type ProvenanceKind = 'live' | 'model' | 'sample'

const META: Record<ProvenanceKind, { label: string; color: string }> = {
  live:   { label: 'LIVE',   color: T.pos },
  model:  { label: 'MODEL',  color: T.gold },
  sample: { label: 'SAMPLE', color: T.warn },
}

const TITLE: Record<ProvenanceKind, string> = {
  live:   'Live data from the named source.',
  model:  'Modeled or derived — not a direct market print.',
  sample: 'Illustrative sample data, not a live feed.',
}

export default function Provenance({
  kind, source, asOf, style,
}: { kind: ProvenanceKind; source: string; asOf?: string; style?: React.CSSProperties }) {
  const m = META[kind]
  return (
    <span
      title={`${TITLE[kind]}${source ? ` Source: ${source}.` : ''}${asOf ? ` As of ${asOf}.` : ''}`}
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
    </span>
  )
}
