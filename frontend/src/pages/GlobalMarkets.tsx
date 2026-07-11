import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import AssetChartModal from '../components/AssetChartModal'
import { BoardSkeleton } from '../components/Skeleton'
import useIsMobile from '../hooks/useIsMobile'

// Global Markets board (hifi handoff "2a"): a pinnable Spotlight of benchmark
// cards over flat editorial tables — indices by region, FX, commodities, US
// yields, and crypto. One cached backend call, refreshed every 5 minutes.

const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'
const GOLD = 'var(--theme-primary, #c9a84c)'
const POS = 'var(--theme-positive, #3fb6a0)'
const NEG = 'var(--theme-negative, #cf4b3f)'

interface Row { label: string; symbol: string; price: number | null; change_pct: number | null; change_abs: number | null; spark: number[] }
interface Board { sections: { name: string; rows: Row[] }[]; as_of: string; date: string | null }

// ── Asset icons (flags via flagcdn, same source as the Currency Matrix) ──────
const FLAGS: Record<string, string[]> = {
  '^GSPC': ['us'], '^IXIC': ['us'], '^DJI': ['us'], '^RUT': ['us'], '^VIX': ['us'],
  '^GSPTSE': ['ca'], '^BVSP': ['br'], '^MXX': ['mx'],
  '^FTSE': ['gb'], '^GDAXI': ['de'], '^FCHI': ['fr'], '^STOXX50E': ['eu'],
  '^IBEX': ['es'], '^SSMI': ['ch'], '^AEX': ['nl'], 'FTSEMIB.MI': ['it'],
  '^N225': ['jp'], '^HSI': ['hk'], '000001.SS': ['cn'], '000300.SS': ['cn'],
  '^KS11': ['kr'], '^TWII': ['tw'], '^NSEI': ['in'], '^AXJO': ['au'], '^STI': ['sg'],
  'DX-Y.NYB': ['us'], 'EURUSD=X': ['eu', 'us'], 'JPY=X': ['us', 'jp'], 'GBPUSD=X': ['gb', 'us'],
  'CNY=X': ['us', 'cn'], 'CHF=X': ['us', 'ch'], 'AUDUSD=X': ['au', 'us'], 'CAD=X': ['us', 'ca'],
  'MXN=X': ['us', 'mx'], 'INR=X': ['us', 'in'],
  '^IRX': ['us'], '2YY=F': ['us'], '^FVX': ['us'], '^TNX': ['us'], '^TYX': ['us'],
}
const COMMODITY_CHIP: Record<string, string> = {
  'CL=F': '#d07b34', 'BZ=F': '#d07b34', 'NG=F': '#d07b34',
  'GC=F': '#c9a84c', 'SI=F': '#aab6c4', 'HG=F': '#c47a52', 'PL=F': '#9fb2c4',
  'ZW=F': '#8faa5a', 'ZC=F': '#8faa5a', 'ZS=F': '#8faa5a',
}
const COIN: Record<string, { glyph: string; color: string }> = {
  'BTC-USD': { glyph: '₿', color: '#f7931a' },
  'ETH-USD': { glyph: 'Ξ', color: '#8f9bd4' },
  'SOL-USD': { glyph: '◎', color: '#14e0a3' },
}

function AssetIcon({ symbol, small }: { symbol: string; small?: boolean }) {
  const coin = COIN[symbol]
  if (coin) {
    const s = small ? 17 : 20
    return (
      <span style={{ width: s, height: s, borderRadius: '50%', background: coin.color, color: '#0a1424', fontFamily: MONO, fontWeight: 700, fontSize: small ? 9.5 : 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        {coin.glyph}
      </span>
    )
  }
  const chip = COMMODITY_CHIP[symbol]
  if (chip) return <span style={{ width: 11, height: 11, borderRadius: 3, background: chip, flex: 'none' }} />
  const flags = FLAGS[symbol]
  if (!flags) return <span style={{ width: 11, flex: 'none' }} />
  // Flat flags at natural aspect (flagcdn's fixed-size endpoints serve wavy
  // emoji-style icons; w40 is the flat set). Fixed height, width follows the
  // flag's real ratio so square flags like Switzerland render true and nothing
  // overflows its outline.
  const h = small ? 12 : 15
  return (
    <span style={{ display: 'inline-flex', gap: 3, flex: 'none' }}>
      {flags.map(cc => (
        <img key={cc} src={`https://flagcdn.com/w40/${cc}.png`} alt="" height={h}
          style={{ height: h, width: 'auto', borderRadius: 2, border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', display: 'block' }} loading="lazy" />
      ))}
    </span>
  )
}

// ── Formatting ────────────────────────────────────────────────────────────────
const fmtPrice = (v: number): string => {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (Math.abs(v) >= 1) return v.toFixed(2)
  return v.toFixed(4)
}
const changeText = (r: Row, yields: boolean): string => {
  if (r.change_pct == null) return '—'
  if (yields && r.change_abs != null) return `${r.change_abs >= 0 ? '+' : ''}${Math.round(r.change_abs * 100)} bp`
  return `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(2)}%`
}

// ── Favorites (pinned Spotlight), persisted by stable symbol id ──────────────
const FAV_KEY = 'gm-favorites'
const DEFAULT_FAVS = ['^GSPC', 'DX-Y.NYB', '^TNX', 'GC=F', 'BTC-USD', '^VIX']
const loadFavs = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || 'null')
    return Array.isArray(raw) ? raw.filter(v => typeof v === 'string') : [...DEFAULT_FAVS]
  } catch { return [...DEFAULT_FAVS] }
}

function Star({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={e => { e.stopPropagation(); onClick() }} aria-label={label} aria-pressed={on}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1, color: on ? GOLD : 'color-mix(in srgb, var(--theme-secondary, #8099b0) 55%, transparent)', width: 20, flex: 'none', textAlign: 'left' }}>
      {on ? '★' : '☆'}
    </button>
  )
}

// ── Spotlight card ────────────────────────────────────────────────────────────
function SpotlightCard({ row, group, yields, onUnpin, onOpen }: { row: Row; group: string; yields: boolean; onUnpin: () => void; onOpen: () => void }) {
  const up = (row.change_pct ?? 0) >= 0
  const c = row.change_pct == null ? 'var(--theme-secondary, #5f7893)' : up ? POS : NEG
  const pts = row.spark
  let line = '', area = ''
  if (pts.length >= 2) {
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1
    const coords = pts.map((v, i) => `${(i / (pts.length - 1) * 140).toFixed(1)},${(40 - (v - lo) / span * 32).toFixed(1)}`)
    line = coords.join(' ')
    area = `0,44 ${line} 140,44`
  }
  return (
    <div onClick={onOpen} role="button" tabIndex={0} aria-label={`Open ${row.label} chart`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{ position: 'relative', overflow: 'hidden', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, var(--theme-surface, #0d1826))', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 28%, transparent)', borderRadius: 5, padding: '13px 14px 15px' }}>
      {line && (
        <svg viewBox="0 0 140 44" preserveAspectRatio="none" aria-hidden="true"
          style={{ position: 'absolute', right: 0, bottom: 0, width: '56%', height: 38, pointerEvents: 'none', WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 45%)', maskImage: 'linear-gradient(90deg, transparent, #000 45%)' }}>
          <polygon points={area} fill={c} opacity={0.1} />
          <polyline points={line} fill="none" stroke={c} strokeWidth={1.3} opacity={0.55} />
        </svg>
      )}
      <button onClick={e => { e.stopPropagation(); onUnpin() }} aria-label={`Unpin ${row.label}`}
        style={{ position: 'absolute', top: 8, right: 9, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 14, color: GOLD, lineHeight: 1, zIndex: 1 }}>★</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11, paddingRight: 18, minWidth: 0 }}>
        <AssetIcon symbol={row.symbol} small />
        <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--theme-secondary, #8aa0ba)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: 'var(--theme-text, #eaf1fb)', lineHeight: 1 }}>
        {row.price == null ? '—' : `${fmtPrice(row.price)}${yields ? '%' : ''}`}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 7 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: c }}>{changeText(row, yields)}</span>
        <span style={{ fontFamily: SANS, fontSize: 10, color: 'var(--theme-secondary, #5f7893)' }}>{group}</span>
      </div>
    </div>
  )
}

// ── Asset-class table (flat editorial) ───────────────────────────────────────
function GroupTable({ name, rows, favs, onToggle, onOpen }: { name: string; rows: Row[]; favs: string[]; onToggle: (sym: string) => void; onOpen: (r: Row, yields: boolean) => void }) {
  const yields = name === 'US Yields'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 2px 7px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 32%, transparent)' }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.17em', color: GOLD }}>{name.toUpperCase()}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--theme-secondary, #4f6a86)' }}>{rows.length}</span>
      </div>
      {rows.map(r => {
        const on = favs.includes(r.symbol)
        const up = (r.change_pct ?? 0) >= 0
        const c = r.change_pct == null ? 'var(--theme-secondary, #5f7893)' : up ? POS : NEG
        return (
          <div key={r.symbol} className="gm-row" onClick={() => onOpen(r, yields)}
            role="button" tabIndex={0} aria-label={`Open ${r.label} chart`}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r, yields) } }}
            style={{ display: 'grid', gridTemplateColumns: '20px auto minmax(0,1fr) auto auto', alignItems: 'center', gap: 10, padding: '6px 4px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))', transition: 'background 0.12s', cursor: 'pointer' }}>
            <Star on={on} onClick={() => onToggle(r.symbol)} label={`${on ? 'Unpin' : 'Pin'} ${r.label}`} />
            <AssetIcon symbol={r.symbol} />
            <span style={{ fontFamily: SANS, fontSize: 13, color: 'var(--theme-text, #c6d4e6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
            <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: 'var(--theme-text, #e6edf7)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {r.price == null ? '—' : `${fmtPrice(r.price)}${yields ? '%' : ''}`}
            </span>
            <span title={`${r.label} · ${changeText(r, yields)}`}
              style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, textAlign: 'right', minWidth: 56, padding: '2px 7px', borderRadius: 3, color: c, background: r.change_pct == null ? 'transparent' : up ? 'color-mix(in srgb, var(--theme-positive, #3fb6a0) 13%, transparent)' : 'color-mix(in srgb, var(--theme-negative, #cf4b3f) 13%, transparent)' }}>
              {changeText(r, yields)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function GlobalMarkets() {
  const isMobile = useIsMobile()
  const today = new Date().toISOString().split('T')[0]
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])   // '' = latest prints
  const [favs, setFavs] = useState<string[]>(loadFavs)
  const [chart, setChart] = useState<{ row: Row; yields: boolean } | null>(null)
  const toggleFav = (sym: string) => setFavs(prev => {
    const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)) } catch { /* private mode */ }
    return next
  })

  const q = useQuery<Board>({
    queryKey: ['global-board', date],
    queryFn: () => axios.get(`/api/market/global-board${date ? `?date=${date}` : ''}`).then(r => r.data),
    staleTime: 300_000, refetchInterval: !date || date === today ? 300_000 : false, retry: 1,
  })

  const sections = q.data?.sections ?? []
  const byName = Object.fromEntries(sections.map(s => [s.name, s.rows]))
  const groupOf: Record<string, string> = {}
  for (const s of sections) for (const r of s.rows) groupOf[r.symbol] = s.name
  const rowBySym: Record<string, Row> = {}
  for (const s of sections) for (const r of s.rows) rowBySym[r.symbol] = r
  const spotlight = favs.map(sym => rowBySym[sym]).filter(Boolean) as Row[]
  const asOf = q.data ? new Date(q.data.as_of).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }) : null

  // Equal-height stacks: the shorter columns absorb slack between their groups
  // (space-between adds to the 22px minimum gap) so all three bottoms align.
  const colStack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0, height: '100%', justifyContent: 'space-between' }

  return (
    <PageWrapper>
      <style>{`.gm-row:hover { background: color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent); }`}</style>
      <div style={{ background: 'var(--theme-surface, #0a1424)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)', borderRadius: 6, padding: isMobile ? '20px 16px 24px' : '26px 26px 30px' }}>

        {/* Header bar */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, paddingBottom: 13, marginBottom: 18, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)' }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: '0.22em', color: GOLD }}>GLOBAL MARKETS</div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--theme-secondary, #5f7893)', marginTop: 7 }}>Your pinned assets up top · star rows below to customize</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, whiteSpace: 'nowrap', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #56708a)' }}>Session</span>
              <input type="date" value={date} max={today} onChange={e => setDate(e.target.value)} aria-label="Session date"
                style={{ width: 132, boxSizing: 'border-box', background: 'var(--theme-bg, #0d1826)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 25%, transparent)', color: 'var(--theme-text, #e6edf7)', fontFamily: MONO, fontSize: 10, padding: '2px 6px', outline: 'none', colorScheme: 'dark' }} />
              {date !== today && (
                <button onClick={() => setDate(today)} aria-label="Show today's session"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--theme-secondary, #56708a)' }}>TODAY</button>
              )}
              {date && (
                <button onClick={() => setDate('')} aria-label="Back to latest"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: GOLD }}>LATEST</button>
              )}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #56708a)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: date ? 'var(--theme-secondary, #56708a)' : POS, boxShadow: date ? 'none' : `0 0 8px ${POS}`, flex: 'none' }} />
              {date ? `Session ${date} · dash = no print` : asOf ? `As of ${asOf} UTC · refresh 5m` : 'Loading'}
            </span>
          </div>
        </div>

        {q.isLoading && <BoardSkeleton isMobile={isMobile} />}
        {q.isError && <div style={{ padding: '32px 0', color: 'var(--theme-secondary, #5f7893)', fontFamily: MONO, fontSize: 11, fontStyle: 'italic' }}>The board is unavailable. Retry shortly.</div>}

        {q.data && (
          <>
            {/* Spotlight */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 2px 9px', marginBottom: 12, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 32%, transparent)' }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', color: GOLD }}>★  SPOTLIGHT</span>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--theme-secondary, #5f7893)' }}>Tap the star on any row to pin / unpin</span>
            </div>
            {spotlight.length === 0 ? (
              <div style={{ border: '1px dashed color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderRadius: 5, padding: 28, textAlign: 'center', fontFamily: MONO, fontSize: 11, color: 'var(--theme-secondary, #5f7893)', marginBottom: 26 }}>
                No pinned assets — tap the ☆ on any row below to build your spotlight.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 6}, 1fr)`, gap: 12, marginBottom: 26 }}>
                {spotlight.map(r => (
                  <SpotlightCard key={r.symbol} row={r} group={groupOf[r.symbol] ?? ''} yields={groupOf[r.symbol] === 'US Yields'} onUnpin={() => toggleFav(r.symbol)} onOpen={() => setChart({ row: r, yields: groupOf[r.symbol] === 'US Yields' })} />
                ))}
              </div>
            )}

            {/* Full board: fixed column stacks per the handoff */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 26 }}>
              <div style={colStack}>
                <GroupTable name="Americas" rows={byName['Americas'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="FX" rows={byName['FX'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
              </div>
              <div style={colStack}>
                <GroupTable name="Europe" rows={byName['Europe'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="Commodities" rows={byName['Commodities'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
              </div>
              <div style={colStack}>
                <GroupTable name="Asia-Pacific" rows={byName['Asia-Pacific'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="US Yields" rows={byName['US Yields'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="Crypto" rows={byName['Crypto'] ?? []} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
              </div>
            </div>
          </>
        )}
        {chart && <AssetChartModal row={chart.row} yields={chart.yields} onClose={() => setChart(null)} />}
      </div>
    </PageWrapper>
  )
}
