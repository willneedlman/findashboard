import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

interface Row { ticker: string; companyName: string; price: number | null; change1d: number | null }
interface ScreenResp { results: Row[] }
interface Filter { field: string; operator: string; value: number }

// Each screen is a named filter + sort combination using the backend's real
// fields/operators (gt | lt | gte | lte). The first four are pure sorts; the
// rest apply fundamental filters.
const SCREENS: { key: string; label: string; filters: Filter[]; sort_by: string; sort_dir: 'asc' | 'desc' }[] = [
  { key: 'mktcap',   label: 'Mkt Cap',  filters: [], sort_by: 'marketCap', sort_dir: 'desc' },
  { key: 'gainers',  label: 'Gainers',  filters: [], sort_by: 'change1d',  sort_dir: 'desc' },
  { key: 'losers',   label: 'Losers',   filters: [], sort_by: 'change1d',  sort_dir: 'asc'  },
  { key: 'volume',   label: 'Volume',   filters: [], sort_by: 'volume',    sort_dir: 'desc' },
  { key: 'value',    label: 'Value',    filters: [{ field: 'peRatio', operator: 'gt', value: 0 }, { field: 'peRatio', operator: 'lt', value: 18 }], sort_by: 'peRatio', sort_dir: 'asc' },
  { key: 'growth',   label: 'Growth',   filters: [{ field: 'revenueGrowth', operator: 'gt', value: 20 }], sort_by: 'revenueGrowth', sort_dir: 'desc' },
  { key: 'dividend', label: 'Dividend', filters: [{ field: 'dividendYield', operator: 'gt', value: 3 }], sort_by: 'dividendYield', sort_dir: 'desc' },
  { key: 'quality',  label: 'Quality',  filters: [{ field: 'roe', operator: 'gt', value: 15 }], sort_by: 'roe', sort_dir: 'desc' },
]

const SECTORS = ['Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical', 'Industrials', 'Communication Services', 'Consumer Defensive', 'Energy', 'Utilities', 'Real Estate', 'Basic Materials']

const selectStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.text,
  fontFamily: T.mono, fontSize: 9.5, padding: '2px 4px', outline: 'none', cursor: 'pointer', width: '100%',
}

export default function ScreenerWidget({ config: _config }: { config: WidgetConfig }) {
  const [key, setKey] = useState('mktcap')
  const [sector, setSector] = useState('')
  const screen = SCREENS.find(s => s.key === key) ?? SCREENS[0]

  const { data, isLoading, isError } = useQuery<ScreenResp>({
    queryKey: ['screener-widget', screen.key, sector],
    queryFn: () => axios.post('/api/screener/run', {
      filters: screen.filters, sector: sector || null, exchange: null,
      sort_by: screen.sort_by, sort_dir: screen.sort_dir, limit: 25,
    }).then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })

  const rows = data?.results ?? []
  const TH: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { fontFamily: T.mono, fontSize: 10.5, padding: '4px 8px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', padding: '3px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {SCREENS.map(s => (
          <button key={s.key} onClick={() => setKey(s.key)} style={{
            fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '1px 7px',
            border: key === s.key ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
            background: key === s.key ? 'rgba(201,168,76,0.12)' : 'transparent',
            color: key === s.key ? T.gold : 'rgba(255,255,255,0.3)',
            cursor: 'pointer', letterSpacing: '0.06em',
          }}>{s.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>Sector</span>
        <select value={sector} onChange={e => setSector(e.target.value)} style={selectStyle}>
          <option value="">All sectors</option>
          {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {isLoading && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Running screen…</div>}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Screen failed — check FMP key</div>}

      {data && (
        rows.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>No matches.</div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: T.surface }}>
                  <th style={{ ...TH, textAlign: 'left' }}>Ticker</th>
                  <th style={TH}>Price</th>
                  <th style={TH}>1D</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.ticker} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ ...TD, textAlign: 'left' }}>
                      <span style={{ color: T.gold, fontWeight: 700 }}>{r.ticker}</span>
                      <span style={{ color: T.muted, fontSize: 8.5, marginLeft: 6 }}>{(r.companyName ?? '').slice(0, 16)}</span>
                    </td>
                    <td style={TD}>{r.price != null ? `$${r.price.toFixed(2)}` : '—'}</td>
                    <td style={{ ...TD, color: r.change1d == null ? T.muted : r.change1d >= 0 ? T.pos : T.neg }}>
                      {r.change1d == null ? '—' : `${r.change1d >= 0 ? '+' : ''}${r.change1d.toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
