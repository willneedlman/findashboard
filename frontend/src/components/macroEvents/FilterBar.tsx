import { Search, X } from 'lucide-react'
import { T } from '../../lib/theme'
import { REGIONS, IMPACTS, type Region, type Impact } from '../../data/mockEventsData'

export interface Filters {
  query: string
  region: Region | 'ALL'
  impact: Impact | 'ALL'
}

function Segment({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '6px 12px', cursor: 'pointer',
        background: active ? T.goldTint(14) : 'transparent',
        border: `1px solid ${active ? T.goldTint(50) : T.border}`,
        color: active ? T.gold : T.muted,
        fontFamily: T.label, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
        transition: 'color 0.15s, border-color 0.15s',
      }}>
      {label}
    </button>
  )
}

function Group<V extends string>({ title, options, value, onChange }: {
  title: string; options: { key: V; label: string }[]; value: V; onChange: (v: V) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>{title}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {options.map(o => <Segment key={o.key} label={o.label} active={value === o.key} onClick={() => onChange(o.key)} />)}
      </div>
    </div>
  )
}

export default function FilterBar({ filters, onChange, count }: {
  filters: Filters
  onChange: (next: Filters) => void
  count: number
}) {
  const regionOpts: { key: Region | 'ALL'; label: string }[] = [
    { key: 'ALL', label: 'All' }, ...REGIONS.map(r => ({ key: r.key, label: r.key })),
  ]
  const impactOpts: { key: Impact | 'ALL'; label: string }[] = [
    { key: 'ALL', label: 'All' }, ...IMPACTS.map(i => ({ key: i, label: i })),
  ]

  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      padding: '16px 18px', marginBottom: 20,
      display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'flex-end',
    }}>
      {/* Search */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 240px', minWidth: 200 }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>Search</span>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, color: T.muted, pointerEvents: 'none' }} />
          <input
            value={filters.query}
            onChange={e => onChange({ ...filters, query: e.target.value })}
            placeholder="Event name, e.g. CPI, FOMC, payrolls"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 30px 8px 32px',
              background: T.bg, border: `1px solid ${T.border}`, color: T.text,
              fontFamily: T.label, fontSize: 12, outline: 'none',
            }}
          />
          {filters.query && (
            <button type="button" onClick={() => onChange({ ...filters, query: '' })}
              aria-label="Clear search"
              style={{ position: 'absolute', right: 8, display: 'flex', background: 'none', border: 'none', color: T.muted, cursor: 'pointer', padding: 2 }}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <Group title="Region" options={regionOpts} value={filters.region} onChange={region => onChange({ ...filters, region })} />
      <Group title="Impact" options={impactOpts} value={filters.impact} onChange={impact => onChange({ ...filters, impact })} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 'auto' }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>Matches</span>
        <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.gold, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{count}</span>
      </div>
    </div>
  )
}
