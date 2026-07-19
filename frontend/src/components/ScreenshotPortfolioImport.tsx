import { useCallback, useRef, useState } from 'react'
import axios from 'axios'
import { ImagePlus } from 'lucide-react'
import { T } from '../lib/theme'
import { normalizeTicker } from '../lib/pmImport'

// Upload/paste a screenshot of a brokerage holdings table and have the backend
// (Claude vision — see backend/routers/portfolio_import.py) extract ticker/
// shares/avg-cost rows. Nothing is committed to the portfolio until the user
// reviews and confirms each row here — AI-read numbers are shown editable,
// never silently trusted, since a misread share count is real money.

interface ParsedRow { ticker: string; shares: number; avgCost: number | null; include: boolean }
interface ImportedHolding { ticker: string; shares: number; avgCost: number | null }

const triggerBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
  fontFamily: T.label, fontSize: 9, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', padding: '6px 10px', cursor: 'pointer',
  width: '100%', justifyContent: 'center', marginTop: 8,
}
const primaryBtn: React.CSSProperties = {
  background: T.gold, border: 'none', color: 'var(--theme-bg)',
  fontFamily: T.label, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 0', cursor: 'pointer', flex: 1,
}
const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
  fontFamily: T.label, fontSize: 9, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 10px', cursor: 'pointer',
}
const rowInp: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono,
  fontSize: 11, padding: '4px 6px', width: '100%', outline: 'none', boxSizing: 'border-box',
}

export default function ScreenshotPortfolioImport({ onImport }: { onImport: (rows: ImportedHolding[]) => void }) {
  const [open, setOpen] = useState(false)
  const [imgDataUrl, setImgDataUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [rows, setRows] = useState<ParsedRow[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => { setImgDataUrl(null); setRows(null); setError(null); setWarning(null) }
  const close = () => { setOpen(false); reset() }

  const loadFile = (file: File) => {
    reset()
    const reader = new FileReader()
    reader.onload = ev => setImgDataUrl(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadFile(file)
    e.target.value = ''
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (file) loadFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/'))
    if (file) loadFile(file)
  }

  const parse = useCallback(() => {
    if (!imgDataUrl) return
    setBusy(true); setError(null); setWarning(null)
    axios.post('/api/portfolio-import/screenshot', { image_base64: imgDataUrl })
      .then(r => {
        const holdings = r.data.holdings as ImportedHolding[]
        setRows(holdings.map(h => ({ ...h, include: true })))
        setWarning(r.data.warning ?? null)
      })
      .catch(e => setError(e?.response?.data?.detail || 'Could not parse that screenshot.'))
      .finally(() => setBusy(false))
  }, [imgDataUrl])

  const updateRow = (i: number, patch: Partial<ParsedRow>) =>
    setRows(prev => prev ? prev.map((r, j) => (j === i ? { ...r, ...patch } : r)) : prev)

  const included = rows?.filter(r => r.include) ?? []

  const commit = () => {
    const toImport = included
      .filter(r => r.ticker.trim() && r.shares > 0)
      .map(r => ({ ticker: normalizeTicker(r.ticker), shares: r.shares, avgCost: r.avgCost }))
    if (!toImport.length) return
    onImport(toImport)
    close()
  }

  return (
    <>
      <button onClick={() => setOpen(true)} style={triggerBtn}>
        <ImagePlus size={12} /> Import from Screenshot
      </button>

      {open && (
        <div onClick={close} role="dialog" aria-modal="true" aria-label="Import portfolio from screenshot"
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 'min(560px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: T.surface, border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 34%, transparent)`, borderRadius: 8, boxShadow: '0 24px 70px rgba(0,0,0,0.55)', overflow: 'hidden' }}>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
              <span style={{ fontFamily: T.label, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>Import from Screenshot</span>
              <button onClick={close} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontSize: 16, lineHeight: 1 }}>×</button>
            </div>

            <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {!rows && (
                <>
                  <div onPaste={handlePaste} onDrop={handleDrop} onDragOver={e => e.preventDefault()}
                    onClick={() => fileRef.current?.click()} tabIndex={0}
                    style={{ border: `1px dashed ${T.border}`, borderRadius: 6, padding: imgDataUrl ? 8 : 24, textAlign: 'center', cursor: 'pointer', color: T.muted, fontFamily: T.mono, fontSize: 11, lineHeight: 1.6 }}>
                    {imgDataUrl
                      ? <img src={imgDataUrl} alt="Selected portfolio screenshot" style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 4, display: 'block', margin: '0 auto' }} />
                      : <>Click to choose a file, drag one in, or paste (⌘V / Ctrl-V) a screenshot of your portfolio holdings</>}
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
                  {error && <div style={{ color: T.neg, fontFamily: T.mono, fontSize: 11 }}>{error}</div>}
                  <button onClick={parse} disabled={!imgDataUrl || busy} style={{ ...primaryBtn, opacity: (!imgDataUrl || busy) ? 0.5 : 1, cursor: (!imgDataUrl || busy) ? 'default' : 'pointer' }}>
                    {busy ? 'Parsing…' : 'Parse Screenshot'}
                  </button>
                </>
              )}

              {rows && (
                <>
                  {warning && <div style={{ color: T.gold, fontFamily: T.mono, fontSize: 10.5 }}>{warning}</div>}
                  {rows.length === 0 ? (
                    <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11 }}>No holdings found — try a clearer screenshot.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '18px 1fr 76px 90px', gap: 8, fontFamily: T.label, fontSize: 8.5, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        <span /><span>Ticker</span><span>Shares</span><span>Avg Cost</span>
                      </div>
                      {rows.map((r, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '18px 1fr 76px 90px', gap: 8, alignItems: 'center', opacity: r.include ? 1 : 0.45 }}>
                          <input type="checkbox" checked={r.include} onChange={e => updateRow(i, { include: e.target.checked })} />
                          <input value={r.ticker} onChange={e => updateRow(i, { ticker: e.target.value.toUpperCase() })} style={rowInp} />
                          <input type="number" value={r.shares} onChange={e => updateRow(i, { shares: parseFloat(e.target.value) || 0 })} style={{ ...rowInp, textAlign: 'right' }} />
                          <input type="number" value={r.avgCost ?? ''} placeholder="—" onChange={e => updateRow(i, { avgCost: e.target.value === '' ? null : (parseFloat(e.target.value) || 0) })} style={{ ...rowInp, textAlign: 'right' }} />
                        </div>
                      ))}
                      <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, marginTop: 2, lineHeight: 1.5 }}>
                        Review before importing — AI-read values can be wrong. Blank avg cost keeps any existing cost basis for that ticker.
                      </p>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={reset} style={ghostBtn}>← Back</button>
                    <button onClick={commit} disabled={included.length === 0} style={{ ...primaryBtn, opacity: included.length === 0 ? 0.5 : 1, cursor: included.length === 0 ? 'default' : 'pointer' }}>
                      Import {included.length} Holding{included.length === 1 ? '' : 's'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
