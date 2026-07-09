import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListFilter, ArrowUp, ArrowDown, X } from 'lucide-react'
import { T } from '../lib/theme'

// One filter/sort control that lives on a column header. The header still shows
// its plain label; this adds a small icon beside it that opens a popover with
// "sort ascending / descending" and (optionally) that column's filter. Shared by
// every scanner table so the interaction is identical everywhere.
//
// The parent owns a single sort {key,dir}|null and each column's filter value;
// this component only reads/writes them. The popover is body-portaled so it
// escapes the table's overflow, matching <TickerLink>.

export type SortDir = 'asc' | 'desc'
export type SortState = { key: string; dir: SortDir } | null

export type FilterSpec =
  | { kind: 'text'; value: string; set: (v: string) => void; placeholder?: string }
  | { kind: 'min'; value: string; set: (v: string) => void; placeholder?: string }
  | { kind: 'select'; value: string; set: (v: string) => void; options: { label: string; key: string }[] }

const Z = 980

function filterActive(f?: FilterSpec): boolean {
  if (!f) return false
  return f.kind === 'select' ? f.value !== '' : f.value.trim() !== ''
}

interface Props {
  align?: 'left' | 'right'
  sortKey?: string          // omit → not sortable
  sort?: SortState
  onSort?: (s: SortState) => void
  filter?: FilterSpec
}

export default function ColumnFilterMenu({ align = 'right', sortKey, sort, onSort, filter }: Props) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const sortedHere = !!(sortKey && sort && sort.key === sortKey)
  const dir = sortedHere ? sort!.dir : null
  const active = sortedHere || filterActive(filter)

  const setSort = (d: SortDir) => {
    if (!sortKey || !onSort) return
    onSort(dir === d ? null : { key: sortKey, dir: d })  // click the active dir again → clear
  }
  const clearAll = () => {
    if (sortedHere && onSort) onSort(null)
    if (filter) filter.set('')
  }

  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ListFilter

  return (
    <>
      <button
        ref={btnRef}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        aria-label="Sort and filter column"
        aria-expanded={open}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 2, marginLeft: 5,
          display: 'inline-flex', verticalAlign: 'middle', lineHeight: 0,
          color: active ? T.gold : 'var(--theme-secondary, #5e768f)',
          opacity: active ? 1 : 0.7,
        }}
      >
        <Icon size={12} />
      </button>
      <Popover open={open} anchor={btnRef} align={align} onClose={() => setOpen(false)}
        sortKey={sortKey} dir={dir} setSort={setSort} filter={filter} active={active} clearAll={clearAll} />
    </>
  )
}

function Popover({ open, anchor, align, onClose, sortKey, dir, setSort, filter, active, clearAll }: {
  open: boolean; anchor: React.RefObject<HTMLButtonElement>; align: 'left' | 'right'; onClose: () => void
  sortKey?: string; dir: SortDir | null; setSort: (d: SortDir) => void
  filter?: FilterSpec; active: boolean; clearAll: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const r = anchor.current.getBoundingClientRect()
    const W = 216
    let left = align === 'right' ? r.right - W : r.left
    let top = r.bottom + 4
    if (left < 8) left = 8
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8
    if (top + 220 > window.innerHeight - 8) top = Math.max(8, r.top - 220)
    setPos({ top, left })
  }, [open, anchor, align])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [open, onClose, anchor])

  if (!open || !pos) return null

  const LABEL: React.CSSProperties = {
    fontFamily: 'var(--theme-sans)', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', padding: '2px 12px 5px',
  }
  const sortRow = (d: SortDir, icon: React.ReactNode, text: string) => {
    const on = dir === d
    return (
      <button onClick={() => setSort(d)} role="menuitemradio" aria-checked={on}
        style={{
          display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
          background: on ? T.goldTint(12) : 'none', border: 'none', cursor: 'pointer',
          padding: '7px 12px', color: on ? T.gold : T.text, fontFamily: 'var(--theme-sans)', fontSize: 12,
        }}
        onMouseEnter={e => { if (!on) e.currentTarget.style.background = T.goldTint(8) }}
        onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'none' }}>
        {icon}{text}
      </button>
    )
  }

  return createPortal(
    <div ref={ref} role="menu"
      style={{
        position: 'fixed', top: pos.top, left: pos.left, width: 216, zIndex: Z,
        background: T.surface, border: `1px solid ${T.goldTint(30)}`,
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)', padding: '6px 0',
      }}>
      {sortKey && (
        <>
          <div style={LABEL}>Sort</div>
          {sortRow('asc', <ArrowUp size={13} />, 'Ascending')}
          {sortRow('desc', <ArrowDown size={13} />, 'Descending')}
        </>
      )}
      {sortKey && filter && <div style={{ height: 1, background: T.border, margin: '5px 0' }} />}
      {filter && (
        <>
          <div style={LABEL}>Filter</div>
          <div style={{ padding: '0 12px 4px' }}><FilterControl filter={filter} /></div>
        </>
      )}
      {active && (
        <>
          <div style={{ height: 1, background: T.border, margin: '5px 0' }} />
          <button onClick={clearAll}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              background: 'none', border: 'none', cursor: 'pointer', padding: '6px 12px',
              color: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-sans)', fontSize: 11,
            }}>
            <X size={12} /> Clear
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}

function FilterControl({ filter }: { filter: FilterSpec }) {
  const field: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: 'var(--theme-bg, #101c2e)',
    border: `1px solid ${filterActive(filter) ? T.gold : T.border}`, color: T.text,
    fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '6px 8px', outline: 'none',
  }
  if (filter.kind === 'select') {
    return (
      <select value={filter.value} onChange={e => filter.set(e.target.value)}
        style={{ ...field, cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>
        {filter.options.map(o => <option key={o.key} value={o.key} style={{ background: T.surface, color: T.text }}>{o.label}</option>)}
      </select>
    )
  }
  return (
    <input
      type={filter.kind === 'min' ? 'number' : 'text'}
      inputMode={filter.kind === 'min' ? 'decimal' : undefined}
      min={filter.kind === 'min' ? 0 : undefined}
      autoFocus
      value={filter.value}
      placeholder={filter.placeholder}
      aria-label={filter.placeholder}
      onChange={e => filter.set(e.target.value)}
      style={field}
    />
  )
}
