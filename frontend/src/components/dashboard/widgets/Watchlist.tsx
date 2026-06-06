import { useState } from 'react'
import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'rgba(255,255,255,0.08)', headerBg: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: '#d7e3fc', muted: 'var(--theme-secondary, #5e768f)', dim: '#3a4d62',
  mono: 'JetBrains Mono, monospace', label: 'IBM Plex Sans, sans-serif',
  pos: '#22C55E', neg: '#EF4444', warn: '#f59e0b',
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 3, height: 12,
}

interface HubData {
  ticker: string
  pct_change_1d: number | null
  market_cap: number | null
  estimated_pe: number | null
  implied_move: number | null
  consensus: string | null
}

// ── Column definitions ────────────────────────────────────────────────────────
const COLUMNS = [
  { id: '1d_pct',    label: '1D %',       width: 82 },
  { id: 'mkt_cap',   label: 'Mkt Cap',    width: 90 },
  { id: 'pe',        label: 'P/E',        width: 68 },
  { id: 'impl_move', label: 'Impl Move',  width: 90 },
  { id: 'consensus', label: 'Rating',     width: 118 },
] as const
type ColId = typeof COLUMNS[number]['id']
const ALL_COL_IDS: ColId[] = COLUMNS.map(c => c.id)
const DEFAULT_COLS: ColId[] = ['1d_pct', 'mkt_cap', 'pe']

function loadCols(): Set<ColId> {
  try {
    const raw = localStorage.getItem('watchlist-cols')
    if (raw) return new Set(JSON.parse(raw) as ColId[])
  } catch { /**/ }
  return new Set(DEFAULT_COLS)
}
function saveCols(s: Set<ColId>) {
  try { localStorage.setItem('watchlist-cols', JSON.stringify([...s])) } catch { /**/ }
}

function fmt(v: number | null, pre = '', suf = '', d = 2) {
  return v != null ? `${pre}${v.toFixed(d)}${suf}` : '—'
}
function formatMarketCap(val: number | null): string {
  if (val == null) return '—'
  if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`
  if (val >= 1e9)  return `$${(val / 1e9).toFixed(2)}B`
  if (val >= 1e6)  return `$${(val / 1e6).toFixed(2)}M`
  return `$${val.toLocaleString()}`
}
function consensusColor(c: string | null): string {
  if (!c) return T.muted
  const l = c.toLowerCase()
  if (l.includes('strong buy'))                          return T.pos
  if (l.includes('buy') || l.includes('outperform'))    return '#86efac'
  if (l.includes('hold') || l.includes('neutral'))      return T.warn
  if (l.includes('sell') || l.includes('underperform')) return T.neg
  return T.text
}

// ── Column selector panel ─────────────────────────────────────────────────────
function ColPanel({ visible, onToggle }: { visible: Set<ColId>; onToggle: (id: ColId) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderTop: `1px solid ${T.border}`, background: 'var(--theme-bg, #080f1d)', flexShrink: 0 }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Columns</span>
        <span style={{ color: T.dim, fontSize: 9, fontFamily: T.mono, display: 'inline-block', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>▾</span>
      </div>
      {open && (
        <div style={{ padding: '0 8px 6px', display: 'flex', flexWrap: 'wrap', gap: '3px 12px' }}>
          {COLUMNS.map(({ id, label }) => {
            const on = visible.has(id)
            return (
              <label key={id} onClick={() => onToggle(id)} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                <div style={{ width: 11, height: 11, flexShrink: 0, border: `1px solid ${on ? T.gold : T.dim}`, background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.1s' }}>
                  {on && <div style={{ width: 5, height: 5, background: T.gold }} />}
                </div>
                <span style={{ fontFamily: T.label, fontSize: 9, color: on ? T.text : T.dim, whiteSpace: 'nowrap' }}>{label}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main widget ───────────────────────────────────────────────────────────────
export default function Watchlist({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers ?? ['SPY', 'QQQ', 'IWM']
  const [visibleCols, setVisibleCols] = useState<Set<ColId>>(loadCols)

  const toggleCol = (id: ColId) => {
    setVisibleCols(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      saveCols(next)
      return next
    })
  }

  const activeCols = COLUMNS.filter(c => visibleCols.has(c.id))
  const TICKER_W = 80
  const minTableW = TICKER_W + activeCols.reduce((s, c) => s + c.width, 0) + 28

  const results = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['watchlist-item-v2', t],
      queryFn: () => axios.get(`/api/corporate/hub?ticker=${t}`).then(r => r.data as HubData),
      staleTime: 600_000,
    })),
  })

  function cellValue(col: typeof COLUMNS[number], data: HubData): { text: string; color?: string } {
    switch (col.id) {
      case '1d_pct': {
        const pct = data.pct_change_1d
        return { text: pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—', color: pct == null ? T.muted : pct >= 0 ? T.pos : T.neg }
      }
      case 'mkt_cap':    return { text: formatMarketCap(data.market_cap) }
      case 'pe':         return { text: fmt(data.estimated_pe, '', '', 1) }
      case 'impl_move':  return { text: data.implied_move != null ? `±${data.implied_move.toFixed(1)}%` : '—', color: T.text }
      case 'consensus':  return { text: data.consensus ? data.consensus.split('  ')[0].trim() : '—', color: consensusColor(data.consensus) }
    }
  }

  return (
    <div style={{ background: T.bg, fontFamily: T.mono, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Widget title */}
      <div style={{ background: T.headerBg, padding: '6px 14px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ color: T.gold, fontSize: 9, fontFamily: T.label, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Watchlist</span>
      </div>

      {/* Scrollable table area */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div style={{ minWidth: minTableW }}>
          {/* Column headers */}
          <div style={{ background: T.headerBg, padding: '5px 14px', borderBottom: `1px solid ${T.border}`, display: 'flex', position: 'sticky', top: 0, zIndex: 1 }}>
            <span style={{ width: TICKER_W, flexShrink: 0, color: T.muted, fontSize: 9, fontFamily: T.label, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Ticker</span>
            {activeCols.map(col => (
              <span key={col.id} style={{ width: col.width, flexShrink: 0, color: T.muted, fontSize: 9, fontFamily: T.label, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', textAlign: 'right' }}>
                {col.label}
              </span>
            ))}
          </div>

          {/* Rows */}
          {tickers.map((ticker, i) => {
            const result = results[i]
            const data = result.data as HubData | undefined
            const rowBg = i % 2 === 0 ? 'var(--theme-surface, #0d1b30)' : T.bg

            if (result.isLoading || !data) {
              return (
                <div key={ticker} style={{ background: rowBg, padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ width: TICKER_W, flexShrink: 0, color: T.gold, fontWeight: 700, fontSize: 9, fontFamily: T.label, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{ticker}</span>
                  <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                    {activeCols.map(c => <div key={c.id} style={{ ...shimmer, width: c.width - 8 }} />)}
                  </div>
                </div>
              )
            }

            return (
              <div key={ticker} style={{ background: rowBg, padding: '9px 14px', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ width: TICKER_W, flexShrink: 0, color: T.gold, fontWeight: 700, fontSize: 9, fontFamily: T.label, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{ticker}</span>
                {activeCols.map(col => {
                  const { text, color } = cellValue(col, data)
                  return (
                    <span key={col.id} style={{ width: col.width, flexShrink: 0, color: color ?? T.text, fontSize: 10, fontFamily: T.mono, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {text}
                    </span>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      <ColPanel visible={visibleCols} onToggle={toggleCol} />
    </div>
  )
}
