import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)',
  border: 'rgba(255,255,255,0.08)',
  headerBg: 'var(--theme-surface, #142032)',
  gold: 'var(--theme-primary, #c9a84c)',
  text: '#d7e3fc',
  muted: 'var(--theme-secondary, #5e768f)',
  mono: 'JetBrains Mono, monospace',
  label: 'IBM Plex Sans, sans-serif',
  pos: '#22C55E',
  neg: '#EF4444',
}

interface ChartData {
  metrics: {
    current_price: number
    total_return: number
  }
  price: { date: string; value: number }[]
}

const shimmerStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 2s infinite',
  borderRadius: 4,
}

const PERIOD_DAYS: Record<string, number> = {
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
  '1y': 365,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const v: number = payload[0].value
  return (
    <div
      style={{
        background: T.headerBg,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        padding: '4px 8px',
        fontFamily: T.mono,
        fontSize: 11,
        color: T.text,
      }}
    >
      ${v.toFixed(2)}
    </div>
  )
}

export default function MiniChart({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker
  const period = config.period ?? '3mo'
  const days = PERIOD_DAYS[period] ?? 90
  const periodStart = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
  const strokeColor = config.color ?? 'var(--theme-tertiary, #1f5673)'
  const gradId = `mini-grad-${ticker}-${period}`

  const { data, isLoading, isError } = useQuery<ChartData>({
    queryKey: ['mini-chart', ticker, period],
    queryFn: async () => {
      const res = await axios.get(`/api/market/history?ticker=${ticker}&start=${periodStart}`)
      return res.data
    },
    enabled: !!ticker,
    staleTime: 900_000,
  })

  const containerStyle: React.CSSProperties = {
    background: T.bg,
    padding: '12px 14px',
    fontFamily: T.mono,
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    overflow: 'hidden',
  }

  if (!ticker || isError) {
    return (
      <div style={containerStyle}>
        <span style={{ color: T.gold, fontWeight: 700, fontSize: 13 }}>
          {config.ticker || 'No ticker set'}
        </span>
        <span style={{ color: T.muted, fontSize: 11, fontFamily: T.label }}>
          Configure ticker in edit mode.
        </span>
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div style={containerStyle}>
        <style>{`@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
        <div style={{ ...shimmerStyle, width: '35%', height: 14 }} />
        <div style={{ ...shimmerStyle, width: '100%', flex: 1, minHeight: 80 }} />
      </div>
    )
  }

  const { current_price, total_return } = data.metrics
  const deltaColor = total_return >= 0 ? T.pos : T.neg
  const deltaSign = total_return >= 0 ? '+' : ''

  return (
    <div style={containerStyle}>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: T.gold, fontWeight: 700, fontSize: 14, letterSpacing: 1 }}>
          {ticker}
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ color: T.text, fontSize: 14, fontWeight: 600 }}>
            ${current_price.toFixed(2)}
          </span>
          <span style={{ color: deltaColor, fontSize: 12 }}>
            {deltaSign}{total_return.toFixed(2)}%
          </span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 60 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.price} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={strokeColor} stopOpacity={0.4} />
                <stop offset="95%" stopColor={strokeColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(128,128,128,0.07)" vertical={false} />
            <XAxis dataKey="date" hide />
            <YAxis
              orientation="right"
              width={44}
              tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => v.toFixed(0)}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="value"
              stroke={strokeColor}
              strokeWidth={1.5}
              fill={`url(#${gradId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
