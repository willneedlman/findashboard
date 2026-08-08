import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { DEFAULT_MACRO_STRIP_SERIES } from '../widgetRegistry'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #142032)',
  gold: 'var(--theme-primary, #c9a84c)', muted: 'var(--theme-secondary, #8099b0)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
}

const shimmerStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, rgba(255,255,255,0.05)) 50%, var(--theme-surface, #0d0d0d) 75%)',
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
    <div style={{ background: T.headerBg, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '6px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 3, minWidth: 110, height: '100%' }}>
      <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontWeight: 700, color: valueColor, whiteSpace: 'nowrap', lineHeight: 1.1 }}>
        <span style={{ fontSize: 26 }}>{num}</span>
        {unit && <span style={{ fontSize: 13, opacity: 0.85, marginLeft: 2 }}>{unit}</span>}
      </span>
    </div>
  )
}

function ShimmerTile() {
  return (
    <div style={{ background: T.headerBg, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '6px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 4, height: '100%', minWidth: 110 }}>
      <div style={{ ...shimmerStyle, width: '70%', height: 7 }} />
      <div style={{ ...shimmerStyle, width: '50%', height: 18 }} />
    </div>
  )
}

const MATURITY_RANK: Record<string, number> = {
  FED: 0, '1M': 1, '3M': 2, '6M': 3, '1Y': 4, '2Y': 5,
  '3Y': 6, '5Y': 7, '7Y': 8, '10Y': 9, '20Y': 10, '30Y': 11,
  SPREAD: 12, SPREAD_5_30: 13,
}

export default function MacroStrip({ config }: { config: WidgetConfig }) {
  const rawKeys      = (config.tickers && config.tickers.length > 0) ? config.tickers : DEFAULT_MACRO_STRIP_SERIES
  const selectedKeys = [...rawKeys].sort((a, b) => (MATURITY_RANK[a] ?? 99) - (MATURITY_RANK[b] ?? 99))

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

  // Responsive grid: auto-fill tiles to fit container, min 90px max 1fr, scroll if needed
  const tileCount = selectedKeys.length
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${tileCount}, minmax(90px, 1fr))`,
    width: '100%',
    minWidth: `${tileCount * 110}px`,
    height: '100%',
    gap: 0,
  }

  const container: React.CSSProperties = {
    background: T.bg, width: '100%', height: '100%',
    boxSizing: 'border-box', overflowX: 'auto', overflowY: 'hidden',
    borderTop: `1px solid ${T.border}`,
    borderRight: `1px solid ${T.border}`,
    borderBottom: `1px solid ${T.border}`,
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--theme-border) transparent',
  }

  const fmt = (v: number | undefined) => v != null ? `${v.toFixed(2)}%` : '—'

  const tileForKey = (key: string) => {
    switch (key) {
      case 'FED':         return <Tile key="FED"         label="Fed Funds"   value={rf != null ? `${(rf * 100).toFixed(2)}%` : '—'} />
      case '1M':          return <Tile key="1M"          label="1M Bill"     value={fmt(curve['1M'])} />
      case '3M':          return <Tile key="3M"          label="3M Bill"     value={fmt(curve['3M'])} />
      case '6M':          return <Tile key="6M"          label="6M Bill"     value={fmt(curve['6M'])} />
      case '1Y':          return <Tile key="1Y"          label="1Y Note"     value={fmt(curve['1Y'])} />
      case '2Y':          return <Tile key="2Y"          label="2Y Note"     value={fmt(curve['2Y'])} />
      case '3Y':          return <Tile key="3Y"          label="3Y Note"     value={fmt(curve['3Y'])} />
      case '5Y':          return <Tile key="5Y"          label="5Y Note"     value={fmt(curve['5Y'])} />
      case '7Y':          return <Tile key="7Y"          label="7Y Note"     value={fmt(curve['7Y'])} />
      case '10Y':         return <Tile key="10Y"         label="10Y Note"    value={fmt(curve['10Y'])} />
      case '20Y':         return <Tile key="20Y"         label="20Y Bond"    value={fmt(curve['20Y'])} />
      case '30Y':         return <Tile key="30Y"         label="30Y Bond"    value={fmt(curve['30Y'])} />
      case 'SPREAD':      return <Tile key="SPREAD"      label="2/10 Spread" value={spread2_10 != null ? `${spread2_10 >= 0 ? '+' : ''}${spread2_10} bps` : '—'} valueColor={spread2_10 == null ? T.muted : spread2_10 >= 0 ? T.pos : T.neg} />
      case 'SPREAD_5_30': return <Tile key="SPREAD_5_30" label="5/30 Spread" value={spread5_30 != null ? `${spread5_30 >= 0 ? '+' : ''}${spread5_30} bps` : '—'} valueColor={spread5_30 == null ? T.muted : spread5_30 >= 0 ? T.pos : T.neg} />
      default:            return null
    }
  }

  return (
    <div style={container}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      <style>{`
        /* Scrollbar styling */
        .macro-strip-container::-webkit-scrollbar { height: 6px; }
        .macro-strip-container::-webkit-scrollbar-track { background: transparent; }
        .macro-strip-container::-webkit-scrollbar-thumb { background: var(--theme-border, rgba(255,255,255,0.08)); border-radius: 3px; }
        .macro-strip-container::-webkit-scrollbar-thumb:hover { background: var(--theme-secondary, #8099b0); }
      `}</style>
      <div style={gridStyle} className="macro-strip-container">
        {isLoading
          ? selectedKeys.map(k => <ShimmerTile key={k} />)
          : selectedKeys.map(tileForKey)
        }
      </div>
    </div>
  )
}
