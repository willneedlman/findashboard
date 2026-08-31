import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { T } from '../../lib/theme'
import HelpTip from '../HelpTip'
import { MONO, SANS, BRIGHT } from './ui'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../ChartTooltip'
import { fetchBetaSuite, fetchMarketHistory } from '../../hooks/useApi'
import { stableValueDomain } from '../../lib/chartDomain'
import { MARKETS, marketStatus, PHASE_COLOR, PHASE_LABEL } from '../../lib/marketHours'
import {
  DASH, change, compact, count, dividend, multiple, price, quoteWithSize, range, shortDate, tone,
} from './format'

/** Windows the chart offers, with the lookback each one asks the API for.
 *  ALL is expressed as a very long lookback rather than a null, so one code
 *  path builds every request. */
const RANGES = [
  { key: '1D', days: 1 },
  { key: '5D', days: 5 },
  { key: '1M', days: 31 },
  { key: '6M', days: 186 },
  { key: 'YTD', days: 0 },
  { key: '1Y', days: 365 },
  { key: '5Y', days: 1826 },
  { key: 'ALL', days: 10_950 },
] as const

/** 1D and 5D are session windows, not calendar windows. Daily bars cannot draw
 *  them: on a Sunday a one-calendar-day lookback contains no trading at all,
 *  which is what left the chart empty. These read intraday candles instead and
 *  take the last sessions PRESENT in the data, so the window follows the market
 *  rather than the clock. */
const SESSION_RANGES: Record<string, number> = { '1D': 1, '5D': 5 }

const NASDAQ = MARKETS.find(m => m.id === 'nasdaq')!

interface Candle { time: number; close: number }

/** The exchange's own calendar date for a bar. Bucketing on the local date puts
 *  a 16:00 ET print on the following day for anyone east of London. */
const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
})
const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
})
const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short',
})
const ET_STAMP_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'long', day: 'numeric',
})
const ET_STAMP_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})
const ET_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric',
})

/** /market/history switches format with the window: long lookbacks return daily
 *  bars dated "2026-08-28", short ones return intraday bars dated in epoch
 *  seconds. Unformatted, the short windows printed "1785776400" as axis ticks. */
function historyLabel(date: unknown): string {
  const raw = String(date ?? '')
  return /^\d{9,}$/.test(raw) ? ET_DATE.format(Number(raw) * 1000) : raw
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

function startFor(key: string): string {
  const now = new Date()
  if (key === 'YTD') return `${now.getFullYear()}-01-01`
  const days = RANGES.find(r => r.key === key)?.days ?? 365
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  return iso(d)
}

interface Quote {
  available?: boolean
  regularMarketPreviousClose?: number | null
  regularMarketOpen?: number | null
  bid?: number | null; bidSize?: number | null
  ask?: number | null; askSize?: number | null
  dayLow?: number | null; dayHigh?: number | null
  fiftyTwoWeekLow?: number | null; fiftyTwoWeekHigh?: number | null
  volume?: number | null; averageVolume?: number | null
  marketCap?: number | null; enterpriseValue?: number | null
  beta?: number | null; trailingPE?: number | null; trailingEps?: number | null
  targetMeanPrice?: number | null; marketCapBasis?: number | null
  dividendRate?: number | null; dividendYield?: number | null
  exchange?: string | null
  earningsDate?: string | null; earningsHorizon?: string | null
}

interface Profile {
  name?: string; sector?: string; industry?: string
  price?: number | null; pe_ratio?: number | null; eps_ttm?: number | null
  market_cap?: number | null
}

export default function OverviewTab({ ticker }: { ticker: string }) {
  const [rangeKey, setRangeKey] = useState<string>('1Y')

  const quote = useQuery<Quote>({
    queryKey: ['cp-quote-detail', ticker],
    queryFn: () => axios.get(`/api/corporate/quote-detail?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const profile = useQuery<Profile>({
    queryKey: ['cp-profile', ticker],
    queryFn: () => axios.get(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const analyst = useQuery<{
    target_mean?: number | null; total_analysts?: number | null
    recommendation_key?: string | null; recommendation_mean?: number | null
    distribution?: { strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }
  }>({
    queryKey: ['cp-analyst', ticker],
    queryFn: () => axios.get(`/api/corporate/hub/analyst?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const sessions = SESSION_RANGES[rangeKey]

  // Re-read the clock rather than the calendar: the phase label and the polling
  // decision both go stale on their own, with no data change to trigger them.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  const session = marketStatus(NASDAQ, now)

  const start = startFor(rangeKey)
  const history = useQuery({
    queryKey: ['cp-history', ticker, start],
    queryFn: () => fetchMarketHistory(ticker, start, iso(new Date())),
    staleTime: 300_000, retry: 1, enabled: !!ticker && !sessions,
  })

  // prepost=true is what makes this 24/5 rather than 9:30-to-4: the same
  // extended-hours coverage the live cockpit charts.
  const intraday = useQuery<{ candles?: Candle[] }>({
    queryKey: ['cp-intraday', ticker],
    queryFn: () => axios
      .get(`/api/market/ohlcv?ticker=${encodeURIComponent(ticker)}&tf=5m&prepost=true`)
      .then(r => r.data),
    staleTime: 60_000, retry: 0, enabled: !!ticker && !!sessions,
    refetchInterval: session.open ? 60_000 : false,
  })

  // The candle feed lags by up to a minute. This is the tick that keeps the
  // printed price current between bars, and it stops when the tape does.
  // regular_close and current_price are two different prints. Showing only one
  // of them means either the close is wrong after 16:00 or the extended move is
  // invisible, and the header needs both.
  const tape = useQuery<{
    current_price?: number | null; regular_close?: number | null
    extended_pct?: number | null; session?: string; basis?: string; as_of?: string
  }>({
    queryKey: ['cp-tape', ticker],
    queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 30_000, retry: 0, enabled: !!ticker,
    refetchInterval: session.open ? 20_000 : false,
  })

  const live = useQuery<{ last?: number | null; prior_close?: number | null }>({
    queryKey: ['cp-live', ticker],
    queryFn: () => axios.get(`/api/market/live-quote?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 10_000, retry: 0, enabled: !!ticker && session.open,
    refetchInterval: session.open ? 15_000 : false,
  })
  // Recomputed over the SELECTED window. This is the honest counterpart to the
  // vendor beta in the stat grid below, whose methodology is undisclosed, so
  // both are shown and each says which it is.
  const beta = useQuery({
    queryKey: ['cp-beta', ticker, start],
    queryFn: () => fetchBetaSuite(ticker, start, iso(new Date()), 'ff3'),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const q = quote.data ?? {}
  const p = profile.data ?? {}
  const t = tape.data ?? {}
  // The headline price is the regular-session close. The extended print gets
  // its own block beside it rather than overwriting this one.
  const last = t.regular_close ?? live.data?.last ?? p.price ?? null
  const ext = t.current_price != null && t.regular_close != null
    && Math.abs(t.current_price - t.regular_close) > 1e-9
    ? t.current_price : null
  // The baseline is the close of the session BEFORE the prints on screen, and
  // the vendor field is that in every phase. The live endpoint derives its own
  // prior close relative to now, which over a weekend is Friday's close, so it
  // measured Friday's price against itself and reported a 0.07% day.
  const prev = q.regularMarketPreviousClose ?? live.data?.prior_close ?? null
  const absChange = last != null && prev != null ? last - prev : null
  const pctChange = absChange != null && prev ? (absChange / prev) * 100 : null

  const { series, sessionDay } = useMemo(() => {
    if (sessions) {
      const candles = (intraday.data?.candles ?? [])
        .filter(c => Number.isFinite(c?.close) && Number.isFinite(c?.time))
      if (!candles.length) return { series: [], sessionDay: null as string | null }

      // Take the last N session dates PRESENT in the feed. On a Sunday that is
      // Friday, over a holiday week it is whatever actually traded, and neither
      // case needs a market calendar here.
      const days = [...new Set(candles.map(c => ET_DAY.format(c.time * 1000)))].sort()
      const keep = new Set(days.slice(-sessions))
      const rows = candles.filter(c => keep.has(ET_DAY.format(c.time * 1000)))

      return {
        series: rows.map(c => {
          const ms = c.time * 1000
          const clock = ET_CLOCK.format(ms)
          return {
            // A category axis keeps the sessions adjacent. On a time axis the
            // overnight gap is 17 hours of empty chart between two days.
            date: sessions > 1 ? `${ET_WEEKDAY.format(ms)} ${clock}` : clock,
            close: c.close,
          }
        }),
        sessionDay: days[days.length - 1] ?? null,
      }
    }

    // /market/history returns { ticker, metrics, price: [{ date, value }] }.
    // Guessing `history[].close` cost a silently empty chart: the request
    // succeeded, the array was simply never found.
    const rows = (history.data?.price ?? []) as { date?: string; value?: number }[]
    return {
      series: rows
        .filter(r => typeof r.value === 'number')
        .map(r => ({ date: historyLabel(r.date), close: r.value as number })),
      sessionDay: null as string | null,
    }
  }, [history.data, intraday.data, sessions])

  // The reference is the previous close on an intraday window and the window's
  // own first point on every other, because "up" means something different over
  // a day than over five years.
  const reference = sessions
    ? prev ?? series[0]?.close ?? null
    : series[0]?.close ?? null
  // Ladder-snapped so a tick that moves the extreme by a cent does not redraw
  // the whole axis under the reader.
  const yDomain = useMemo(
    () => stableValueDomain(series.map(d => d.close), reference),
    [series, reference],
  )
  const endsUp = series.length > 0 && reference != null
    ? series[series.length - 1].close >= reference
    : true
  const lineColor = endsUp ? 'var(--theme-positive)' : 'var(--theme-negative)'

  const windowStats = useMemo(() => {
    if (series.length < 2) return []
    const first = series[0].close
    const lastClose = series[series.length - 1].close
    const rets: number[] = []
    let peak = first
    let maxDd = 0
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1].close
      const b = series[i].close
      if (a > 0) rets.push(b / a - 1)
      peak = Math.max(peak, b)
      if (peak > 0) maxDd = Math.min(maxDd, b / peak - 1)
    }
    const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1)
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)
    const vol = Math.sqrt(variance) * Math.sqrt(252) * 100
    const chg = first > 0 ? (lastClose / first - 1) * 100 : null
    return [
      { label: 'Change in window', value: chg == null ? DASH : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`, tone: tone(chg) },
      // The vendor beta in the stat grid has an undisclosed methodology. This
      // one is computed over the window on screen, which is the honest
      // counterpart, so both are shown rather than one standing for the other.
      { label: 'Annualized vol', value: `${vol.toFixed(1)}%`, tone: 'var(--theme-text)' },
      { label: 'Max drawdown', value: `${(maxDd * 100).toFixed(1)}%`, tone: 'var(--theme-negative)' },
    ]
  }, [series])

  const computedBeta = beta.data?.capm?.betas?.mktrf
  const stats = useMemo(() => {
    if (!windowStats.length) return windowStats
    const b = typeof computedBeta === 'number' ? computedBeta.toFixed(2) : DASH
    // Inserted second, beside the change it helps explain, rather than appended
    // after the drawdown.
    return [
      windowStats[0],
      { label: 'Computed CAPM beta', value: b, tone: 'var(--theme-text)' },
      ...windowStats.slice(1),
    ]
  }, [windowStats, computedBeta])

  const stampDay = (iso?: string) => {
    if (!iso) return null
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : ET_STAMP_DAY.format(d)
  }
  const stampTime = (iso?: string) => {
    if (!iso) return null
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : ET_STAMP_TIME.format(d)
  }
  const day = stampDay(t.as_of) ?? (sessionDay ? stampDay(`${sessionDay}T16:00:00-04:00`) : null)
  const closeStamp = day ? `At close ${day}` : 'At close'
  const extLabel = t.session === 'pre' ? 'Pre-market' : 'After hours'
  const extStamp = day
    ? `${extLabel} ${day}${stampTime(t.as_of) ? `, ${stampTime(t.as_of)}` : ''}`
    : extLabel

  const loading = quote.isLoading || profile.isLoading

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
    }}>
      {/* ── Row 2: price block ──────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 40, flexWrap: 'wrap',
        padding: '18px 22px 16px',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: MONO, fontSize: 44, fontWeight: 700, letterSpacing: '-0.01em',
              color: 'var(--theme-text-bright, #dce3ed)', lineHeight: 1,
            }}>
              {price(last)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 19, fontWeight: 700, color: tone(absChange) }}>
              {change(absChange, pctChange)}
            </span>
          </div>
          <div style={{
            marginTop: 9, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            fontFamily: SANS, fontSize: 10, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
          }}>
            <span>{closeStamp}</span>
            <span>Previous close {price(prev)}</span>
            {/* What the printed price MEANS: a live regular-hours print, an
                extended-hours print, or Friday's close sitting over a weekend.
                Without it the reader cannot tell a stale number from a moving
                one. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                className={session.open ? 'ft-live-dot' : undefined}
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: PHASE_COLOR[session.phase],
                }}
              />
              <span style={{ color: PHASE_COLOR[session.phase] }}>
                {session.phase === 'regular' ? 'Live' : PHASE_LABEL[session.phase]}
              </span>
              {!session.open && sessionDay && (
                <span>· Session {sessionDay}</span>
              )}
            </span>
          </div>
        </div>

        {ext != null && (
          <div style={{ paddingBottom: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: MONO, fontSize: 28, fontWeight: 700,
                color: 'var(--theme-text)', lineHeight: 1,
              }}>
                {price(ext)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: tone(t.extended_pct) }}>
                {change(
                  last != null ? ext - last : null,
                  t.extended_pct ?? (last ? (ext / last - 1) * 100 : null),
                )}
              </span>
            </div>
            <div style={{
              marginTop: 9, fontFamily: SANS, fontSize: 10, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
            }}>
              {extStamp}
            </div>
          </div>
        )}

        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <Eyebrow>Analyst mean target</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: T.gold, marginTop: 3 }}>
            {price(analyst.data?.target_mean ?? q.targetMeanPrice)}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, marginTop: 3, color: tone(
            last != null && (analyst.data?.target_mean ?? q.targetMeanPrice) != null
              ? (analyst.data?.target_mean ?? q.targetMeanPrice)! - last : null) }}>
            {(() => {
              const tgt = analyst.data?.target_mean ?? q.targetMeanPrice
              if (tgt == null || last == null || !last) return DASH
              const up = (tgt / last - 1) * 100
              const n = analyst.data?.total_analysts
              return `${up > 0 ? '+' : ''}${up.toFixed(1)}% implied upside${n ? `, n=${n}` : ''}`
            })()}
          </div>
          {/* The call already carries the consensus and the full vote spread.
              A mean target without the rating behind it hides who set it. */}
          {analyst.data?.recommendation_key && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 7,
            }}>
              <span style={{
                fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', padding: '2px 7px',
                border: `1px solid ${T.border}`, color: T.gold, whiteSpace: 'nowrap',
              }}>
                {analyst.data.recommendation_key.replace(/_/g, ' ')}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted, whiteSpace: 'nowrap' }}>
                {(() => {
                  const b = analyst.data.distribution ?? {}
                  const buy = (b.strongBuy ?? 0) + (b.buy ?? 0)
                  const sell = (b.sell ?? 0) + (b.strongSell ?? 0)
                  return `${buy} buy / ${b.hold ?? 0} hold / ${sell} sell`
                })()}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Row 3: price chart ──────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${T.borderFaint}`, padding: '12px 22px 16px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: 16, flexWrap: 'wrap', marginBottom: 10,
        }}>
          <div style={{ display: 'inline-flex', gap: 2 }}>
            {RANGES.map(r => {
              const on = r.key === rangeKey
              return (
                <button
                  key={r.key}
                  onClick={() => setRangeKey(r.key)}
                  style={{
                    fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase',
                    padding: '4px 9px', cursor: 'pointer', background: 'transparent',
                    border: on ? '1px solid color-mix(in srgb, var(--theme-primary) 35%, transparent)' : '1px solid transparent',
                    color: on ? T.gold : T.muted,
                    transition: 'color 120ms cubic-bezier(0.23,1,0.32,1), border-color 120ms cubic-bezier(0.23,1,0.32,1)',
                  }}
                >
                  {r.key}
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
            {stats.map(s => (
              <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <Eyebrow>{s.label}</Eyebrow>
                <span style={{
                  fontFamily: MONO, fontSize: 12.5, fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums', color: s.tone,
                }}>
                  {s.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: T.bg, border: `1px solid ${T.border}`, height: 300 }}>
          {series.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 22, right: 12, bottom: 8, left: 4 }}>
                <defs>
                  <linearGradient id="cp-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.13} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0.13} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontFamily: MONO, fontSize: 11, fill: 'rgba(255,255,255,0.35)' }}
                  tickLine={false} axisLine={false} minTickGap={48}
                />
                <YAxis
                  orientation="right" domain={yDomain} width={64} allowDataOverflow
                  tick={{ fontFamily: MONO, fontSize: 11, fill: 'rgba(255,255,255,0.35)' }}
                  tickLine={false} axisLine={false} tickCount={4}
                  tickFormatter={(v: number) => v.toFixed(2)}
                />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR}
                  formatter={(v: number) => [v.toFixed(2), 'Close']} />
                {reference != null && (
                  <ReferenceLine y={reference} stroke="rgba(255,255,255,0.28)" strokeDasharray="7 6" />
                )}
                <Area
                  type="monotone" dataKey="close" stroke={lineColor} strokeWidth={1.7}
                  fill="url(#cp-area)" isAnimationActive={false}
                  dot={false} activeDot={{ r: 3.4, fill: lineColor, stroke: 'none' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: MONO, fontSize: 11, color: T.muted,
            }}>
              {(sessions ? intraday.isLoading : history.isLoading)
                ? 'Loading price history'
                : 'No price history for this window'}
            </div>
          )}
        </div>
      </div>

      {/* ── Key stats. Four columns of dense label/value rows rather than
              sixteen padded tiles: this is a quote brief, and a brief is read
              by scanning down a column, not by looking at boxes. ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
        columnGap: 30, padding: '12px 22px 6px',
        borderTop: `1px solid ${T.borderFaint}`,
      }}>
        <Stat label="Previous close" value={price(prev)} />
        <Stat label="Day's range" value={range(q.dayLow, q.dayHigh)} />
        <Stat
          label="Market cap (intraday)"
          value={compact(q.marketCap ?? p.market_cap)}
          tip={q.marketCapBasis
            ? `Built on ${compact(q.marketCapBasis)} diluted shares via yfinance.`
            : undefined}
        />
        <Stat
          label="Earnings date (est.)"
          value={q.earningsDate
            ? `${shortDate(q.earningsDate)}${q.earningsHorizon ? ` ${q.earningsHorizon}` : ''}`
            : DASH}
        />

        <Stat label="Open" value={price(q.regularMarketOpen)} />
        <Stat label="52 week range" value={range(q.fiftyTwoWeekLow, q.fiftyTwoWeekHigh)} />
        <Stat label="Enterprise value" value={compact(q.enterpriseValue)} />
        <Stat label="P/E ratio (TTM)" value={multiple(q.trailingPE ?? p.pe_ratio)} />

        <Stat label="Bid" value={quoteWithSize(q.bid, q.bidSize)} />
        <Stat label="Volume" value={count(q.volume)} />
        <Stat label="Beta (5Y monthly)" value={multiple(q.beta)} />
        <Stat label="EPS (TTM)" value={price(q.trailingEps ?? p.eps_ttm)} />

        <Stat label="Ask" value={quoteWithSize(q.ask, q.askSize)} />
        <Stat label="Avg volume (3M)" value={count(q.averageVolume)} />
        <Stat label="Forward dividend & yield" value={dividend(q.dividendRate, q.dividendYield)} />
        <Stat label="1Y target estimate" value={price(analyst.data?.target_mean ?? q.targetMeanPrice)} />
      </div>

      {/* ── Row 5: source strip ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 24, flexWrap: 'wrap',
        padding: '9px 22px 10px', background: 'rgba(0,0,0,0.16)',
        borderTop: `1px solid ${T.borderFaint}`,
      }}>
        <Source label="Market cap basis" value={q.marketCapBasis ? `${compact(q.marketCapBasis)} diluted, yfinance` : DASH} />
        <Source label="Bid and ask" value="Last quote, not live" />
        <Source label="Beta" value="Vendor 5Y monthly" />
        <Source label="Dividend" value={dividend(q.dividendRate, q.dividendYield)} />
      </div>
    </div>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
      textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
    }}>
      {children}
    </span>
  )
}

function Stat({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14,
      padding: '7px 0',
      borderBottom: '1px dashed rgba(255,255,255,0.10)',
      minWidth: 0,
    }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontFamily: SANS, fontSize: 12, color: T.muted, whiteSpace: 'nowrap',
      }}>
        {label}
        {tip && <HelpTip text={tip} width={240} position="bottom" />}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 12, fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', color: BRIGHT,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value}
      </span>
    </div>
  )
}

function Source({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Eyebrow>{label}</Eyebrow>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted }}>{value}</span>
    </div>
  )
}
