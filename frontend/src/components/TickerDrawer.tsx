import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Star } from 'lucide-react'
import { fmtMarketCap, fmtNum } from '../lib/format'
import { setLinkedTicker, TICKER_TOOLS, tickerToolUrl } from '../lib/tickerLink'
import { readWatchlist, toggleWatchlist } from '../lib/watchlist'
import { fetchTickerHub, fetchImpliedMove, fetchSnapshotSeries } from '../hooks/useApi'

// Ticker overview drawer: one slide-over composing endpoints that already
// exist (corporate hub, implied move, IV30/GEX snapshots). Opens via the
// 'ft:ticker-drawer' event (command palette). Every tile deep-links into the
// full tool, so it doubles as tool discovery.

const GOLD  = 'var(--theme-primary, #c9a84c)'
const TEXT  = 'var(--theme-text, #d7e3fc)'
const SEC   = 'var(--theme-secondary, #8099b0)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const MONO  = 'var(--theme-mono, monospace)'
const SANS  = 'var(--theme-sans, sans-serif)'
const POS   = 'var(--theme-positive, #22c55e)'
const NEG   = 'var(--theme-negative, #ef4444)'

const LABEL: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.18em',
  textTransform: 'uppercase', color: SEC,
}
const SECTION: React.CSSProperties = { padding: '12px 16px', borderBottom: `1px solid ${BORDER}` }

function Spark({ points }: { points: number[] }) {
  if (!points || points.length < 2) return null
  const w = 132, h = 34
  const lo = Math.min(...points), hi = Math.max(...points)
  const span = hi - lo || 1
  const up = points[points.length - 1] >= points[0]
  const pts = points.map((v, i) =>
    `${(i / (points.length - 1)) * w},${h - 3 - ((v - lo) / span) * (h - 6)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={up ? POS : NEG} strokeWidth={1.5} />
    </svg>
  )
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={LABEL}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: color ?? TEXT, whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

function TileNote({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: MONO, fontSize: 10, color: SEC, letterSpacing: '0.04em' }}>{children}</div>
}

// Lazy-loaded by TickerDrawerHost in App.tsx (keeps axios + this UI out of the
// critical-path index chunk); the host owns the open/close event plumbing.
export default function TickerDrawer({ open, sym, onClose }: { open: boolean; sym: string; onClose: () => void }) {
  const [wl, setWl] = useState<string[]>(readWatchlist)
  const navigate = useNavigate()

  useEffect(() => { if (open) setWl(readWatchlist()) }, [open, sym])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const enabled = open && !!sym
  const hub = useQuery({
    queryKey: ['drawer-hub', sym], enabled,
    queryFn: () => fetchTickerHub(sym),
  })
  const implied = useQuery({
    queryKey: ['drawer-implied', sym], enabled,
    queryFn: () => fetchImpliedMove(sym),
  })
  const iv = useQuery({
    queryKey: ['drawer-iv30', sym], enabled,
    queryFn: () => fetchSnapshotSeries('iv30', sym),
  })
  // compute=false: live GEX aggregates every chain (20-40s) — only show a value
  // when the daily snapshot loop (or a Dealer GEX visit) has already left one.
  const gex = useQuery({
    queryKey: ['drawer-gex', sym], enabled,
    queryFn: () => fetchSnapshotSeries('gex', sym, false),
  })

  const d = hub.data
  const pct: number | null = d?.pct_change_1d ?? null
  const inWl = wl.includes(sym)
  const toggleWl = () => setWl(toggleWatchlist(sym))

  const openTool = (tool: (typeof TICKER_TOOLS)[number]) => {
    setLinkedTicker(sym)
    onClose()
    navigate(tickerToolUrl(tool, sym))
  }

  const ivPts = iv.data?.points ?? []
  const ivNow = ivPts.length ? ivPts[ivPts.length - 1]?.v : null
  const gexPts = gex.data?.points ?? []
  const gexLast = gexPts.length ? gexPts[gexPts.length - 1] : null
  const news: any[] = Array.isArray(d?.news) ? d.news.slice(0, 3) : []

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, zIndex: 990, background: 'rgba(3,8,16,0.5)' }}>
          <motion.aside
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={e => e.stopPropagation()}
            aria-label={`${sym} overview`}
            style={{
              position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(400px, 94vw)',
              background: 'var(--theme-bg, #101c2e)', borderLeft: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`,
              boxShadow: '-18px 0 48px rgba(0,0,0,0.45)', overflowY: 'auto',
            }}>

            {/* header */}
            <div style={{ ...SECTION, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: MONO, fontSize: 19, fontWeight: 700, color: GOLD, letterSpacing: '0.04em' }}>{sym}</span>
                  <button onClick={toggleWl} title={inWl ? 'Remove from watchlist' : 'Add to watchlist'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: inWl ? GOLD : SEC, display: 'flex' }}>
                    <Star size={14} fill={inWl ? 'currentColor' : 'none'} />
                  </button>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 11, color: SEC, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {hub.isLoading ? 'Loading…' : d ? `${d.company_name ?? sym} · ${d.sector ?? ''}` : 'Profile unavailable'}
                </div>
              </div>
              <button onClick={onClose} aria-label="Close"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: SEC, padding: 2, display: 'flex' }}>
                <X size={16} />
              </button>
            </div>

            {/* quote */}
            <div style={{ ...SECTION, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: TEXT }}>
                  {d?.current_price != null ? `$${Number(d.current_price).toFixed(2)}` : hub.isLoading ? '…' : '—'}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: pct == null ? SEC : pct >= 0 ? POS : NEG }}>
                  {pct == null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% 1D`}
                </span>
              </div>
              <Spark points={d?.sparkline ?? []} />
            </div>

            {/* fundamentals strip */}
            <div style={{ ...SECTION, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <Stat label="Mkt Cap" value={d?.market_cap != null ? fmtMarketCap(d.market_cap) : '—'} />
              <Stat label="P/E" value={fmtNum(d?.pe_ratio, 1)} />
              <Stat label="Beta" value={fmtNum(d?.beta, 2)} />
            </div>

            {/* volatility */}
            <div style={SECTION}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Volatility</div>
              {iv.isLoading ? <TileNote>Reading the 30d chain…</TileNote> : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  <Stat label="IV30" value={fmtNum(ivNow, 1, '%')} />
                  <Stat label="IV Rank" value={iv.data?.iv_rank != null ? fmtNum(iv.data.iv_rank, 0) : '—'}
                    color={iv.data?.iv_rank != null ? (iv.data.iv_rank >= 65 ? NEG : iv.data.iv_rank <= 25 ? POS : TEXT) : SEC} />
                  <Stat label="Implied Move" value={implied.data != null ? `±${fmtNum(implied.data, 1, '%')}` : '—'} />
                </div>
              )}
              {!iv.isLoading && iv.data?.iv_rank == null && (
                <div style={{ marginTop: 6 }}><TileNote>Rank accrues after ~20 daily IV points.</TileNote></div>
              )}
            </div>

            {/* dealer gamma */}
            <div style={SECTION}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Dealer Gamma</div>
              {gexLast && typeof gexLast.v === 'number' ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Stat label="Net GEX" value={`${gexLast.v < 0 ? '-' : '+'}$${fmtNum(Math.abs(gexLast.v), 0)}M`}
                    color={gexLast.v >= 0 ? POS : NEG} />
                  <Stat label="As Of" value={gexLast.d ?? '—'} />
                </div>
              ) : (
                <TileNote>No snapshot yet. Open Dealer GEX for the live profile.</TileNote>
              )}
            </div>

            {/* earnings */}
            <div style={SECTION}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Next Earnings</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Stat label="Date" value={d?.date ?? '—'} />
                <Stat label="Horizon" value={d?.horizon ?? '—'} />
              </div>
            </div>

            {/* news */}
            <div style={SECTION}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Latest News</div>
              {news.length === 0 && <TileNote>{hub.isLoading ? 'Loading…' : 'No recent headlines.'}</TileNote>}
              {news.map((n, i) => {
                const title = n?.title ?? n?.headline ?? ''
                const link = n?.link ?? n?.url
                return (
                  <a key={i} href={link} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'block', fontFamily: SANS, fontSize: 11.5, lineHeight: 1.45, color: TEXT,
                      textDecoration: 'none', padding: '4px 0', borderBottom: i < news.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                    {title}
                    {n?.publisher && <span style={{ color: SEC, fontSize: 10 }}> · {n.publisher}</span>}
                  </a>
                )
              })}
            </div>

            {/* deep links */}
            <div style={{ padding: '12px 16px 18px' }}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Open In</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                {TICKER_TOOLS.map(t => (
                  <button key={t.route} onClick={() => openTool(t)}
                    style={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${BORDER}`, cursor: 'pointer',
                      color: TEXT, fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                      textTransform: 'uppercase', padding: '7px 0' }}>
                    {t.short}
                  </button>
                ))}
              </div>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
