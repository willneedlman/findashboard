import { useState } from 'react'
import { Bell } from 'lucide-react'
import { T } from '../../lib/theme'
import type { MacroEvent, Impact } from '../../data/mockEventsData'
import {
  deriveSurprise, reactionCode, reactionValue, sparkPoints, historyBars,
  countdownShort, countdownLong, shortDate, type SortCol, type Tone,
} from './tapeUtils'

const GRID = '52px 60px minmax(0,1fr) 36px 88px 88px 88px 106px 200px 56px 32px'
const GAP = 13
const IMPACT_RAIL: Record<Impact, string> = { High: T.neg, Medium: T.warn, Low: T.muted }
const toneColor = (t: Tone) => (t === 'pos' ? T.pos : t === 'neg' ? T.neg : T.muted)
const toneBg = (t: Tone) => (t === 'pos' ? T.posTint(12) : t === 'neg' ? T.negTint(12) : 'rgba(255,255,255,0.04)')

export interface Section { id: string; label: string | null; sub?: string; muted?: boolean; rows: MacroEvent[] }
export interface Sort { column: SortCol; dir: 'asc' | 'desc' }

const COLS: { label: string; col: SortCol; align: 'left' | 'right' }[] = [
  { label: 'TIME ET', col: 'time', align: 'left' },
  { label: 'DATE', col: 'date', align: 'left' },
  { label: 'EVENT', col: 'event', align: 'left' },
  { label: 'REG', col: 'region', align: 'left' },
  { label: 'ACTUAL', col: 'actual', align: 'right' },
  { label: 'CONSENSUS', col: 'consensus', align: 'right' },
  { label: 'PREVIOUS', col: 'previous', align: 'right' },
  { label: 'SURPRISE', col: 'surprise', align: 'right' },
  { label: 'REACTION', col: 'reaction', align: 'left' },
  { label: 'HISTORY', col: 'history', align: 'right' },
]

function SortHeader({ label, col, align, sort, onSort }: {
  label: string; col: SortCol; align: 'left' | 'right'; sort: Sort; onSort: (c: SortCol) => void
}) {
  const active = sort.column === col
  const upFill = active && sort.dir === 'asc' ? T.gold : 'currentColor'
  const dnFill = active && sort.dir === 'desc' ? T.gold : 'currentColor'
  const upOp = active ? (sort.dir === 'asc' ? 1 : 0.35) : 0.4
  const dnOp = active ? (sort.dir === 'desc' ? 1 : 0.35) : 0.4
  return (
    <button type="button" onClick={() => onSort(col)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        font: 'inherit', letterSpacing: 'inherit', textTransform: 'uppercase',
        color: active ? T.gold : T.muted,
      }}>
      {label}
      <svg width="7" height="11" viewBox="0 0 8 12" style={{ flexShrink: 0 }}>
        <path d="M4 1 6.8 4.8H1.2Z" fill={upFill} opacity={upOp} />
        <path d="M4 11 1.2 7.2H6.8Z" fill={dnFill} opacity={dnOp} />
      </svg>
    </button>
  )
}

function Sparkline({ history, released }: { history?: number[]; released: boolean }) {
  return (
    <svg width="56" height="18" viewBox="0 0 56 18" style={{ justifySelf: 'end' }}>
      <polyline points={sparkPoints(history)} fill="none" stroke={released ? T.gold : T.muted} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

function Row({ e, zebra, expanded, onToggle, alerted, onAlert }: {
  e: MacroEvent; zebra: boolean
  expanded: boolean; onToggle: () => void; alerted: boolean; onAlert: () => void
}) {
  const [hover, setHover] = useState(false)
  const released = e.status === 'released'
  const rail = expanded ? T.gold : IMPACT_RAIL[e.impact]
  const time = e.datetime.slice(11, 16)
  const surprise = deriveSurprise(e)
  const negActual = released && !!e.actual && /^[-−]/.test(e.actual.trim())
  const bg = expanded ? T.goldTint(4) : hover ? T.hover : zebra ? 'rgba(255,255,255,0.015)' : 'transparent'

  const cell: React.CSSProperties = { fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' }
  const stop = (fn: () => void) => (ev: React.MouseEvent) => { ev.stopPropagation(); fn() }

  return (
    <div style={{ borderLeft: `3px solid ${rail}`, background: bg, borderBottom: `1px solid ${T.borderFaint}` }}>
      <div
        onClick={onToggle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: GAP, alignItems: 'center', padding: '11px 16px', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
        {/* TIME */}
        <span style={{ ...cell, fontSize: 12, color: T.muted }}>{time}</span>
        {/* DATE */}
        <span style={{ ...cell, fontSize: 11, color: T.muted }}>{shortDate(e.datetime)}</span>
        {/* EVENT — truncates with ellipsis until the row is expanded, then shows in full */}
        <span style={{ ...cell, fontSize: 13, fontWeight: 700, color: expanded ? T.gold : T.text,
          whiteSpace: expanded ? 'normal' : 'nowrap', overflow: expanded ? 'visible' : 'hidden', textOverflow: 'ellipsis', lineHeight: expanded ? 1.35 : undefined }}>
          {e.name}<span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 400, color: T.muted }}> · {e.category} · {e.country} · {e.sourceName}</span>
        </span>
        {/* REG */}
        <span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 700, color: T.muted }}>{e.countryCode}</span>
        {/* ACTUAL */}
        <span style={{ ...cell, textAlign: 'right', fontSize: released ? 12 : 11, fontWeight: 700, color: released ? (negActual ? T.neg : T.text) : T.gold }}>
          {released ? e.actual : countdownShort(e.datetime)}
        </span>
        {/* CONSENSUS */}
        {e.expected
          ? <span style={{ ...cell, textAlign: 'right', fontSize: 12, color: e.status === 'upcoming' ? T.text : T.muted }}>{e.expected}</span>
          : <span style={{ textAlign: 'right', fontFamily: T.label, fontSize: 9.5, fontStyle: 'italic', color: T.muted, whiteSpace: 'nowrap' }}>{e.status === 'upcoming' ? 'Not released' : '—'}</span>}
        {/* PREVIOUS */}
        <span style={{ ...cell, textAlign: 'right', fontSize: 12, color: T.muted }}>{e.previous}</span>
        {/* SURPRISE */}
        {surprise
          ? <span style={{ ...cell, justifySelf: 'end', padding: '2px 8px', fontSize: 10.5, fontWeight: 700, color: toneColor(surprise.tone), background: toneBg(surprise.tone) }}>
              {surprise.label}{surprise.value ? ` ${surprise.value}` : ''}
            </span>
          : <span style={{ ...cell, textAlign: 'right', fontSize: 11, color: T.muted }}>—</span>}
        {/* REACTION — three fixed columns of asset + colored value, no chip fills */}
        {!released
          ? <span style={{ fontFamily: T.label, fontSize: 10.5, fontStyle: 'italic', color: T.muted }}>Not released</span>
          : e.reactions.length
            ? <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', columnGap: 10, fontFamily: T.mono, fontSize: 10, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {[0, 1, 2].map(i => {
                  const r = e.reactions[i]
                  if (!r) return <span key={i} />
                  return (
                    <span key={r.asset} style={{ display: 'flex', justifyContent: 'space-between', gap: 4, whiteSpace: 'nowrap' }}>
                      <span style={{ color: T.muted }}>{reactionCode(r.asset)}</span>
                      <span style={{ color: r.change >= 0 ? T.pos : T.neg }}>{reactionValue(r)}</span>
                    </span>
                  )
                })}
              </span>
            : <span style={{ fontFamily: T.label, fontSize: 10.5, fontStyle: 'italic', color: T.muted }}>Awaiting close</span>}
        {/* HISTORY */}
        <Sparkline history={e.history} released={released} />
        {/* BELL */}
        <button type="button" onClick={stop(onAlert)} aria-label={alerted ? 'Alert on' : 'Set alert'}
          style={{ display: 'flex', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: alerted ? T.gold : T.muted }}>
          <Bell size={14} fill={alerted ? T.goldTint(30) : 'none'} />
        </button>
      </div>

      {/* Expanded detail */}
      <div className="mev-expand" style={{ display: 'grid', gridTemplateRows: expanded ? '1fr' : '0fr' }}>
        <div style={{ overflow: 'hidden' }}>
          <div className="mev-fade" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, padding: '4px 16px 16px 154px', opacity: expanded ? 1 : 0 }}>
            <div>
              <p style={{ margin: 0, fontFamily: T.label, fontSize: 12, lineHeight: 1.6, color: T.text, maxWidth: 720 }}>{e.summary}</p>
              <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={ev => ev.stopPropagation()}
                style={{ display: 'inline-block', marginTop: 8, fontFamily: T.label, fontSize: 10.5, fontWeight: 600, color: T.blue, textDecoration: 'none' }}>
                {e.sourceName} release ↗
              </a>
            </div>
            {e.history && e.history.length > 1 && (
              <div>
                <span style={{ display: 'block', fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, marginBottom: 6 }}>LAST {Math.min(6, e.history.length)} PRINTS</span>
                <svg width="300" height="48" viewBox="0 0 300 48">
                  {historyBars(e.history).map((b, i, arr) => (
                    <rect key={i} x={b.x} y={b.y} width={40} height={b.height} fill={i === arr.length - 1 ? T.gold : T.goldTint(28)} />
                  ))}
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ReleaseTape({ sections, totalCount, nextHigh, sort, onSort, expandedId, onToggle, isAlerted, onAlert }: {
  sections: Section[]; totalCount: number; nextHigh: MacroEvent | null
  sort: Sort; onSort: (c: SortCol) => void
  expandedId: string | null; onToggle: (id: string) => void
  isAlerted: (e: MacroEvent) => boolean; onAlert: (e: MacroEvent) => void
}) {
  const label = { fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const }
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.25)' }}>
      {/* Panel header + countdown */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 16px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.borderFaint}` }}>
        <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: T.muted }}>RELEASE TAPE · {totalCount} EVENTS</span>
        {nextHigh && (
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold, fontVariantNumeric: 'tabular-nums' }}>
            NEXT HIGH IMPACT · {nextHigh.countryCode} {nextHigh.name.split(' (')[0]} · {countdownLong(nextHigh.datetime)}
          </span>
        )}
      </div>

      {/* Sortable column header */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: GAP, alignItems: 'center', padding: '8px 16px', borderBottom: `1px solid ${T.border}`, ...label }}>
        {COLS.map(c => <SortHeader key={c.col} label={c.label} col={c.col} align={c.align} sort={sort} onSort={onSort} />)}
        <span />
      </div>

      {/* Sections */}
      {sections.map(section => (
        <div key={section.id}>
          {section.label && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', background: 'rgba(0,0,0,0.14)' }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: section.muted ? T.muted : T.text }}>{section.label}</span>
              {section.sub && <span style={{ ...label, fontSize: 9, letterSpacing: '0.1em', color: T.muted }}>{section.sub}</span>}
            </div>
          )}
          {section.rows.map((e, i) => (
            <Row key={e.id} e={e} zebra={i % 2 === 1}
              expanded={expandedId === e.id} onToggle={() => onToggle(e.id)}
              alerted={isAlerted(e)} onAlert={() => onAlert(e)} />
          ))}
        </div>
      ))}
    </div>
  )
}
