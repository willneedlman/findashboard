import { useState } from 'react'
import axios from 'axios'
import { readPMBooks, toWeightedLegs, type ImportResult } from '../lib/pmImport'

async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const r = await axios.get(`/api/market/quote/${encodeURIComponent(ticker)}`)
    return r.data?.current_price ?? null
  } catch {
    return null
  }
}

// Dropdown that loads a saved Portfolio Manager portfolio and hands the caller
// market-value-weighted equity legs plus a cash-sleeve weight. Surfaces the
// "excluded options/futures" note itself so every host gets consistent feedback.
// With no saved portfolios it renders nothing by default; pass `emptyLabel` to
// keep the control visible as a disabled placeholder instead, so a host that
// presents this as one of its primary inputs doesn't lose the affordance
// entirely when the book is empty.
export default function PMImportPicker({
  onImport, style, emptyLabel,
}: {
  onImport: (result: ImportResult, name: string) => void
  style?: React.CSSProperties
  emptyLabel?: string
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ports = readPMBooks()
  if (ports.length === 0) {
    if (!emptyLabel) return null
    return (
      <select disabled value="" style={style} aria-label={emptyLabel}>
        <option value="">{emptyLabel}</option>
      </select>
    )
  }

  const handle = async (id: string) => {
    const p = ports.find(x => x.id === id)
    if (!p) return
    setBusy(true)
    setNote(null)
    try {
      const result = await toWeightedLegs(p, fetchPrice)
      onImport(result, p.name)
      setNote(result.legs.length === 0 && result.cashWeight === 0
        ? 'Nothing to import from that portfolio.'
        : result.note)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <select
        disabled={busy}
        value=""
        onChange={e => { if (e.target.value) handle(e.target.value) }}
        style={style}
      >
        <option value="">{busy ? 'Importing…' : 'Load from Portfolio Manager'}</option>
        {ports.map(p => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.holdings.length} holding{p.holdings.length === 1 ? '' : 's'}{p.cash.length ? ' + cash' : ''})
          </option>
        ))}
      </select>
      {note && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #5e768f)', lineHeight: 1.5 }}>
          {note}
        </div>
      )}
    </div>
  )
}
