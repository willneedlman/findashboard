import { useRef, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, ReferenceLine, ResponsiveContainer } from 'recharts'
import { Search, LayoutGrid, ArrowUpRight, Clock, X, Upload, Briefcase, TrendingUp, Zap, Calculator, Globe, Scale } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import TickerLogo from '../components/TickerLogo'
import useIsMobile from '../hooks/useIsMobile'
import { usePortfolio, type PortfolioHolding } from '../contexts/PortfolioContext'
import { loadActivePortfolio, useQuotes, priceHoldings } from '../components/dashboard/widgets/usePortfolio'
import { HUBS, ALL_TOOLS } from '../lib/hubs'
import { getRecents } from '../lib/recents'

const F = {
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  bright: 'var(--theme-text, #dce3ed)',
  sec: 'var(--theme-secondary, #8099b0)',
  muted: 'var(--theme-secondary, #5e768f)',
  surface: 'var(--theme-surface, #101c2e)',
  panel: 'var(--theme-bg, #0d1826)',
  topbar: 'color-mix(in srgb, var(--theme-bg, #0d1826) 88%, #000)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  borderFaint: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  amber: '#f59e0b',
  sans: 'var(--theme-sans)',
  mono: 'var(--theme-mono)',
}

const INDEX_TICKERS = ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD', 'GLD', 'TLT']
const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`
// Word-prefix search: each query term must match the start of a word, so a
// 2-letter ticker like "GS" no longer matches inside "earnings"/"holdings".
const wordMatch = (text: string, query: string) =>
  query.toLowerCase().split(/\s+/).filter(Boolean).every(term => text.toLowerCase().split(/[^a-z0-9]+/).some(w => w.startsWith(term)))
const tapeLabel = (s: string) => s.replace(/^\^/, '').replace(/-USD$/, '')

function marketSession(): { label: string; color: string } {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()
  const mins = et.getHours() * 60 + et.getMinutes()
  if (day === 0 || day === 6) return { label: 'Market closed', color: F.muted }
  if (mins >= 570 && mins < 960) return { label: 'Market open', color: F.pos }
  if (mins >= 240 && mins < 570) return { label: 'Pre-market', color: F.amber }
  return { label: 'Market closed', color: F.muted }
}

// One 1Y fetch powers every range; each range slices the tail (in trading days)
// and re-bases the %-change off the first visible point. Infinity = full year.
const RANGES = [
  { label: '1D', points: 2 },
  { label: '1W', points: 6 },
  { label: '1M', points: 23 },
  { label: '1Y', points: Infinity },
]

const cap: React.CSSProperties = { fontFamily: F.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.muted }

// ── Holdings / index marquee tape ──────────────────────────────────────────
const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

type TapeSource = 'holdings' | 'indices'

function TapeToggle({ source, onSource }: { source: TapeSource; onSource: (s: TapeSource) => void }) {
  const opt = (key: TapeSource, label: string) => (
    <button
      onClick={() => onSource(key)}
      aria-pressed={source === key}
      style={{
        fontFamily: F.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
        padding: '2px 8px', cursor: 'pointer', background: 'none',
        color: source === key ? F.gold : F.muted,
        border: `1px solid ${source === key ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)' : 'transparent'}`,
      }}
    >{label}</button>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, height: '100%', padding: '0 12px 0 14px', borderLeft: `1px solid ${F.border}` }}>
      <span style={{ ...cap, fontSize: 8, letterSpacing: '0.12em', marginRight: 4 }}>Tape</span>
      {opt('holdings', 'Holdings')}
      {opt('indices', 'Indices')}
    </div>
  )
}

function Tape({ segments, source, onSource }: { segments: { sym: string; price: string; pct: number | null }[]; source: TapeSource; onSource: (s: TapeSource) => void }) {
  const Seg = ({ s, k }: { s: typeof segments[number]; k: string }) => {
    const color = s.pct == null ? F.muted : s.pct >= 0 ? F.pos : F.neg
    return (
      <span key={k} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexShrink: 0 }}>
        <span style={{ color: F.muted, letterSpacing: '0.04em' }}>{s.sym}</span>
        <span style={{ color }}>{s.price}{s.pct != null && ` ${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%`}</span>
      </span>
    )
  }
  const Run = ({ p }: { p: string }) => (
    <div style={{ display: 'inline-flex', gap: 26, paddingRight: 26 }}>
      {segments.map((s, i) => <Seg key={`${p}-${i}`} s={s} k={`${p}-${i}`} />)}
    </div>
  )
  return (
    <div style={{ borderBottom: `1px solid ${F.borderFaint}`, background: F.topbar, height: 30, display: 'flex', alignItems: 'center' }}>
      <style>{`@keyframes home-tape{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', height: '100%' }}>
        {segments.length === 0 ? (
          <span style={{ paddingLeft: 14, fontFamily: F.mono, fontSize: 11, color: F.muted }}>—</span>
        ) : prefersReducedMotion ? (
          <div style={{ display: 'flex', gap: 26, overflowX: 'auto', padding: '0 14px', fontFamily: F.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {segments.map((s, i) => <Seg key={i} s={s} k={`s-${i}`} />)}
          </div>
        ) : (
          <div
            onMouseEnter={e => (e.currentTarget.style.animationPlayState = 'paused')}
            onMouseLeave={e => (e.currentTarget.style.animationPlayState = 'running')}
            style={{ display: 'inline-flex', whiteSpace: 'nowrap', willChange: 'transform', animation: 'home-tape 46s linear infinite', fontFamily: F.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums', paddingLeft: 14 }}
          >
            <Run p="a" /><Run p="b" />
          </div>
        )}
      </div>
      <TapeToggle source={source} onSource={onSource} />
    </div>
  )
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes home-spin{to{transform:rotate(360deg)}}`}</style>
      <div aria-label="Loading" role="status" style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)', borderTopColor: 'var(--theme-primary, #c9a84c)', animation: 'home-spin 0.7s linear infinite' }} />
    </>
  )
}

// ── Performance chart (%-change vs time, ranged 1D/1W/1M/1Y) ─────────────────
interface CumPoint { date: string; portfolio: number }
function fmtAxisDate(d: string, rangeIdx: number): string {
  const dt = d.includes('T') ? new Date(d) : new Date(d + 'T00:00:00')
  if (isNaN(dt.getTime())) return d
  if (rangeIdx === 0) return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) // 1D → 10:30
  if (rangeIdx === 1) return dt.toLocaleDateString('en-US', { weekday: 'short' })                  // 1W → Mon
  if (rangeIdx === 2) return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })    // 1M → Jun 3
  return dt.toLocaleDateString('en-US', { month: 'short' })                                        // 1Y → Jun
}
function PerformanceSpark({ tickers, weights, rangeIdx }: { tickers: string[]; weights: number[]; rangeIdx: number }) {
  // 1D pulls an intraday series (last few sessions) and shows just the latest
  // session; the longer ranges share one daily 1Y fetch sliced client-side.
  const isIntraday = rangeIdx === 0
  const { start, end, interval } = useMemo(() => {
    const now = new Date()
    if (isIntraday) {
      const s = new Date(now); s.setDate(s.getDate() - 5)
      const e = new Date(now); e.setDate(e.getDate() + 1)
      return { start: s.toISOString().split('T')[0], end: e.toISOString().split('T')[0], interval: '15m' }
    }
    const s = new Date(now); s.setFullYear(s.getFullYear() - 1)
    return { start: s.toISOString().split('T')[0], end: now.toISOString().split('T')[0], interval: '1d' }
  }, [isIntraday])

  const { data, isLoading } = useQuery<{ cumulative: CumPoint[] }>({
    queryKey: ['home-perf', tickers.join(','), interval],
    queryFn: () => axios.post('/api/portfolio/backtest', { tickers, weights, benchmark: 'SPY', start, end, interval }).then(r => r.data),
    staleTime: isIntraday ? 60_000 : 300_000,
    enabled: tickers.length >= 1,
    retry: 1,
  })
  const full = data?.cumulative ?? []
  const pts = useMemo(() => {
    if (isIntraday) {
      if (full.length < 2) return []
      const lastDay = full[full.length - 1].date.slice(0, 10)
      const session = full.filter(p => p.date.slice(0, 10) === lastDay)
      const src = session.length >= 2 ? session : full.slice(-2)
      const base = src[0].portfolio
      return src.map(p => ({ date: p.date, pct: base > 0 ? (p.portfolio / base - 1) * 100 : 0 }))
    }
    const pointsWanted = RANGES[rangeIdx].points
    const sliced = pointsWanted === Infinity ? full : full.slice(-pointsWanted)
    if (sliced.length < 2) return []
    const base = sliced[0].portfolio
    const rebased = sliced.map(p => ({ date: p.date, pct: base > 0 ? (p.portfolio / base - 1) * 100 : 0 }))
    // Thin the 1Y series so the SVG stays light.
    return rebased.length > 180 ? rebased.filter((_, i, a) => i === 0 || i === a.length - 1 || i % Math.floor(a.length / 160) === 0) : rebased
  }, [full, rangeIdx, isIntraday])

  if (pts.length < 2) {
    return (
      <div style={{ height: '100%', minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F.sans, fontSize: 10, color: F.muted }}>
        {isLoading ? <Spinner /> : 'No performance data'}
      </div>
    )
  }
  const up = pts[pts.length - 1].pct >= 0
  const stroke = up ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'

  return (
    <div style={{ height: '100%', minHeight: 120 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
          <defs>
            <linearGradient id="homePerf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" strokeDasharray="3 4" />
          <XAxis dataKey="date" tickFormatter={d => fmtAxisDate(d, rangeIdx)} tick={{ fontSize: 8, fill: F.muted, fontFamily: 'var(--theme-mono)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={44} tickMargin={8} padding={{ left: 14, right: 14 }} />
          <YAxis orientation="right" width={34} tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(v >= 10 || v <= -10 ? 0 : 1)}%`} tick={{ fontSize: 8, fill: F.muted, fontFamily: 'var(--theme-mono)' }} tickLine={false} axisLine={false} tickCount={3} />
          <Area type="monotone" dataKey="pct" stroke={stroke} strokeWidth={1.5} fill="url(#homePerf)" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Portfolio import strip (preserved global PortfolioContext feature) ───────
function parsePortfolioText(text: string, filename: string): PortfolioHolding[] | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(text)
      const arr = Array.isArray(obj) ? obj : (obj.assets ?? obj.tickers ?? null)
      if (!arr) return null
      if (typeof arr[0] === 'string')
        return (arr as string[]).map(t => ({ ticker: t.trim().toUpperCase(), weight: Math.round(100 / arr.length) }))
      return (arr as { ticker: string; weight?: number; strategy?: string }[]).map(a => ({
        ticker: String(a.ticker).toUpperCase().trim(), weight: Number(a.weight ?? 0), strategy: a.strategy,
      }))
    } catch { return null }
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const HEADER_WORDS = new Set(['ticker', 'symbol', 'weight', 'allocation', 'pct', 'percent', 'name', 'stock'])
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const holdings: PortfolioHolding[] = []
    for (const line of lines) {
      const parts = line.split(',')
      const col1 = parts[0].trim()
      if (HEADER_WORDS.has(col1.toLowerCase())) continue
      const ticker = col1.toUpperCase()
      if (!ticker) continue
      const weight = parseFloat(parts[1])
      holdings.push({ ticker, weight: isNaN(weight) ? 0 : weight, strategy: parts[2]?.trim() })
    }
    if (holdings.length === 0) return null
    if (holdings.every(h => h.weight === 0)) holdings.forEach(h => { h.weight = Math.round(100 / holdings.length) })
    return holdings
  }
  return null
}

function PortfolioImportStrip() {
  const { holdings, tickers, setHoldings, clearPortfolio } = usePortfolio()
  const fileRef = useRef<HTMLInputElement>(null)
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const parsed = parsePortfolioText(ev.target?.result as string, file.name)
      if (!parsed || parsed.length === 0) { alert('Could not parse file. Use CSV (ticker,weight) or JSON.'); return }
      setHoldings(parsed)
    }
    reader.readAsText(file)
    e.target.value = ''
  }
  const btn: React.CSSProperties = { background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)', color: F.gold, fontFamily: F.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }
  return (
    <div style={{ background: F.panel, border: `1px solid ${F.border}`, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <input ref={fileRef} type="file" accept=".json,.csv,.txt" style={{ display: 'none' }} onChange={handleFile} />
      <span style={{ ...cap, letterSpacing: '0.14em' }}>Context Portfolio</span>
      {tickers.length === 0 ? (
        <>
          <button style={btn} onClick={() => fileRef.current?.click()}><Upload size={10} /> Import</button>
          <span style={{ fontFamily: F.sans, fontSize: 9, color: F.muted, lineHeight: 1.4 }}>CSV col 1 TICKER, col 2 WEIGHT, or JSON array. Feeds tools that follow your watchlist.</span>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
            {holdings.map(h => (
              <span key={h.ticker} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${F.border}`, fontFamily: F.mono, fontSize: 10, color: F.gold }}>
                {h.ticker}{h.weight > 0 ? <span style={{ color: F.muted, fontSize: 8 }}> {h.weight}%</span> : null}
              </span>
            ))}
          </div>
          <button style={btn} onClick={() => fileRef.current?.click()}><Upload size={10} /> Replace</button>
          <button onClick={clearPortfolio} style={{ ...btn, background: 'color-mix(in srgb, var(--theme-negative) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 20%, transparent)', color: F.neg }}><X size={10} /> Clear</button>
        </>
      )}
    </div>
  )
}

// ── Hub card ────────────────────────────────────────────────────────────────
function HubCard({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const [hover, setHover] = useState(false)
  const hub = HUBS.find(h => h.slug === slug)!
  const Icon = hub.icon
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/hub/${hub.slug}`)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/hub/${hub.slug}`) } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 12, padding: '17px 18px',
        background: hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 4%, var(--theme-bg, #0d1826))' : F.panel,
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)' : F.border}`,
        cursor: 'pointer', outline: 'none', transition: 'border-color 0.14s ease, background 0.14s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, flexShrink: 0, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)', color: F.gold }}>
          <Icon size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: F.sans, fontSize: 15, fontWeight: 700, color: F.text }}>{hub.label}</span>
            <span style={{ fontFamily: F.mono, fontSize: 9, color: F.muted, border: '1px solid rgba(255,255,255,0.1)', padding: '1px 5px' }}>{hub.tools.length}</span>
            <ArrowUpRight size={13} style={{ marginLeft: 'auto', color: F.gold, opacity: hover ? 0.9 : 0.5, transform: hover ? 'translate(1px,-1px)' : 'none', transition: 'opacity 0.14s ease, transform 0.14s ease' }} />
          </div>
          <div style={{ fontFamily: F.sans, fontSize: 11, color: F.sec, lineHeight: 1.45, marginTop: 4 }}>{hub.tagline}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingTop: 11, borderTop: `1px solid ${F.borderFaint}` }}>
        {hub.tools.map(t => (
          <span key={t.route} style={{ fontFamily: F.sans, fontSize: 10.5, color: 'var(--theme-secondary, #9fb0c6)', padding: '3px 8px', background: 'color-mix(in srgb, var(--theme-text, #fff) 4%, transparent)', border: `1px solid ${F.border}`, whiteSpace: 'nowrap' }}>{t.chip}</span>
        ))}
      </div>
    </div>
  )
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...cap, fontSize: 8.5 }}>{label}</div>
      <div style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, color: color ?? F.text, marginTop: 3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  )
}

// ── Section header (gold tick + label + rule) ────────────────────────────────
function SectionLabel({ icon: Icon, label, count }: { icon: React.ElementType; label: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <Icon size={11} style={{ color: F.muted, flexShrink: 0 }} />
      <span style={{ fontFamily: F.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.sec, whiteSpace: 'nowrap' }}>{label}</span>
      {count != null && <span style={{ fontFamily: F.mono, fontSize: 10, color: F.muted }}>{count}</span>}
      <div style={{ flex: 1, height: 1, background: F.borderFaint }} />
    </div>
  )
}

function ResultGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>{children}</div>
}

function ResultTile({ icon: Icon, title, sub, onClick }: { icon: React.ElementType; title: string; sub: string; onClick: () => void }) {
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter') onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', background: F.panel, border: `1px solid ${F.border}`, cursor: 'pointer' }}>
      <Icon size={15} style={{ color: F.gold, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: F.sans, fontSize: 12.5, fontWeight: 700, color: F.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        <div style={{ fontFamily: F.sans, fontSize: 10, color: F.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
      </div>
    </div>
  )
}

// ── Ticker mini-dashboard (global-search ticker branch) ─────────────────────
interface HubResp {
  company_name?: string; sector?: string; exchange?: string
  market_cap?: number | null; pe_ratio?: number | null; dividend_yield?: number | null; beta?: number | null
  fifty_two_week_high?: number | null; fifty_two_week_low?: number | null
  current_price?: number | null; pct_change_1d?: number | null
  open?: number | null; previous_close?: number | null; day_high?: number | null; day_low?: number | null
  volume?: number | null; avg_volume?: number | null
  sparkline?: number[]
}
const dash = (s: string | number | null | undefined) => (s === null || s === undefined || s === '' ? '—' : String(s))
const EXCHANGE_NAMES: Record<string, string> = {
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NASDAQ: 'NASDAQ', NasdaqGS: 'NASDAQ', NasdaqGM: 'NASDAQ', NasdaqCM: 'NASDAQ',
  NYQ: 'NYSE', NYSE: 'NYSE', NYE: 'NYSE',
  ASE: 'NYSE American', AMEX: 'NYSE American',
  PCX: 'NYSE Arca', ARCA: 'NYSE Arca', BATS: 'Cboe', CBOE: 'Cboe',
}
const exchangeLabel = (e?: string | null) => (!e ? null : EXCHANGE_NAMES[e] ?? e)
const fmtPrice = (v?: number | null) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const fmtCompact = (v?: number | null) => (v == null || v === 0 ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v))
const fmtRatio = (v?: number | null) => (v == null || v === 0 ? '—' : v.toFixed(2))
const fmtYield = (v?: number | null) => (v == null || v === 0 ? '—' : `${v.toFixed(2)}%`)
const rangePct = (price?: number | null, lo?: number | null, hi?: number | null) => {
  if (price == null || lo == null || hi == null || hi <= lo) return null
  return Math.min(98, Math.max(2, ((price - lo) / (hi - lo)) * 100))
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '13px 22px', borderRight: '1px solid rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ fontFamily: F.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: F.muted }}>{label}</div>
      <div style={{ fontFamily: F.mono, fontSize: 13.5, fontWeight: 600, color: F.text, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function RangeBar({ label, lo, hi, price, color, divider }: { label: string; lo?: number | null; hi?: number | null; price?: number | null; color: string; divider: boolean }) {
  const pct = rangePct(price, lo, hi)
  return (
    <div style={{ padding: '16px 22px', borderRight: divider ? `1px solid ${F.borderFaint}` : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
        <span style={{ fontFamily: F.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: F.muted }}>{label}</span>
        <span style={{ fontFamily: F.mono, fontSize: 10, color: F.sec }}>{fmtPrice(lo)} – {fmtPrice(hi)}</span>
      </div>
      <div style={{ position: 'relative', height: 4, background: 'rgba(255,255,255,0.07)' }}>
        {pct != null && (
          <>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: color }} />
            <div style={{ position: 'absolute', left: `${pct}%`, top: '50%', width: 9, height: 9, borderRadius: '50%', background: color, border: '2px solid #0d1826', transform: 'translate(-50%,-50%)' }} />
          </>
        )}
      </div>
    </div>
  )
}

function TickerSpark({ data, color }: { data: number[]; color: string }) {
  const pts = useMemo(() => data.map((v, i) => ({ i, v })), [data])
  if (pts.length < 2) return <div style={{ height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F.sans, fontSize: 10, color: F.muted }}>No trend data</div>
  return (
    <div style={{ height: 84 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="tickerSpark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill="url(#tickerSpark)" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function JumpTile({ icon: Icon, title, sub, onClick }: { icon: React.ElementType; title: string; sub: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', background: hover ? '#101e30' : F.panel, border: `1px solid ${hover ? 'rgba(201,168,76,0.45)' : F.border}`, cursor: 'pointer', transition: 'border-color 0.15s ease, background 0.15s ease' }}>
      <Icon size={16} style={{ color: F.gold, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: F.sans, fontSize: 12.5, fontWeight: 700, color: F.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        <div style={{ fontFamily: F.sans, fontSize: 10, color: F.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
      </div>
    </div>
  )
}

function TickerDashboard({ sym }: { sym: string }) {
  const isMobile = useIsMobile()
  const quotes = useQuotes([sym])
  const { data: hub, isLoading } = useQuery<HubResp>({
    queryKey: ['ticker-hub', sym],
    queryFn: () => axios.get(`/api/corporate/hub?ticker=${encodeURIComponent(sym)}`).then(r => r.data),
    staleTime: 300_000,
    retry: 1,
  })

  const q = quotes[sym]
  const price = q?.current_price ?? hub?.current_price ?? null
  const pct = q?.pct_change_1d ?? hub?.pct_change_1d ?? null
  const up = (pct ?? 0) >= 0
  const chg = up ? F.pos : F.neg
  const prev = hub?.previous_close ?? null
  const chgAbs = price != null && prev != null ? price - prev
    : price != null && pct != null ? price - price / (1 + pct / 100) : null

  const spark = hub?.sparkline ?? []
  const monthUp = spark.length >= 2 ? spark[spark.length - 1] >= spark[0] : up
  const monthColor = monthUp ? F.pos : F.neg
  const monthPct = spark.length >= 2 && spark[0] !== 0 ? (spark[spark.length - 1] / spark[0] - 1) * 100 : null

  const panel: React.CSSProperties = { border: `1px solid ${F.border}`, borderTop: `2px solid ${F.gold}`, background: F.panel }

  if (isLoading && !hub) {
    return <div style={{ ...panel, height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
  }

  return (
    <>
      <style>{`@keyframes home-tkr-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`}</style>
      <div style={{ ...panel, animation: 'home-tkr-in 0.25s ease' }}>
        {/* 1. Identity + price */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', padding: '18px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <TickerLogo ticker={sym} size={50} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontFamily: F.sans, fontSize: 21, fontWeight: 700, color: F.bright, lineHeight: 1 }}>{dash(hub?.company_name ?? sym)}</span>
                {exchangeLabel(hub?.exchange) && <span style={{ fontFamily: F.mono, fontSize: 9, color: F.sec, border: '1px solid rgba(255,255,255,0.12)', padding: '2px 6px' }}>{exchangeLabel(hub?.exchange)}</span>}
              </div>
              <div style={{ fontFamily: F.sans, fontSize: 11.5, color: F.muted, marginTop: 7 }}>{dash(hub?.sector)}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: F.mono, fontSize: 34, fontWeight: 700, color: F.bright, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{fmtPrice(price)}</div>
            {pct != null && (
              <div style={{ display: 'inline-flex', alignItems: 'center', marginTop: 8, fontFamily: F.mono, fontSize: 13, fontWeight: 700, color: chg, background: up ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)', border: `1px solid ${up ? 'rgba(34,197,94,0.32)' : 'rgba(239,68,68,0.32)'}`, padding: '4px 10px' }}>
                {up ? '↑' : '↓'}&nbsp;{chgAbs != null ? `${up ? '+' : '-'}${Math.abs(chgAbs).toFixed(2)}` : '—'}&nbsp;&nbsp;{up ? '+' : '-'}{Math.abs(pct).toFixed(2)}%
              </div>
            )}
            <div style={{ fontFamily: F.sans, fontSize: 10.5, color: F.muted, marginTop: 8 }}>As of {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · Prev close {fmtPrice(prev)}</div>
          </div>
        </div>

        {/* 2. Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 4}, 1fr)`, borderTop: `1px solid ${F.borderFaint}` }}>
          <StatCell label="Open" value={fmtPrice(hub?.open)} />
          <StatCell label="Prev Close" value={fmtPrice(prev)} />
          <StatCell label="Volume" value={fmtCompact(hub?.volume)} />
          <StatCell label="Avg Volume" value={fmtCompact(hub?.avg_volume)} />
          <StatCell label="Market Cap" value={fmtCompact(hub?.market_cap)} />
          <StatCell label="P/E Ratio" value={fmtRatio(hub?.pe_ratio)} />
          <StatCell label="Div Yield" value={fmtYield(hub?.dividend_yield)} />
          <StatCell label="Beta" value={fmtRatio(hub?.beta)} />
        </div>

        {/* 3. Range bars */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: `1px solid ${F.borderFaint}` }}>
          <RangeBar label="Day's Range" lo={hub?.day_low} hi={hub?.day_high} price={price} color={chg} divider />
          <RangeBar label="52-Week Range" lo={hub?.fifty_two_week_low} hi={hub?.fifty_two_week_high} price={price} color={F.gold} divider={false} />
        </div>

        {/* 4. 1-month sparkline */}
        <div style={{ padding: '16px 22px', borderTop: `1px solid ${F.borderFaint}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: F.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: F.muted }}>1-Month Trend</span>
            {monthPct != null && <span style={{ fontFamily: F.mono, fontSize: 10, fontWeight: 700, color: monthColor }}>{monthUp ? '+' : '-'}{Math.abs(monthPct).toFixed(2)}%</span>}
          </div>
          <TickerSpark data={spark} color={monthColor} />
        </div>
      </div>
    </>
  )
}

function TickerJumpTiles({ sym, isMobile }: { sym: string; isMobile: boolean }) {
  const navigate = useNavigate()
  const tiles = [
    { icon: TrendingUp, title: 'Market data', sub: 'Price history & chart', route: `/market?ticker=${sym}` },
    { icon: Calculator, title: 'DCF valuation', sub: 'Intrinsic value & upside', route: `/dcf?ticker=${sym}` },
    { icon: Globe, title: 'Company profile', sub: 'Revenue mix & geography', route: `/supply-chain?ticker=${sym}` },
    { icon: Scale, title: 'Peer comparison', sub: 'Multiples vs sector peers', route: `/relative-valuation?ticker=${sym}` },
  ]
  return (
    <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 4}, 1fr)`, gap: 10 }}>
      {tiles.map(t => <JumpTile key={t.route} icon={t.icon} title={t.title} sub={t.sub} onClick={() => navigate(t.route)} />)}
    </div>
  )
}

export default function Home() {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [rangeIdx, setRangeIdx] = useState(2) // 1M
  const [tapeSource, setTapeSource] = useState<TapeSource>('holdings')
  const [searchFocus, setSearchFocus] = useState(false)
  const [q, setQ] = useState('')

  const session = useMemo(marketSession, [])
  const dateLabel = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), [])

  // Holdings come from the Portfolio Manager store (shares → real dollar value).
  const pm = useMemo(loadActivePortfolio, [])
  const ctx = usePortfolio()
  const hasPM = pm.holdings.length > 0
  const holdingTickers = hasPM ? pm.holdings.map(h => h.ticker) : ctx.tickers
  const hasHoldings = holdingTickers.length > 0
  // Always keep the cockpit alive: fall back to the major indices for a brand-new account.
  const dataTickers = hasHoldings ? holdingTickers : ['SPY', 'QQQ', 'DIA', 'IWM', 'NVDA']

  // Holdings power the cockpit; the index set is only fetched when the tape is
  // switched to Indices (cached thereafter).
  const quoteTickers = useMemo(
    () => Array.from(new Set(tapeSource === 'indices' ? [...dataTickers, ...INDEX_TICKERS] : dataTickers)),
    [dataTickers.join(','), tapeSource], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const quotes = useQuotes(quoteTickers)

  // Portfolio value + day P&L + total return (only meaningful with PM shares).
  const priced = useMemo(() => priceHoldings(pm.holdings, quotes), [pm.holdings, quotes])
  const totalValue = priced.reduce((s, p) => s + p.value, 0) + pm.cash
  const totalCost = priced.reduce((s, p) => s + p.cost, 0) + pm.cash
  const dayPnl = priced.reduce((s, p) => s + p.dayPnl, 0)
  const totalPnl = totalValue - totalCost
  const dayPct = (totalValue - dayPnl) > 0 ? (dayPnl / (totalValue - dayPnl)) * 100 : 0
  const totalPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

  // Top holdings list for the right cockpit cell.
  const topHoldings = useMemo(() => {
    if (hasPM) {
      return [...priced].sort((a, b) => b.value - a.value).slice(0, 5)
        .map(p => ({ sym: p.ticker, secondary: `${p.shares.toLocaleString()} sh`, price: quotes[p.ticker]?.current_price ?? p.price, pct: quotes[p.ticker]?.pct_change_1d ?? null }))
    }
    const src = hasHoldings ? ctx.holdings.map(h => h.ticker) : dataTickers
    return src.slice(0, 5).map((t, i) => ({ sym: t, secondary: hasHoldings && ctx.holdings[i]?.weight ? `${ctx.holdings[i].weight}%` : 'Market', price: quotes[t]?.current_price ?? null, pct: quotes[t]?.pct_change_1d ?? null }))
  }, [hasPM, priced, ctx.holdings, dataTickers, hasHoldings, quotes])

  // Best / worst day movers for the value-cell stat strip.
  const movers = useMemo(() => [...priced].filter(p => quotes[p.ticker]).sort((a, b) => b.pct1d - a.pct1d), [priced, quotes])
  const best = movers[0]
  const worst = movers.length > 1 ? movers[movers.length - 1] : undefined

  // Tape segments — holdings by default, switchable to the index set.
  const tapeSegments = useMemo(() => {
    const syms = tapeSource === 'indices' ? INDEX_TICKERS : dataTickers
    return syms.map(s => {
      const q = quotes[s]
      return { sym: tapeLabel(s), price: q?.current_price != null ? q.current_price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—', pct: q?.pct_change_1d ?? null }
    })
  }, [tapeSource, dataTickers, quotes])

  // Performance weights (value-weighted for PM, else equal).
  const perfWeights = useMemo(() => {
    if (hasPM && totalValue > pm.cash) return priced.map(p => p.value / (totalValue - pm.cash))
    return dataTickers.map(() => 1 / dataTickers.length)
  }, [hasPM, priced, totalValue, pm.cash, dataTickers])
  const perfTickers = hasPM ? pm.holdings.map(h => h.ticker) : dataTickers

  // Recents → resolve to tools (max 4 shown).
  const recents = useMemo(() => getRecents().map(r => ALL_TOOLS.find(t => t.route === r)).filter(Boolean).slice(0, 4) as typeof ALL_TOOLS, [])

  // Global search: tools (by name/desc), a ticker (when the query looks like a
  // symbol), and quick actions. Tickers route to the two pages that read ?ticker.
  const ql = q.trim().toLowerCase()
  const filtered = useMemo(() => !ql ? [] : ALL_TOOLS.filter(t => wordMatch(`${t.title} ${t.desc}`, ql)), [ql])

  const sym = useMemo(() => {
    const raw = q.trim()
    return /^[A-Za-z]{1,5}(\.[A-Za-z])?$/.test(raw) ? raw.toUpperCase() : null
  }, [q])
  const tickerResults = useMemo(() => {
    if (!sym) return []
    const mkt = ALL_TOOLS.find(t => t.route === '/market')
    const dcf = ALL_TOOLS.find(t => t.route === '/dcf')
    return [
      { key: 'tk-market', icon: mkt?.icon ?? TrendingUp, title: `${sym} · Market data`, sub: 'Price history, returns, and chart', route: `/market?ticker=${sym}` },
      { key: 'tk-dcf', icon: dcf?.icon ?? TrendingUp, title: `${sym} · DCF valuation`, sub: 'Intrinsic value and upside', route: `/dcf?ticker=${sym}` },
    ]
  }, [sym])

  const actionResults = useMemo(() => {
    if (!ql) return []
    const actions = [
      { key: 'ac-dash', icon: LayoutGrid, title: 'Open My Dashboard', sub: 'Your saved cockpit', route: '/dashboard', kw: 'dashboard home cockpit overview saved' },
      { key: 'ac-pm', icon: Briefcase, title: 'Open Portfolio Manager', sub: 'Add and manage holdings', route: '/portfolio-manager', kw: 'portfolio manager holdings positions add import cash' },
    ]
    return actions.filter(a => wordMatch(`${a.title} ${a.kw}`, ql))
  }, [ql])

  const noResults = filtered.length === 0 && tickerResults.length === 0 && actionResults.length === 0

  const cockpitCols = isMobile ? '1fr' : '1fr 1.5fr 1.25fr'

  return (
    <PageWrapper>
      <div className="mx-auto w-full max-w-[1180px] 2xl:max-w-[1440px]" style={{ background: F.surface, border: `1px solid ${F.border}` }}>
        <Tape segments={tapeSegments} source={tapeSource} onSource={setTapeSource} />

        <div style={{ padding: isMobile ? '18px 16px 22px' : '24px 28px 30px' }}>
          {/* hero */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', paddingBottom: 18, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' }}>
            <div>
              <div style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: 24, fontWeight: 700, letterSpacing: '0.1em', color: F.gold, lineHeight: 1 }}>ALPHATAPE</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: session.color, flexShrink: 0 }} />
                <span style={{ fontFamily: F.sans, fontSize: 11.5, color: F.sec, letterSpacing: '0.02em' }}>{dateLabel} · {session.label}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: F.topbar, border: `1px solid ${searchFocus ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)' : F.border}`, padding: '9px 12px', width: isMobile ? 200 : 280, transition: 'border-color 0.15s ease' }}>
                <Search size={13} style={{ color: F.muted, flexShrink: 0 }} />
                <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => setSearchFocus(true)} onBlur={() => setSearchFocus(false)} aria-label="Search tools, tickers, and actions" placeholder="Search tools, tickers, actions" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: F.text, fontFamily: F.sans, fontSize: 12 }} />
                {q && <button onClick={() => setQ('')} aria-label="Clear" style={{ background: 'none', border: 'none', cursor: 'pointer', color: F.muted, display: 'flex', padding: 0 }}><X size={12} /></button>}
              </div>
              <button onClick={() => navigate('/dashboard')} style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, background: F.gold, border: 'none', padding: '9px 14px', cursor: 'pointer' }}>
                <LayoutGrid size={14} style={{ color: '#101c2e' }} />
                <span style={{ fontFamily: F.sans, fontSize: 12, fontWeight: 700, color: '#101c2e', letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>My Dashboard</span>
              </button>
            </div>
          </div>

          {/* search results override the hubs grid */}
          {ql ? (
            <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {sym && (
                <div>
                  <SectionLabel icon={TrendingUp} label={`Ticker · ${sym}`} />
                  <TickerDashboard sym={sym} />
                  <TickerJumpTiles sym={sym} isMobile={isMobile} />
                </div>
              )}
              {filtered.length > 0 && (
                <div>
                  <SectionLabel icon={Search} label="Tools" count={filtered.length} />
                  <ResultGrid>
                    {filtered.map(t => <ResultTile key={t.route} icon={t.icon} title={t.title} sub={t.desc} onClick={() => navigate(t.route)} />)}
                  </ResultGrid>
                </div>
              )}
              {actionResults.length > 0 && (
                <div>
                  <SectionLabel icon={Zap} label="Actions" />
                  <ResultGrid>
                    {actionResults.map(r => <ResultTile key={r.key} icon={r.icon} title={r.title} sub={r.sub} onClick={() => navigate(r.route)} />)}
                  </ResultGrid>
                </div>
              )}
              {noResults && (
                <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: F.sans, fontSize: 12, color: F.sec }}>
                  Nothing matches <span style={{ color: F.text, fontFamily: F.mono }}>{q}</span>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* cockpit band */}
              <div style={{ marginTop: 18, border: `1px solid ${F.border}`, borderTop: `2px solid ${F.gold}`, background: F.panel, display: 'grid', gridTemplateColumns: cockpitCols }}>
                {/* portfolio value */}
                <div style={{ padding: '16px 18px', borderRight: isMobile ? 'none' : `1px solid ${F.borderFaint}`, borderBottom: isMobile ? `1px solid ${F.borderFaint}` : 'none' }}>
                  <div style={cap}>Portfolio Value</div>
                  {hasPM ? (
                    <>
                      <div style={{ fontFamily: F.mono, fontSize: 31, fontWeight: 700, color: F.text, fontVariantNumeric: 'tabular-nums', marginTop: 10, letterSpacing: '-0.01em' }}>{money(totalValue)}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                        <ArrowUpRight size={13} style={{ color: dayPnl >= 0 ? F.pos : F.neg, transform: dayPnl >= 0 ? 'none' : 'scaleY(-1)' }} />
                        <span style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: dayPnl >= 0 ? F.pos : F.neg, fontVariantNumeric: 'tabular-nums' }}>{dayPnl >= 0 ? '+' : ''}{money(dayPnl)}</span>
                        <span style={{ fontFamily: F.mono, fontSize: 12, color: dayPnl >= 0 ? F.pos : F.neg }}>{dayPct >= 0 ? '+' : ''}{dayPct.toFixed(2)}%</span>
                      </div>
                      <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${F.borderFaint}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 16px' }}>
                        <MiniStat label="Total Return" value={`${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`} color={totalPnl >= 0 ? F.pos : F.neg} />
                        <MiniStat label="Positions" value={String(priced.length)} />
                        <MiniStat label="Invested" value={money(totalValue - pm.cash)} />
                        <MiniStat label="Cash" value={money(pm.cash)} />
                        {best && <MiniStat label="Top Today" value={`${best.ticker} ${best.pct1d >= 0 ? '+' : ''}${best.pct1d.toFixed(1)}%`} color={best.pct1d >= 0 ? F.pos : F.neg} />}
                        {worst && <MiniStat label="Lag Today" value={`${worst.ticker} ${worst.pct1d >= 0 ? '+' : ''}${worst.pct1d.toFixed(1)}%`} color={worst.pct1d >= 0 ? F.pos : F.neg} />}
                      </div>
                    </>
                  ) : (
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
                      <div style={{ fontFamily: F.sans, fontSize: 11.5, color: F.sec, lineHeight: 1.5, maxWidth: 220 }}>Track live value, day P&amp;L, and return. Add holdings in the Portfolio Manager.</div>
                      <button onClick={() => navigate('/portfolio-manager')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)', color: F.gold, fontFamily: F.sans, fontSize: 11, fontWeight: 700, padding: '7px 12px', cursor: 'pointer' }}>
                        <Briefcase size={13} /> Open Portfolio Manager
                      </button>
                    </div>
                  )}
                </div>

                {/* performance */}
                <div style={{ padding: '16px 18px', borderRight: isMobile ? 'none' : `1px solid ${F.borderFaint}`, borderBottom: isMobile ? `1px solid ${F.borderFaint}` : 'none', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={cap}>Performance</div>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {RANGES.map((r, i) => (
                        <button key={r.label} onClick={() => setRangeIdx(i)} style={{ fontFamily: F.mono, fontSize: 9, padding: '2px 6px', cursor: 'pointer', background: 'none', color: i === rangeIdx ? F.gold : F.muted, border: `1px solid ${i === rangeIdx ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)' : 'transparent'}` }}>{r.label}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ flex: 1, marginTop: 12, minHeight: 120 }}>
                    <PerformanceSpark tickers={perfTickers} weights={perfWeights} rangeIdx={rangeIdx} />
                  </div>
                </div>

                {/* top holdings */}
                <div style={{ padding: '14px 16px' }}>
                  <div style={{ ...cap, marginBottom: 9 }}>{hasHoldings ? 'Top Holdings' : 'Markets'}</div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {topHoldings.map(h => (
                      <div key={h.sym} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', borderBottom: `1px solid ${F.borderFaint}` }}>
                        <TickerLogo ticker={h.sym} size={24} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontFamily: F.sans, fontSize: 12, fontWeight: 600, color: F.bright, lineHeight: 1.2 }}>{h.sym}</div>
                          <div style={{ fontFamily: F.sans, fontSize: 9, color: F.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.secondary}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontFamily: F.mono, fontSize: 12, color: F.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{h.price != null ? h.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</div>
                          <div style={{ fontFamily: F.mono, fontSize: 10, color: h.pct == null ? F.muted : h.pct >= 0 ? F.pos : F.neg }}>{h.pct != null ? `${h.pct >= 0 ? '+' : ''}${h.pct.toFixed(1)}%` : '—'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* jump back in */}
              {recents.length > 0 && (
                <div style={{ marginTop: 22 }}>
                  <SectionLabel icon={Clock} label="Jump Back In" />
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10 }}>
                    {recents.map(r => {
                      const Icon = r.icon
                      return (
                        <RecentChip key={r.route} icon={Icon} title={r.title} onClick={() => navigate(r.route)} />
                      )
                    })}
                  </div>
                </div>
              )}

              {/* hubs */}
              <div style={{ marginTop: 26 }}>
                <SectionLabel icon={LayoutGrid} label="Hubs" count={HUBS.length} />
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 12 }}>
                  {HUBS.map(h => <HubCard key={h.slug} slug={h.slug} />)}
                </div>
              </div>

              {/* context portfolio importer */}
              <div style={{ marginTop: 26 }}>
                <PortfolioImportStrip />
              </div>
            </>
          )}
        </div>
      </div>
    </PageWrapper>
  )
}

function RecentChip({ icon: Icon, title, onClick }: { icon: React.ElementType; title: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
        background: hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, var(--theme-bg, #0d1826))' : F.panel,
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 42%, transparent)' : F.border}`,
        cursor: 'pointer', outline: 'none', transition: 'border-color 0.14s ease, background 0.14s ease',
      }}
    >
      <Icon size={15} style={{ color: F.gold, flexShrink: 0 }} />
      <span style={{ fontFamily: F.sans, fontSize: 12, fontWeight: 600, color: F.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
    </div>
  )
}
