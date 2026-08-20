import { useRef, useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { AreaChart, Area, YAxis, ReferenceLine, ResponsiveContainer } from 'recharts'
import { Search, LayoutGrid, ArrowUpRight, Clock, X, Upload, Briefcase, TrendingUp, Zap, Calculator, Globe, Scale, Building2, Sunrise } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import TickerLogo from '../components/TickerLogo'
import MarketClockMini from '../components/MarketClockMini'
import MorningBrief from '../components/MorningBrief'
import useIsMobile from '../hooks/useIsMobile'
import { usePortfolio, type PortfolioHolding } from '../contexts/PortfolioContext'
import { loadActivePortfolio, useQuotes, priceHoldings } from '../components/dashboard/widgets/usePortfolio'
import { HUBS, ALL_TOOLS } from '../lib/hubs'
import { getRecents } from '../lib/recents'
import { wordMatch, tickerFromQuery } from '../lib/search'
import { getRecentTickers, recordRecentTicker } from '../lib/recentTickers'
import { formatLocalTime, localTimeZone, todayLocal } from '../lib/time'
import EmptyState from '../components/EmptyState'
import ShortcutKey from '../components/ShortcutKey'
import { resolveIntents, intentUrl } from '../lib/searchIntent'

const F = {
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  bright: 'var(--theme-text, #dce3ed)',
  sec: 'var(--theme-secondary, #8099b0)',
  muted: 'var(--theme-secondary, #8099b0)',
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

const cap: React.CSSProperties = { fontFamily: F.sans, fontSize: 9, fontWeight: 400, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.muted }

// ── Holdings / index marquee tape ──────────────────────────────────────────
const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

type TapeSource = 'holdings' | 'indices'

function TapeToggle({ source, onSource }: { source: TapeSource; onSource: (s: TapeSource) => void }) {
  const opt = (key: TapeSource, label: string) => (
    <button
      onClick={() => onSource(key)}
      aria-pressed={source === key}
      style={{
        fontFamily: F.mono, fontSize: 8.5, fontWeight: 400, letterSpacing: '0.1em', textTransform: 'uppercase',
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
      <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0, lineHeight: 1 }}>
        <span style={{ color: F.muted, letterSpacing: '0.04em' }}>{s.sym}</span>
        <span style={{ color }}>{s.price}{s.pct != null && ` ${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%`}</span>
      </span>
    )
  }
  const Run = ({ p }: { p: string }) => (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 24, padding: '0 24px 0 14px' }}>
      {segments.map((s, i) => <Seg key={`${p}-${i}`} s={s} k={`${p}-${i}`} />)}
    </div>
  )
  return (
    <div style={{ borderBottom: `1px solid ${F.borderFaint}`, background: F.topbar, height: 26, display: 'flex', alignItems: 'center' }}>
      <style>{`@keyframes home-tape{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}`}</style>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', height: '100%', maskImage: 'linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent)', WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent)' }}>
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
            style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', willChange: 'transform', backfaceVisibility: 'hidden', background: F.topbar, animation: 'home-tape 46s linear infinite', fontFamily: F.mono, fontSize: 10, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}
          >
            <Run p="a" /><Run p="b" />
          </div>
        )}
      </div>
      <TapeToggle source={source} onSource={onSource} />
    </div>
  )
}

// One loading treatment across the app. A rotation is also the one motion the
// global reduced-motion rule cannot soften: capping duration at 0.01ms turns a
// spin into a strobe, so the bar replaces the concept rather than gating it.
function Spinner() {
  return <EmptyState variant="loading" size="compact" title="Loading" />
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
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F.sans, fontSize: 10, color: F.muted }}>
        {isLoading ? <Spinner /> : 'No performance data'}
      </div>
    )
  }
  const up = pts[pts.length - 1].pct >= 0
  const stroke = up ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'

  return (
    <div style={{ height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts} margin={{ top: 6, right: 4, left: 4, bottom: 2 }}>
          <defs>
            <linearGradient id="homePerf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" strokeDasharray="3 4" />
          <YAxis orientation="right" width={34} tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(v >= 10 || v <= -10 ? 0 : 1)}%`} tick={{ fontSize: 8, fill: F.muted, fontFamily: 'var(--theme-mono)' }} tickLine={false} axisLine={false} tickCount={3} />
          <Area type="monotone" dataKey="pct" stroke={stroke} strokeWidth={1.8} fill="url(#homePerf)" dot={false} isAnimationActive={false} />
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
  const btn: React.CSSProperties = { background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)', color: F.gold, fontFamily: F.sans, fontSize: 9, fontWeight: 400, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }
  return (
    <div style={{ background: F.panel, border: `1px solid ${F.border}`, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <input ref={fileRef} type="file" accept=".json,.csv,.txt" aria-label="Import context portfolio" style={{ display: 'none' }} onChange={handleFile} />
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
function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...cap, fontSize: 8.5 }}>{label}</div>
      <div style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 400, color: color ?? F.text, marginTop: 3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  )
}

// ── Section header (gold tick + label + rule) ────────────────────────────────
function SectionLabel({ icon: Icon, label, count, note }: { icon: React.ElementType; label: string; count?: number; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <Icon size={11} style={{ color: F.muted, flexShrink: 0 }} />
      <span style={{ fontFamily: F.sans, fontSize: 10, fontWeight: 400, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.sec, whiteSpace: 'nowrap' }}>{label}</span>
      {count != null && <span style={{ fontFamily: F.mono, fontSize: 10, color: F.muted }}>{count}</span>}
      {note && <span style={{ fontFamily: F.sans, fontSize: 10, color: F.muted, whiteSpace: 'nowrap' }}>{note}</span>}
      <div style={{ flex: 1, height: 1, background: F.borderFaint }} />
    </div>
  )
}

function ResultGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>{children}</div>
}

function ResultTile({ icon: Icon, title, sub, onClick, selected }: { icon: React.ElementType; title: string; sub: string; onClick: () => void; selected?: boolean }) {
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter') onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', background: selected ? '#101e30' : F.panel, border: `1px solid ${selected ? 'rgba(201,168,76,0.55)' : F.border}`, cursor: 'pointer' }}>
      <Icon size={15} style={{ color: F.gold, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: F.sans, fontSize: 12.5, fontWeight: 400, color: F.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
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
  PNK: 'OTC', PINX: 'OTC', OTC: 'OTC', OTCMKTS: 'OTC', OTCQB: 'OTC', OTCQX: 'OTC', OQB: 'OTC', OQX: 'OTC',
}
const exchangeLabel = (e?: string | null) => (!e ? null : EXCHANGE_NAMES[e.toUpperCase()] ?? EXCHANGE_NAMES[e] ?? e)
const fmtPrice = (v?: number | null) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const fmtCompact = (v?: number | null) => (v == null || v === 0 ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v))
const fmtRatio = (v?: number | null) => (v == null || v === 0 ? '—' : v.toFixed(2))
const fmtYield = (v?: number | null) => (v == null || v === 0 ? '—' : `${v.toFixed(2)}%`)
const rangePct = (price?: number | null, lo?: number | null, hi?: number | null) => {
  if (price == null || lo == null || hi == null || hi <= lo) return null
  return Math.min(98, Math.max(2, ((price - lo) / (hi - lo)) * 100))
}

function StatCell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} style={{ padding: '13px 22px', borderRight: '1px solid rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ fontFamily: F.sans, fontSize: 8.5, fontWeight: 400, letterSpacing: '0.14em', textTransform: 'uppercase', color: F.muted }}>{label}</div>
      <div style={{ fontFamily: F.mono, fontSize: 13.5, fontWeight: 400, color: F.text, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function RangeBar({ label, lo, hi, price, color, divider }: { label: string; lo?: number | null; hi?: number | null; price?: number | null; color: string; divider: boolean }) {
  const pct = rangePct(price, lo, hi)
  return (
    <div style={{ padding: '16px 22px', borderRight: divider ? `1px solid ${F.borderFaint}` : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
        <span style={{ fontFamily: F.sans, fontSize: 8.5, fontWeight: 400, letterSpacing: '0.14em', textTransform: 'uppercase', color: F.muted }}>{label}</span>
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
        <div style={{ fontFamily: F.sans, fontSize: 12.5, fontWeight: 400, color: F.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
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

  useEffect(() => {
    if (quotes[sym]?.current_price ?? hub?.current_price) recordRecentTicker(sym)
  }, [hub, quotes, sym])

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

  // No quote data => not a real / listed symbol. Show a clean miss, not a zeros shell.
  if (price == null || price === 0) {
    return (
      <div style={{ ...panel, padding: '26px 22px', textAlign: 'center' }}>
        <div style={{ fontFamily: F.sans, fontSize: 13, fontWeight: 400, color: F.text }}>No market data for {sym}</div>
        <div style={{ fontFamily: F.sans, fontSize: 11, color: F.muted, marginTop: 6 }}>Not a recognized US-listed security, or no quote available.</div>
      </div>
    )
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
                <span style={{ fontFamily: F.sans, fontSize: 21, fontWeight: 400, color: F.bright, lineHeight: 1 }}>{dash(hub?.company_name ?? sym)}</span>
                {exchangeLabel(hub?.exchange) && <span style={{ fontFamily: F.mono, fontSize: 9, color: F.sec, border: '1px solid rgba(255,255,255,0.12)', padding: '2px 6px' }}>{exchangeLabel(hub?.exchange)}</span>}
              </div>
              <div style={{ fontFamily: F.sans, fontSize: 11.5, color: F.muted, marginTop: 7 }}>{dash(hub?.sector)}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: F.mono, fontSize: 34, fontWeight: 400, color: F.bright, letterSpacing: 'var(--theme-num-tracking, normal)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{fmtPrice(price)}</div>
            {pct != null && (
              <div style={{ display: 'inline-flex', alignItems: 'center', marginTop: 8, fontFamily: F.mono, fontSize: 13, fontWeight: 400, color: chg, background: up ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)', border: `1px solid ${up ? 'rgba(34,197,94,0.32)' : 'rgba(239,68,68,0.32)'}`, padding: '4px 10px' }}>
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
          <StatCell label="Beta" value={fmtRatio(hub?.beta)} title="Vendor beta, methodology undisclosed. See Company Profile for computed CAPM / Scholes-Williams beta." />
        </div>

        {/* 3. Range bars */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: `1px solid ${F.borderFaint}` }}>
          <RangeBar label="Day's Range" lo={hub?.day_low} hi={hub?.day_high} price={price} color={chg} divider />
          <RangeBar label="52-Week Range" lo={hub?.fifty_two_week_low} hi={hub?.fifty_two_week_high} price={price} color={F.gold} divider={false} />
        </div>

        {/* 4. 1-month sparkline */}
        <div style={{ padding: '16px 22px', borderTop: `1px solid ${F.borderFaint}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: F.sans, fontSize: 8.5, fontWeight: 400, letterSpacing: '0.14em', textTransform: 'uppercase', color: F.muted }}>1-Month Trend</span>
            {monthPct != null && <span style={{ fontFamily: F.mono, fontSize: 10, fontWeight: 400, color: monthColor }}>{monthUp ? '+' : '-'}{Math.abs(monthPct).toFixed(2)}%</span>}
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
    { icon: Globe, title: 'Company profile', sub: 'Price history, revenue mix & credit', route: `/company-profile?ticker=${sym}` },
    { icon: Calculator, title: 'DCF valuation', sub: 'Intrinsic value & upside', route: `/dcf?ticker=${sym}` },
    { icon: Scale, title: 'Peer comparison', sub: 'Multiples vs sector peers', route: `/peer-comparison?ticker=${sym}` },
    { icon: TrendingUp, title: 'Chart Studio', sub: 'Candles with every overlay', route: '/chart-studio' },
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
  const [briefOpen, setBriefOpen] = useState(false)

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
  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const dql = debouncedQ.toLowerCase()
  const filtered = useMemo(() => !ql ? [] : ALL_TOOLS.filter(t => wordMatch(`${t.title} ${t.desc}`, ql)), [ql])

  const sym = useMemo(() => tickerFromQuery(q), [q])

  const actionResults = useMemo(() => {
    if (!ql) return []
    const actions = [
      { key: 'ac-dash', icon: LayoutGrid, title: 'Open My Dashboard', sub: 'Your saved cockpit', route: '/dashboard', kw: 'dashboard home cockpit overview saved' },
      { key: 'ac-pm', icon: Briefcase, title: 'Open Portfolio Manager', sub: 'Add and manage holdings', route: '/portfolio-manager', kw: 'portfolio manager holdings positions add import cash' },
    ]
    return actions.filter(a => wordMatch(`${a.title} ${a.kw}`, ql))
  }, [ql])

  // Company-name search: resolve "blackrock" -> BLK via the SEC index. Only when
  // the query isn't already a bare ticker (which renders the dashboard directly).
  const companyQuery = useQuery<{ results: { ticker: string; name: string }[] }>({
    queryKey: ['company-search', dql],
    queryFn: () => axios.get(`/api/corporate/search?q=${encodeURIComponent(debouncedQ)}`).then(r => r.data),
    enabled: dql.length >= 2,
    staleTime: 300_000,
    retry: 1,
  })
  const companyResults = companyQuery.data?.results ?? []
  // A confident company-name match wins over a bare ticker guess, so 5-letter
  // company names ("sompo", "apple") resolve to the real ticker (SMPNY, AAPL)
  // instead of a dead symbol — but a query that IS a listed ticker keeps it.
  // Tool-ish words keep the list; remaining matches are offered as alternatives.
  const autoTicker = filtered.length === 0 && actionResults.length === 0
    && companyResults[0]?.name.toLowerCase().startsWith(ql) ? companyResults[0].ticker : null
  const symIsListed = !!sym && companyResults.some(c => c.ticker === sym)
  const dashSym = symIsListed ? sym : (autoTicker ?? sym)
  const otherCompanies = (sym && dashSym === sym) ? [] : companyResults.filter(c => c.ticker !== dashSym)
  const searching = ql.length >= 2 && (debouncedQ !== q.trim() || companyQuery.isFetching)

  const intentHits = useMemo(() => resolveIntents(q, 3), [q])
  const noResults = !dashSym && filtered.length === 0 && actionResults.length === 0 && companyResults.length === 0 && intentHits.length === 0

  // Arrow-key navigation over the flat tool+action result list; Enter opens the
  // selection, or jumps to the ticker's market data when a symbol is typed.
  const navRoutes = useMemo(() => [...filtered.map(t => t.route), ...actionResults.map(r => r.route)], [filtered, actionResults])
  const [selIdx, setSelIdx] = useState(-1)
  useEffect(() => setSelIdx(-1), [ql])
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelIdx(i => Math.min(navRoutes.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx(i => Math.max(-1, i - 1)) }
    else if (e.key === 'Enter') {
      if (selIdx >= 0 && navRoutes[selIdx]) return navigate(navRoutes[selIdx])
      // A phrase that names what the user wants beats defaulting to a profile:
      // "AAPL implied volatility" is a request for the vol surface, not a quote.
      const intent = resolveIntents(q)[0]
      if (intent && q.trim().split(/\s+/).length > 1) return navigate(intentUrl(intent))
      if (dashSym) return navigate(`/company-profile?ticker=${dashSym}`)
      if (intent) navigate(intentUrl(intent))
    }
  }
  const recentTickers = useMemo(() => getRecentTickers(), [])

  const overviewCols = isMobile ? '1fr' : '0.82fr 0.98fr 1.12fr'
  const localStamp = formatLocalTime(new Date())

  // Holdings rows for Overview column 1 (dollar value + day change), largest first.
  const holdingRows = useMemo(
    () => [...priced].sort((a, b) => b.value - a.value).slice(0, 4)
      .map(p => ({ ticker: p.ticker, value: p.value, pct: quotes[p.ticker]?.pct_change_1d ?? p.pct1d ?? null })),
    [priced, quotes],
  )

  // Movers for Overview column 2 — largest absolute day moves, bar sized to magnitude.
  const moversTop = useMemo(() => {
    const ranked = [...movers].sort((a, b) => Math.abs(b.pct1d) - Math.abs(a.pct1d)).slice(0, 3)
    const max = Math.max(1, ...ranked.map(m => Math.abs(m.pct1d)))
    return ranked.map(m => ({ ticker: m.ticker, pct: m.pct1d, mag: Math.abs(m.pct1d) / max }))
  }, [movers])

  return (
    <PageWrapper>
      <div style={{ background: 'var(--theme-bg, #090e16)' }}>
        {/* Home renders full-bleed (Layout gives /app a no-padding container), so the
            tape spans the whole top; content below is centered by the inner max-width. */}
        <Tape segments={tapeSegments} source={tapeSource} onSource={setTapeSource} />

        <div style={{ maxWidth: 1360, margin: '0 auto', width: '100%', boxSizing: 'border-box', padding: isMobile ? '0 16px 40px' : '0 40px 48px' }}>
          {/* Hero — centered wordmark, status, command search, recent chips */}
          <div style={{ textAlign: 'center', padding: isMobile ? '32px 0 26px' : '56px 0 36px' }}>
            <div style={{ fontFamily: 'Cinzel, Georgia, serif', fontSize: isMobile ? 30 : 40, fontWeight: 700, letterSpacing: '0.2em', color: F.gold, lineHeight: 1 }}>ALPHATAPE</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 14 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: session.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${session.color} 20%, transparent)`, flexShrink: 0 }} />
              <span style={{ fontFamily: F.sans, fontSize: 12.5, color: F.sec, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{dateLabel} · {session.label}</span>
              {/* Re-open morning brief anytime (daily banner still fires on first visit). */}
              {!ql && (
                <button
                  type="button"
                  onClick={() => setBriefOpen(true)}
                  title="Morning brief"
                  aria-label="Open morning brief"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, padding: 0, cursor: 'pointer',
                    background: briefOpen
                      ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)'
                      : 'transparent',
                    border: `1px solid ${briefOpen
                      ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)'
                      : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 28%, transparent)'}`,
                    color: F.gold, borderRadius: 4,
                  }}
                >
                  <Sunrise size={15} strokeWidth={1.75} />
                </button>
              )}
            </div>

            {/* Always mounted so brief data prefetches in the background on Home. */}
            <MorningBrief
              sessionLabel={session.label}
              dateLabel={dateLabel}
              portfolioName={hasPM ? pm.name : undefined}
              positions={priced.map(p => ({
                ticker: p.ticker,
                shares: p.shares,
                value: p.value,
                cost: p.cost,
                pnl: p.pnl,
                pnlPct: p.pnlPct,
                dayPnl: p.dayPnl,
                pct1d: p.pct1d,
                price: p.price,
              }))}
              cash={pm.cash}
              isMobile={isMobile}
              open={briefOpen}
              onOpenChange={setBriefOpen}
              suppressUi={!!ql}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 640, margin: '26px auto 0', borderBottom: `1px solid ${searchFocus ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 70%, transparent)' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)'}`, padding: '12px 4px', transition: 'border-color 0.15s ease' }}>
              <Search size={17} style={{ color: F.gold, flexShrink: 0 }} />
              <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={onSearchKey} onFocus={() => setSearchFocus(true)} onBlur={() => setSearchFocus(false)} aria-label="Search tickers or tools" placeholder="Search tickers or tools" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: F.text, fontFamily: F.sans, fontSize: 16 }} />
              {q
                ? <button onClick={() => setQ('')} aria-label="Clear" style={{ background: 'none', border: 'none', cursor: 'pointer', color: F.muted, display: 'flex', padding: 0 }}><X size={14} /></button>
                : <ShortcutKey />}
            </div>
            {!ql && recentTickers.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 18, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F.sans, fontSize: 10, fontWeight: 400, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.muted }}>Recent</span>
                {recentTickers.slice(0, 5).map(t => (
                  <button key={t} onClick={() => setQ(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: F.mono, fontSize: 12, color: F.sec, letterSpacing: '0.04em' }}>{t}</button>
                ))}
              </div>
            )}
          </div>

          {/* search results override the overview + hubs */}
          {ql ? (
            <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {dashSym && (
                <div>
                  <SectionLabel icon={TrendingUp} label={`Ticker · ${dashSym}`} />
                  <TickerDashboard sym={dashSym} />
                  <TickerJumpTiles sym={dashSym} isMobile={isMobile} />
                </div>
              )}
              {otherCompanies.length > 0 && (
                <div>
                  <SectionLabel icon={Building2} label={dashSym ? 'Other companies' : 'Companies'} count={otherCompanies.length} />
                  <ResultGrid>
                    {otherCompanies.map(c => <ResultTile key={c.ticker} icon={Building2} title={`${c.ticker} · ${c.name}`} sub="View ticker dashboard" onClick={() => setQ(c.ticker)} />)}
                  </ResultGrid>
                </div>
              )}
              {filtered.length > 0 && (
                <div>
                  <SectionLabel icon={Search} label="Tools" count={filtered.length} />
                  <ResultGrid>
                    {filtered.map((t, i) => <ResultTile key={t.route} icon={t.icon} title={t.title} sub={t.desc} selected={selIdx === i} onClick={() => navigate(t.route)} />)}
                  </ResultGrid>
                </div>
              )}
              {actionResults.length > 0 && (
                <div>
                  <SectionLabel icon={Zap} label="Actions" />
                  <ResultGrid>
                    {actionResults.map((r, j) => <ResultTile key={r.key} icon={r.icon} title={r.title} sub={r.sub} selected={selIdx === filtered.length + j} onClick={() => navigate(r.route)} />)}
                  </ResultGrid>
                </div>
              )}
              {searching && companyResults.length === 0 && filtered.length === 0 && actionResults.length === 0 && (
                <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: F.sans, fontSize: 12, color: F.muted }}>
                  Searching…
                </div>
              )}
              {intentHits.length > 0 && filtered.length === 0 && actionResults.length === 0 && (
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontFamily: F.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.muted, padding: '10px 2px 6px' }}>Go to</div>
                  {intentHits.map(hit => (
                    <button key={hit.route} onClick={() => navigate(intentUrl(hit))}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '9px 2px' }}>
                      <span style={{ fontFamily: F.sans, fontSize: 14, color: F.text }}>{hit.title}</span>
                      {hit.ticker && <span style={{ fontFamily: F.mono, fontSize: 11, color: F.gold }}>{hit.ticker}</span>}
                    </button>
                  ))}
                </div>
              )}
              {noResults && !searching && (
                <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: F.sans, fontSize: 12, color: F.sec }}>
                  Nothing matches <span style={{ color: F.text, fontFamily: F.mono }}>{q}</span>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* ── Overview: 3-column divided region ── */}
              <SectionLabel icon={LayoutGrid} label="Overview" note={`as of ${localStamp} ${localTimeZone()}`} />
              <div style={{ display: 'grid', gridTemplateColumns: overviewCols }}>
                {/* Column 1 — Portfolio + Holdings */}
                <div style={{ padding: isMobile ? '20px 0' : '4px 34px 4px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={cap}>Portfolio</span>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {RANGES.map((r, idx) => (
                        <button key={r.label} onClick={() => setRangeIdx(idx)} style={{ fontFamily: F.mono, fontSize: 9, padding: '2px 6px', cursor: 'pointer', background: 'none', color: idx === rangeIdx ? F.gold : F.muted, border: `1px solid ${idx === rangeIdx ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)' : 'transparent'}` }}>{r.label}</button>
                      ))}
                    </div>
                  </div>
                  {hasPM ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 10 }}>
                        <span style={{ fontFamily: F.mono, fontSize: 34, fontWeight: 700, color: F.bright, fontVariantNumeric: 'tabular-nums', letterSpacing: 'var(--theme-num-tracking, normal)' }}>{money(totalValue)}</span>
                        <span style={{ fontFamily: F.mono, fontSize: 13, color: dayPnl >= 0 ? F.pos : F.neg }}>{dayPct >= 0 ? '↑' : '↓'} {Math.abs(dayPct).toFixed(2)}%</span>
                      </div>
                      <div style={{ marginTop: 12, height: 80 }}>
                        <PerformanceSpark tickers={perfTickers} weights={perfWeights} rangeIdx={rangeIdx} />
                      </div>
                      <div style={{ display: 'flex', gap: 28, marginTop: 12 }}>
                        <MiniStat label="Invested" value={money(totalValue - pm.cash)} />
                        <MiniStat label="Positions" value={String(priced.length)} />
                        <MiniStat label="Cash" value={money(pm.cash)} />
                      </div>
                      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${F.borderFaint}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={cap}>Holdings · {priced.length}</span>
                        <button onClick={() => navigate('/portfolio-manager')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: F.sans, fontSize: 11, color: F.gold }}>Manage →</button>
                      </div>
                      {holdingRows.map(h => (
                        <div key={h.ticker} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 0.7fr', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${F.borderFaint}` }}>
                          <span style={{ fontFamily: F.mono, fontSize: 13, fontWeight: 700, color: F.text }}>{h.ticker}</span>
                          <span style={{ fontFamily: F.mono, fontSize: 12, color: F.sec, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(h.value)}</span>
                          <span style={{ fontFamily: F.mono, fontSize: 12, color: h.pct == null ? F.muted : h.pct >= 0 ? F.pos : F.neg, textAlign: 'right' }}>{h.pct != null ? `${h.pct >= 0 ? '+' : ''}${h.pct.toFixed(1)}%` : '—'}</span>
                        </div>
                      ))}
                      {priced.length > holdingRows.length && (
                        <button onClick={() => navigate('/portfolio-manager')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 0 0', fontFamily: F.sans, fontSize: 11.5, color: F.gold }}>View all {priced.length} →</button>
                      )}
                    </>
                  ) : (
                    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
                      <div style={{ fontFamily: F.sans, fontSize: 12.5, color: F.sec, lineHeight: 1.55, maxWidth: 260 }}>Track live value, day P&amp;L, and holdings here. Add positions in the Portfolio Manager.</div>
                      <button onClick={() => navigate('/portfolio-manager')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)`, color: F.gold, fontFamily: F.sans, fontSize: 12, padding: '9px 14px', cursor: 'pointer' }}>
                        <Briefcase size={13} /> Open Portfolio Manager
                      </button>
                    </div>
                  )}
                </div>

                {/* Column 2 — Since you left / Movers / This week */}
                <div style={{ padding: isMobile ? '20px 0' : '4px 34px', borderLeft: isMobile ? 'none' : `1px solid ${F.border}`, borderTop: isMobile ? `1px solid ${F.border}` : 'none', display: 'flex', flexDirection: 'column', gap: 22 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <Clock size={11} style={{ color: F.gold }} />
                      <span style={{ fontFamily: F.sans, fontSize: 10, fontWeight: 400, letterSpacing: '0.16em', textTransform: 'uppercase', color: F.gold }}>Since you left</span>
                    </div>
                    <div style={{ fontFamily: F.sans, fontSize: 13.5, lineHeight: 1.62, color: F.text }}>
                      {hasPM && best ? (() => {
                        // Lead with the name driving the book its way, then the counterweight
                        // if it's actually pulling the other direction.
                        const up = dayPct >= 0
                        const w = worst ?? best
                        const fmtPctv = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
                        const chip = (m: typeof best) => <b style={{ color: m.pct1d >= 0 ? F.pos : F.neg }}>{m.ticker} {fmtPctv(m.pct1d)}</b>
                        const driver = up ? best : w
                        const counter = up ? w : best
                        const counterMatters = driver.ticker !== counter.ticker && (up ? counter.pct1d < 0 : counter.pct1d > 0)
                        return (
                          <>Book {up ? 'up' : 'down'} <b style={{ color: up ? F.pos : F.neg }}>{Math.abs(dayPct).toFixed(2)}%</b>, {up ? 'led' : 'dragged'} by {chip(driver)}
                            {counterMatters ? <>, though {chip(counter)} {up ? 'lagged' : 'held up'}.</> : '.'}</>
                        )
                      })() : (
                        <>Markets update live. Add holdings to get a personalized since-you-left brief on your book each session.</>
                      )}
                    </div>
                  </div>

                  {moversTop.length > 0 && (
                    <div>
                      <span style={cap}>Movers</span>
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
                        {moversTop.map(m => (
                          <div key={m.ticker} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{ fontFamily: F.mono, fontSize: 11.5, color: F.text, width: 46, flex: 'none' }}>{m.ticker}</span>
                            <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.round(m.mag * 100)}%`, height: '100%', background: m.pct >= 0 ? F.pos : F.neg, opacity: 0.85 }} />
                            </div>
                            <span style={{ fontFamily: F.mono, fontSize: 11.5, color: m.pct >= 0 ? F.pos : F.neg, width: 52, textAlign: 'right', flex: 'none' }}>{m.pct >= 0 ? '+' : ''}{m.pct.toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <ThisWeek holdings={holdingTickers} onOpen={() => navigate('/earnings')} />
                </div>

                {/* Column 3 — 24-hour dial */}
                <div style={{ padding: isMobile ? '24px 0 8px' : '4px 0 4px 34px', borderLeft: isMobile ? 'none' : `1px solid ${F.border}`, borderTop: isMobile ? `1px solid ${F.border}` : 'none' }}>
                  <MarketClockMini />
                </div>
              </div>

              {/* ── Jump Back In ── */}
              {recents.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 22, borderTop: `1px solid ${F.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Clock size={11} style={{ color: F.muted }} />
                    <span style={{ fontFamily: F.sans, fontSize: 10, fontWeight: 400, letterSpacing: '0.18em', textTransform: 'uppercase', color: F.muted }}>Jump Back In</span>
                  </div>
                  <div style={{ height: 8 }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {recents.map(r => <JumpItem key={r.route} icon={r.icon} title={r.title} onClick={() => navigate(r.route)} />)}
                  </div>
                </div>
              )}

              {/* ── Hubs ledger ── */}
              <div style={{ marginTop: 30 }}>
                <SectionLabel icon={LayoutGrid} label="Hubs" note={`${HUBS.length} workspaces · ${ALL_TOOLS.length} tools`} />
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', columnGap: 56 }}>
                  {HUBS.map((h, i) => <HubLedgerCell key={h.slug} slug={h.slug} last={i >= HUBS.length - (isMobile ? 1 : HUBS.length % 2 === 0 ? 2 : 1)} onNav={navigate} />)}
                </div>
              </div>

              <div style={{ marginTop: 28 }}>
                <PortfolioImportStrip />
              </div>
            </>
          )}
        </div>
      </div>
    </PageWrapper>
  )
}

// Bounded outline link (no fill) for the Jump Back In row.
function JumpItem({ icon: Icon, title, onClick }: { icon: React.ElementType; title: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 9, padding: '9px 15px', cursor: 'pointer', background: 'none',
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 50%, transparent)' : 'rgba(255,255,255,0.12)'}`,
        transition: 'border-color 0.14s ease, color 0.14s ease',
      }}>
      <Icon size={15} style={{ color: F.gold, flexShrink: 0 }} />
      <span style={{ fontFamily: F.sans, fontSize: 13.5, fontWeight: 400, color: hover ? F.bright : F.sec, whiteSpace: 'nowrap' }}>{title}</span>
    </button>
  )
}

const DAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

// This-week calendar: the user's holdings' earnings (HELD) merged with the
// macro/economic calendar (MACRO), chronological. Best-effort — either feed can
// be unavailable; falls back gracefully.
interface WeekRow { date: string; day: string; time?: string; event: string; tag: 'HELD' | 'MACRO'; prio: number }
function ThisWeek({ holdings, onOpen }: { holdings: string[]; onOpen: () => void }) {
  const today = useMemo(() => todayLocal(), [])
  const earn = useQuery<{ rows: { symbol: string; date: string; hour?: string }[] }>({
    queryKey: ['home-earn', today],
    queryFn: () => axios.get(`/api/earnings/calendar?date=${today}&days=7`).then(r => r.data),
    staleTime: 30 * 60 * 1000, retry: 0,
  })
  const macro = useQuery<{ events: { date: string; label: string; importance: 'high' | 'medium'; time_et?: string; category?: string }[] }>({
    queryKey: ['home-macro'],
    queryFn: () => axios.get('/api/rates/macro-calendar').then(r => r.data),
    staleTime: 30 * 60 * 1000, retry: 0,
  })
  const held = useMemo(() => new Set(holdings.map(h => h.toUpperCase())), [holdings])
  const rows = useMemo<WeekRow[]>(() => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const within = (d: string) => {
      const days = Math.round((new Date(d + 'T12:00:00').getTime() - midnight.getTime()) / 86400000)
      return days >= 0 && days <= 7
    }
    const dayOf = (d: string) => DAY_ABBR[new Date(d + 'T12:00:00').getDay()]
    const earnTime = (h?: string) => h === 'bmo' ? 'BMO' : h === 'amc' ? 'AMC' : undefined
    const out: WeekRow[] = []
    for (const r of earn.data?.rows ?? [])
      if (r.date && held.has((r.symbol || '').toUpperCase()) && within(r.date)) out.push({ date: r.date, day: dayOf(r.date), time: earnTime(r.hour), event: `${r.symbol} earnings`, tag: 'HELD', prio: 0 })
    for (const e of macro.data?.events ?? [])
      // prio: your earnings (0) > Fed/monetary incl. FOMC minutes (1) > other
      // high-importance prints (2) > medium (3). Drives which survive the cap.
      if (e.date && within(e.date)) out.push({ date: e.date, day: dayOf(e.date), time: e.time_et ? `${e.time_et} ET` : undefined, event: e.label, tag: 'MACRO', prio: e.category === 'monetary' ? 1 : e.importance === 'high' ? 2 : 3 })
    // Keep the 6 most important (so a marquee event is never crowded out by routine
    // daily releases), then show those chronologically (HELD before MACRO same day).
    const byDate = (a: WeekRow, b: WeekRow) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.prio - b.prio
    return [...out].sort((a, b) => a.prio - b.prio || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 6).sort(byDate)
  }, [earn.data, macro.data, held])
  return (
    <div>
      <span style={cap}>This week</span>
      {rows.length > 0 ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 11 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: F.sans, fontSize: 13 }}>
              <span style={{ fontFamily: F.mono, color: F.gold, width: 34, flex: 'none' }}>{r.day}</span>
              <span style={{ color: F.sec, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.event}</span>
              {r.time && <span style={{ fontFamily: F.mono, fontSize: 10, color: F.muted, flex: 'none' }}>{r.time}</span>}
              <span style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: '0.08em', color: r.tag === 'HELD' ? F.gold : F.muted, flex: 'none' }}>{r.tag}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 10, fontFamily: F.sans, fontSize: 12, color: F.muted, lineHeight: 1.5 }}>
          Nothing scheduled this week.{' '}
          <button onClick={onOpen} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: F.sans, fontSize: 12, color: F.gold }}>Open calendar →</button>
        </div>
      )}
    </div>
  )
}

// Hubs ledger cell — header/subheader → hairline → clickable tool tags (tileless).
function HubLedgerCell({ slug, last, onNav }: { slug: string; last: boolean; onNav: (route: string) => void }) {
  const hub = HUBS.find(h => h.slug === slug)!
  return (
    <div style={{ padding: '26px 0', borderBottom: last ? 'none' : `1px solid ${F.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: F.sans, fontSize: 22, fontWeight: 400, color: F.bright }}>{hub.label}</span>
        <span style={{ fontFamily: F.mono, fontSize: 12, color: F.muted }}>{hub.tools.length}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => onNav(`/hub/${hub.slug}`)} aria-label={`Open ${hub.label} hub`} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: F.gold, display: 'flex' }}>
          <ArrowUpRight size={16} />
        </button>
      </div>
      <div style={{ fontFamily: F.sans, fontSize: 14, color: F.sec, marginTop: 6 }}>{hub.tagline}</div>
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${F.borderFaint}`, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {hub.tools.map(t => (
          <button key={t.route} onClick={() => onNav(t.route)}
            onMouseEnter={e => { e.currentTarget.style.color = F.bright; e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)'; e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)' }}
            onMouseLeave={e => { e.currentTarget.style.color = F.sec; e.currentTarget.style.borderColor = F.border; e.currentTarget.style.background = 'transparent' }}
            style={{ background: 'transparent', border: `1px solid ${F.border}`, borderRadius: 3, cursor: 'pointer', padding: '4px 10px', fontFamily: F.sans, fontSize: 13, color: F.sec, transition: 'color 0.12s ease, border-color 0.12s ease, background 0.12s ease' }}>
            {t.chip}
          </button>
        ))}
      </div>
    </div>
  )
}
