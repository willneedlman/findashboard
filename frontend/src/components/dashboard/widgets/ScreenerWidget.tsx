import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { fmtMarketCap } from '../../../lib/format'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  faint:   'rgba(255,255,255,0.05)',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #8099b0)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive, #22c55e)',
  neg:     'var(--theme-negative, #ef4444)',
}

interface Row {
  ticker: string; companyName?: string; sector?: string
  price?: number | null; change1d?: number | null; marketCap?: number | null; volume?: number | null
  peRatio?: number | null; forwardPE?: number | null; psRatio?: number | null; pbRatio?: number | null
  evEbitda?: number | null; dividendYield?: number | null; roe?: number | null; netMargin?: number | null
  revenueGrowth?: number | null; epsGrowth?: number | null; beta?: number | null
}
interface ScreenResp { results: Row[] }
interface Filter { field: string; operator: string; value: number }

const SCREENS: { key: string; label: string; filters: Filter[]; sort_by: string; sort_dir: 'asc' | 'desc' }[] = [
  { key: 'mktcap',   label: 'Mkt Cap',  filters: [], sort_by: 'marketCap', sort_dir: 'desc' },
  { key: 'gainers',  label: 'Gainers',  filters: [], sort_by: 'change1d',  sort_dir: 'desc' },
  { key: 'losers',   label: 'Losers',   filters: [], sort_by: 'change1d',  sort_dir: 'asc'  },
  { key: 'volume',   label: 'Volume',   filters: [], sort_by: 'volume',    sort_dir: 'desc' },
  { key: 'value',    label: 'Value',    filters: [{ field: 'peRatio', operator: 'gt', value: 0 }, { field: 'peRatio', operator: 'lt', value: 18 }], sort_by: 'peRatio', sort_dir: 'asc' },
  { key: 'growth',   label: 'Growth',   filters: [{ field: 'revenueGrowth', operator: 'gt', value: 20 }], sort_by: 'revenueGrowth', sort_dir: 'desc' },
  { key: 'dividend', label: 'Dividend', filters: [{ field: 'dividendYield', operator: 'gt', value: 3 }], sort_by: 'dividendYield', sort_dir: 'desc' },
  { key: 'quality',  label: 'Quality',  filters: [{ field: 'roe', operator: 'gt', value: 15 }], sort_by: 'roe', sort_dir: 'desc' },
]

function fmtVol(v?: number | null): string {
  if (v == null) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return String(v)
}
const num = (v?: number | null, d = 1) => v == null ? '—' : v.toFixed(d)
const pctCell = (v?: number | null, d = 1) => ({ text: v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`, color: v == null ? T.muted : v >= 0 ? T.pos : T.neg })

interface Col { id: string; label: string; w: number; render: (r: Row) => { text: string; color?: string } }
const COLUMNS: Col[] = [
  { id: 'last',   label: 'Last',     w: 64, render: r => ({ text: r.price != null ? `$${r.price.toFixed(2)}` : '—' }) },
  { id: 'chg1d',  label: '1D',       w: 60, render: r => pctCell(r.change1d, 2) },
  { id: 'mktcap', label: 'Mkt Cap',  w: 74, render: r => ({ text: r.marketCap != null ? fmtMarketCap(r.marketCap * 1e9) : '—' }) },
  { id: 'pe',     label: 'P/E',      w: 52, render: r => ({ text: num(r.peRatio) }) },
  { id: 'fpe',    label: 'Fwd P/E',  w: 60, render: r => ({ text: num(r.forwardPE) }) },
  { id: 'ps',     label: 'P/S',      w: 50, render: r => ({ text: num(r.psRatio, 2) }) },
  { id: 'pb',     label: 'P/B',      w: 50, render: r => ({ text: num(r.pbRatio, 2) }) },
  { id: 'ev',     label: 'EV/EBITDA',w: 72, render: r => ({ text: num(r.evEbitda) }) },
  { id: 'dy',     label: 'Yield',    w: 56, render: r => ({ text: r.dividendYield != null ? `${r.dividendYield.toFixed(2)}%` : '—' }) },
  { id: 'roe',    label: 'ROE',      w: 56, render: r => pctCell(r.roe) },
  { id: 'nm',     label: 'Net Mgn',  w: 62, render: r => pctCell(r.netMargin) },
  { id: 'rg',     label: 'Rev Gr',   w: 60, render: r => pctCell(r.revenueGrowth) },
  { id: 'eg',     label: 'EPS Gr',   w: 60, render: r => pctCell(r.epsGrowth) },
  { id: 'beta',   label: 'Beta',     w: 50, render: r => ({ text: num(r.beta, 2) }) },
  { id: 'vol',    label: 'Vol',      w: 60, render: r => ({ text: fmtVol(r.volume) }) },
  { id: 'sector', label: 'Sector',   w: 120, render: r => ({ text: r.sector || '—', color: T.muted }) },
]
const DEFAULT_COLS = ['last', 'chg1d', 'mktcap', 'pe']
const TICKER_W = 116

export default function ScreenerWidget({ config: _config }: { config: WidgetConfig }) {
  const [key, setKey] = useState('mktcap')
  const [visible, setVisible] = useState<string[]>(DEFAULT_COLS)
  const [open, setOpen] = useState<'' | 'screen' | 'cols'>('')
  const screen = SCREENS.find(s => s.key === key) ?? SCREENS[0]

  const { data, isLoading, isError } = useQuery<ScreenResp>({
    queryKey: ['screener-widget', screen.key],
    queryFn: () => axios.post('/api/screener/run', {
      filters: screen.filters, sector: null, exchange: null,
      sort_by: screen.sort_by, sort_dir: screen.sort_dir, limit: 40,
    }).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })

  const rows = data?.results ?? []
  const cols = COLUMNS.filter(c => visible.includes(c.id))
  const minW = TICKER_W + cols.reduce((s, c) => s + c.w, 0) + 20

  const ctrlBtn: React.CSSProperties = {
    fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    padding: '3px 8px', cursor: 'pointer', border: `1px solid ${T.border}`, background: 'var(--theme-bg, #101c2e)', color: T.text,
    display: 'inline-flex', alignItems: 'center', gap: 5,
  }
  const TH: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10.5, padding: '5px 8px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {/* Controls: Screen + Columns dropdowns */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <button style={ctrlBtn} onClick={() => setOpen(o => o === 'screen' ? '' : 'screen')}>
          <span style={{ color: T.muted }}>Screen:</span> <span style={{ color: T.gold }}>{screen.label}</span>
          <span style={{ color: T.muted, fontSize: 8 }}>{open === 'screen' ? '↑' : '↓'}</span>
        </button>
        <button style={ctrlBtn} onClick={() => setOpen(o => o === 'cols' ? '' : 'cols')}>
          Columns <span style={{ color: T.muted }}>({cols.length})</span>
          <span style={{ color: T.muted, fontSize: 8 }}>{open === 'cols' ? '↑' : '↓'}</span>
        </button>
      </div>

      {open === 'screen' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 8px', borderBottom: `1px solid ${T.border}`, background: T.surface, flexShrink: 0 }}>
          {SCREENS.map(s => (
            <button key={s.key} onClick={() => { setKey(s.key); setOpen('') }} style={{
              fontFamily: T.mono, fontSize: 9, fontWeight: 700, padding: '2px 8px', cursor: 'pointer', letterSpacing: '0.04em',
              border: key === s.key ? '1px solid color-mix(in srgb, var(--theme-primary) 55%, transparent)' : `1px solid ${T.border}`,
              background: key === s.key ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent', color: key === s.key ? T.gold : T.muted,
            }}>{s.label}</button>
          ))}
        </div>
      )}

      {open === 'cols' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '8px', borderBottom: `1px solid ${T.border}`, background: T.surface, flexShrink: 0, maxHeight: 110, overflowY: 'auto' }}>
          {COLUMNS.map(c => {
            const on = visible.includes(c.id)
            const toggle = () => setVisible(v => on ? v.filter(x => x !== c.id) : [...v, c.id])
            return (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                <span onClick={toggle} style={{ width: 12, height: 12, flexShrink: 0, border: `1px solid ${on ? T.gold : T.border}`, background: on ? 'color-mix(in srgb, var(--theme-primary) 35%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {on && <span style={{ width: 6, height: 6, background: T.gold }} />}
                </span>
                <span onClick={toggle} style={{ fontFamily: T.mono, fontSize: 9.5, color: on ? T.gold : T.muted }}>{c.label}</span>
              </label>
            )
          })}
        </div>
      )}

      {isLoading && (() => {
        const bar = (w: string): React.CSSProperties => ({
          height: 9, width: w, borderRadius: 3,
          background: 'linear-gradient(90deg, color-mix(in srgb, var(--theme-text, #d7e3fc) 6%, transparent) 25%, color-mix(in srgb, var(--theme-text, #d7e3fc) 18%, transparent) 50%, color-mix(in srgb, var(--theme-text, #d7e3fc) 6%, transparent) 75%)',
          backgroundSize: '200% 100%', animation: 'ft-shimmer 1.4s linear infinite',
        })
        return (
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} aria-busy="true" aria-label="Running screen">
            <table style={{ minWidth: minW, width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: T.surface, zIndex: 1 }}>
                  <th style={{ ...TH, textAlign: 'left', width: TICKER_W }}>Ticker</th>
                  {cols.map(c => <th key={c.id} style={{ ...TH, width: c.w }}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 9 }).map((_, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.faint}` }}>
                    <td style={{ ...TD, textAlign: 'left' }}><div style={{ ...bar('46px'), animationDelay: `${i * 0.05}s` }} /></td>
                    {cols.map(c => (
                      <td key={c.id} style={{ ...TD }}><div style={{ ...bar('70%'), marginLeft: 'auto', animationDelay: `${i * 0.05}s` }} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: '8px 12px', fontFamily: T.mono, fontSize: 9, letterSpacing: '0.06em', color: T.muted, textTransform: 'uppercase' }}>Running screen…</div>
          </div>
        )
      })()}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Screen failed. Check the FMP key.</div>}

      {data && (rows.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>No matches.</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table style={{ minWidth: minW, width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: T.surface, zIndex: 1 }}>
                <th style={{ ...TH, textAlign: 'left', width: TICKER_W }}>Ticker</th>
                {cols.map(c => <th key={c.id} style={{ ...TH, width: c.w }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.ticker} style={{ borderBottom: `1px solid ${T.faint}` }}>
                  <td style={{ ...TD, textAlign: 'left' }}>
                    <span style={{ color: T.gold, fontWeight: 700 }}>{r.ticker}</span>
                    <span style={{ color: T.muted, fontSize: 8.5, marginLeft: 6 }}>{(r.companyName ?? '').slice(0, 14)}</span>
                  </td>
                  {cols.map(c => {
                    const { text, color } = c.render(r)
                    return <td key={c.id} style={{ ...TD, width: c.w, color: color ?? T.text }}>{text}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
