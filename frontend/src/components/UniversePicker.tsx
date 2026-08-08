import { useState } from 'react'
import axios from 'axios'
import { readPMBooks, toWeightedLegs, normalizeTicker, type WeightedLeg } from '../lib/pmImport'

async function defaultFetchPrice(ticker: string): Promise<number | null> {
  try {
    const r = await axios.get(`/api/market/quote/${encodeURIComponent(ticker)}`)
    return r.data?.current_price ?? null
  } catch {
    return null
  }
}

// Unified portfolio-selection control. Consolidates the old PMImportPicker
// (weighted legs) and the various page-local raw <select> + readPMPortfolios
// combos (plain ticker lists) into one component with one gold-accented
// chrome, one trigger label, and one empty-state fallback.

const TRIGGER_LABEL = 'Load from Portfolio Manager'
const DEFAULT_TICKER_CAP = 50

export interface ScreenHandoff {
  screens: { id: string; name: string }[]
  loading?: boolean
  onSelect: (screenId: string) => void
  triggerLabel?: string
}

interface BaseProps {
  style?: React.CSSProperties
  tickerCap?: number
  screenHandoff?: ScreenHandoff
  // Set false when the host already surfaces its own status/error copy for
  // the import (e.g. a shared note row that also covers screen-run errors),
  // so the message isn't shown twice.
  showNote?: boolean
}

interface WeightedProps extends BaseProps {
  mode: 'weighted'
  onImportWeighted: (result: { legs: WeightedLeg[]; cashWeight: number; note: string | null }, name: string) => void
  fetchPrice?: (ticker: string) => Promise<number | null>
}

interface TickersProps extends BaseProps {
  mode: 'tickers'
  onImportTickers: (tickers: string[], name: string) => void
}

type UniversePickerProps = WeightedProps | TickersProps

const CHROME: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)',
  fontSize: 11,
  padding: '6px 8px',
  outline: 'none',
  cursor: 'pointer',
}

const NOTE_STYLE: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)', lineHeight: 1.5,
}

const FALLBACK_STYLE: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)', fontSize: 9.5, color: 'var(--theme-secondary, #8099b0)',
  fontStyle: 'normal', letterSpacing: '0.01em',
}

function dedupeTickers(raw: string[], cap: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    const sym = normalizeTicker(t)
    if (!sym || sym === 'CASH' || seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
    if (out.length >= cap) break
  }
  return out
}

// Consolidated universe-selection control: pick a saved Portfolio Manager
// book (weighted legs or a plain ticker list) and, optionally, hand off to a
// saved screen. Renders the standard "no books yet" fallback instead of
// disappearing when the PM has nothing saved, so every host reads the same
// way in the empty case.
export default function UniversePicker(props: UniversePickerProps) {
  const { style, screenHandoff } = props
  const tickerCap = props.tickerCap ?? DEFAULT_TICKER_CAP
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ports = readPMBooks()

  const hasBooks = ports.length > 0
  const hasScreens = (screenHandoff?.screens.length ?? 0) > 0
  if (!hasBooks && !hasScreens) {
    return <div style={FALLBACK_STYLE}>No books yet → open Portfolio Manager</div>
  }

  const handlePortfolio = async (id: string) => {
    const p = ports.find(x => x.id === id)
    if (!p) return
    setNote(null)
    if (props.mode === 'weighted') {
      setBusy(true)
      try {
        const result = await toWeightedLegs(p, props.fetchPrice ?? defaultFetchPrice)
        props.onImportWeighted(result, p.name)
        setNote(result.legs.length === 0 && result.cashWeight === 0 ? 'Nothing to import from that portfolio.' : result.note)
      } finally {
        setBusy(false)
      }
    } else {
      const cleaned = dedupeTickers(p.holdings.map(h => h.ticker), tickerCap)
      if (cleaned.length === 0) {
        setNote(`No equity tickers found in ${p.name}.`)
        return
      }
      props.onImportTickers(cleaned, p.name)
      setNote(cleaned.length >= tickerCap ? `Loaded ${cleaned.length} from ${p.name} (capped at ${tickerCap}).` : `Loaded ${cleaned.length} from ${p.name}.`)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {hasBooks && (
          <select
            disabled={busy}
            value=""
            onChange={e => { if (e.target.value) void handlePortfolio(e.target.value) }}
            style={{ ...CHROME, ...style }}
          >
            <option value="">{busy ? 'Importing…' : TRIGGER_LABEL}</option>
            {ports.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.holdings.length} holding{p.holdings.length === 1 ? '' : 's'}{p.cash.length ? ' + cash' : ''})
              </option>
            ))}
          </select>
        )}
        {screenHandoff && hasScreens && (
          <select
            disabled={screenHandoff.loading}
            value=""
            onChange={e => { if (e.target.value) screenHandoff.onSelect(e.target.value) }}
            style={{ ...CHROME, ...style, opacity: screenHandoff.loading ? 0.6 : 1, cursor: screenHandoff.loading ? 'wait' : 'pointer' }}
          >
            <option value="">{screenHandoff.loading ? 'Running…' : (screenHandoff.triggerLabel ?? 'Load from Screener')}</option>
            {screenHandoff.screens.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
      </div>
      {props.showNote !== false && note && <div style={NOTE_STYLE}>{note}</div>}
    </div>
  )
}
