import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:    'var(--theme-bg, #101c2e)',
  border: 'rgba(255,255,255,0.05)',
  gold:  'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)',
  text:  'var(--theme-text, #d7e3fc)',
  mono:  'var(--theme-mono)',
  label: 'var(--theme-sans)',
  rich:  '#e07a52',
  cheap: '#22c55e',
  neutral: '#8a9ab0',
}

interface HubData {
  pe_ratio: number | null
  forward_pe: number | null
  price_to_sales: number | null
  ev_ebitda: number | null
  peg_ratio: number | null
  dividend_yield: number | null
}

// Broad large-cap reference levels. The sub-line compares each metric to these
// ("vs market") rather than a fabricated per-sector number.
const REF: Record<string, number> = { pe: 22, fpe: 19, ps: 2.8, ev: 14, peg: 1.6, dy: 1.5 }

// Uniform rule (matches the design): above the market reference reads rich
// (orange, up), below reads cheap (green, down), within 8% reads in line.
function cell(label: string, raw: number | null, ref: number, fmt: (v: number) => string) {
  if (raw == null || !isFinite(raw) || raw <= 0) return { label, value: '—', rel: '', color: T.neutral, arrow: '' }
  const deltaPct = (raw / ref - 1) * 100
  const inLine = Math.abs(deltaPct) < 8
  const isHigh = deltaPct > 0
  const color = inLine ? T.neutral : isHigh ? T.rich : T.cheap
  const arrow = inLine ? '' : isHigh ? '↑' : '↓'
  const rel = inLine ? 'in line' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}% vs mkt`
  return { label, value: fmt(raw), rel, color, arrow }
}

export default function ValuationWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()
  const { data, isLoading } = useQuery<HubData>({
    queryKey: ['valuation-widget', ticker],
    queryFn: () => axios.get(`/api/corporate/hub?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })

  // yfinance returns dividendYield already as a percent (0.36 = 0.36%).
  const dy = data?.dividend_yield ?? null
  const cells = [
    cell('P / E', data?.pe_ratio ?? null, REF.pe, v => v.toFixed(1)),
    cell('Fwd P / E', data?.forward_pe ?? null, REF.fpe, v => v.toFixed(1)),
    cell('P / S', data?.price_to_sales ?? null, REF.ps, v => v.toFixed(1)),
    cell('EV / EBITDA', data?.ev_ebitda ?? null, REF.ev, v => v.toFixed(1)),
    cell('PEG', data?.peg_ratio ?? null, REF.peg, v => v.toFixed(2)),
    cell('Div Yield', dy, REF.dy, v => `${v.toFixed(2)}%`),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridAutoRows: '1fr' }}>
        {cells.map((m, i) => (
          <div key={i} style={{ padding: '10px 12px', borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, minWidth: 0 }}>
            <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{m.label}</div>
            <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{isLoading ? '·' : m.value}</div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: m.color, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
              {m.arrow && <span>{m.arrow}</span>}{m.rel}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
