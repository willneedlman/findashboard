import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  neg:     '#ef4444',
}

interface SectorRow {
  ticker: string
  name: string
  returns: Record<string, number | null>
  momentum: number | null
}
interface RotationResp { sectors: SectorRow[]; as_of: string }

// Same green→red heat ramp the full Sector Rotation tool uses.
function heat(v: number | null, maxAbs = 12): string {
  if (v == null) return 'var(--theme-hover, rgba(255,255,255,0.04))'
  const i = Math.min(Math.abs(v) / maxAbs, 1)
  return v > 0 ? `rgba(34,197,94,${0.12 + i * 0.45})` : `rgba(239,68,68,${0.12 + i * 0.45})`
}

const PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y']

export default function SectorRotationWidget({ config }: { config: WidgetConfig }) {
  const [period, setPeriod] = useState(PERIODS.includes(config.sectorPeriod ?? '') ? (config.sectorPeriod as string) : '1M')

  const { data, isLoading, isError } = useQuery<RotationResp>({
    queryKey: ['sector-rotation-widget'],
    queryFn: () => axios.get('/api/market/sector-rotation').then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  const rows = [...(data?.sectors ?? [])].sort(
    (a, b) => (b.returns?.[period] ?? -Infinity) - (a.returns?.[period] ?? -Infinity)
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', padding: '3px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {PERIODS.map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 6px',
            border: period === p ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
            background: period === p ? 'rgba(201,168,76,0.12)' : 'transparent',
            color: period === p ? T.gold : 'rgba(255,255,255,0.3)',
            cursor: 'pointer', letterSpacing: '0.06em',
          }}>{p}</button>
        ))}
      </div>

      {isLoading && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Loading…</div>}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Failed to load sectors</div>}

      {data && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {rows.map(s => {
            const v = s.returns?.[period] ?? null
            return (
              <div key={s.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid ${T.border}`, background: heat(v) }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.gold, minWidth: 38 }}>{s.ticker}</span>
                <span style={{ fontFamily: T.label, fontSize: 10, color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text }}>
                  {v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
