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

const POS = '#22c55e', NEG = '#ef4444'
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
  const vals = rows.map(s => s.returns?.[period]).filter((v): v is number => v != null)
  const maxAbs = Math.max(0.01, ...vals.map(Math.abs))
  const ups = vals.filter(v => v >= 0).length
  const downs = vals.filter(v => v < 0).length

  const periodBtn = (active: boolean): React.CSSProperties => ({
    fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 7px', cursor: 'pointer', letterSpacing: '0.06em',
    border: active ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
    background: active ? 'rgba(201,168,76,0.12)' : 'transparent',
    color: active ? T.gold : 'rgba(255,255,255,0.3)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', padding: '4px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} style={periodBtn(period === p)}>{p}</button>)}
        <span style={{ marginLeft: 'auto', fontFamily: T.mono, fontSize: 9, whiteSpace: 'nowrap' }}>
          <span style={{ color: POS }}>↑ {ups}</span>&nbsp;&nbsp;<span style={{ color: NEG }}>↓ {downs}</span>
        </span>
      </div>

      {isLoading && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Loading…</div>}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Failed to load sectors</div>}

      {data && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {rows.map((s, i) => {
            const v = s.returns?.[period] ?? null
            const up = (v ?? 0) >= 0
            const scaled = v == null ? 0 : Math.min(Math.abs(v) / maxAbs, 1)
            const pct = `${(scaled * 100).toFixed(0)}%`
            const a = (0.35 + scaled * 0.5).toFixed(2)
            return (
              <div key={s.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontFamily: T.mono, fontSize: 9, color: '#4a5d72', width: 14, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: T.gold, border: '1px solid rgba(201,168,76,0.3)', padding: '1px 5px', flexShrink: 0, width: 42, textAlign: 'center' }}>{s.ticker}</span>
                <span style={{ fontFamily: T.label, fontSize: 10, color: '#c8d4e6', width: 92, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 40 }}>
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: 1 }}>
                    <div style={{ width: up ? '0%' : pct, height: 9, background: `rgba(239,68,68,${a})` }} />
                  </div>
                  <div style={{ width: 1, height: 13, background: 'rgba(255,255,255,0.14)', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start', paddingLeft: 1 }}>
                    <div style={{ width: up ? pct : '0%', height: 9, background: `rgba(34,197,94,${a})` }} />
                  </div>
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: up ? POS : NEG, width: 46, textAlign: 'right', flexShrink: 0 }}>
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
