import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { T } from '../../lib/theme'
import TickerLogo from '../TickerLogo'
import HelpTip from '../HelpTip'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../ChartTooltip'
import { fetchMarketHistory } from '../../hooks/useApi'
import {
  DASH, change, compact, count, dividend, multiple, price, quoteWithSize, range, shortDate, tone,
} from './format'

const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'

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
}

interface Profile {
  name?: string; sector?: string; industry?: string
  price?: number | null; pe_ratio?: number | null; eps_ttm?: number | null
  market_cap?: number | null
}

export default function OverviewHeader({ ticker }: { ticker: string }) {
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
  const analyst = useQuery<{ target_mean?: number | null; total_analysts?: number | null }>({
    queryKey: ['cp-analyst', ticker],
    queryFn: () => axios.get(`/api/corporate/hub/analyst?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const start = startFor(rangeKey)
  const history = useQuery({
    queryKey: ['cp-history', ticker, start],
    queryFn: () => fetchMarketHistory(ticker, start, iso(new Date())),
    staleTime: 300_000, retry: 1, enabled: !!ticker,
  })

  const q = quote.data ?? {}
  const p = profile.data ?? {}
  const last = p.price ?? null
  const prev = q.regularMarketPreviousClose ?? null
  const absChange = last != null && prev != null ? last - prev : null
  const pctChange = absChange != null && prev ? (absChange / prev) * 100 : null

  const series = useMemo(() => {
    // /market/history returns { ticker, metrics, price: [{ date, value }] }.
    // Guessing `history[].close` cost a silently empty chart: the request
    // succeeded, the array was simply never found.
    const rows = (history.data?.price ?? []) as { date?: string; value?: number }[]
    return rows
      .filter(r => typeof r.value === 'number')
      .map(r => ({ date: String(r.date ?? ''), close: r.value as number }))
  }, [history.data])

  // The reference is the previous close on an intraday window and the window's
  // own first point on every other, because "up" means something different over
  // a day than over five years.
  const reference = rangeKey === '1D'
    ? prev ?? series[0]?.close ?? null
    : series[0]?.close ?? null
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

  const loading = quote.isLoading || profile.isLoading

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
      marginBottom: 20,
    }}>
      {/* ── Row 1: identity ─────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        padding: '17px 22px 15px',
      }}>
        <TickerLogo ticker={ticker} size={40} />
        <span style={{ fontFamily: MONO, fontSize: 25, fontWeight: 700, letterSpacing: '0.02em', color: T.gold }}>
          {ticker}
        </span>
        <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: 'var(--theme-text-bright, #dce3ed)' }}>
          {p.name ?? (loading ? '' : DASH)}
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {q.exchange && <Tag tone="gold">{q.exchange}</Tag>}
          {p.sector && <Tag>{p.sector}</Tag>}
          {p.industry && <Tag>{p.industry}</Tag>}
        </div>
      </div>

      {/* ── Row 2: price block ──────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 40, flexWrap: 'wrap',
        padding: '18px 22px 16px', borderTop: `1px solid ${T.borderFaint}`,
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
            marginTop: 9, fontFamily: SANS, fontSize: 10, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
          }}>
            Previous close {price(prev)}
          </div>
        </div>

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
            {windowStats.map(s => (
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
                  orientation="right" domain={['auto', 'auto']} width={64}
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
              {history.isLoading ? 'Loading price history' : 'No price history for this window'}
            </div>
          )}
        </div>
      </div>

      {/* ── Row 4: key stat grid ────────────────────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
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
        <Stat label="Earnings date (est.)" value={DASH} />

        <Stat label="Open" value={price(q.regularMarketOpen)} />
        <Stat label="52 week range" value={range(q.fiftyTwoWeekLow, q.fiftyTwoWeekHigh)} />
        <Stat label="Enterprise value" value={compact(q.enterpriseValue)} />
        <Stat label="P/E ratio (TTM)" value={multiple(q.trailingPE ?? p.pe_ratio)} />

        <Stat label="Bid" value={quoteWithSize(q.bid, q.bidSize)} tip="Last quote, not live." />
        <Stat label="Volume" value={count(q.volume)} />
        <Stat
          label="Beta (5Y monthly)"
          value={multiple(q.beta)}
          tip="Vendor beta, methodology undisclosed. The computed figure over the selected window sits in the chart header."
        />
        <Stat label="EPS (TTM)" value={price(q.trailingEps ?? p.eps_ttm)} />

        <Stat label="Ask" value={quoteWithSize(q.ask, q.askSize)} tip="Last quote, not live." />
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
      padding: '13px 22px',
      borderRight: '1px solid rgba(255,255,255,0.04)',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Eyebrow>{label}</Eyebrow>
        {tip && <HelpTip text={tip} width={240} position="bottom" />}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 13.5, fontVariantNumeric: 'tabular-nums',
        color: T.text, overflowWrap: 'anywhere',
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

function Tag({ children, tone: t }: { children: React.ReactNode; tone?: 'gold' }) {
  const gold = t === 'gold'
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, padding: '2px 7px',
      border: `1px solid ${gold ? 'color-mix(in srgb, var(--theme-primary) 45%, transparent)' : T.border}`,
      color: gold ? T.gold : T.muted,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}
