import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { T } from '../../../lib/theme'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'

const DEFAULT_TICKERS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL']

interface CalendarRow {
  symbol: string
  date: string
  hour?: string
  epsEstimate?: number | null
}
interface EnrichedRow {
  symbol: string
  nextDate?: string | null
}
interface ImpliedRow {
  symbol: string
  impliedMove?: number | null
  impliedMoveExpiry?: string | null
}
interface EarningsEntry {
  ticker: string
  date: string | null
  hour?: string
  epsEstimate?: number | null
  impliedMove?: number | null
  impliedMoveExpiry?: string | null
}

async function loadEarnings(tickers: string[]): Promise<EarningsEntry[]> {
  const symbols = tickers.join(',')
  const today = new Date().toISOString().slice(0, 10)
  const [calendar, enriched, implied] = await Promise.all([
    axios.get(`/api/earnings/calendar?date=${today}&days=14`).then(r => r.data).catch(() => ({ rows: [] })),
    axios.get(`/api/earnings/enrich?symbols=${encodeURIComponent(symbols)}`).then(r => r.data).catch(() => ({ rows: [] })),
    axios.get(`/api/earnings/implied-move?symbols=${encodeURIComponent(symbols)}`).then(r => r.data),
  ])
  const calendarByTicker = new Map((calendar.rows as CalendarRow[]).map(row => [row.symbol, row]))
  const enrichedByTicker = new Map((enriched.rows as EnrichedRow[]).map(row => [row.symbol, row]))
  const impliedByTicker = new Map((implied.rows as ImpliedRow[]).map(row => [row.symbol, row]))
  return tickers.map(ticker => {
    const scheduled = calendarByTicker.get(ticker)
    const fallback = enrichedByTicker.get(ticker)
    const move = impliedByTicker.get(ticker)
    return {
      ticker,
      date: scheduled?.date ?? fallback?.nextDate ?? null,
      hour: scheduled?.hour,
      epsEstimate: scheduled?.epsEstimate,
      impliedMove: move?.impliedMove,
      impliedMoveExpiry: move?.impliedMoveExpiry,
    }
  })
}

export default function EarningsCalendar({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers?.length ? config.tickers : DEFAULT_TICKERS
  const { data, isLoading, isError } = useQuery({
    queryKey: ['earnings-widget-rich', tickers.join(',')],
    queryFn: () => loadEarnings(tickers),
    staleTime: 300_000,
    retry: 1,
  })
  const entries = [...(data ?? [])].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: T.bg }}>
      {isLoading && <div style={{ padding: 12, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>Loading earnings...</div>}
      {isError && <div style={{ padding: 12, color: T.neg, fontFamily: T.mono, fontSize: 10 }}>Earnings unavailable</div>}
      {entries.map(entry => (
        <div key={entry.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: `1px solid ${T.border}` }}>
          <TickerLogo ticker={entry.ticker} size={20} />
          <div style={{ minWidth: 58 }}>
            <div style={{ color: T.gold, fontFamily: T.label, fontSize: 9, fontWeight: 700 }}>{entry.ticker}</div>
            <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 8 }}>{entry.date ?? 'Date pending'}</div>
          </div>
          {entry.hour && <span style={{ color: T.blue, fontFamily: T.mono, fontSize: 8 }}>{entry.hour}</span>}
          {entry.epsEstimate != null && <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 8 }}>EPS {entry.epsEstimate.toFixed(2)}</span>}
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ color: entry.impliedMove == null ? T.muted : T.text, fontFamily: T.mono, fontSize: 10 }}>
              {entry.impliedMove == null ? '-' : `+/-${entry.impliedMove.toFixed(1)}%`}
            </div>
            {entry.impliedMoveExpiry && <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 7 }}>exp {entry.impliedMoveExpiry}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
