import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'

const T = {
  bg: 'var(--theme-bg, #101c2e)', muted: 'var(--theme-secondary, #5e768f)',
  text: 'var(--theme-text, #d7e3fc)', mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
}

interface Row { ticker: string; marketCap: number | null; sector: string; change1d: number | null }
interface Tile { t: string; cap: number; chg: number }
interface Sector { name: string; cap: number; tiles: Tile[] }

function heat(p: number): string {
  const x = Math.max(-1, Math.min(1, p / 4))
  return x >= 0 ? `rgba(34,197,94,${(0.12 + x * 0.5).toFixed(2)})` : `rgba(239,68,68,${(0.12 + -x * 0.5).toFixed(2)})`
}

function groupSectors(rows: Row[]): Sector[] {
  const by: Record<string, Tile[]> = {}
  for (const r of rows) {
    if (!r.sector || r.marketCap == null || r.change1d == null) continue
    ;(by[r.sector] ??= []).push({ t: r.ticker, cap: r.marketCap, chg: r.change1d })
  }
  return Object.entries(by)
    .map(([name, tiles]) => ({
      name,
      tiles: tiles.sort((a, b) => b.cap - a.cap).slice(0, 8),
      cap: tiles.reduce((s, t) => s + t.cap, 0),
    }))
    .filter(s => s.tiles.length > 0)
    .sort((a, b) => b.cap - a.cap)
    .slice(0, 7)
}

export default function HeatmapWidget({ config: _c }: { config: WidgetConfig }) {
  const { data, isLoading, isError } = useQuery<{ results: Row[] }>({
    queryKey: ['heatmap-screener'],
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: () => axios.post('/api/screener/run', { filters: [], sort_by: 'marketCap', sort_dir: 'desc', limit: 80 }).then(r => r.data),
  })

  const sectors = groupSectors(data?.results ?? [])

  if (sectors.length === 0) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, background: T.bg, fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
        {isLoading ? 'Loading market data…' : isError ? 'Heatmap data unavailable.' : 'No market data.'}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', gap: 2, padding: 2, background: T.bg, overflow: 'hidden' }}>
      {sectors.map(sec => {
        const maxCap = Math.max(...sec.tiles.map(t => t.cap), 1)
        return (
          <div key={sec.name} style={{ flexGrow: sec.cap, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontFamily: T.label, fontSize: 7, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0, paddingLeft: 1 }}>{sec.name}</div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {sec.tiles.map(t => {
                const rel = t.cap / maxCap
                return (
                  <div key={t.t} style={{ flexGrow: t.cap, flexBasis: 0, minHeight: 0, background: heat(t.chg), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, overflow: 'hidden', padding: 1 }}>
                    {rel >= 0.32 && <TickerLogo ticker={t.t} size={Math.round(10 + rel * 11)} />}
                    <span style={{ fontFamily: T.mono, fontSize: Math.min(11, 7 + rel * 4), fontWeight: 700, color: T.text, lineHeight: 1, whiteSpace: 'nowrap' }}>{t.t}</span>
                    {rel >= 0.5 && <span style={{ fontFamily: T.mono, fontSize: 8, color: 'rgba(255,255,255,0.75)', marginTop: 1 }}>{t.chg >= 0 ? '+' : ''}{t.chg.toFixed(1)}%</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
