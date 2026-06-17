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
  cheap: 'var(--theme-positive, #22c55e)',
  neutral: 'var(--theme-secondary, #8a9ab0)',
}

interface PeerRow {
  ticker: string; is_target: boolean
  pe: number | null; forward_pe: number | null; ps: number | null
  ev_ebitda: number | null; peg: number | null; dividend_yield: number | null
}
interface PeerResp { ticker: string; sector: string; peers: PeerRow[] }

function median(vals: (number | null | undefined)[]): number | null {
  const xs = vals.filter((v): v is number => v != null && isFinite(v) && v > 0).sort((a, b) => a - b)
  if (!xs.length) return null
  const m = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
}

// For multiples, above the sector median reads rich (orange), below reads cheap
// (green); within 8% is in line. `invert` flips the read for dividend yield,
// where a higher yield is the attractive (cheap) signal, not the expensive one.
function cell(label: string, raw: number | null, med: number | null, fmt: (v: number) => string, invert = false) {
  if (raw == null || !isFinite(raw) || raw <= 0) return { label, value: '—', rel: '', color: T.neutral, arrow: '' }
  const value = fmt(raw)
  if (med == null) return { label, value, rel: 'no sector data', color: T.neutral, arrow: '' }
  const deltaPct = (raw / med - 1) * 100
  const inLine = Math.abs(deltaPct) < 8
  const isHigh = deltaPct > 0
  const expensive = invert ? !isHigh : isHigh
  const color = inLine ? T.neutral : expensive ? T.rich : T.cheap
  const arrow = inLine ? '' : isHigh ? '↑' : '↓'
  const rel = inLine ? 'in line' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}% vs sector`
  return { label, value, rel, color, arrow }
}

export default function ValuationWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()
  const { data, isLoading } = useQuery<PeerResp>({
    queryKey: ['valuation-widget', ticker],
    queryFn: () => axios.get(`/api/corporate/peer-valuation?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 1_800_000,
    retry: 1,
  })

  const peers = data?.peers ?? []
  const self = peers.find(p => p.is_target) ?? null
  const others = peers.filter(p => !p.is_target)
  const med = (k: keyof PeerRow) => median(others.map(p => p[k] as number | null))

  const cells = [
    cell('P / E', self?.pe ?? null, med('pe'), v => v.toFixed(1)),
    cell('Fwd P / E', self?.forward_pe ?? null, med('forward_pe'), v => v.toFixed(1)),
    cell('P / S', self?.ps ?? null, med('ps'), v => v.toFixed(1)),
    cell('EV / EBITDA', self?.ev_ebitda ?? null, med('ev_ebitda'), v => v.toFixed(1)),
    cell('PEG', self?.peg ?? null, med('peg'), v => v.toFixed(2)),
    cell('Div Yield', self?.dividend_yield ?? null, med('dividend_yield'), v => `${v.toFixed(2)}%`, true),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridAutoRows: '1fr' }}>
        {cells.map((m, i) => (
          <div key={i} style={{ padding: '10px 12px', borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, minWidth: 0 }}>
            <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{m.label}</div>
            <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{isLoading ? '·' : m.value}</div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: m.color, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {m.arrow && <span>{m.arrow}</span>}{isLoading ? '' : m.rel}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
