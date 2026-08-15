import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { KpiStrip, MONO, SANS, mix } from './cockpitKit'
import { T } from '../lib/theme'
import { TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM } from './valuationShared'

// Market breadth: how many members are behind the index move.
//
// The index level cannot answer this. A benchmark at a record high with 40% of
// its members under their 200-day average is a different market from the same
// high with 80% above it, and only the second one is broad. Everything here is
// computed from the constituent lists the terminal already ships, so it costs
// no new feed.

const LABELS: Record<string, string> = {
  '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq-100', '^DJI': 'Dow Jones', '^GSPTSE': 'TSX 60',
  '^FTSE': 'FTSE 100', '^GDAXI': 'DAX', '^FCHI': 'CAC 40', '^STOXX50E': 'Euro Stoxx 50',
  '^IBEX': 'IBEX 35', '^SSMI': 'SMI', '^AEX': 'AEX', 'FTSEMIB.MI': 'FTSE MIB',
  '^N225': 'Nikkei 225', '^HSI': 'Hang Seng', '^NSEI': 'Nifty 50', '^AXJO': 'ASX 200',
  '^STI': 'Straits Times',
}

interface Point {
  date: string; ad_line: number; net_advancers: number | null
  pct_above_50: number | null; pct_above_200: number | null
  new_highs: number; new_lows: number; index?: number
}
interface Breadth {
  available: boolean
  reason?: string
  index?: string
  as_of?: string
  coverage?: { listed: number; priced: number }
  today?: { advancing: number; declining: number; unchanged: number; ad_ratio: number | null; new_highs: number; new_lows: number }
  participation?: { pct_above_50: number | null; pct_above_200: number | null; pct_above_50_change: number | null; pct_above_200_change: number | null }
  divergence?: { state: 'narrowing' | 'broadening' | 'aligned'; sessions: number; index_change_pct: number | null; ad_line_change: number } | null
  history?: Point[]
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

// The reading a breadth chart exists to produce, said in words. A reader should
// not have to eyeball two lines to learn that the rally is thinning.
const VERDICT: Record<string, { title: string; body: string; tone: string }> = {
  narrowing: {
    title: 'Narrowing',
    tone: T.neg,
    body: 'The index is up over the last month while fewer members are participating. Rallies carried by a shrinking group are the ones that tend to reverse hardest.',
  },
  broadening: {
    title: 'Broadening',
    tone: T.pos,
    body: 'The index is down over the last month while more members are advancing than declining. Selling that the average name has stopped joining often marks the end of it.',
  },
  aligned: {
    title: 'Aligned',
    tone: T.muted,
    body: 'Price and participation are moving together, so the index move reflects the average member rather than a handful of them.',
  },
}

function Panel({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ft-chart-panel">
      <div className="ft-chart-label" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span>{title}</span>
        {meta && <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', textTransform: 'none' }}>{meta}</span>}
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  )
}

export default function MarketBreadth() {
  const [index, setIndex] = useState('^GSPC')

  const listQ = useQuery<{ indices: { symbol: string; members: number }[] }>({
    queryKey: ['breadth-indices'],
    queryFn: () => axios.get('/api/market/breadth/indices').then(r => r.data),
    staleTime: 60 * 60_000,
  })
  const q = useQuery<Breadth>({
    queryKey: ['breadth', index],
    queryFn: () => axios.get('/api/market/breadth', { params: { index } }).then(r => r.data),
    staleTime: 25 * 60_000,
    retry: 0,
  })

  const d = q.data
  const label = LABELS[index] ?? index
  const history = d?.history ?? []
  const verdict = d?.divergence ? VERDICT[d.divergence.state] : null

  return (
    <PageWrapper title="Market Breadth" meta={d?.as_of ? `${d.coverage?.priced ?? 0} members · ${d.as_of}` : undefined}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {(listQ.data?.indices ?? []).map(item => {
          const on = item.symbol === index
          return (
            <button key={item.symbol} onClick={() => setIndex(item.symbol)}
              style={{
                fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                padding: '6px 11px', minHeight: 32, boxSizing: 'border-box', cursor: 'pointer',
                background: on ? mix(T.gold, 14) : 'transparent',
                border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.muted,
              }}>
              {LABELS[item.symbol] ?? item.symbol}
              <span style={{ fontFamily: MONO, fontSize: 9, marginLeft: 6, opacity: 0.7 }}>{item.members}</span>
            </button>
          )
        })}
      </div>

      {q.isLoading && <EmptyState variant="loading" title={`Measuring ${label} breadth`} hint="Pricing every member of the index." />}

      {!q.isLoading && !d?.available && (
        <EmptyState variant="unavailable" title="Breadth unavailable"
          hint={d?.reason ?? 'The member prices did not load. Pick another index, or retry shortly.'} />
      )}

      {d?.available && d.today && d.participation && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <KpiStrip cells={[
            { label: 'Advancing', value: String(d.today.advancing), vc: T.pos, sub: `${d.today.declining} declining` },
            { label: 'A / D ratio', value: d.today.ad_ratio == null ? '—' : d.today.ad_ratio.toFixed(2),
              vc: (d.today.ad_ratio ?? 1) >= 1 ? T.pos : T.neg, sub: 'above 1 is more up than down' },
            { label: 'Above 50-day', value: pct(d.participation.pct_above_50),
              sub: d.participation.pct_above_50_change == null ? undefined
                : `${d.participation.pct_above_50_change >= 0 ? '+' : ''}${d.participation.pct_above_50_change} today`,
              sc: (d.participation.pct_above_50_change ?? 0) >= 0 ? T.pos : T.neg },
            { label: 'Above 200-day', value: pct(d.participation.pct_above_200),
              sub: d.participation.pct_above_200_change == null ? undefined
                : `${d.participation.pct_above_200_change >= 0 ? '+' : ''}${d.participation.pct_above_200_change} today`,
              sc: (d.participation.pct_above_200_change ?? 0) >= 0 ? T.pos : T.neg },
            { label: '52-week highs', value: String(d.today.new_highs), vc: T.pos, sub: `${d.today.new_lows} new lows` },
          ]} />

          {verdict && d.divergence && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 16px',
              background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${verdict.tone}`,
            }}>
              <div style={{ flex: 'none' }}>
                <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>Last month</div>
                <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: verdict.tone, marginTop: 4 }}>{verdict.title}</div>
              </div>
              <div style={{ fontFamily: SANS, fontSize: 11.5, lineHeight: 1.55, color: T.muted, maxWidth: 720 }}>
                {verdict.body}
                <span style={{ color: T.text }}>
                  {' '}Index {d.divergence.index_change_pct == null ? '' : `${d.divergence.index_change_pct >= 0 ? '+' : ''}${d.divergence.index_change_pct}%`},
                  {' '}A/D line {d.divergence.ad_line_change >= 0 ? '+' : ''}{d.divergence.ad_line_change} over {d.divergence.sessions} sessions.
                </span>
              </div>
            </div>
          )}

          <Panel title="Advance / decline line vs the index"
            meta="the A/D line is cumulative net advancers, rebased to zero six months ago">
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={history} margin={{ top: 6, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.borderFaint} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={44} stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} />
                <YAxis yAxisId="ad" stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} width={54} />
                <YAxis yAxisId="px" orientation="right" domain={['auto', 'auto']} stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} width={60} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} labelFormatter={shortDate} />
                <Legend wrapperStyle={{ fontFamily: SANS, fontSize: 10 }} />
                <Area isAnimationActive={false} yAxisId="ad" type="monotone" dataKey="ad_line" name="A/D line" stroke={T.gold}
                  fill={mix(T.gold, 12)} strokeWidth={1.7} dot={false} />
                <Line isAnimationActive={false} yAxisId="px" type="monotone" dataKey="index" name={label} stroke={T.blue} strokeWidth={1.4} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="Participation" meta="share of members trading above their own moving average">
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={history} margin={{ top: 6, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.borderFaint} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={44} stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} />
                <YAxis domain={[0, 100]} unit="%" stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} width={44} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} labelFormatter={shortDate}
                  formatter={(v: number) => `${v}%`} />
                <Legend wrapperStyle={{ fontFamily: SANS, fontSize: 10 }} />
                {/* Half the index above its own average is the line between a
                    broad market and a thin one. */}
                <ReferenceLine y={50} stroke={T.muted} strokeDasharray="4 3" />
                <Line isAnimationActive={false} type="monotone" dataKey="pct_above_50" name="above 50-day" stroke={T.gold} strokeWidth={1.6} dot={false} />
                <Line isAnimationActive={false} type="monotone" dataKey="pct_above_200" name="above 200-day" stroke={T.blue} strokeWidth={1.6} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="New 52-week highs and lows" meta="members setting a one-year extreme that session">
            <ResponsiveContainer width="100%" height={190}>
              <ComposedChart data={history} margin={{ top: 6, right: 8, left: 0, bottom: 4 }} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" stroke={T.borderFaint} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={44} stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} />
                <YAxis stroke={T.muted} tick={{ fill: T.muted, fontSize: 9 }} width={44} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} labelFormatter={shortDate} />
                <Legend wrapperStyle={{ fontFamily: SANS, fontSize: 10 }} />
                <Area isAnimationActive={false} type="monotone" dataKey="new_highs" name="new highs" stroke={T.pos} fill={mix(T.pos, 18)} strokeWidth={1.4} dot={false} />
                <Area isAnimationActive={false} type="monotone" dataKey="new_lows" name="new lows" stroke={T.neg} fill={mix(T.neg, 18)} strokeWidth={1.4} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}
    </PageWrapper>
  )
}
