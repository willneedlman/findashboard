import { useState, useEffect, useCallback } from 'react'
import PageWrapper from '../components/PageWrapper'
import TickerInput from '../components/TickerInput'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'

// ── Types ─────────────────────────────────────────────────────────────────────

type Direction = 'Long' | 'Short' | 'Long Call' | 'Long Put' | 'Short Call' | 'Short Put' | 'Spread'
type Status = 'Watching' | 'Open' | 'Closed' | 'Cancelled'

interface Trade {
  id: string
  ticker: string
  direction: Direction
  entryDate: string
  entryPrice: number
  size: number
  stopLoss: number | null
  target: number | null
  thesis: string
  tags: string[]
  status: Status
  exitDate: string | null
  exitPrice: number | null
  notes: string
}

const STORAGE_KEY = 'ft-trade-journal'
const TODAY = new Date().toISOString().slice(0, 10)
const DIRECTIONS: Direction[] = ['Long', 'Short', 'Long Call', 'Long Put', 'Short Call', 'Short Put', 'Spread']
const STATUSES: Status[] = ['Watching', 'Open', 'Closed', 'Cancelled']
const ALL_TAGS = ['momentum', 'earnings', 'technical', 'macro', 'squeeze', 'value', 'options']

// ── Derived computations ───────────────────────────────────────────────────────

function calcPnl(t: Trade): number | null {
  if (t.exitPrice == null || t.status !== 'Closed') return null
  const sign = t.direction.startsWith('Short') ? -1 : 1
  return (t.exitPrice - t.entryPrice) * t.size * sign
}

function calcPnlPct(t: Trade): number | null {
  if (t.exitPrice == null || t.status !== 'Closed') return null
  return ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100
}

function calcRMultiple(t: Trade): number | null {
  const pnl = calcPnl(t)
  if (pnl == null || t.stopLoss == null) return null
  const risk = Math.abs(t.entryPrice - t.stopLoss) * t.size
  if (risk === 0) return null
  return pnl / risk
}

function daysHeld(t: Trade): number | null {
  if (!t.exitDate) return null
  const a = new Date(t.entryDate).getTime()
  const b = new Date(t.exitDate).getTime()
  return Math.round((b - a) / 86400000)
}

function fmt(n: number, decimals = 2, prefix = '') {
  return `${prefix}${n >= 0 ? '' : ''}${n.toFixed(decimals)}`
}

// ── Palette ───────────────────────────────────────────────────────────────────

const C = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #142032)',
  border:  'var(--theme-border, rgba(255,255,255,0.07))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  pos:     'var(--theme-positive, #22c55e)',
  neg:     'var(--theme-negative, #ef4444)',
  dim:     'var(--theme-text-muted, rgba(215,227,252,0.35))',
}

const label = (text: string): React.CSSProperties => ({
  fontFamily: C.mono,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase' as const,
  color: C.muted,
  marginBottom: 5,
  display: 'block',
})

// ── Sub-components ────────────────────────────────────────────────────────────

function Tag({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: C.mono,
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 3,
        border: `1px solid ${active ? C.gold : C.border}`,
        background: active ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)' : 'transparent',
        color: active ? C.gold : C.muted,
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      {name}
    </button>
  )
}

function StatusBadge({ status, pnl }: { status: Status; pnl: number | null }) {
  const color =
    status === 'Watching' ? C.muted :
    status === 'Open'     ? C.gold :
    status === 'Cancelled' ? C.dim :
    pnl != null && pnl >= 0 ? C.pos : C.neg

  return (
    <span style={{
      fontFamily: C.mono,
      fontSize: 9,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      padding: '2px 7px',
      borderRadius: 3,
      border: `1px solid ${color}`,
      color,
      whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

function RBadge({ r }: { r: number | null }) {
  if (r == null) return <span style={{ color: C.dim, fontFamily: C.mono, fontSize: 11 }}>—</span>
  const color = r >= 2 ? '#16a34a' : r >= 1 ? C.pos : r >= 0 ? C.muted : C.neg
  return (
    <span style={{ fontFamily: C.mono, fontSize: 11, color, fontWeight: 600 }}>
      {r >= 0 ? '+' : ''}{r.toFixed(2)}R
    </span>
  )
}

function PnlCell({ t }: { t: Trade }) {
  const pnl = calcPnl(t)
  if (pnl == null) return <span style={{ color: C.dim, fontFamily: C.mono, fontSize: 11 }}>—</span>
  return (
    <span style={{ fontFamily: C.mono, fontSize: 11, color: pnl >= 0 ? C.pos : C.neg, fontWeight: 600 }}>
      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
    </span>
  )
}

// ── Add Trade Form ─────────────────────────────────────────────────────────────

const BLANK_FORM = {
  ticker: '',
  direction: 'Long' as Direction,
  entryDate: TODAY,
  entryPrice: '',
  size: '',
  stopLoss: '',
  target: '',
  thesis: '',
  tags: [] as string[],
  status: 'Watching' as Status,
}

function AddTradeForm({ onAdd }: { onAdd: (t: Trade) => void }) {
  const [open, setOpen] = useState(true)
  const [form, setForm] = useState(BLANK_FORM)

  function set(k: string, v: unknown) { setForm(f => ({ ...f, [k]: v })) }
  function toggleTag(tag: string) {
    setForm(f => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter(x => x !== tag) : [...f.tags, tag],
    }))
  }

  function submit() {
    if (!form.ticker || !form.entryPrice || !form.size) return
    const trade: Trade = {
      id: Date.now().toString(),
      ticker: form.ticker.toUpperCase().trim(),
      direction: form.direction,
      entryDate: form.entryDate,
      entryPrice: parseFloat(form.entryPrice as string),
      size: parseFloat(form.size as string),
      stopLoss: form.stopLoss ? parseFloat(form.stopLoss as string) : null,
      target: form.target ? parseFloat(form.target as string) : null,
      thesis: form.thesis,
      tags: form.tags,
      status: form.status,
      exitDate: null,
      exitPrice: null,
      notes: '',
    }
    onAdd(trade)
    setForm(BLANK_FORM)
  }

  const inp: React.CSSProperties = {
    fontFamily: C.mono,
    fontSize: 11,
    background: 'var(--theme-bg, #0a1628)',
    border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
    color: C.text,
    padding: '6px 9px',
    width: '100%',
    outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, marginBottom: 12 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '10px 0',
          color: C.text,
          fontFamily: C.mono,
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        <span>+ Add Trade</span>
        <span style={{ color: C.muted }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 14 }}>
          <div>
            <span style={label('Ticker')}>Ticker</span>
            <TickerInput
              style={inp}
              value={form.ticker}
              onChange={v => set('ticker', v)}
              placeholder="Ticker or company"
            />
          </div>

          <div>
            <span style={label('Direction')}>Direction</span>
            <select
              style={{ ...inp, cursor: 'pointer' }}
              value={form.direction}
              onChange={e => set('direction', e.target.value)}
            >
              {DIRECTIONS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <span style={label('Entry Date')}>Entry Date</span>
              <input type="date" style={inp} value={form.entryDate} onChange={e => set('entryDate', e.target.value)} />
            </div>
            <div>
              <span style={label('Status')}>Status</span>
              <select style={{ ...inp, cursor: 'pointer' }} value={form.status} onChange={e => set('status', e.target.value)}>
                {STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <span style={label('Entry Price')}>Entry Price</span>
              <input type="number" style={inp} value={form.entryPrice} onChange={e => set('entryPrice', e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <span style={label('Size')}>Size</span>
              <input type="number" style={inp} value={form.size} onChange={e => set('size', e.target.value)} placeholder="100" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <span style={label('Stop Loss')}>Stop Loss</span>
              <input type="number" style={inp} value={form.stopLoss} onChange={e => set('stopLoss', e.target.value)} placeholder="optional" />
            </div>
            <div>
              <span style={label('Target')}>Target</span>
              <input type="number" style={inp} value={form.target} onChange={e => set('target', e.target.value)} placeholder="optional" />
            </div>
          </div>

          <div>
            <span style={label('Thesis')}>Thesis</span>
            <textarea
              style={{ ...inp, resize: 'vertical', minHeight: 64 }}
              rows={3}
              value={form.thesis}
              onChange={e => set('thesis', e.target.value)}
              placeholder="Why this trade?"
            />
          </div>

          <div>
            <span style={label('Tags')}>Tags</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
              {ALL_TAGS.map(tag => (
                <Tag key={tag} name={tag} active={form.tags.includes(tag)} onClick={() => toggleTag(tag)} />
              ))}
            </div>
          </div>

          <button
            onClick={submit}
            style={{
              marginTop: 4,
              fontFamily: C.mono,
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              fontWeight: 700,
              background: 'color-mix(in srgb, var(--theme-primary) 12%, transparent)',
              border: `1px solid ${C.gold}`,
              borderRadius: 4,
              color: C.gold,
              padding: '8px 0',
              cursor: 'pointer',
              width: '100%',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary) 22%, transparent)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary) 12%, transparent)')}
          >
            Add Trade
          </button>
        </div>
      )}
    </div>
  )
}

// ── Stats Panel ───────────────────────────────────────────────────────────────

function StatsPanel({ trades }: { trades: Trade[] }) {
  const closed = trades.filter(t => t.status === 'Closed')
  if (closed.length === 0) return null

  const pnls = closed.map(calcPnl).filter((x): x is number => x != null)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p < 0)
  const winRate = closed.length ? wins.length / closed.length : 0
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0
  const totalWins = wins.reduce((a, b) => a + b, 0)
  const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  const profitFactor = totalLoss > 0 ? totalWins / totalLoss : totalWins > 0 ? Infinity : 0
  const rMults = closed.map(calcRMultiple).filter((x): x is number => x != null)
  const expectancy = rMults.length ? rMults.reduce((a, b) => a + b, 0) / rMults.length : null
  const totalPnl = pnls.reduce((a, b) => a + b, 0)

  const row = (label: string, value: string, color?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.muted }}>{label}</span>
      <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600, color: color || C.text }}>{value}</span>
    </div>
  )

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.muted, marginBottom: 8 }}>
        Performance ({closed.length} closed)
      </div>
      {row('Win Rate', `${(winRate * 100).toFixed(1)}%`, winRate >= 0.5 ? C.pos : C.neg)}
      {row('Avg Win', avgWin > 0 ? `$${avgWin.toFixed(2)}` : '—', C.pos)}
      {row('Avg Loss', avgLoss > 0 ? `$${avgLoss.toFixed(2)}` : '—', C.neg)}
      {row('Profit Factor', isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞', profitFactor >= 1 ? C.pos : C.neg)}
      {expectancy != null && row('Expectancy', `${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(2)}R`, expectancy >= 0 ? C.pos : C.neg)}
      {row('Total P&L', `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, totalPnl >= 0 ? C.pos : C.neg)}
    </div>
  )
}

// ── Close Trade Form ──────────────────────────────────────────────────────────

function CloseForm({ trade, onClose }: { trade: Trade; onClose: (exitDate: string, exitPrice: number, notes: string) => void }) {
  const [exitDate, setExitDate] = useState(TODAY)
  const [exitPrice, setExitPrice] = useState('')
  const [notes, setNotes] = useState(trade.notes)

  const inp: React.CSSProperties = {
    fontFamily: C.mono,
    fontSize: 11,
    background: 'var(--theme-bg, #0a1628)',
    border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
    color: C.text,
    padding: '6px 9px',
    width: '100%',
    outline: 'none',
    boxSizing: 'border-box',
  }

  function submit() {
    if (!exitPrice) return
    onClose(exitDate, parseFloat(exitPrice), notes)
  }

  return (
    <div style={{
      background: 'color-mix(in srgb, var(--theme-primary) 5%, transparent)',
      border: `1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)`,
      borderRadius: 6,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.gold }}>
        Close — {trade.ticker}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <span style={label('Exit Date')}>Exit Date</span>
          <input type="date" style={inp} value={exitDate} onChange={e => setExitDate(e.target.value)} />
        </div>
        <div>
          <span style={label('Exit Price')}>Exit Price</span>
          <input type="number" style={inp} value={exitPrice} onChange={e => setExitPrice(e.target.value)} placeholder="0.00" />
        </div>
      </div>
      <div>
        <span style={label('Notes')}>Notes</span>
        <textarea style={{ ...inp, resize: 'vertical', minHeight: 56 }} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Lessons learned…" />
      </div>
      <button
        onClick={submit}
        style={{
          fontFamily: C.mono,
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 700,
          background: 'color-mix(in srgb, var(--theme-primary) 12%, transparent)',
          border: `1px solid ${C.gold}`,
          borderRadius: 4,
          color: C.gold,
          padding: '7px 0',
          cursor: 'pointer',
          width: '100%',
        }}
      >
        Record Close
      </button>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function DetailPanel({ trade, onUpdateNotes }: { trade: Trade; onUpdateNotes: (notes: string) => void }) {
  const [notes, setNotes] = useState(trade.notes)
  const pnl = calcPnl(trade)
  const pnlPct = calcPnlPct(trade)
  const r = calcRMultiple(trade)
  const days = daysHeld(trade)
  const rr = trade.stopLoss && trade.target
    ? Math.abs(trade.target - trade.entryPrice) / Math.abs(trade.entryPrice - trade.stopLoss)
    : null

  function cell(label: string, value: string | null, color?: string) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontFamily: C.mono, fontSize: 8, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted }}>{label}</span>
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: color || C.text }}>{value ?? '—'}</span>
      </div>
    )
  }

  return (
    <div style={{
      background: 'var(--theme-hover, rgba(255,255,255,0.025))',
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      {/* Thesis */}
      {trade.thesis && (
        <div>
          <div style={{ fontFamily: C.mono, fontSize: 8, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted, marginBottom: 6 }}>Thesis</div>
          <div style={{ fontFamily: C.mono, fontSize: 12, color: C.text, lineHeight: 1.6 }}>{trade.thesis}</div>
        </div>
      )}

      {/* Tags */}
      {trade.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {trade.tags.map(tag => (
            <span key={tag} style={{
              fontFamily: C.mono,
              fontSize: 9,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '2px 7px',
              borderRadius: 3,
              border: `1px solid ${C.border}`,
              color: C.muted,
            }}>{tag}</span>
          ))}
        </div>
      )}

      {/* Risk / Reward */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {cell('Stop Loss', trade.stopLoss ? `$${trade.stopLoss.toFixed(2)}` : null, C.neg)}
        {cell('Target', trade.target ? `$${trade.target.toFixed(2)}` : null, C.pos)}
        {rr != null && cell('R:R Ratio', `1 : ${rr.toFixed(2)}`)}
        {days != null && cell('Days Held', `${days}d`)}
      </div>

      {/* Closed stats */}
      {trade.status === 'Closed' && pnl != null && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          {cell('Realized P&L', `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? C.pos : C.neg)}
          {pnlPct != null && cell('Return %', `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, pnlPct >= 0 ? C.pos : C.neg)}
          {r != null && cell('R-Multiple', `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`, r >= 0 ? C.pos : C.neg)}
          {days != null && cell('Duration', `${days}d`)}
        </div>
      )}

      {/* Notes */}
      <div>
        <div style={{ fontFamily: C.mono, fontSize: 8, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted, marginBottom: 6 }}>Notes</div>
        <textarea
          style={{
            fontFamily: C.mono,
            fontSize: 11,
            background: 'var(--theme-hover, rgba(255,255,255,0.03))',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.text,
            padding: '7px 10px',
            width: '100%',
            outline: 'none',
            resize: 'vertical',
            minHeight: 64,
            boxSizing: 'border-box',
          }}
          rows={3}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={() => onUpdateNotes(notes)}
          placeholder="Observations, lessons, adjustments…"
        />
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TradeJournal() {
  const [trades, setTrades] = useState<Trade[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  const [filterStatus, setFilterStatus] = useState<'All' | Status>('All')
  const [search, setSearch] = useState('')
  const [closingId, setClosingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades))
  }, [trades])

  const addTrade = useCallback((t: Trade) => {
    setTrades(prev => [t, ...prev])
  }, [])

  function deleteTrade(id: string) {
    setTrades(prev => prev.filter(t => t.id !== id))
    if (closingId === id) setClosingId(null)
    if (expandedId === id) setExpandedId(null)
  }

  function closeTrade(id: string, exitDate: string, exitPrice: number, notes: string) {
    setTrades(prev => prev.map(t =>
      t.id === id ? { ...t, status: 'Closed' as Status, exitDate, exitPrice, notes } : t
    ))
    setClosingId(null)
  }

  function updateNotes(id: string, notes: string) {
    setTrades(prev => prev.map(t => t.id === id ? { ...t, notes } : t))
  }

  function exportCsv() {
    const headers = ['id', 'ticker', 'direction', 'entryDate', 'entryPrice', 'size', 'stopLoss', 'target', 'thesis', 'tags', 'status', 'exitDate', 'exitPrice', 'notes', 'pnl', 'pnlPct', 'rMultiple']
    const rows = trades.map(t => {
      const pnl = calcPnl(t)
      const pnlPct = calcPnlPct(t)
      const r = calcRMultiple(t)
      return [
        t.id, t.ticker, t.direction, t.entryDate, t.entryPrice, t.size,
        t.stopLoss ?? '', t.target ?? '', `"${t.thesis.replace(/"/g, '""')}"`,
        t.tags.join(';'), t.status, t.exitDate ?? '', t.exitPrice ?? '',
        `"${t.notes.replace(/"/g, '""')}"`,
        pnl?.toFixed(2) ?? '', pnlPct?.toFixed(2) ?? '', r?.toFixed(3) ?? '',
      ].join(',')
    })
    const csv = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trade-journal-${TODAY}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sorted = [...trades].sort((a, b) => b.entryDate.localeCompare(a.entryDate))
  const filtered = sorted.filter(t => {
    const matchStatus = filterStatus === 'All' || t.status === filterStatus
    const q = search.toLowerCase()
    const matchSearch = !q || t.ticker.toLowerCase().includes(q) || t.thesis.toLowerCase().includes(q)
    return matchStatus && matchSearch
  })

  useReportCapture(() => {
    if (!trades.length) return null
    const closed = trades.filter(t => t.status === 'Closed')
    const pnls = closed.map(calcPnl).filter((x): x is number => x != null)
    const wins = pnls.filter(p => p > 0)
    const losses = pnls.filter(p => p < 0)
    const totalPnl = pnls.reduce((a, b) => a + b, 0)
    const winRate = closed.length ? wins.length / closed.length : 0
    const totalWins = wins.reduce((a, b) => a + b, 0)
    const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
    const profitFactor = totalLoss > 0 ? totalWins / totalLoss : totalWins > 0 ? Infinity : 0
    const openCount = trades.filter(t => t.status === 'Open').length
    const pieces: ClipDraft[] = [
      kpiClip('Trade Journal', 'Trade Journal Summary', [
        { label: 'Total Trades', value: String(trades.length) },
        { label: 'Open', value: String(openCount) },
        { label: 'Closed', value: String(closed.length) },
        ...(closed.length ? [
          { label: 'Win Rate', value: `${(winRate * 100).toFixed(1)}%` },
          { label: 'Total P&L', value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` },
          { label: 'Profit Factor', value: isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞' },
        ] : []),
      ]),
      tableClip(
        'Trade Journal',
        'Recent Trades',
        ['Ticker', 'Direction', 'Entry', 'Entry $', 'Size', 'Status', 'Exit', 'P&L'],
        sorted.slice(0, 20).map(t => {
          const pnl = calcPnl(t)
          return [
            t.ticker,
            t.direction,
            t.entryDate,
            t.entryPrice,
            t.size,
            t.status,
            t.exitDate ?? '—',
            pnl != null ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '—',
          ]
        }),
      ),
    ]
    return pieces
  }, { disabled: !trades.length, sourceTab: 'Trade Journal' })

  const thCol: React.CSSProperties = {
    fontFamily: C.mono,
    fontSize: 8,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: C.muted,
    padding: '8px 10px',
    textAlign: 'left',
    borderBottom: `1px solid ${C.border}`,
    whiteSpace: 'nowrap',
    fontWeight: 700,
  }

  return (
    <PageWrapper title="Trade Journal">
      <div style={{
        display: 'flex',
        height: 'calc(100dvh - 52px)',
        background: C.bg,
        fontFamily: C.mono,
        overflow: 'hidden',
      }}>
        {/* ── Left Sidebar ────────────────────────────────────────────────── */}
        <div style={{
          width: 380,
          minWidth: 380,
          borderRight: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '12px 20px 10px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontFamily: C.mono, fontSize: 9, color: C.muted, letterSpacing: '0.1em' }}>
              track · learn · improve
            </div>
          </div>

          {/* Scrollable content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>
            <AddTradeForm onAdd={addTrade} />

            {/* Filters */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted, marginBottom: 8 }}>Filter</div>
              <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
                {(['All', 'Watching', 'Open', 'Closed'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    style={{
                      fontFamily: C.mono,
                      fontSize: 9,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      padding: '3px 9px',
                      borderRadius: 3,
                      border: `1px solid ${filterStatus === s ? C.gold : C.border}`,
                      background: filterStatus === s ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : 'transparent',
                      color: filterStatus === s ? C.gold : C.muted,
                      cursor: 'pointer',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <input
                style={{
                  fontFamily: C.mono,
                  fontSize: 11,
                  background: 'var(--theme-hover, rgba(255,255,255,0.04))',
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  color: C.text,
                  padding: '6px 9px',
                  width: '100%',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                placeholder="Search ticker or thesis…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <StatsPanel trades={trades} />
          </div>
        </div>

        {/* ── Right Panel ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Top bar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderBottom: `1px solid ${C.border}`,
          }}>
            <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted }}>
              {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
            </div>
            <button
              onClick={exportCsv}
              disabled={trades.length === 0}
              style={{
                fontFamily: C.mono,
                fontSize: 9,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                background: 'transparent',
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: C.muted,
                padding: '5px 12px',
                cursor: trades.length ? 'pointer' : 'not-allowed',
                opacity: trades.length ? 1 : 0.4,
              }}
            >
              Export CSV
            </button>
          </div>

          {/* Table */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '60%',
                gap: 10,
              }}>
                <div style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.muted }}>
                  No trades yet
                </div>
                <div style={{ fontFamily: C.mono, fontSize: 11, color: C.dim }}>
                  Add your first trade using the form on the left.
                </div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Ticker', 'Direction', 'Date', 'Entry', 'Size', 'Stop', 'Target', 'Status', 'P&L', 'R', 'Actions'].map(h => (
                      <th key={h} style={thCol}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => {
                    const isExpanded = expandedId === t.id
                    const isClosing = closingId === t.id
                    const pnl = calcPnl(t)
                    const r = calcRMultiple(t)

                    const tdStyle: React.CSSProperties = {
                      fontFamily: C.mono,
                      fontSize: 11,
                      color: C.text,
                      padding: '9px 10px',
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: 'nowrap',
                      verticalAlign: 'middle',
                    }

                    return (
                      <>
                        <tr
                          key={t.id}
                          style={{
                            cursor: 'pointer',
                            background: isExpanded ? 'var(--theme-hover, rgba(255,255,255,0.03))' : 'transparent',
                            transition: 'background 0.12s',
                          }}
                          onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'var(--theme-hover, rgba(255,255,255,0.02))' }}
                          onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                          onClick={() => setExpandedId(isExpanded ? null : t.id)}
                        >
                          <td style={{ ...tdStyle, fontWeight: 700, color: C.gold }}>{t.ticker}</td>
                          <td style={{ ...tdStyle, color: C.muted }}>{t.direction}</td>
                          <td style={tdStyle}>{t.entryDate}</td>
                          <td style={tdStyle}>${t.entryPrice.toFixed(2)}</td>
                          <td style={tdStyle}>{t.size}</td>
                          <td style={{ ...tdStyle, color: t.stopLoss ? C.neg : C.dim }}>{t.stopLoss ? `$${t.stopLoss.toFixed(2)}` : '—'}</td>
                          <td style={{ ...tdStyle, color: t.target ? C.pos : C.dim }}>{t.target ? `$${t.target.toFixed(2)}` : '—'}</td>
                          <td style={tdStyle}><StatusBadge status={t.status} pnl={pnl} /></td>
                          <td style={tdStyle}><PnlCell t={t} /></td>
                          <td style={tdStyle}><RBadge r={r} /></td>
                          <td style={{ ...tdStyle }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              {t.status !== 'Closed' && t.status !== 'Cancelled' && (
                                <button
                                  onClick={() => setClosingId(isClosing ? null : t.id)}
                                  style={{
                                    fontFamily: C.mono,
                                    fontSize: 9,
                                    letterSpacing: '0.1em',
                                    textTransform: 'uppercase',
                                    background: isClosing ? 'color-mix(in srgb, var(--theme-primary) 15%, transparent)' : 'transparent',
                                    border: `1px solid ${isClosing ? C.gold : C.border}`,
                                    borderRadius: 3,
                                    color: isClosing ? C.gold : C.muted,
                                    padding: '3px 8px',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  Close
                                </button>
                              )}
                              <button
                                onClick={() => deleteTrade(t.id)}
                                style={{
                                  fontFamily: C.mono,
                                  fontSize: 12,
                                  background: 'transparent',
                                  border: `1px solid ${C.border}`,
                                  borderRadius: 3,
                                  color: C.muted,
                                  padding: '2px 7px',
                                  cursor: 'pointer',
                                  lineHeight: 1,
                                }}
                              >
                                ×
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* Close form row */}
                        {isClosing && (
                          <tr key={`${t.id}-close`}>
                            <td colSpan={11} style={{ padding: '0 12px 12px', background: 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                              <CloseForm
                                trade={t}
                                onClose={(exitDate, exitPrice, notes) => closeTrade(t.id, exitDate, exitPrice, notes)}
                              />
                            </td>
                          </tr>
                        )}

                        {/* Detail panel row */}
                        {isExpanded && (
                          <tr key={`${t.id}-detail`}>
                            <td colSpan={11} style={{ padding: '0 12px 12px', background: 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                              <DetailPanel trade={t} onUpdateNotes={notes => updateNotes(t.id, notes)} />
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}
