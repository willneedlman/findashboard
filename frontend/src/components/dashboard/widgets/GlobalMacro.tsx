import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../../lib/theme'
import type { WidgetConfig } from '../../../hooks/useDashboard'

interface BoardRow {
  label: string
  symbol: string
  price: number | null
  change_pct: number | null
  status: string
}

interface BoardSection {
  name: string
  rows: BoardRow[]
}

interface BoardResponse {
  sections: BoardSection[]
  as_of: string
  window: string
}

const WINDOWS = ['10m', '30m', '1h', '1d', '1w', '1m', 'ytd']
const SECTION_COLOR: Record<string, string> = {
  Americas: T.pos,
  Europe: T.blue,
  'Asia-Pacific': 'var(--theme-accent-violet, #a78bfa)',
  FX: T.blue,
  Commodities: 'var(--theme-accent-orange, #f97316)',
  'US Yields': T.gold,
  Crypto: T.warn,
}

const CATEGORY_SECTIONS: Record<string, string[]> = {
  equity: ['Americas', 'Europe', 'Asia-Pacific'],
  fx: ['FX'],
  commodity: ['Commodities'],
  bond: ['US Yields'],
  vol: ['Americas'],
  crypto: ['Crypto'],
}

function visibleSections(data: BoardResponse | undefined, categories?: string[]): BoardSection[] {
  if (!data) return []
  if (!categories?.length) return data.sections
  const names = new Set(categories.flatMap(category => CATEGORY_SECTIONS[category] ?? [category]))
  return data.sections.filter(section => names.has(section.name))
}

function formatPrice(row: BoardRow, section: string): string {
  if (row.price == null) return '-'
  if (section === 'US Yields') return `${row.price.toFixed(2)}%`
  if (section === 'FX') return row.price < 10 ? row.price.toFixed(4) : row.price.toFixed(2)
  return row.price.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export default function GlobalMacro({ config }: { config: WidgetConfig }) {
  const [window, setWindow] = useState('1d')
  const { data, isLoading, isError } = useQuery<BoardResponse>({
    queryKey: ['global-macro-board', window],
    queryFn: () => axios.get(`/api/market/global-board?window=${window}`).then(r => r.data),
    staleTime: 120_000,
    refetchInterval: 120_000,
    retry: 1,
  })
  const sections = visibleSections(data, config.categories)
  const onlyVol = config.categories?.length === 1 && config.categories[0] === 'vol'
  const selectedSymbols = new Set((config.macroSymbols ?? []).map(symbol => symbol.toUpperCase()))
  const rowLimit = config.displayState === 'minimum' ? 3 : config.displayState === 'compact' ? 6 : Infinity

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', gap: 2, padding: '3px 6px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {WINDOWS.map(value => (
          <button key={value} onClick={() => setWindow(value)} style={{
            border: `1px solid ${value === window ? T.gold : T.border}`,
            background: value === window ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent',
            color: value === window ? T.gold : T.muted,
            fontFamily: T.mono, fontSize: 8, padding: '1px 5px', cursor: 'pointer',
          }}>
            {value.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading && <div style={{ padding: 12, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>Loading global markets...</div>}
        {isError && <div style={{ padding: 12, color: T.neg, fontFamily: T.mono, fontSize: 10 }}>Global markets unavailable</div>}
        {sections.map(section => (
          <div key={section.name}>
            <div style={{
              padding: '4px 10px 2px', borderBottom: `1px solid ${T.border}`,
              color: SECTION_COLOR[section.name] ?? T.gold, fontFamily: T.mono,
              fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              {section.name}
            </div>
            {section.rows
              .filter(row => section.name !== 'Americas' || !onlyVol || row.symbol === '^VIX')
              .filter(row => !selectedSymbols.size || selectedSymbols.has(row.symbol.toUpperCase()))
              .slice(0, rowLimit)
              .map(row => (
                <div key={row.symbol} style={{
                  display: 'flex', alignItems: 'center', padding: '4px 10px',
                  borderBottom: `1px solid ${T.border}`, gap: 8,
                }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text, fontFamily: T.label, fontSize: 10 }}>
                    {row.label}
                  </span>
                  <span style={{ color: T.text, fontFamily: T.mono, fontSize: 10 }}>{formatPrice(row, section.name)}</span>
                  <span style={{
                    minWidth: 52, textAlign: 'right', fontFamily: T.mono, fontSize: 9,
                    color: row.change_pct == null ? T.muted : row.change_pct >= 0 ? T.pos : T.neg,
                  }}>
                    {row.change_pct == null ? '-' : `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%`}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}
