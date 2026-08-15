import { useRef, useState } from 'react'
import UniversePicker from './UniversePicker'
import { T } from '../lib/theme'
import { MONO, SANS, mix } from '../pages/cockpitKit'

// A list of tickers you build rather than a comma-separated string you type.
//
// Four ways in, because the source depends on what you are doing: typing a name
// you already have in mind, pasting a list from somewhere else, pulling a book
// you already keep in Portfolio Manager, or opening a file an export gave you.
// A single text input only serves the first two, and badly — one stray comma
// and a whole scan silently screens the wrong universe.
//
// Paste is handled deliberately: pasting "AAPL, MSFT NVDA" into the box splits
// into three chips instead of becoming one malformed entry.

const SPLIT = /[\s,;|]+/

/** Tickers out of arbitrary text. Tolerates commas, spaces, newlines, tabs,
 *  quotes and a leading $, which is what real pasted lists actually contain. */
export function parseTickers(text: string): string[] {
  return (text || '')
    .split(SPLIT)
    .map(t => t.replace(/^[$"']+|["',.]+$/g, '').trim().toUpperCase())
    .filter(t => /^[A-Z][A-Z.\-]{0,6}$/.test(t))
}

// Column names that mean a row is labels, not data. Checked across every cell,
// because "date,amount" has no symbol-ish word in column one yet DATE parses as
// a perfectly good four-letter ticker.
const HEADER_WORDS = new Set([
  'ticker', 'symbol', 'stock', 'name', 'description', 'date', 'price', 'qty',
  'quantity', 'shares', 'amount', 'value', 'cost', 'basis', 'account', 'side',
  'type', 'weight', 'position', 'currency', 'total',
])

/** Tickers out of a CSV, TSV or plain list.
 *
 *  Two shapes, told apart by their cells rather than by guessing at the
 *  extension: a holdings row is a symbol followed by numbers, so only its first
 *  column is a ticker; a list row is symbols all the way across, so every cell
 *  counts. Reading "AAPL, MSFT, NVDA" as first-column-only silently dropped two
 *  of the three.
 */
export function parseTickerFile(text: string): string[] {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const out: string[] = []
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('#')) continue
    const cells = line.split(/[,;\t]/).map(c => c.trim()).filter(Boolean)
    if (i === 0 && cells.some(c => HEADER_WORDS.has(c.toLowerCase()))) continue
    const allSymbols = cells.length > 1 && cells.every(c => parseTickers(c).length === 1)
    out.push(...(cells.length <= 1 || allSymbols ? parseTickers(line) : parseTickers(cells[0]).slice(0, 1)))
  }
  return out
}

export default function TickerBasket({ value, onChange, cap = 25, label = 'Tickers', actions }: {
  value: string[]
  onChange: (next: string[]) => void
  cap?: number
  label?: string
  /** Rendered at the end of the import row, pushed right. Lets a host put its
   *  own controls on the same line instead of spending another row on them. */
  actions?: React.ReactNode
}) {
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const add = (incoming: string[], source?: string) => {
    const merged = [...value]
    let added = 0
    for (const t of incoming) {
      if (merged.length >= cap) break
      if (!merged.includes(t)) { merged.push(t); added++ }
    }
    onChange(merged)
    const dropped = incoming.length - added
    setNote(
      added === 0 ? `Nothing new${source ? ` in ${source}` : ''}.`
        : `Added ${added}${source ? ` from ${source}` : ''}${
            merged.length >= cap && dropped > 0 ? ` · ${dropped} not added, ${cap} is the cap` : ''}.`,
    )
  }

  const commitDraft = () => {
    const hits = parseTickers(draft)
    if (hits.length) { add(hits); setDraft('') }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const hits = parseTickerFile(await file.text())
      if (!hits.length) setNote(`No tickers found in ${file.name}.`)
      else add(hits, file.name)
    } catch {
      setNote(`Could not read ${file.name}.`)
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={lbl} htmlFor="tb-input">{label} · {value.length}/{cap}</label>

      {/* The basket. Clicking anywhere focuses the input, so the whole control
          behaves like one field rather than chips sitting next to a box. */}
      <div
        onClick={() => document.getElementById('tb-input')?.focus()}
        style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
          minHeight: 32, padding: '4px 6px', cursor: 'text',
          background: T.bg, border: `1px solid ${T.goldTint(35)}`,
        }}>
        {value.map(t => (
          <span key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
            fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: T.text,
            background: T.goldTint(12), border: `1px solid ${T.goldTint(34)}`, padding: '2px 3px 2px 7px',
          }}>
            {t}
            <button onClick={e => { e.stopPropagation(); onChange(value.filter(x => x !== t)); setNote(null) }}
              aria-label={`Remove ${t}`} title={`Remove ${t}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontSize: 12, lineHeight: 1, padding: '0 3px' }}>×</button>
          </span>
        ))}
        <input
          id="tb-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); commitDraft() }
            // Backspace on an empty box removes the last chip, the way every
            // tag input behaves.
            else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={commitDraft}
          onPaste={e => {
            const text = e.clipboardData.getData('text')
            if (SPLIT.test(text.trim())) { e.preventDefault(); add(parseTickers(text), 'paste') }
          }}
          placeholder={value.length ? 'Add…' : 'Type a ticker and press Enter, or paste a list'}
          style={{
            flex: '1 1 120px', minWidth: 100, background: 'transparent', border: 'none',
            outline: 'none', color: T.text, fontFamily: MONO, fontSize: 11.5, padding: '3px 2px',
            textTransform: 'uppercase',
          }} />
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <UniversePicker
          mode="tickers"
          tickerCap={cap}
          showNote={false}
          onImportTickers={(tickers, name) => add(tickers, name)}
          style={{ fontSize: 9.5, padding: '4px 8px' }} />

        <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" style={{ display: 'none' }}
          onChange={e => void onFile(e.target.files?.[0])} />
        <button onClick={() => fileRef.current?.click()} title="CSV or text file, first column, or a plain list"
          style={btn}>Import file</button>

        {value.length > 0 && (
          <button onClick={() => { onChange([]); setNote(null) }} style={{ ...btn, color: T.muted }}>Clear</button>
        )}

        {note && (
          <span style={{ fontFamily: SANS, fontSize: 9.5, color: mix(T.muted, 85) }}>{note}</span>
        )}
        {actions && <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>{actions}</div>}
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: T.muted, display: 'block',
}
const btn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer',
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '5px 10px',
}
