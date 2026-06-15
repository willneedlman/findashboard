import { useState } from 'react'
import axios from 'axios'
import { readPMPortfolios, toWeightedLegs, type ImportResult } from '../lib/pmImport'

async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const r = await axios.get(`/api/market/quote/${encodeURIComponent(ticker)}`)
    return r.data?.current_price ?? null
  } catch {
    return null
  }
}

// Dropdown that loads a saved Portfolio Manager portfolio and hands the caller
// market-value-weighted equity legs plus a cash-sleeve weight. Renders nothing
// when the PM has no saved portfolios. Surfaces the "excluded options/futures"
// note itself so every host gets consistent feedback.
export default function PMImportPicker({
  onImport, style,
}: {
  onImport: (result: ImportResult, name: string) => void
  style?: React.CSSProperties
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ports = readPMPortfolios()
  if (ports.length === 0) return null

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
