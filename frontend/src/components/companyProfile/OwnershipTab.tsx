import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import EmptyState from '../EmptyState'
import { Panel, DataTable, MONO, SANS, BRIGHT, DIM } from './ui'
import { DASH, compact, count, pct, tone } from './format'

interface Holder {
  holder?: string; shares?: number | null; value?: number | null
  pct_out?: number | null; pct_change?: number | null; date?: string
}
interface Institutional {
  pct_institutions?: number | null
  pct_insiders?: number | null
  float_shares?: number | null
  holders?: Holder[]
  funds?: Holder[]
  changes?: { filed?: string }
  source?: string
}

const GOLD = 'var(--theme-primary)'
const GREEN = '#2f6b4b'
const NEUTRAL = 'var(--theme-chart-neutral, #4a7fa5)'

export default function OwnershipTab({ ticker }: { ticker: string }) {
  const [view, setView] = useState<'holders' | 'funds'>('holders')

  const q = useQuery<Institutional>({
    queryKey: ['cp-institutional', ticker],
    queryFn: () => axios.get(`/api/corporate/institutional?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const d = q.data ?? {}
  const inst = (d.pct_institutions ?? 0) * 100
  const insiders = (d.pct_insiders ?? 0) * 100
  const retail = Math.max(0, 100 - inst - insiders)
  const rows = (view === 'holders' ? d.holders : d.funds) ?? []
  const hasMix = d.pct_institutions != null || d.pct_insiders != null

  if (!q.isLoading && !hasMix && !rows.length) {
    return (
      <EmptyState
        title="Ownership"
        hint="No 13F ownership reported for this symbol. Expected for a security institutions do not file positions on."
      />
    )
  }

  // Three segments only. Passive share is a SUBSET of institutions, not a slice
  // of the float, so it belongs in the legend and never in the bar.
  const segments = [
    { label: 'Institutions', value: inst, color: GOLD },
    { label: 'Insiders', value: insiders, color: GREEN },
    { label: 'Retail and other', value: retail, color: NEUTRAL },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Panel title="Ownership mix" meta={d.changes?.filed ? `13F, filed ${d.changes.filed}` : '13F'}>
        <div style={{ padding: '18px 18px 16px' }}>
          <div style={{ display: 'flex', height: 26, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
            {segments.map(s => (
              <div key={s.label} style={{
                width: `${s.value}%`, background: s.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {/* Suppressed under ~6% or the label spills out of its own box. */}
                {s.value >= 6 && (
                  <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: T.bg }}>
                    {s.value.toFixed(1)}%
                  </span>
                )}
              </div>
            ))}
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 18, marginTop: 16,
          }}>
            <Legend swatch={GOLD} label="Institutions" value={pct(inst)}
              note={d.float_shares ? `${compact((d.pct_institutions ?? 0) * d.float_shares)} shares held` : undefined} />
            <Legend swatch={GREEN} label="Insiders" value={pct(insiders)}
              note={d.float_shares ? `${compact((d.pct_insiders ?? 0) * d.float_shares)} shares held` : undefined} />
            <Legend swatch={NEUTRAL} label="Retail and other" value={pct(retail)}
              note="Residual of float" />
          </div>
        </div>
      </Panel>

      <Panel
        title={view === 'holders' ? 'Top institutional holders' : 'Top fund holders'}
        meta={d.source ? `13F, via ${d.source}` : '13F'}
      >
        <div style={{ display: 'flex', gap: 2, padding: '10px 16px', borderBottom: `1px solid ${T.borderFaint}` }}>
          {(['holders', 'funds'] as const).map(k => {
            const on = k === view
            return (
              <button key={k} onClick={() => setView(k)} style={{
                fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', padding: '5px 11px', cursor: 'pointer',
                background: on ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent',
                border: `1px solid ${on ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : 'transparent'}`,
                color: on ? T.gold : T.muted,
                transition: 'color 120ms cubic-bezier(0.23,1,0.32,1)',
              }}>
                {k === 'holders' ? 'Institutions' : 'Funds'}
              </button>
            )
          })}
        </div>
        {rows.length ? (
          <DataTable
            head={[view === 'holders' ? 'Holder' : 'Fund', 'Shares', 'Value', 'Percent out', 'Change']}
            firstColWidth={220}
            rows={rows.map(h => [
              h.holder ?? DASH,
              count(h.shares),
              compact(h.value),
              // This source sends the top-level mix as fractions but the
              // per-holder figures already as percents, so these two must not
              // be scaled again. They were reading 806% of shares outstanding.
              pct(h.pct_out, 2),
              <span key="c" style={{ color: tone(h.pct_change) }}>{pct(h.pct_change, 2, true)}</span>,
            ])}
          />
        ) : (
          <div style={{ padding: 18, fontFamily: MONO, fontSize: 11, color: T.muted }}>
            No {view === 'holders' ? 'institutional' : 'fund'} positions reported.
          </div>
        )}
      </Panel>
    </div>
  )
}

function Legend({ swatch, label, value, note, dim }: {
  swatch: string; label: string; value: string; note?: string; dim?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 9, height: 9, background: swatch, opacity: dim ? 0.55 : 1, flexShrink: 0 }} />
        <span style={{
          fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.muted,
        }}>
          {label}
        </span>
      </span>
      <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: BRIGHT }}>{value}</span>
      {note && <span style={{ fontFamily: SANS, fontSize: 10, color: DIM }}>{note}</span>}
    </div>
  )
}
