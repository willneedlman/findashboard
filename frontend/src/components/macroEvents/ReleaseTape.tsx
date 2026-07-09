import { useState } from 'react'
import { Bell } from 'lucide-react'
import { T } from '../../lib/theme'
import HelpTip from '../HelpTip'
import type { MacroEvent, Impact } from '../../data/mockEventsData'
import {
  deriveSurprise, reactionCode, reactionValue, sparkPoints, historyBars,
  countdownShort, countdownLong, shortDate, type SortCol, type Tone,
} from './tapeUtils'

const GRID = '64px 1fr 44px 104px 104px 104px 128px 244px 72px 36px'
const IMPACT_RAIL: Record<Impact, string> = { High: T.neg, Medium: T.warn, Low: T.muted }
const toneColor = (t: Tone) => (t === 'pos' ? T.pos : t === 'neg' ? T.neg : T.muted)
const toneBg = (t: Tone) => (t === 'pos' ? T.posTint(12) : t === 'neg' ? T.negTint(12) : 'rgba(255,255,255,0.04)')

export interface Section { id: string; label: string | null; sub?: string; muted?: boolean; perRowDate?: boolean; rows: MacroEvent[] }
export interface Sort { column: SortCol; dir: 'asc' | 'desc' }

const COLS: { label: string; col: SortCol; align: 'left' | 'right'; help?: string }[] = [
  { label: 'TIME ET', col: 'time', align: 'left' },
  { label: 'EVENT', col: 'event', align: 'left' },
  { label: 'REG', col: 'region', align: 'left' },
  { label: 'ACTUAL', col: 'actual', align: 'right', help: 'The released figure. On upcoming rows this shows the countdown to release instead.' },
  { label: 'CONSENSUS', col: 'consensus', align: 'right', help: 'The forecast, where a free one exists: Atlanta Fed GDPNow for GDP, futures-implied for FOMC. FRED does not publish street consensus for the monthly prints, so most rows show a dash.' },
  { label: 'PREVIOUS', col: 'previous', align: 'right', help: 'The prior period print.' },
  { label: 'SURPRISE', col: 'surprise', align: 'right', help: 'Actual versus the number the market anchored to (consensus if present, else the prior print). BEAT/MISS for growth and jobs, COOLER/HOTTER for inflation, AS PRICED for rate decisions.' },
  { label: 'REACTION', col: 'reaction', align: 'left', help: 'The release-day cross-asset move: S&P 500 (SPX) and the dollar (DXY) in percent, the 10-year yield in basis points.' },
  { label: 'HISTORY', col: 'history', align: 'right', help: 'The recent print trend. Expand the row for the last several values as bars.' },
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

function Row({ e, zebra, perRowDate, expanded, onToggle, alerted, onAlert }: {
  e: MacroEvent; zebra: boolean; perRowDate?: boolean
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
        style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: 16, alignItems: 'center', padding: '11px 16px', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
        {/* TIME */}
        {perRowDate
          ? <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ ...cell, fontSize: 12, color: T.muted }}>{time}</span>
              <span style={{ ...cell, fontSize: 9, color: T.muted }}>{shortDate(e.datetime)}</span>
            </div>
          : <span style={{ ...cell, fontSize: 12, color: T.muted }}>{time}</span>}
        {/* EVENT */}
        <span style={{ ...cell, fontSize: 13, fontWeight: 700, color: expanded ? T.gold : T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {e.name}<span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 400, color: T.muted }}> · {e.category} · {e.sourceName}</span>
        </span>
        {/* REG */}
        <span style={{ fontFamily: T.label, fontSize: 10, fontWeight: 700, color: T.muted }}>{e.countryCode}</span>
        {/* ACTUAL */}
        <span style={{ ...cell, textAlign: 'right', fontSize: released ? 12 : 11, fontWeight: 700, color: released ? (negActual ? T.neg : T.text) : T.gold }}>
          {released ? e.actual : countdownShort(e.datetime)}
        </span>
        {/* CONSENSUS */}
        <span style={{ ...cell, textAlign: 'right', fontSize: 12, color: e.status === 'upcoming' && e.expected ? T.text : T.muted }}>{e.expected ?? '—'}</span>
        {/* PREVIOUS */}
        <span style={{ ...cell, textAlign: 'right', fontSize: 12, color: T.muted }}>{e.previous}</span>
        {/* SURPRISE */}
        {surprise
          ? <span style={{ ...cell, justifySelf: 'end', padding: '2px 8px', fontSize: 10.5, fontWeight: 700, color: toneColor(surprise.tone), background: toneBg(surprise.tone) }}>
              {surprise.label}{surprise.value ? ` ${surprise.value}` : ''}
            </span>
          : <span style={{ ...cell, textAlign: 'right', fontSize: 11, color: T.muted }}>—</span>}
        {/* REACTION */}
        {released
          ? <span style={{ display: 'flex', gap: 5, fontFamily: T.mono, fontSize: 10, fontWeight: 700 }}>
              {e.reactions.slice(0, 3).map(r => {
                const up = r.change >= 0
                return <span key={r.asset} style={{ padding: '2px 7px', color: up ? T.pos : T.neg, background: up ? T.posTint(12) : T.negTint(12), whiteSpace: 'nowrap' }}>{reactionCode(r.asset)} {reactionValue(r)}</span>
              })}
            </span>
          : <span style={{ fontFamily: T.label, fontSize: 10.5, fontStyle: 'italic', color: T.muted }}>Pending release</span>}
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
          <div className="mev-fade" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, padding: '4px 16px 16px 96px', opacity: expanded ? 1 : 0 }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: 16, alignItems: 'center', padding: '8px 16px', borderBottom: `1px solid ${T.border}`, ...label }}>
        {COLS.map(c => (
          <span key={c.col} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start' }}>
            <SortHeader label={c.label} col={c.col} align={c.align} sort={sort} onSort={onSort} />
            {c.help && <HelpTip text={c.help} width={230} />}
          </span>
        ))}
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
            <Row key={e.id} e={e} zebra={i % 2 === 1} perRowDate={section.perRowDate}
              expanded={expandedId === e.id} onToggle={() => onToggle(e.id)}
              alerted={isAlerted(e)} onAlert={() => onAlert(e)} />
          ))}
        </div>
      ))}
    </div>
  )
}
