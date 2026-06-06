import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'rgba(255,255,255,0.08)', headerBg: 'var(--theme-surface, #142032)',
  gold: 'var(--theme-primary, #c9a84c)', muted: 'var(--theme-secondary, #5e768f)',
  mono: 'JetBrains Mono, monospace', label: 'IBM Plex Sans, sans-serif',
  pos: '#22C55E', neg: '#EF4444',
}

const shimmerStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 3,
}

function splitUnit(value: string): [string, string] {
  if (value === '—') return ['—', '']
  const bps = value.match(/^([+\-]?\d+)\s*(bps)$/)
  if (bps) return [bps[1], ' bps']
  const pct = value.match(/^([+\-]?[\d.]+)(%)$/)
  if (pct) return [pct[1], '%']
  return [value, '']
}

function Tile({ label, value, valueColor = T.gold }: { label: string; value: string; valueColor?: string }) {
  const [num, unit] = splitUnit(value)
  return (
    <div style={{ background: T.headerBg, borderRight: `1px solid ${T.border}`, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, minWidth: 0, height: '100%' }}>
      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.12em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontWeight: 700, color: valueColor, whiteSpace: 'nowrap', lineHeight: 1.1 }}>
        <span style={{ fontSize: 32 }}>{num}</span>
        {unit && <span style={{ fontSize: 16, opacity: 0.75 }}>{unit}</span>}
      </span>
    </div>
  )
}

function ShimmerTile() {
  return (
    <div style={{ background: T.headerBg, borderRight: `1px solid ${T.border}`, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, height: '100%' }}>
      <div style={{ ...shimmerStyle, width: '65%', height: 9 }} />
      <div style={{ ...shimmerStyle, width: '45%', height: 22 }} />
    </div>
  )
}

const DEFAULT_YIELDS = ['FED', '1Y', '2Y', '5Y', '10Y', 'SPREAD']

export default function MacroStrip({ config }: { config: WidgetConfig }) {
  const selectedKeys = (config.tickers && config.tickers.length > 0) ? config.tickers : DEFAULT_YIELDS

  const { data: yieldData, isLoading: yieldLoading } = useQuery<{ curve: Record<string, number> }>({
    queryKey: ['yield-curve'],
    queryFn: () => axios.get('/api/rates/yield-curve').then(r => r.data),
    staleTime: 300_000,
  })

  const { data: rfData, isLoading: rfLoading } = useQuery<{ rate: number }>({
    queryKey: ['risk-free'],
    queryFn: () => axios.get('/api/rates/risk-free').then(r => r.data),
    staleTime: 300_000,
    enabled: selectedKeys.includes('FED'),
  })

  const isLoading = yieldLoading || (selectedKeys.includes('FED') && rfLoading)
  const curve = yieldData?.curve ?? {}
  const rf = rfData?.rate ?? null

  const spread2_10 = (curve['10Y'] != null && curve['2Y'] != null)
    ? Math.round((curve['10Y'] - curve['2Y']) * 100) : null
  const spread5_30 = (curve['30Y'] != null && curve['5Y'] != null)
    ? Math.round((curve['30Y'] - curve['5Y']) * 100) : null

  // Pure CSS grid — no JS measurement, no flashing
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${selectedKeys.length}, 1fr)`,
    width: '100%',
    height: '100%',
  }

  const container: React.CSSProperties = {
    background: T.bg, width: '100%', height: '100%',
    boxSizing: 'border-box', overflow: 'hidden',
    borderTop: `1px solid ${T.border}`,
  }

  const fmt = (v: number | undefined) => v != null ? `${v.toFixed(2)}%` : '—'

  const tileForKey = (key: string) => {
    switch (key) {
      case 'FED':         return <Tile key="FED"         label="Fed Funds"  value={rf != null ? `${(rf * 100).toFixed(2)}%` : '—'} />
      case '1Y':          return <Tile key="1Y"          label="1Y Yield"   value={fmt(curve['1Y'])} />
      case '2Y':          return <Tile key="2Y"          label="2Y Yield"   value={fmt(curve['2Y'])} />
      case '5Y':          return <Tile key="5Y"          label="5Y Yield"   value={fmt(curve['5Y'])} />
      case '10Y':         return <Tile key="10Y"         label="10Y Yield"  value={fmt(curve['10Y'])} />
      case '20Y':         return <Tile key="20Y"         label="20Y Yield"  value={fmt(curve['20Y'])} />
      case '30Y':         return <Tile key="30Y"         label="30Y Yield"  value={fmt(curve['30Y'])} />
      case 'SPREAD':      return <Tile key="SPREAD"      label="2/10 Spread" value={spread2_10 != null ? `${spread2_10 >= 0 ? '+' : ''}${spread2_10} bps` : '—'} valueColor={spread2_10 == null ? T.muted : spread2_10 >= 0 ? T.pos : T.neg} />
      case 'SPREAD_5_30': return <Tile key="SPREAD_5_30" label="5/30 Spread" value={spread5_30 != null ? `${spread5_30 >= 0 ? '+' : ''}${spread5_30} bps` : '—'} valueColor={spread5_30 == null ? T.muted : spread5_30 >= 0 ? T.pos : T.neg} />
      default:            return null
    }
  }

  return (
    <div style={container}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      <div style={gridStyle}>
        {isLoading
          ? selectedKeys.map(k => <ShimmerTile key={k} />)
          : selectedKeys.map(tileForKey)
        }
      </div>
    </div>
  )
}
