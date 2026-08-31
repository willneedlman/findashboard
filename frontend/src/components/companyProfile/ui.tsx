import { T } from '../../lib/theme'
import HelpTip from '../HelpTip'

export const MONO = 'var(--theme-mono)'
export const SANS = 'var(--theme-sans)'
export const BRIGHT = 'var(--theme-text-bright, #dce3ed)'
export const DIM = 'var(--theme-text-dim, rgba(255,255,255,0.35))'
export const ROW_LINE = '1px solid rgba(255,255,255,0.04)'
export const STRIP = 'rgba(0,0,0,0.16)'

/** One panel answers one question. The header strip names the question and the
 *  right-hand meta names where the answer came from, which the brief requires
 *  on every panel carrying vendor data. */
export function Panel({ title, meta, children, style }: {
  title: string
  meta?: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <section style={{
      // Content panels take --theme-bg, which is LIGHTER than --theme-surface.
      // Getting that backwards makes a reading panel look like a sunken overlay.
      background: T.bg,
      border: `1px solid ${T.border}`,
      minWidth: 0,
      ...style,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
        padding: '11px 18px',
        background: STRIP,
        borderBottom: `1px solid ${T.border}`,
      }}>
        <span style={{
          fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.text,
        }}>
          {title}
        </span>
        {meta && (
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: T.muted }}>
            {meta}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/** A labelled figure with the basis it was computed on. The note is not
 *  decoration: a metric without its basis is a number nobody can check. */
export function Cell({ label, value, note, tone: t, size = 19, tip }: {
  label: string
  value: string
  note?: string
  tone?: string
  size?: number
  /** How the figure is derived. A modelled number that does not say what it is
   *  modelled from is a number the reader has to take on faith. */
  tip?: string
}) {
  return (
    <div style={{ background: T.bg, padding: '15px 18px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{
        fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: DIM,
      }}>
        {label}
        {tip && <HelpTip text={tip} width={280} />}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: size, fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', color: t ?? BRIGHT, lineHeight: 1.1,
        overflowWrap: 'anywhere',
      }}>
        {value}
      </span>
      {note && (
        <span style={{ fontFamily: SANS, fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
          {note}
        </span>
      )}
    </div>
  )
}

/** A scrollable data table. Wide content scrolls inside its own container so
 *  the page body never moves sideways. */
export function DataTable({ head, rows, align, firstColWidth }: {
  head: string[]
  rows: (string | React.ReactNode)[][]
  align?: ('left' | 'right')[]
  firstColWidth?: number
}) {
  const at = (i: number) => align?.[i] ?? (i === 0 ? 'left' : 'right')
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={{
                fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: T.muted, textAlign: at(i),
                padding: '11px 16px', whiteSpace: 'nowrap',
                background: STRIP, borderBottom: `1px solid ${T.border}`,
                minWidth: i === 0 ? firstColWidth : undefined,
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: ROW_LINE }}>
              {r.map((c, j) => (
                <td key={j} style={{
                  padding: '10px 16px', textAlign: at(j), whiteSpace: 'nowrap',
                  fontFamily: j === 0 ? SANS : MONO,
                  fontSize: j === 0 ? 12 : 12,
                  fontWeight: j === 0 ? 600 : 400,
                  fontVariantNumeric: 'tabular-nums',
                  color: j === 0 ? BRIGHT : T.text,
                }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A proportion bar. The value is always printed beside it, because colour
 *  never carries the meaning on its own. */
export function Bar({ pct, color, height = 6 }: { pct: number; color: string; height?: number }) {
  return (
    <div style={{
      flex: 1, height, minWidth: 40,
      background: 'rgba(255,255,255,0.05)',
      border: `1px solid ${T.borderFaint}`,
    }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', background: color,
      }} />
    </div>
  )
}
