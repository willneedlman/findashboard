import { useState } from 'react'
import axios from 'axios'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import AssetChartModal from '../components/AssetChartModal'
import { BoardSkeleton } from '../components/Skeleton'
import ErrorState from '../components/ErrorState'
import useIsMobile from '../hooks/useIsMobile'
import { formatLocalTime, localDateInputValue, localTimeZone } from '../lib/time'

// Global Markets board (hifi handoff "2a"): a pinnable Spotlight of benchmark
// cards over flat editorial tables — indices by region, FX, commodities, US
// yields, and crypto. Yahoo-backed latest data refreshes once per minute.

const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'
const GOLD = 'var(--theme-primary, #c9a84c)'
const POS = 'var(--theme-positive, #3fb6a0)'
const NEG = 'var(--theme-negative, #cf4b3f)'

interface Row { label: string; symbol: string; quote_symbol?: string; is_cme_proxy?: boolean; price: number | null; change_pct: number | null; change_abs: number | null; spark: number[]; status: 'intraday' | 'delayed' | 'end_of_day' | 'unavailable'; as_of: string | null }
interface Board { sections: { name: string; rows: Row[] }[]; as_of: string; date: string | null; window: MarketWindow; refresh_seconds: number; americas_mode: 'cash_indices' | 'cme_futures' }
type MarketWindow = '10m' | '30m' | '1h' | '1d' | '1w' | '1m' | 'ytd'
const WINDOWS: { key: MarketWindow; label: string }[] = [
  { key: '10m', label: '10M' }, { key: '30m', label: '30M' }, { key: '1h', label: '1H' },
  { key: '1d', label: '1D' }, { key: '1w', label: '1W' }, { key: '1m', label: '1M' }, { key: 'ytd', label: 'YTD' },
]

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
  '^IRX': ['us'], 'FRED:DGS2': ['us'], '^FVX': ['us'], '^TNX': ['us'], '^TYX': ['us'],
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
      style={{ position: 'relative', overflow: 'hidden', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, var(--theme-surface, #0d1826))', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 28%, transparent)', borderRadius: 0, padding: '13px 14px 15px' }}>
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
        <span style={{ fontFamily: SANS, fontSize: 10, color: 'var(--theme-secondary, #5f7893)' }}>{row.is_cme_proxy ? 'CME futures proxy' : group}</span>
      </div>
    </div>
  )
}

// ── Asset-class table (flat editorial) ───────────────────────────────────────
function GroupTable({ name, rows, window, favs, onToggle, onOpen }: { name: string; rows: Row[]; window: MarketWindow; favs: string[]; onToggle: (sym: string) => void; onOpen: (r: Row, yields: boolean) => void }) {
  const yields = name === 'US Yields'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 2px 7px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 32%, transparent)' }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.17em', color: GOLD }}>{name.toUpperCase()}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--theme-secondary, #4f6a86)' }}>{rows.length} · Δ {window.toUpperCase()}</span>
      </div>
      {rows.map(r => {
        const on = favs.includes(r.symbol)
        const up = (r.change_pct ?? 0) >= 0
        const c = r.change_pct == null ? 'var(--theme-secondary, #5f7893)' : up ? POS : NEG
        return (
          <div key={r.symbol} className="gm-row" onClick={() => onOpen(r, yields)}
            role="button" tabIndex={0} aria-label={`Open ${r.label} chart`}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r, yields) } }}
            style={{ display: 'grid', gridTemplateColumns: '20px 48px minmax(0,1fr) auto auto', alignItems: 'center', gap: 10, padding: '6px 4px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))', transition: 'background 0.12s', cursor: 'pointer' }}>
            <Star on={on} onClick={() => onToggle(r.symbol)} label={`${on ? 'Unpin' : 'Pin'} ${r.label}`} />
            <AssetIcon symbol={r.symbol} />
            <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
              <span style={{ fontFamily: SANS, fontSize: 13, color: 'var(--theme-text, #c6d4e6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
              {r.is_cme_proxy && <span title="CME futures proxy used while the U.S. cash session is closed" style={{ flex: 'none', fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--theme-tertiary, #60a5fa)' }}>CME</span>}
            </span>
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
  const today = localDateInputValue()
  const [date, setDate] = useState('')
  const [window, setWindow] = useState<MarketWindow>('1d')
  const [favs, setFavs] = useState<string[]>(loadFavs)
  const [chart, setChart] = useState<{ row: Row; yields: boolean } | null>(null)
  const toggleFav = (sym: string) => setFavs(prev => {
    const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)) } catch { /* private mode */ }
    return next
  })

  const q = useQuery<Board>({
    queryKey: ['global-board', date, window],
    queryFn: () => axios.get('/api/market/global-board', {
      params: { ...(date ? { date } : {}), window },
      // Cold multi-ticker Yahoo download can exceed the browser default when
      // the server is contended; give it room so we paint data, not a skeleton.
      timeout: 90_000,
    }).then(r => r.data),
    // Keep showing the last board while window/date changes or a background
    // refresh runs — full skeleton only on the true first load.
    placeholderData: keepPreviousData,
    staleTime: date ? 300_000 : 120_000,
    refetchInterval: date ? false : 120_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })

  const sections = q.data?.sections ?? []
  const byName = Object.fromEntries(sections.map(s => [s.name, s.rows]))
  const groupOf: Record<string, string> = {}
  for (const s of sections) for (const r of s.rows) groupOf[r.symbol] = s.name
  const rowBySym: Record<string, Row> = {}
  for (const s of sections) for (const r of s.rows) rowBySym[r.symbol] = r
  const spotlight = favs.map(sym => rowBySym[sym]).filter(Boolean) as Row[]
  const asOf = q.data ? formatLocalTime(q.data.as_of) : null
  const zone = localTimeZone()

  // Equal-height stacks: the shorter columns absorb slack between their groups
  // (space-between adds to the 22px minimum gap) so all three bottoms align.
  const colStack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0, height: '100%', justifyContent: 'space-between' }

  return (
    <PageWrapper>
      <style>{`.gm-row:hover { background: color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent); }`}</style>
      <div style={{ background: 'var(--theme-surface, #0a1424)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)', borderRadius: 0, padding: isMobile ? '20px 16px 24px' : '26px 26px 30px' }}>

        {/* Header bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, paddingBottom: 13, marginBottom: 18, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 240 }}>
              <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: '0.22em', color: GOLD }}>GLOBAL MARKETS</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, whiteSpace: 'nowrap', flexWrap: 'wrap' }}>
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
            {!date && <span style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', background: 'var(--theme-bg, #101c2e)' }}>
              {WINDOWS.map(item => <button key={item.key} onClick={() => setWindow(item.key)} aria-pressed={window === item.key}
                style={{ border: 'none', background: window === item.key ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'transparent', color: window === item.key ? GOLD : 'var(--theme-secondary, #8099b0)', cursor: 'pointer', padding: '4px 6px', fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.04em' }}>{item.label}</button>)}
            </span>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px 16px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--theme-secondary, #5f7893)' }}>Pinned benchmarks · change is measured from the selected interval · displayed in {zone}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.12em', lineHeight: 1.45, textTransform: 'uppercase', color: 'var(--theme-secondary, #56708a)', textAlign: 'right' }}>
              <span style={{ flex: '0 0 auto', padding: '3px 5px', border: `1px solid ${date ? 'var(--theme-border, rgba(255,255,255,0.14))' : 'color-mix(in srgb, var(--theme-tertiary, #60a5fa) 45%, transparent)'}`, color: date ? 'var(--theme-secondary, #8099b0)' : 'var(--theme-tertiary, #60a5fa)', background: date ? 'transparent' : 'color-mix(in srgb, var(--theme-tertiary, #60a5fa) 8%, transparent)' }}>{date ? 'SESSION CLOSE' : 'MARKET DATA'}</span>
              <span>
                {date
                  ? `Session ${date} · completed session`
                  : asOf
                    ? `${q.data?.americas_mode === 'cme_futures' ? 'CME futures proxies · ' : ''}Yahoo Finance · as of ${asOf} local · refreshes every 2m${q.isFetching ? ' · updating…' : ''}`
                    : 'Loading'}
              </span>
            </span>
          </div>
        </div>

        {/* Only the first ever load shows the full skeleton; window switches and
            background refreshes keep the previous board on screen. */}
        {q.isLoading && !q.data && <BoardSkeleton isMobile={isMobile} />}
        {q.isError && !q.data && <ErrorState title="Board unavailable" message="The board is unavailable." onRetry={() => q.refetch()} />}

        {q.data && (
          <>
            {/* Spotlight */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 2px 9px', marginBottom: 12, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 32%, transparent)' }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', color: GOLD }}>★  SPOTLIGHT</span>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--theme-secondary, #5f7893)' }}>Tap the star on any row to pin / unpin</span>
            </div>
            {spotlight.length === 0 ? (
              <div style={{ border: '1px dashed color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderRadius: 0, padding: 28, textAlign: 'center', fontFamily: MONO, fontSize: 11, color: 'var(--theme-secondary, #5f7893)', marginBottom: 26 }}>
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
                <GroupTable name="Americas" rows={byName['Americas'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="FX" rows={byName['FX'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
              </div>
              <div style={colStack}>
                <GroupTable name="Europe" rows={byName['Europe'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="Commodities" rows={byName['Commodities'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
              </div>
              <div style={colStack}>
                <GroupTable name="Asia-Pacific" rows={byName['Asia-Pacific'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="US Yields" rows={byName['US Yields'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
                <GroupTable name="Crypto" rows={byName['Crypto'] ?? []} window={q.data.window} favs={favs} onToggle={toggleFav} onOpen={(r, y) => setChart({ row: r, yields: y })} />
              </div>
            </div>
          </>
        )}
        {chart && <AssetChartModal row={chart.row} yields={chart.yields} onClose={() => setChart(null)} />}
      </div>
    </PageWrapper>
  )
}
