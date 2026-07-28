import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowUpDown, Bell, CalendarDays, ChevronRight, Crosshair,
  ExternalLink, Gauge, Globe2, Landmark, Layers, Moon, Newspaper, Target, TrendingDown, X,
} from 'lucide-react'
import { hasSeenMorningBriefToday, markMorningBriefSeenToday } from '../lib/morningBrief'
import {
  buildBookInsights, daysUntil, type BriefPosition,
} from '../lib/morningBriefInsights'
import {
  buildOvernightUniverse, crossedGammaFlip, earningsCause, sortByAbsMove,
  type EarningsCause, type OvernightRow,
} from '../lib/overnightMoves'
import { readWatchlist } from '../lib/watchlist'
import { useTheme } from '../contexts/ThemeContext'

const F = {
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  bright: 'var(--theme-text, #dce3ed)',
  sec: 'var(--theme-secondary, #8099b0)',
  muted: 'var(--theme-secondary, #5e768f)',
  surface: 'var(--theme-surface, #101c2e)',
  panel: 'color-mix(in srgb, var(--theme-bg, #0d1826) 55%, var(--theme-surface, #101c2e))',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  sans: 'var(--theme-sans)',
  mono: 'var(--theme-mono)',
}

const DAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`
const pctStr = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`

/** Shared row grids — fixed trailing cols so $ / % / labels stay flush-right. */
const ROW = {
  attr: '56px minmax(0, 1fr) 68px 52px',
  conc: '56px minmax(0, 1fr) 36px 72px',
  /** Name | unrealized $ | unrealized % | recovery % — four fixed tracks, no jammed cells. */
  under: '56px minmax(72px, 1fr) 64px 72px',
  /** Day | Name | Wt% | When — When is a fixed track wide enough for the longest
   * "tomorrow HH:MM ET" so the nowrap time never spills past the panel edge. */
  earn: 'minmax(0, 0.9fr) minmax(0, 1.15fr) minmax(0, 0.85fr) 128px',
  /** Day | Event | Tag | When — fixed When track (same reason as earn). */
  macro: 'minmax(0, 0.7fr) minmax(0, 1.6fr) minmax(0, 0.75fr) 128px',
  news: '56px minmax(0, 1fr) 18px',
  /** Name | Signal (cause / crossed-flip) | Prior | Now | Chg % */
  overnight: '58px minmax(0, 1fr) 62px 62px 56px',
} as const

const SESSION_LABEL: Record<string, string> = {
  'pre-market': 'Pre-market', 'regular': 'Regular session', 'after-hours': 'After-hours',
  'closed': 'Market closed', 'weekend': 'Weekend',
}

function overnightCauseLabel(c: EarningsCause): string {
  switch (c.kind) {
    case 'reported-amc-yesterday': return 'Reported AMC yesterday'
    case 'reports-bmo-today': return 'Reports BMO today'
    case 'reports-amc-today': return 'Reports AMC today'
    case 'reports-soon': return `Reports in ${c.days}d`
  }
}

export interface MorningBriefProps {
  sessionLabel: string
  dateLabel: string
  portfolioName?: string
  positions: BriefPosition[]
  cash: number
  isMobile?: boolean
  /** Controlled open state (e.g. sunrise re-access button on Home). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Hide daily banner UI (e.g. while Home search is open) but keep prefetching. */
  suppressUi?: boolean
}

interface HeldEarn {
  symbol: string
  date: string
  day: string
  time?: string
  days: number
  weight: number
}

interface GlobalBoardRow {
  label: string
  symbol: string
  is_cme_proxy: boolean
  price: number | null
  change_pct: number | null
}

interface OvernightMovesResponse {
  session: string
  indicative: boolean
  rows: { ticker: string; prior_close: number | null; last: number | null; change_pct: number | null }[]
}

interface OptionPosition {
  underlying: string
  expiry: string
  type: string
  strike: number
  quantity: number
}

interface AggGreeksNet {
  delta: number
  gamma: number
  theta: number
  vega: number
}

interface NewsItem {
  ticker: string
  title: string
  link: string
  publisher: string
  pubDate: string
}

interface MarketNewsItem {
  title: string
  link: string
  source: string
  ageLabel: string
  sentiment?: string
}

function normalizeNews(raw: unknown, ticker: string): NewsItem[] {
  if (!Array.isArray(raw)) return []
  const out: NewsItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const content = (o.content && typeof o.content === 'object' ? o.content : null) as Record<string, unknown> | null
    const title = String(content?.title || o.title || '').trim()
    if (!title) continue
    const linkObj = content?.canonicalUrl
    const link = String(
      (linkObj && typeof linkObj === 'object' && (linkObj as { url?: string }).url)
      || o.link
      || o.url
      || '',
    )
    const provider = content?.provider
    const publisher = String(
      (provider && typeof provider === 'object' && (provider as { displayName?: string }).displayName)
      || o.publisher
      || o.source
      || '',
    )
    const pubDate = String(content?.pubDate || o.pubDate || o.providerPublishTime || '')
    out.push({ ticker, title, link, publisher, pubDate })
  }
  return out
}

function formatPubTime(raw: string): string {
  if (!raw) return ''
  const n = Number(raw)
  const d = Number.isFinite(n) && n > 1e9
    ? new Date(n > 1e12 ? n : n * 1000)
    : new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  const ageH = (Date.now() - d.getTime()) / 3600000
  if (ageH < 1) return `${Math.max(1, Math.round(ageH * 60))}m`
  if (ageH < 48) return `${Math.round(ageH)}h`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Daily Home notification + book-specific brief. Not a hub tool.
 */
export default function MorningBrief({
  sessionLabel,
  dateLabel,
  portfolioName,
  positions,
  cash,
  isMobile,
  open: openControlled,
  onOpenChange,
  suppressUi = false,
}: MorningBriefProps) {
  const navigate = useNavigate()
  const { user } = useTheme()
  const [banner, setBanner] = useState(() => !hasSeenMorningBriefToday())
  const [openInternal, setOpenInternal] = useState(false)
  const [showAllOvernight, setShowAllOvernight] = useState(false)
  const controlled = openControlled !== undefined
  const open = controlled ? openControlled : openInternal

  const setOpen = (next: boolean) => {
    if (!controlled) setOpenInternal(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    const sync = () => {
      if (hasSeenMorningBriefToday()) setBanner(false)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const dismiss = () => {
    markMorningBriefSeenToday()
    setOpen(false)
    setBanner(false)
  }

  const openBrief = () => {
    setOpen(true)
    markMorningBriefSeenToday()
    setBanner(false)
  }

  // Sunrise re-access from Home (controlled open) should clear the daily banner too.
  useEffect(() => {
    if (open) {
      markMorningBriefSeenToday()
      setBanner(false)
    }
  }, [open])

  // ── Prefetch on Home mount (not gated on open) ──────────────────────────
  const spyQ = useQuery<{ pct_change_1d?: number | null }>({
    queryKey: ['morning-brief-spy'],
    queryFn: () => axios.get('/api/market/quote/SPY').then(r => r.data),
    staleTime: 60_000,
    retry: 0,
  })

  // Watchlist read once on mount — the brief re-renders fresh each time it's opened.
  const watchlistTickers = useMemo(() => readWatchlist(), [])
  const overnightUniverse = useMemo(
    () => buildOvernightUniverse(positions.map(p => p.ticker), watchlistTickers),
    [positions, watchlistTickers],
  )

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  // Unfiltered market calendar — held-name filtering happens client-side, so the
  // same fetch also drives overnight cause-tagging for watchlist-only names.
  const earn = useQuery<{ rows: { symbol: string; date: string; hour?: string }[] }>({
    queryKey: ['morning-brief-earn', today],
    queryFn: () => axios.get(`/api/earnings/calendar?date=${today}&days=14`).then(r => r.data),
    enabled: overnightUniverse.length > 0,
    staleTime: 30 * 60 * 1000,
    retry: 0,
  })

  // Single source of truth with the Macro Event Hub (/macro-events): same feed,
  // same events, so a name never shows in one surface and not the other.
  const macro = useQuery<{
    events: { datetime: string; name: string; impact: 'High' | 'Medium' | 'Low'; category?: string; region?: string; status?: string }[]
  }>({
    queryKey: ['morning-brief-macro', today],
    queryFn: () => axios.get('/api/macro-events').then(r => r.data),
    staleTime: 30 * 60 * 1000,
    retry: 0,
  })

  const token = typeof window !== 'undefined' ? (localStorage.getItem('ft-session-token') || '') : ''
  const alerts = useQuery<{ alerts: { id: string; ticker?: string; symbol?: string; condition?: string; threshold?: number; note?: string; message?: string }[] }>({
    queryKey: ['morning-brief-alerts', user?.id],
    queryFn: () => axios.get(`/api/alerts/${user!.id}`, {
      headers: token ? { Authorization: `Bearer ${token}`, 'x-session-token': token } : {},
    }).then(r => r.data),
    enabled: !!user?.id,
    staleTime: 60_000,
    retry: 0,
  })

  // Overnight section — index/futures context, book+watchlist gap scan, and the
  // paper-trading book's aggregate options greeks (the only persisted options
  // book of record; there's no live broker feed to draw a real one from).
  const globalBoard = useQuery<{ sections: { name: string; rows: GlobalBoardRow[] }[] }>({
    queryKey: ['morning-brief-global-board'],
    queryFn: () => axios.get('/api/market/global-board?window=1d').then(r => r.data),
    staleTime: 2 * 60 * 1000,
    retry: 0,
  })

  const overnight = useQuery<OvernightMovesResponse>({
    queryKey: ['morning-brief-overnight', overnightUniverse.join(',')],
    queryFn: () => axios.get(`/api/market/overnight-moves?tickers=${encodeURIComponent(overnightUniverse.join(','))}`).then(r => r.data),
    enabled: overnightUniverse.length > 0,
    staleTime: 20_000,
    retry: 0,
  })

  const paperAccount = useQuery<{ option_positions: OptionPosition[] }>({
    queryKey: ['morning-brief-paper-account', user?.id],
    queryFn: () => axios.get(`/api/paper/account?user_id=${user!.id}`, {
      headers: token ? { Authorization: `Bearer ${token}`, 'x-session-token': token } : {},
    }).then(r => r.data),
    enabled: !!user?.id,
    staleTime: 60_000,
    retry: 0,
  })

  const optionPositionsForGreeks = useMemo(() => (paperAccount.data?.option_positions ?? []).map(p => ({
    ticker: p.underlying,
    strike: p.strike,
    expiry: p.expiry,
    qty: Math.abs(p.quantity),
    option_type: p.type,
    position_type: p.quantity >= 0 ? 'long' : 'short',
  })), [paperAccount.data])

  const aggGreeks = useQuery<{ net: AggGreeksNet }>({
    queryKey: ['morning-brief-agg-greeks', optionPositionsForGreeks],
    queryFn: () => axios.post('/api/options/aggregate-greeks', { positions: optionPositionsForGreeks }).then(r => r.data),
    enabled: optionPositionsForGreeks.length > 0,
    staleTime: 60_000,
    retry: 0,
  })

  const insights = useMemo(
    () => buildBookInsights(positions, cash, spyQ.data?.pct_change_1d ?? null),
    [positions, cash, spyQ.data?.pct_change_1d],
  )

  // Book news: one headline per top weight (max 5 names) — prefetch while Home is open.
  const newsTickers = useMemo(
    () => insights.concentration.slice(0, 5).map(c => c.ticker),
    [insights.concentration],
  )
  const newsQueries = useQueries({
    queries: newsTickers.map(t => ({
      queryKey: ['morning-brief-news', t],
      queryFn: () => axios.get(`/api/market/news?ticker=${encodeURIComponent(t)}`).then(r => r.data),
      enabled: !!t,
      staleTime: 15 * 60 * 1000,
      retry: 0,
    })),
  })

  const newsItems = useMemo(() => {
    const merged: NewsItem[] = []
    newsTickers.forEach((t, i) => {
      const payload = newsQueries[i]?.data
      const raw = payload?.news ?? payload
      const one = normalizeNews(raw, t)[0]
      if (one) merged.push(one)
    })
    const seen = new Set<string>()
    return merged.filter(n => {
      const k = n.title.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }, [newsTickers, newsQueries])

  // Market wire + SPY news in parallel (no sequential waterfall).
  const marketWire = useQuery<{
    breaking?: { text: string; url?: string; source_label?: string; published_at?: number; age_hours?: number; sentiment?: string }[]
    sources?: { label: string; items?: { text: string; url?: string; published_at?: number; age_hours?: number; sentiment?: string }[] }[]
  }>({
    queryKey: ['morning-brief-market-wire'],
    queryFn: () => axios.get('/api/sentiment/snapshot?timeframe_hours=24').then(r => r.data),
    staleTime: 10 * 60 * 1000,
    retry: 0,
  })

  const spyNewsFallback = useQuery<{ news?: unknown }>({
    queryKey: ['morning-brief-spy-news'],
    queryFn: () => axios.get('/api/market/news?ticker=SPY').then(r => r.data),
    staleTime: 15 * 60 * 1000,
    retry: 0,
  })

  const marketNews = useMemo(() => {
    const bookTitles = new Set(newsItems.map(n => n.title.toLowerCase()))
    const out: MarketNewsItem[] = []
    const push = (title: string, link: string, source: string, ageLabel: string, sentiment?: string) => {
      const t = title.trim()
      if (!t || bookTitles.has(t.toLowerCase())) return
      if (out.some(x => x.title.toLowerCase() === t.toLowerCase())) return
      out.push({ title: t, link, source, ageLabel, sentiment })
    }

    for (const b of marketWire.data?.breaking ?? []) {
      if (!b?.text) continue
      const age = b.age_hours != null
        ? (b.age_hours < 1 ? `${Math.max(1, Math.round(b.age_hours * 60))}m` : `${Math.round(b.age_hours)}h`)
        : (b.published_at ? formatPubTime(String(b.published_at)) : '')
      push(b.text, b.url || '', b.source_label || 'Wire', age, b.sentiment)
    }

    if (out.length < 6) {
      const pool: { text: string; url?: string; source: string; age_hours?: number; published_at?: number; sentiment?: string }[] = []
      for (const src of marketWire.data?.sources ?? []) {
        for (const it of src.items ?? []) {
          if (it?.text) pool.push({ ...it, source: src.label })
        }
      }
      pool
        .sort((a, b) => (a.age_hours ?? 99) - (b.age_hours ?? 99))
        .forEach(it => {
          if (out.length >= 8) return
          const age = it.age_hours != null
            ? (it.age_hours < 1 ? `${Math.max(1, Math.round(it.age_hours * 60))}m` : `${Math.round(it.age_hours)}h`)
            : (it.published_at ? formatPubTime(String(it.published_at)) : '')
          push(it.text, it.url || '', it.source, age, it.sentiment)
        })
    }

    if (out.length < 4) {
      for (const n of normalizeNews(spyNewsFallback.data?.news ?? spyNewsFallback.data, 'SPY')) {
        if (out.length >= 8) break
        push(n.title, n.link, n.publisher || 'Market', formatPubTime(n.pubDate))
      }
    }

    return out.slice(0, 8)
  }, [marketWire.data, spyNewsFallback.data, newsItems])

  // Whole brief ready — no partial paint of remote sections. Gamma-flip lookups
  // (below) are deliberately excluded: an uncomputed GEX snapshot can take
  // 20-40s to fill live, and a "crossed flip" badge is a nice-to-have, not
  // worth stalling the whole modal for.
  const briefReady = useMemo(() => {
    const settled = (q: { isFetched: boolean; isError: boolean; isSuccess: boolean; fetchStatus: string }) =>
      q.isFetched || q.isError || q.isSuccess
    if (!settled(spyQ)) return false
    if (overnightUniverse.length > 0 && !settled(earn)) return false
    if (!settled(macro)) return false
    if (!!user?.id && !settled(alerts)) return false
    if (!settled(marketWire)) return false
    if (!settled(spyNewsFallback)) return false
    if (newsTickers.length > 0 && newsQueries.some(q => !q.isFetched && !q.isError && !q.isSuccess)) return false
    if (!settled(globalBoard)) return false
    if (overnightUniverse.length > 0 && !settled(overnight)) return false
    if (!!user?.id && !settled(paperAccount)) return false
    if (optionPositionsForGreeks.length > 0 && !settled(aggGreeks)) return false
    return true
  }, [
    spyQ, earn, macro, alerts, marketWire, spyNewsFallback, newsTickers.length, newsQueries,
    overnightUniverse.length, user?.id, globalBoard, overnight, paperAccount, optionPositionsForGreeks.length, aggGreeks,
  ])

  const heldSet = useMemo(() => new Set(positions.map(p => p.ticker.toUpperCase())), [positions])
  const weightBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of insights.dayAttribution) m.set(a.ticker.toUpperCase(), a.weight)
    return m
  }, [insights.dayAttribution])

  const overnightIndices = useMemo(() => {
    const watch = new Set(['^GSPC', '^IXIC', '^DJI', '^RUT'])
    const americas = globalBoard.data?.sections?.find(s => s.name === 'Americas')
    return (americas?.rows ?? []).filter(r => watch.has(r.symbol))
  }, [globalBoard.data])

  const overnightRows = useMemo<OvernightRow[]>(
    () => (overnight.data?.rows ?? []).map(r => ({
      ticker: r.ticker, priorClose: r.prior_close, last: r.last, changePct: r.change_pct,
    })),
    [overnight.data],
  )
  const overnightMovers = useMemo(() => sortByAbsMove(overnightRows), [overnightRows])

  const causeByTicker = useMemo(() => {
    const rows = earn.data?.rows ?? []
    const m = new Map<string, EarningsCause>()
    for (const t of overnightUniverse) {
      const c = earningsCause(t, rows)
      if (c) m.set(t, c)
    }
    return m
  }, [earn.data, overnightUniverse])

  // Gamma-flip level per top holding, read-only against whatever's already
  // accrued (compute=false) — never triggers a live 20-40s GEX fill, so this
  // stays a lazy, non-blocking enhancement to the movers table.
  const flipTickers = useMemo(() => insights.concentration.map(c => c.ticker), [insights.concentration])
  const flipQueries = useQueries({
    queries: flipTickers.map(t => ({
      queryKey: ['morning-brief-gex-flip', t],
      queryFn: () => axios.get(`/api/snapshots/series?kind=gex&ticker=${encodeURIComponent(t)}&compute=false`).then(r => r.data),
      enabled: !!t,
      staleTime: 30 * 60 * 1000,
      retry: 0,
    })),
  })
  const flipByTicker = useMemo(() => {
    const m = new Map<string, number>()
    flipTickers.forEach((t, i) => {
      const pts = (flipQueries[i]?.data as { points?: { flip?: number }[] } | undefined)?.points ?? []
      const flip = [...pts].reverse().find(p => p.flip != null)?.flip
      if (flip != null) m.set(t, flip)
    })
    return m
  }, [flipTickers, flipQueries])

  const heldEarnings = useMemo<HeldEarn[]>(() => {
    const earnTime = (h?: string) => (h === 'bmo' ? 'BMO' : h === 'amc' ? 'AMC' : undefined)
    const out: HeldEarn[] = []
    for (const r of earn.data?.rows ?? []) {
      const sym = (r.symbol || '').toUpperCase()
      if (!r.date || !heldSet.has(sym)) continue
      const days = daysUntil(r.date)
      if (days < 0 || days > 14) continue
      out.push({
        symbol: sym,
        date: r.date,
        day: DAY_ABBR[new Date(r.date + 'T12:00:00').getDay()],
        time: earnTime(r.hour),
        days,
        weight: weightBy.get(sym) ?? 0,
      })
    }
    return out.sort((a, b) => a.days - b.days || b.weight - a.weight).slice(0, 6)
  }, [earn.data, heldSet, weightBy])

  type MacroRow = { date: string; day: string; label: string; tag: string; time?: string; prio: number; days: number }
  const macroWeek = useMemo<MacroRow[]>(() => {
    // De-dupe by metric (an event can appear as both a just-released and an
    // upcoming occurrence within the week); keep the soonest.
    const byLabel = new Map<string, MacroRow>()
    for (const e of macro.data?.events ?? []) {
      const date = (e.datetime || '').slice(0, 10)
      if (!date) continue
      if ((e.region || 'US') !== 'US') continue          // the brief is a US-desk snapshot
      const days = daysUntil(date)
      if (days < 0 || days > 7) continue
      // Fed decisions or high-impact prints only; skip routine medium/low.
      const isFed = e.category === 'Central Bank'
      const isHigh = e.impact === 'High'
      if (!isFed && !isHigh) continue
      const label = e.name.replace(/\s*\([^)]*\)\s*$/, '')  // drop the "(May 2026)" period suffix
      const time = (e.datetime || '').slice(11, 16)          // "10:00"
      const row: MacroRow = {
        date, day: DAY_ABBR[new Date(date + 'T12:00:00').getDay()], label,
        tag: isFed ? 'FED' : 'HIGH', time: time ? `${time} ET` : undefined,
        prio: isFed ? 0 : 1, days,
      }
      const ex = byLabel.get(label)
      if (!ex || row.days < ex.days) byLabel.set(label, row)
    }
    return [...byLabel.values()]
      .sort((a, b) => a.date.localeCompare(b.date) || a.prio - b.prio)
      .slice(0, 6)
  }, [macro.data])

  const bookAlerts = useMemo(() => {
    const rows = alerts.data?.alerts ?? []
    return rows.filter(a => {
      const t = (a.ticker || a.symbol || '').toUpperCase()
      return t && heldSet.has(t)
    }).slice(0, 5)
  }, [alerts.data, heldSet])

  const teaser = useMemo(() => {
    if (!positions.length) return `${sessionLabel} · set holdings for a book brief`
    const top = insights.dayAttribution[0]
    if (top && Math.abs(top.dayPnl) >= 1) {
      return `${top.ticker} ${money(top.dayPnl)} day P&L · book ${pctStr(insights.dayPct, 2)}`
    }
    return `Book ${pctStr(insights.dayPct, 2)} · ${insights.breadth.up}↑ ${insights.breadth.down}↓`
  }, [positions.length, insights, sessionLabel])

  const attr = insights.dayAttribution.slice(0, 6)
  const maxAbsDay = Math.max(1, ...attr.map(a => Math.abs(a.dayPnl)))
  const wide = !isMobile
  const panelMax = isMobile ? '100%' : 780

  // Keep mounted for background prefetch even when nothing is visible.
  const showBanner = banner && !open && !suppressUi
  if (!showBanner && !open) return null

  return (
    <>
      {showBanner && (
        <div style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
          <div
            role="status"
            style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              marginTop: isMobile ? 14 : 18, padding: '11px 14px',
              border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)`,
              background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)',
              textAlign: 'left',
            }}
          >
            <Bell size={14} style={{ color: F.gold, flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: '1 1 200px' }}>
              <div style={{
                fontFamily: F.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', color: F.gold,
              }}>
                Morning brief{portfolioName ? ` · ${portfolioName}` : ''}
              </div>
              <div style={{
                fontFamily: F.sans, fontSize: 12.5, color: F.sec, marginTop: 2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {teaser}
              </div>
            </div>
            <button
              type="button"
              onClick={openBrief}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: F.gold, border: 'none', color: 'var(--theme-bg, #101c2e)',
                fontFamily: F.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase', padding: '7px 12px', cursor: 'pointer', flexShrink: 0,
              }}
            >
              Open <ChevronRight size={13} />
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss morning brief for today"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: F.muted, display: 'flex', padding: 4 }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Morning brief"
          style={{
            position: 'fixed', inset: 0, zIndex: 80,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: isMobile ? '36px 10px 24px' : '48px 24px 36px',
            background: 'rgba(0,0,0,0.58)', overflowY: 'auto',
          }}
          onClick={e => { if (e.target === e.currentTarget) dismiss() }}
        >
          <div
            style={{
              width: '100%', maxWidth: panelMax, background: F.surface,
              border: `1px solid ${F.border}`, boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
              textAlign: 'left', overflowX: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <header style={{
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
              gap: 16, padding: wide ? '18px 24px 14px' : '16px 16px 12px',
              borderBottom: `1px solid ${F.border}`,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontFamily: F.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em',
                  textTransform: 'uppercase', color: F.gold,
                }}>
                  Morning brief{portfolioName ? ` · ${portfolioName}` : ''}
                </div>
                <div style={{ fontFamily: F.sans, fontSize: 13, color: F.sec, marginTop: 5 }}>
                  {dateLabel} · {sessionLabel}
                  {insights.equityValue > 0 && (
                    <span style={{ color: F.muted }}> · equity {money(insights.equityValue)}</span>
                  )}
                </div>
              </div>
              <button type="button" onClick={dismiss} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: F.muted, display: 'flex', padding: 4, flexShrink: 0 }}>
                <X size={16} />
              </button>
            </header>

            <div style={{
              padding: wide ? '20px 24px 22px' : '16px 16px 18px',
              display: 'flex', flexDirection: 'column', gap: wide ? 22 : 18,
            }}>
              {!briefReady ? (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    minHeight: 220, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 12, padding: '48px 20px',
                  }}
                >
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    border: `2px solid ${F.border}`,
                    borderTopColor: F.gold,
                    animation: 'mb-spin 0.7s linear infinite',
                  }} />
                  <style>{`@keyframes mb-spin{to{transform:rotate(360deg)}}`}</style>
                  <div style={{
                    fontFamily: F.sans, fontSize: 13, color: F.sec, letterSpacing: '0.02em',
                  }}>
                    Preparing morning brief…
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 10, color: F.muted }}>
                    Book · earnings · macro · news · wire
                  </div>
                </div>
              ) : (
              <>
              {/* Lead — hierarchy: kicker → headline → takeaways */}
              <section>
                <div style={{
                  fontFamily: F.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
                  textTransform: 'uppercase', color: F.muted, marginBottom: 8,
                }}>
                  Session read
                </div>
                <p style={{
                  margin: 0, fontFamily: F.sans, fontSize: wide ? 18 : 15.5, lineHeight: 1.3,
                  color: F.bright, fontWeight: 600, textAlign: 'left', letterSpacing: '-0.015em',
                }}>
                  {insights.headline}
                </p>
                {insights.takeaways.length > 0 && (
                  <ul style={{
                    margin: '14px 0 0', padding: '12px 0 0', listStyle: 'none',
                    borderTop: `1px solid ${F.border}`,
                    display: 'flex', flexDirection: 'column', gap: 8,
                  }}>
                    {insights.takeaways.map((t, i) => (
                      <li key={i} style={{
                        display: 'grid', gridTemplateColumns: '12px 1fr', gap: 10,
                        alignItems: 'start', fontFamily: F.sans, fontSize: 12.5, lineHeight: 1.4, color: F.sec,
                      }}>
                        <span style={{ color: F.muted, lineHeight: 1.4, fontSize: 11 }}>·</span>
                        <span style={{ minWidth: 0 }}>{t}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Overnight — futures/index context, book+watchlist gap scan.
                  Skipped outright on weekends: there's no tape, thin or
                  otherwise, so a flat "indicative" futures/gap readout would
                  just be noise dressed up as a signal. */}
              {overnight.data?.session !== 'weekend' && (
              <section>
                <SectionCap icon={Moon} label="Overnight" />
                <div style={{ fontFamily: F.sans, fontSize: 11, color: F.muted, marginBottom: 10 }}>
                  {overnight.data ? (SESSION_LABEL[overnight.data.session] ?? overnight.data.session) : 'Session —'}
                  {overnight.data?.indicative && (
                    <span style={{ color: F.gold }}> · indicative — thin extended-hours tape, not a confirmed print</span>
                  )}
                </div>

                {overnightIndices.length > 0 && (
                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 14,
                    paddingBottom: 12, borderBottom: `1px solid ${F.border}`,
                  }}>
                    {overnightIndices.map(row => (
                      <div key={row.symbol} style={{ minWidth: 82 }}>
                        <div style={{ fontFamily: F.sans, fontSize: 9.5, color: F.muted, letterSpacing: '0.03em' }}>
                          {row.label}{row.is_cme_proxy ? ' · fut' : ''}
                        </div>
                        <div style={{
                          fontFamily: F.mono, fontSize: 13, fontWeight: 600, marginTop: 2,
                          color: (row.change_pct ?? 0) >= 0 ? F.pos : F.neg,
                        }}>
                          {row.change_pct != null ? pctStr(row.change_pct) : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {overnightMovers.length > 0 ? (
                  <>
                    <ColHead cols={ROW.overnight} labels={['Name', 'Signal', 'Prior', 'Now', 'Chg %']} alignEnd={[2, 3, 4]} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(showAllOvernight ? overnightMovers : overnightMovers.slice(0, 6)).map(row => {
                        const cause = causeByTicker.get(row.ticker)
                        const flip = flipByTicker.get(row.ticker)
                        const crossed = crossedGammaFlip(row.priorClose, row.last, flip)
                        const signal = [cause ? overnightCauseLabel(cause) : null, crossed ? 'Crossed gamma flip' : null]
                          .filter(Boolean).join(' · ')
                        return (
                          <button
                            key={row.ticker}
                            type="button"
                            onClick={() => { dismiss(); navigate(`/company-profile?ticker=${row.ticker}`) }}
                            style={{
                              display: 'grid', gridTemplateColumns: ROW.overnight, gap: 10, alignItems: 'start',
                              background: 'none', border: 'none', cursor: 'pointer', padding: '5px 0',
                              textAlign: 'left', width: '100%',
                            }}
                          >
                            <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 600, color: F.text }}>
                              {row.ticker}
                              {!heldSet.has(row.ticker) && <span style={{ color: F.muted, fontWeight: 400 }}> WL</span>}
                            </span>
                            <span style={{ fontFamily: F.sans, fontSize: 11, color: F.muted, lineHeight: 1.35 }}>
                              {signal || '—'}
                              {crossed && <ArrowUpDown size={10} style={{ verticalAlign: -1, marginLeft: 4, color: F.gold }} />}
                            </span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 11.5, color: F.sec, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                            }}>{row.priorClose != null ? row.priorClose.toFixed(2) : '—'}</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 11.5, color: F.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                            }}>{row.last != null ? row.last.toFixed(2) : '—'}</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                              color: (row.changePct ?? 0) >= 0 ? F.pos : F.neg,
                            }}>{row.changePct != null ? pctStr(row.changePct) : '—'}</span>
                          </button>
                        )
                      })}
                    </div>
                    {overnightMovers.length > 6 && (
                      <div style={{ marginTop: 8 }}>
                        <TextLink onClick={() => setShowAllOvernight(v => !v)}>
                          {showAllOvernight ? 'Show top movers only' : `Show all ${overnightMovers.length} scanned →`}
                        </TextLink>
                      </div>
                    )}
                  </>
                ) : (
                  <EmptyLine>No overnight data for book or watchlist tickers.</EmptyLine>
                )}
              </section>
              )}

              <section>
                <SectionCap icon={Gauge} label="Your options book (paper)" />
                {optionPositionsForGreeks.length > 0 && aggGreeks.data ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                    {(['delta', 'gamma', 'theta', 'vega'] as const).map(k => (
                      <div key={k}>
                        <div style={{
                          fontFamily: F.sans, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: F.muted,
                        }}>{k}</div>
                        <div style={{
                          fontFamily: F.mono, fontSize: 14, fontWeight: 600, marginTop: 2,
                          color: aggGreeks.data!.net[k] >= 0 ? F.pos : F.neg,
                        }}>{aggGreeks.data!.net[k].toFixed(k === 'delta' ? 1 : 3)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyLine>No open option positions in the paper book.</EmptyLine>
                )}
              </section>

              {/* Two-column body on desktop */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: wide ? '1.15fr 0.95fr' : '1fr',
                gap: wide ? 28 : 18,
                alignItems: 'start',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
                  {attr.length > 0 && (
                    <section>
                      <SectionCap icon={Target} label="Who moved your book ($)" />
                      <ColHead cols={ROW.attr} labels={['Name', '', 'Day $', '%']} alignEnd={[2, 3]} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {attr.map(a => (
                          <button
                            key={a.ticker}
                            type="button"
                            onClick={() => { dismiss(); navigate(`/company-profile?ticker=${a.ticker}`) }}
                            style={{
                              display: 'grid', gridTemplateColumns: ROW.attr, alignItems: 'center', gap: 10,
                              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
                              textAlign: 'left', width: '100%',
                            }}
                          >
                            <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 600, color: F.text }}>{a.ticker}</span>
                            <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden', minWidth: 0 }}>
                              <div style={{
                                width: `${Math.round((Math.abs(a.dayPnl) / maxAbsDay) * 100)}%`,
                                height: '100%', background: a.dayPnl >= 0 ? F.pos : F.neg, opacity: 0.9,
                              }} />
                            </div>
                            <span style={{
                              fontFamily: F.mono, fontSize: 12.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                              color: a.dayPnl >= 0 ? F.pos : F.neg,
                            }}>{money(a.dayPnl)}</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                              color: F.muted,
                            }}>{pctStr(a.pct1d)}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  <section>
                    <SectionCap icon={Newspaper} label="News on your book" />
                    {positions.length === 0 ? (
                      <EmptyLine>Add holdings to pull headlines for names you own.</EmptyLine>
                    ) : newsItems.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                        {newsItems.map((n, i) => {
                          const openNews = () => {
                            if (n.link) window.open(n.link, '_blank', 'noopener,noreferrer')
                            else { dismiss(); navigate(`/company-profile?ticker=${n.ticker}`) }
                          }
                          return (
                            <button
                              key={`${n.ticker}-${i}`}
                              type="button"
                              onClick={openNews}
                              style={{
                                display: 'grid', gridTemplateColumns: ROW.news, gap: 10, alignItems: 'start',
                                background: i % 2 ? 'transparent' : 'rgba(255,255,255,0.02)',
                                border: 'none', cursor: 'pointer', padding: '8px 6px', textAlign: 'left', width: '100%',
                              }}
                            >
                              <span style={{
                                fontFamily: F.mono, fontSize: 11, fontWeight: 700, color: F.gold,
                                letterSpacing: '0.02em', paddingTop: 1,
                              }}>{n.ticker}</span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{
                                  fontFamily: F.sans, fontSize: 13, lineHeight: 1.35, color: F.bright,
                                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                }}>{n.title}</div>
                                <div style={{
                                  fontFamily: F.mono, fontSize: 10, color: F.muted, marginTop: 3,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                }}>
                                  {[n.publisher, formatPubTime(n.pubDate)].filter(Boolean).join(' · ')}
                                </div>
                              </div>
                              {n.link ? <ExternalLink size={13} style={{ color: F.muted, marginTop: 2, flexShrink: 0 }} /> : <span />}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <EmptyLine>No recent headlines for top holdings.</EmptyLine>
                    )}
                    {newsTickers.length > 0 && (
                      <div style={{ marginTop: 8, fontFamily: F.sans, fontSize: 11, color: F.muted }}>
                        One story per name · {newsTickers.join(', ')}
                      </div>
                    )}
                  </section>

                  <section>
                    <SectionCap icon={Globe2} label="Market & economy" />
                    {marketNews.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                        {marketNews.map((n, i) => (
                          <button
                            key={`mkt-${i}`}
                            type="button"
                            onClick={() => {
                              if (n.link) window.open(n.link, '_blank', 'noopener,noreferrer')
                              else { dismiss(); navigate('/sentiment') }
                            }}
                            style={{
                              display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 18px', gap: 10, alignItems: 'start',
                              background: i % 2 ? 'transparent' : 'rgba(255,255,255,0.02)',
                              border: 'none', cursor: 'pointer', padding: '8px 6px', textAlign: 'left', width: '100%',
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{
                                fontFamily: F.sans, fontSize: 13, lineHeight: 1.35, color: F.bright,
                                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                              }}>{n.title}</div>
                              <div style={{
                                fontFamily: F.mono, fontSize: 10, color: F.muted, marginTop: 3,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              }}>
                                {[n.source, n.ageLabel, n.sentiment && n.sentiment !== 'neutral' ? n.sentiment : '']
                                  .filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            {n.link
                              ? <ExternalLink size={13} style={{ color: F.muted, marginTop: 2, flexShrink: 0 }} />
                              : <span />}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <EmptyLine>
                        No wire headlines right now.{' '}
                        <TextLink onClick={() => { dismiss(); navigate('/sentiment') }}>Open sentiment →</TextLink>
                      </EmptyLine>
                    )}
                  </section>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
                  {insights.concentration.length > 0 && (
                    <section>
                      <SectionCap icon={Layers} label="Concentration" />
                      <ColHead cols={ROW.conc} labels={['Name', '', 'Wt', '5% shock']} alignEnd={[2, 3]} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {insights.concentration.map(c => (
                          <div key={c.ticker} style={{
                            display: 'grid', gridTemplateColumns: ROW.conc, gap: 8, alignItems: 'center',
                            padding: '4px 0',
                          }}>
                            <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 600, color: F.text }}>{c.ticker}</span>
                            <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden', minWidth: 0 }}>
                              <div style={{
                                width: `${Math.round(c.weight * 100)}%`, height: '100%',
                                background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 70%, transparent)',
                              }} />
                            </div>
                            <span style={{
                              fontFamily: F.mono, fontSize: 12, color: F.sec, textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                            }}>{Math.round(c.weight * 100)}%</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 11.5, color: F.muted, textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                            }}>{money(c.move5pct)}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {insights.underwater.length > 0 && (
                    <section>
                      <SectionCap icon={TrendingDown} label="Below cost" />
                      <ColHead cols={ROW.under} labels={['Name', 'P&L $', 'P&L %', 'Break-even']} alignEnd={[1, 2, 3]} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {insights.underwater.map(u => (
                          <button
                            key={u.ticker}
                            type="button"
                            onClick={() => { dismiss(); navigate(`/company-profile?ticker=${u.ticker}`) }}
                            style={{
                              display: 'grid', gridTemplateColumns: ROW.under, gap: 8, alignItems: 'center',
                              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
                              textAlign: 'left', width: '100%',
                            }}
                          >
                            <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 600, color: F.text }}>{u.ticker}</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 12.5, color: F.neg, textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                            }}>{money(u.pnl)}</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 12, color: F.muted, textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                            }}>{pctStr(u.pnlPct)}</span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 12, color: F.sec, textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                            }}>{pctStr(u.recoveryPct)}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  <section>
                    <SectionCap icon={CalendarDays} label="Earnings on your names" />
                    {positions.length === 0 ? (
                      <EmptyLine>Add holdings to map report dates onto your book.</EmptyLine>
                    ) : heldEarnings.length > 0 ? (
                      <>
                        <ColHead cols={ROW.earn} labels={['Day', 'Name', 'Weight', 'When']} alignEnd={[2, 3]} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {heldEarnings.map(e => (
                            <button
                              key={`${e.symbol}-${e.date}`}
                              type="button"
                              onClick={() => { dismiss(); navigate(`/corporate?ticker=${e.symbol}`) }}
                              style={{
                                display: 'grid', gridTemplateColumns: ROW.earn, columnGap: 10, alignItems: 'center',
                                background: 'none', border: 'none', cursor: 'pointer', padding: '5px 0',
                                textAlign: 'left', width: '100%', boxSizing: 'border-box',
                              }}
                            >
                              <span style={{ fontFamily: F.mono, color: F.gold, fontSize: 12 }}>{e.day}</span>
                              <span style={{
                                fontFamily: F.mono, fontSize: 12.5, fontWeight: 600, color: F.text,
                                overflow: 'hidden', textOverflow: 'ellipsis',
                              }}>{e.symbol}</span>
                              <span style={{
                                fontFamily: F.mono, fontSize: 12, color: F.muted, textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                              }}>
                                {e.weight > 0 ? `${Math.round(e.weight * 100)}%` : '—'}
                              </span>
                              <span style={{
                                fontFamily: F.mono, fontSize: 12, color: F.sec, textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                              }}>
                                {e.days === 0 ? 'today' : e.days === 1 ? 'tomorrow' : `${e.days}d`}
                                {e.time ? ` ${e.time}` : ''}
                              </span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <EmptyLine>No held names report in the next two weeks.</EmptyLine>
                    )}
                  </section>

                  <section>
                    <SectionCap icon={Landmark} label="Macro this week" />
                    {macroWeek.length > 0 ? (
                      <>
                        <ColHead cols={ROW.macro} labels={['Day', 'Event', 'Tag', 'When']} alignEnd={[3]} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {macroWeek.map((m, i) => (
                            <button
                              key={`${m.date}-${m.label}-${i}`}
                              type="button"
                              onClick={() => { dismiss(); navigate('/macro-events') }}
                              style={{
                                display: 'grid', gridTemplateColumns: ROW.macro, columnGap: 10, alignItems: 'center',
                                background: 'none', border: 'none', cursor: 'pointer', padding: '5px 0',
                                textAlign: 'left', width: '100%', boxSizing: 'border-box',
                              }}
                            >
                              <span style={{ fontFamily: F.mono, color: F.gold, fontSize: 12 }}>{m.day}</span>
                              <span style={{
                                fontFamily: F.sans, fontSize: 12.5, color: F.text,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>{m.label}</span>
                              <span style={{
                                fontFamily: F.mono, fontSize: 10, letterSpacing: '0.06em',
                                color: m.tag === 'FED' ? F.gold : F.muted,
                              }}>{m.tag}</span>
                              <span style={{
                                fontFamily: F.mono, fontSize: 11.5, color: F.sec, textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                              }}>
                                {m.days === 0 ? 'today' : m.days === 1 ? 'tomorrow' : `${m.days}d`}
                                {m.time ? ` ${m.time}` : ''}
                              </span>
                            </button>
                          ))}
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <TextLink onClick={() => { dismiss(); navigate('/macro-events') }}>Full macro calendar →</TextLink>
                        </div>
                      </>
                    ) : (
                      <EmptyLine>
                        No high-impact or Fed prints in the next 7 days.{' '}
                        <TextLink onClick={() => { dismiss(); navigate('/macro-events') }}>Calendar →</TextLink>
                      </EmptyLine>
                    )}
                  </section>

                  {user?.id && (
                    <section>
                      <SectionCap icon={AlertTriangle} label="Alerts on your book" />
                      {bookAlerts.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 4 }}>
                          {bookAlerts.map(a => (
                            <div key={a.id} style={{
                              display: 'grid', gridTemplateColumns: 'minmax(56px, 64px) 1fr', gap: 10,
                              fontFamily: F.sans, fontSize: 12.5, color: F.sec, lineHeight: 1.4,
                            }}>
                              <span style={{ fontFamily: F.mono, fontWeight: 600, color: F.text }}>
                                {(a.ticker || a.symbol || '').toUpperCase()}
                              </span>
                              <span style={{ minWidth: 0 }}>
                                {(a.condition || 'alert').replace(/_/g, ' ')}
                                {a.threshold != null ? ` ${a.threshold}` : ''}
                              </span>
                            </div>
                          ))}
                          <TextLink onClick={() => { dismiss(); navigate('/alerts') }}>Manage alerts →</TextLink>
                        </div>
                      ) : (
                        <EmptyLine>
                          No active alerts on held tickers.{' '}
                          <TextLink onClick={() => { dismiss(); navigate('/alerts') }}>Set one →</TextLink>
                        </EmptyLine>
                      )}
                    </section>
                  )}
                </div>
              </div>

              {!positions.length && (
                <button
                  type="button"
                  onClick={() => { dismiss(); navigate('/portfolio-manager') }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)',
                    border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)`,
                    color: F.gold, fontFamily: F.sans, fontSize: 13, fontWeight: 600,
                    padding: '12px 14px', cursor: 'pointer',
                  }}
                >
                  <Crosshair size={14} /> Open Portfolio Manager
                </button>
              )}

              <button
                type="button"
                onClick={dismiss}
                style={{
                  alignSelf: 'stretch', background: 'none', border: `1px solid ${F.border}`,
                  color: F.muted, fontFamily: F.sans, fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.1em', textTransform: 'uppercase', padding: '11px 12px', cursor: 'pointer',
                }}
              >
                Got it · hide until tomorrow
              </button>
              </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function SectionCap({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8,
      paddingBottom: 6, borderBottom: `1px solid ${F.border}`,
    }}>
      <Icon size={12} style={{ color: F.gold, flexShrink: 0 }} />
      <span style={{
        fontFamily: F.sans, fontSize: 10, fontWeight: 600, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: F.gold,
      }}>{label}</span>
    </div>
  )
}

function ColHead({
  cols,
  labels,
  alignEnd = [],
}: {
  cols: string
  labels: string[]
  /** Column indices (0-based) right-aligned. */
  alignEnd?: number[]
}) {
  const end = new Set(alignEnd.length ? alignEnd : labels.map((_, i) => i).filter(i => i > 0 && i >= labels.length - 2))
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: cols, columnGap: 10, alignItems: 'center',
      marginBottom: 4, padding: '0 0 2px', width: '100%', boxSizing: 'border-box',
    }}>
      {labels.map((l, i) => (
        <span key={i} style={{
          fontFamily: F.sans, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: F.muted, textAlign: end.has(i) ? 'right' : 'left',
          opacity: l ? 1 : 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{l || '·'}</span>
      ))}
    </div>
  )
}

function EmptyLine({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <p style={{
      margin: '4px 0 0', fontFamily: mono ? F.mono : F.sans, fontSize: mono ? 11 : 13,
      color: F.muted, lineHeight: 1.45,
    }}>{children}</p>
  )
}

function TextLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        fontFamily: F.sans, fontSize: 12, color: F.gold,
      }}
    >{children}</button>
  )
}
