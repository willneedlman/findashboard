import { Search, Calendar, X } from 'lucide-react'
import { T } from '../../lib/theme'
import { REGIONS, IMPACTS, type Region, type Impact } from '../../data/mockEventsData'

export interface Filters {
  query: string
  region: Region | 'ALL'
  impact: Impact | 'ALL'
  from: string   // yyyy-mm-dd
  to: string     // yyyy-mm-dd
}

const box: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center' }
const seg: React.CSSProperties = { padding: '5px 12px', fontFamily: T.label, fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', whiteSpace: 'nowrap' }

function Segmented<V extends string>({ options, value, onPick, danger }: {
  options: { key: V; label: string }[]; value: V; onPick: (v: V) => void; danger?: V
}) {
  return (
    <div style={{ ...box, padding: 3, gap: 2 }}>
      {options.map(o => {
        const active = o.key === value
        return (
          <button key={o.key} type="button" onClick={() => onPick(o.key)}
            style={{
              ...seg, fontWeight: active ? 700 : 600,
              color: active ? T.bg : o.key === danger ? T.neg : T.muted,
              background: active ? T.gold : 'transparent',
            }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function MacroToolbar({ filters, onChange, count }: {
  filters: Filters; onChange: (f: Filters) => void; count: number
}) {
  const regionOpts: { key: Region | 'ALL'; label: string }[] = [{ key: 'ALL', label: 'ALL' }, ...REGIONS.map(r => ({ key: r.key, label: r.key }))]
  const impactOpts: { key: Impact | 'ALL'; label: string }[] = [
    { key: 'ALL', label: 'ALL' }, { key: 'High', label: 'HIGH' }, { key: 'Medium', label: 'MED' }, { key: 'Low', label: 'LOW' },
  ]
  const dateInput: React.CSSProperties = {
    background: 'transparent', border: 'none', outline: 'none', color: T.text,
    fontFamily: T.mono, fontSize: 10.5, colorScheme: 'dark', width: 112, padding: 0,
  }

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '16px 0' }}>
      <div style={{ ...box, flex: 1, padding: '8px 12px', gap: 8 }}>
        <Search size={13} color={T.muted} style={{ flexShrink: 0 }} />
        <input
          value={filters.query}
          onChange={e => onChange({ ...filters, query: e.target.value })}
          placeholder="Search events — CPI, FOMC, payrolls…"
          style={{ ...dateInput, width: '100%', fontFamily: T.label, fontSize: 11 }}
        />
        {filters.query && <button type="button" onClick={() => onChange({ ...filters, query: '' })} aria-label="Clear"
          style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', display: 'flex', padding: 0 }}><X size={13} /></button>}
      </div>

      <div style={{ ...box, padding: '7px 12px', gap: 8 }}>
        <Calendar size={12} color={T.muted} style={{ flexShrink: 0 }} />
        <input type="date" value={filters.from} onChange={e => onChange({ ...filters, from: e.target.value })} style={dateInput} aria-label="From date" />
        <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 11 }}>→</span>
        <input type="date" value={filters.to} onChange={e => onChange({ ...filters, to: e.target.value })} style={dateInput} aria-label="To date" />
      </div>

      <Segmented options={regionOpts} value={filters.region} onPick={region => onChange({ ...filters, region })} />
      <Segmented options={impactOpts} value={filters.impact} onPick={impact => onChange({ ...filters, impact })} danger="High" />

      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, whiteSpace: 'nowrap' }}>{count} matches</span>
    </div>
  )
}
