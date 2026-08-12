import { useCallback, useRef, useState } from 'react'
import axios from 'axios'
import { ImagePlus } from 'lucide-react'
import { T } from '../lib/theme'
import { normalizeTicker } from '../lib/pmImport'

// Upload/paste one or more screenshots of a brokerage holdings table and have
// the backend (Claude vision — see backend/routers/portfolio_import.py)
// extract ticker/shares/avg-cost rows. Each screenshot is parsed independently
// in parallel and the results are merged into one review list. Nothing is
// committed to the portfolio until the user reviews and confirms each row
// here — AI-read numbers are shown editable, never silently trusted, since a
// misread share count is real money.

interface ParsedRow { ticker: string; shares: number; avgCost: number | null; include: boolean }
interface ImportedHolding { ticker: string; shares: number; avgCost: number | null }
interface ImportedOption { underlying: string; type: 'call' | 'put'; strike: number; expiry: string; side: 'long' | 'short'; contracts: number; avgPremium: number | null }
interface ImportedCash { label: string; amount: number }
interface ParsedOptionRow extends ImportedOption { include: boolean }
interface ParsedCashRow extends ImportedCash { include: boolean }
interface PendingImage { id: number; dataUrl: string }

const MAX_IMAGES = 8

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

export default function ScreenshotPortfolioImport({ onImport }: { onImport: (payload: { holdings: ImportedHolding[]; options: ImportedOption[]; cash: ImportedCash[] }) => void }) {
  const [open, setOpen] = useState(false)
  const [images, setImages] = useState<PendingImage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [rows, setRows] = useState<ParsedRow[] | null>(null)
  const [optRows, setOptRows] = useState<ParsedOptionRow[]>([])
  const [cashRows, setCashRows] = useState<ParsedCashRow[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)

  const resetResults = () => { setRows(null); setOptRows([]); setCashRows([]); setError(null); setWarning(null) }
  const clearAll = () => { setImages([]); resetResults() }
  const close = () => { setOpen(false); clearAll() }

  const addFiles = (files: File[]) => {
    const imgs = files.filter(f => f.type.startsWith('image/'))
    imgs.forEach(file => {
      const reader = new FileReader()
      reader.onload = ev => {
        const dataUrl = ev.target?.result as string
        setImages(prev => {
          if (prev.length >= MAX_IMAGES) {
            setError(`You can add up to ${MAX_IMAGES} screenshots at a time.`)
            return prev
          }
          return [...prev, { id: nextId.current++, dataUrl }]
        })
      }
      reader.readAsDataURL(file)
    })
  }

  const removeImage = (id: number) => setImages(prev => prev.filter(img => img.id !== id))

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter(i => i.type.startsWith('image/'))
      .map(i => i.getAsFile())
      .filter((f): f is File => !!f)
    addFiles(files)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    addFiles(Array.from(e.dataTransfer.files))
  }

  const parse = useCallback(() => {
    if (!images.length) return
    setBusy(true); setError(null); setWarning(null)
    Promise.allSettled(images.map(img => axios.post('/api/portfolio-import/screenshot', { image_base64: img.dataUrl })))
      .then(results => {
        const holdings: ImportedHolding[] = []
        const options: ImportedOption[] = []
        const cash: ImportedCash[] = []
        const notes: string[] = []
        results.forEach((res, i) => {
          const label = images.length > 1 ? `Screenshot ${i + 1}: ` : ''
          if (res.status === 'fulfilled') {
            holdings.push(...(res.value.data.holdings as ImportedHolding[]))
            options.push(...((res.value.data.options ?? []) as ImportedOption[]))
            cash.push(...((res.value.data.cash ?? []) as ImportedCash[]))
            if (res.value.data.warning) notes.push(`${label}${res.value.data.warning}`)
          } else {
            const detail = res.reason?.response?.data?.detail || 'could not be parsed'
            notes.push(`${label}${detail}`)
          }
        })
        setRows(holdings.map(h => ({ ...h, include: true })))
        setOptRows(options.map(o => ({ ...o, include: true })))
        setCashRows(cash.map(c => ({ ...c, include: true })))
        setWarning(notes.length ? notes.join(' · ') : null)
      })
      .finally(() => setBusy(false))
  }, [images])

  const updateRow = (i: number, patch: Partial<ParsedRow>) =>
    setRows(prev => prev ? prev.map((r, j) => (j === i ? { ...r, ...patch } : r)) : prev)
  const updateCashRow = (i: number, patch: Partial<ParsedCashRow>) =>
    setCashRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const updateOptRow = (i: number, patch: Partial<ParsedOptionRow>) =>
    setOptRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const included = rows?.filter(r => r.include) ?? []
  const includedOpts = optRows.filter(r => r.include)

  const commit = () => {
    const cash = cashRows.filter(c => c.include).map(({ include: _i, ...c }) => c)
    const holdings = included
      .filter(r => r.ticker.trim() && r.shares > 0)
      .map(r => ({ ticker: normalizeTicker(r.ticker), shares: r.shares, avgCost: r.avgCost }))
    const options = includedOpts
      .filter(r => r.underlying.trim() && r.strike > 0 && r.expiry.trim() && r.contracts > 0)
      .map(r => ({ ...r, underlying: normalizeTicker(r.underlying) }))
    if (!holdings.length && !options.length && !cash.length) return
    onImport({ holdings, options, cash })
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
                  {images.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
                      {images.map(img => (
                        <div key={img.id} style={{ position: 'relative', border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden', aspectRatio: '1', background: T.bg }}>
                          <img src={img.dataUrl} alt="Selected portfolio screenshot" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          <button onClick={() => removeImage(img.id)} disabled={busy} aria-label="Remove screenshot"
                            style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, lineHeight: '16px', textAlign: 'center', background: 'rgba(0,0,0,0.65)', border: 'none', color: '#fff', fontSize: 12, cursor: busy ? 'default' : 'pointer', borderRadius: 3, padding: 0 }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {images.length < MAX_IMAGES && (
                    <div onPaste={handlePaste} onDrop={handleDrop} onDragOver={e => e.preventDefault()}
                      onClick={() => fileRef.current?.click()} tabIndex={0}
                      style={{ border: `1px dashed ${T.border}`, borderRadius: 6, padding: images.length ? 14 : 24, textAlign: 'center', cursor: 'pointer', color: T.muted, fontFamily: T.mono, fontSize: 11, lineHeight: 1.6 }}>
                      {images.length
                        ? <>+ Add another screenshot ({images.length}/{MAX_IMAGES})</>
                        : <>Click to choose file(s), drag them in, or paste (⌘V / Ctrl-V). Add as many screenshots as you need</>}
                    </div>
                  )}
                  <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileChange} />
                  {error && <div style={{ color: T.neg, fontFamily: T.mono, fontSize: 11 }}>{error}</div>}
                  <button onClick={parse} disabled={!images.length || busy} style={{ ...primaryBtn, opacity: (!images.length || busy) ? 0.5 : 1, cursor: (!images.length || busy) ? 'default' : 'pointer' }}>
                    {busy ? 'Parsing…' : images.length > 1 ? `Parse ${images.length} Screenshots` : 'Parse Screenshot'}
                  </button>
                </>
              )}

              {rows && (
                <>
                  {warning && <div style={{ color: T.gold, fontFamily: T.mono, fontSize: 10.5 }}>{warning}</div>}
                  {rows.length === 0 && optRows.length === 0 ? (
                    <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11 }}>No positions found. Try a clearer screenshot.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {rows.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontFamily: T.label, fontSize: 8.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Shares</div>
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
                        </div>
                      )}

                      {optRows.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontFamily: T.label, fontSize: 8.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Options</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '18px 1fr 46px 60px 84px 52px 44px 64px', gap: 5, fontFamily: T.label, fontSize: 8, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            <span /><span>Underlying</span><span>Type</span><span>Strike</span><span>Expiry</span><span>Side</span><span>Qty</span><span>Premium</span>
                          </div>
                          {optRows.map((r, i) => (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: '18px 1fr 46px 60px 84px 52px 44px 64px', gap: 5, alignItems: 'center', opacity: r.include ? 1 : 0.45 }}>
                              <input type="checkbox" checked={r.include} onChange={e => updateOptRow(i, { include: e.target.checked })} />
                              <input value={r.underlying} onChange={e => updateOptRow(i, { underlying: e.target.value.toUpperCase() })} style={rowInp} />
                              <select value={r.type} onChange={e => updateOptRow(i, { type: e.target.value as 'call' | 'put' })} style={{ ...rowInp, padding: '4px 2px' }}>
                                <option value="call">Call</option><option value="put">Put</option>
                              </select>
                              <input type="number" value={r.strike} onChange={e => updateOptRow(i, { strike: parseFloat(e.target.value) || 0 })} style={{ ...rowInp, textAlign: 'right' }} />
                              <input value={r.expiry} placeholder="YYYY-MM-DD" onChange={e => updateOptRow(i, { expiry: e.target.value })} style={rowInp} />
                              <select value={r.side} onChange={e => updateOptRow(i, { side: e.target.value as 'long' | 'short' })} style={{ ...rowInp, padding: '4px 2px' }}>
                                <option value="long">Long</option><option value="short">Short</option>
                              </select>
                              <input type="number" value={r.contracts} onChange={e => updateOptRow(i, { contracts: parseFloat(e.target.value) || 0 })} style={{ ...rowInp, textAlign: 'right' }} />
                              <input type="number" value={r.avgPremium ?? ''} placeholder="—" onChange={e => updateOptRow(i, { avgPremium: e.target.value === '' ? null : (parseFloat(e.target.value) || 0) })} style={{ ...rowInp, textAlign: 'right' }} />
                            </div>
                          ))}
                          <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, lineHeight: 1.5 }}>
                            Each contract imports as a single-leg position. Premium is per share (cost per contract ÷ 100).
                          </p>
                        </div>
                      )}

                      {(
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontFamily: T.label, fontSize: 8.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Cash</span>
                            <button
                              onClick={() => setCashRows(prev => [...prev, { label: 'Cash', amount: 0, include: true }])}
                              style={{ ...ghostBtn, padding: '3px 8px', fontSize: 8 }}
                            >+ Add</button>
                          </div>
                          {cashRows.length === 0 && (
                            <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, lineHeight: 1.5 }}>
                              No cash balance was found in this screenshot. Add one if your broker shows it on a different screen.
                            </p>
                          )}
                          <div style={{ display: 'grid', gridTemplateColumns: '18px 1fr 110px', gap: 5, fontFamily: T.label, fontSize: 8, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            <span /><span>Label</span><span>Amount</span>
                          </div>
                          {cashRows.map((r, i) => (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: '18px 1fr 110px', gap: 5, alignItems: 'center', opacity: r.include ? 1 : 0.45 }}>
                              <input type="checkbox" checked={r.include} onChange={e => updateCashRow(i, { include: e.target.checked })} />
                              <input value={r.label} onChange={e => updateCashRow(i, { label: e.target.value })} style={rowInp} />
                              <input type="number" value={r.amount} onChange={e => updateCashRow(i, { amount: parseFloat(e.target.value) || 0 })} style={{ ...rowInp, textAlign: 'right' }} />
                            </div>
                          ))}
                          <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, lineHeight: 1.5 }}>
                            Cash imports at a zero accrual rate. Buying power and account totals are excluded on purpose: buying power is a borrowing limit, and a total would double-count the positions above.
                          </p>
                        </div>
                      )}

                      <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, lineHeight: 1.5 }}>
                        Review before importing. Read values can be wrong. Blank avg cost keeps any existing cost basis for that ticker.
                      </p>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={resetResults} style={ghostBtn}>← Back</button>
                    <button onClick={commit} disabled={included.length + includedOpts.length === 0} style={{ ...primaryBtn, opacity: included.length + includedOpts.length === 0 ? 0.5 : 1, cursor: included.length + includedOpts.length === 0 ? 'default' : 'pointer' }}>
                      Import {included.length + includedOpts.length + cashRows.filter(c => c.include).length} Item{included.length + includedOpts.length + cashRows.filter(c => c.include).length === 1 ? '' : 's'}
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
