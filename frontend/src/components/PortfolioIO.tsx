/**
 * PortfolioIO — Import / Export for portfolio and ticker-list pages.
 *
 * Two modes:
 *   mode="portfolio"  — full Asset[] with ticker, weight, strategy, stratParams
 *   mode="tickers"    — simple string[] of tickers
 *
 * Supported file formats:
 *   JSON (.json)  — native format (both modes)
 *   CSV  (.csv)   — "TICKER,WEIGHT" or "TICKER" (one per line)
 */

import { useRef } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioAsset {
  ticker: string
  weight: number
  strategy?: string
  stratParams?: Record<string, unknown>
}

type Mode = 'portfolio' | 'tickers'

interface PortfolioIOProps {
  mode: Mode
  // portfolio mode
  assets?: PortfolioAsset[]
  onImportAssets?: (assets: PortfolioAsset[]) => void
  // tickers mode
  tickers?: string[]
  onImportTickers?: (tickers: string[]) => void
  // optional label suffix shown in the file name
  name?: string
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)', muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
}

const btn = (primary = false): React.CSSProperties => ({
  flex: 1,
  fontFamily: S.label, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '6px 0', cursor: 'pointer',
  border: `1px solid ${primary ? S.gold : S.border}`,
  background: primary ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : 'transparent',
  color: primary ? S.gold : S.muted,
  transition: 'all 0.12s',
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function parseFile(text: string, filename: string): { assets?: PortfolioAsset[]; tickers?: string[] } | null {
  const lower = filename.toLowerCase()

  // ── JSON ──────────────────────────────────────────────────────────────────
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(text)
      if (Array.isArray(obj)) {
        // bare array of assets or tickers
        if (typeof obj[0] === 'string') return { tickers: obj.map((t: string) => t.trim().toUpperCase()).filter(Boolean) }
        return { assets: obj.map(normalizeAsset) }
      }
      if (obj.assets)  return { assets: (obj.assets as PortfolioAsset[]).map(normalizeAsset) }
      if (obj.tickers) return { tickers: (obj.tickers as string[]).map((t: string) => t.trim().toUpperCase()).filter(Boolean) }
    } catch { /* fall through */ }
    return null
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const assets: PortfolioAsset[] = []
    const tickers: string[] = []
    for (const line of lines) {
      const parts = line.split(',')
      const ticker = parts[0].trim().toUpperCase()
      if (!ticker) continue
      const weight = parseFloat(parts[1])
      if (!isNaN(weight)) assets.push({ ticker, weight, strategy: parts[2]?.trim() })
      else tickers.push(ticker)
    }
    if (assets.length > 0) return { assets }
    if (tickers.length > 0) return { tickers }
  }

  return null
}

function normalizeAsset(a: Partial<PortfolioAsset>): PortfolioAsset {
  return {
    ticker:     String(a.ticker ?? '').toUpperCase().trim(),
    weight:     Number(a.weight ?? 0),
    strategy:   a.strategy,
    stratParams: a.stratParams ?? {},
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function PortfolioIO({ mode, assets, onImportAssets, tickers, onImportTickers, name }: PortfolioIOProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  // ── Export ─────────────────────────────────────────────────────────────────
  function handleExport(format: 'json' | 'csv') {
    const slug = (name ?? 'portfolio').toLowerCase().replace(/\s+/g, '-')
    const date = new Date().toISOString().split('T')[0]

    if (mode === 'portfolio' && assets) {
      if (format === 'json') {
        const payload = { version: 1, type: 'portfolio', exported: date, assets }
        downloadFile(JSON.stringify(payload, null, 2), `${slug}-${date}.json`, 'application/json')
      } else {
        const header = '# ticker,weight,strategy'
        const rows   = assets.map(a => `${a.ticker},${a.weight},${a.strategy ?? ''}`)
        downloadFile([header, ...rows].join('\n'), `${slug}-${date}.csv`, 'text/csv')
      }
    }

    if (mode === 'tickers' && tickers) {
      if (format === 'json') {
        const payload = { version: 1, type: 'tickers', exported: date, tickers }
        downloadFile(JSON.stringify(payload, null, 2), `${slug}-${date}.json`, 'application/json')
      } else {
        downloadFile(['# ticker', ...tickers].join('\n'), `${slug}-${date}.csv`, 'text/csv')
      }
    }
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const parsed = parseFile(text, file.name)
      if (!parsed) { alert('Could not parse file. Use JSON or CSV format.'); return }

      if (mode === 'portfolio' && onImportAssets) {
        const importedAssets = parsed.assets ?? parsed.tickers?.map(t => ({ ticker: t, weight: Math.round(100 / (parsed.tickers!.length)), strategy: undefined, stratParams: {} }))
        if (importedAssets) onImportAssets(importedAssets)
      }
      if (mode === 'tickers' && onImportTickers) {
        const importedTickers = parsed.tickers ?? parsed.assets?.map(a => a.ticker)
        if (importedTickers) onImportTickers(importedTickers)
      }
    }
    reader.readAsText(file)
    e.target.value = ''   // allow re-importing the same file
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontFamily: S.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: S.muted }}>
        Portfolio I/O
      </span>

      {/* Import row */}
      <div style={{ display: 'flex', gap: 4 }}>
        <input ref={fileRef} type="file" accept=".json,.csv,.txt" style={{ display: 'none' }} onChange={handleFileChange} />
        <button style={btn(true)} onClick={() => fileRef.current?.click()}>
          ↑ Import
        </button>
      </div>

      {/* Export row */}
      <div style={{ display: 'flex', gap: 4 }}>
        <button style={btn()} onClick={() => handleExport('json')}>↓ JSON</button>
        <button style={btn()} onClick={() => handleExport('csv')}>↓ CSV</button>
      </div>

      {/* Format hint */}
      <span style={{ fontFamily: S.label, fontSize: 8, color: 'var(--theme-text-faint, var(--theme-text-faint, rgba(255,255,255,0.22)))', lineHeight: 1.4 }}>
        {mode === 'portfolio'
          ? 'JSON · CSV (ticker,weight,strategy) · or bare ticker list'
          : 'JSON · CSV (one ticker per line)'}
      </span>
    </div>
  )
}
