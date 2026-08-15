/*
 * The issue matrix: every quoted node on one row, model against street.
 *
 * This is the equivalent of the options chain and takes every pixel left over.
 * The columns are ordered the way a trader reads them: what the model says,
 * what we are showing, what the street is showing, then the reference data and
 * the risk the line carries.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, TH, TD, GOOD, BAD, WARN, Seg } from '../mm2/ui'
import { fmt32, fmt32Eighths } from '../../lib/fimm/bondmath'
import { GROUPS, type FiEngine, type Group, type NodeView, type PriceMode } from '../../lib/fimm/engine'

export function TenorStrip({ group, onGroup, sel, onSel, rows, mode, onMode }: {
  group: Group | 'All'
  onGroup: (g: Group | 'All') => void
  sel: number
  onSel: (id: number) => void
  rows: NodeView[]
  mode: PriceMode
  onMode: (m: PriceMode) => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', flexShrink: 0,
      borderBottom: `1px solid ${T.border}`, background: T.bg, overflowX: 'auto',
    }}>
      <span style={{ ...LABEL, fontSize: 8, flexShrink: 0 }}>Curve</span>
      <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        {(['All', ...GROUPS] as (Group | 'All')[]).map(g => (
          <button key={g} onClick={() => onGroup(g)} style={tab(g === group)}>{g}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 1, flexShrink: 0, marginLeft: 4, paddingLeft: 10, borderLeft: `1px solid ${T.border}` }}>
        {rows.map(r => (
          <button key={r.node.id} onClick={() => onSel(r.node.id)} style={tab(r.node.id === sel, r.posMM !== 0)}>
            {r.node.label}
          </button>
        ))}
      </div>
      <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
        <Seg
          options={[{ label: '32nds', value: '32nds' }, { label: 'Decimal', value: 'decimal' }, { label: 'Yield', value: 'yield' }]}
          value={mode} onChange={onMode} size={9}
        />
      </div>
    </div>
  )
}

const tab = (on: boolean, held = false): React.CSSProperties => ({
  ...MONO, fontSize: 10, fontWeight: on ? 700 : 500, padding: '3px 10px', cursor: 'pointer',
  whiteSpace: 'nowrap',
  border: `1px solid ${on ? T.gold : held ? alpha(T.gold, 40) : T.border}`,
  background: on ? alpha(T.gold, 16) : 'transparent',
  color: on ? T.gold : held ? T.text : T.muted,
})

const COLS = [
  'Asset', 'Model yield', 'Model price', 'Your bid', 'Your ask',
  'Street bid', 'Street ask', 'Size', 'CUSIP / coupon', 'Maturity', 'ASW', 'DV01', 'Position',
]

export default function Matrix({ eng, rows, sel, onSel, mode }: {
  eng: FiEngine
  rows: NodeView[]
  sel: number
  onSel: (id: number) => void
  mode: PriceMode
}) {
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, zIndex: 2, background: T.surface }}>
            {COLS.map((c, i) => (
              <th key={c} style={{ ...TH, textAlign: i === 0 ? 'left' : 'right', borderBottom: `1px solid ${T.border}` }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => <Row key={r.node.id} eng={eng} v={r} on={r.node.id === sel} onSel={onSel} mode={mode} />)}
        </tbody>
      </table>
    </div>
  )
}

function Row({ eng, v, on, onSel, mode }: {
  eng: FiEngine; v: NodeView; on: boolean; onSel: (id: number) => void; mode: PriceMode
}) {
  const nd = v.node
  const q = v.quote
  const dv = eng.dv01(nd)
  const unit = nd.unit === 'MM' ? 'mm' : 'lots'
  // A blocked side is shown at its price in the muted tone rather than removed.
  // A gap where a quote used to be reads as a data failure, not as a decision.
  const bidTone = q.bidState === 'active' ? T.text : q.bidState === 'riskBlocked' ? BAD : T.muted
  const askTone = q.askState === 'active' ? T.text : q.askState === 'riskBlocked' ? BAD : T.muted

  return (
    <tr
      onClick={() => onSel(nd.id)}
      style={{
        cursor: 'pointer',
        background: on ? alpha(T.gold, 12) : v.posMM !== 0 ? alpha(T.blue, 6) : 'transparent',
        borderBottom: `1px solid ${alpha(T.border, 60)}`,
      }}
    >
      <td style={{ ...TD, textAlign: 'left' }}>
        <span style={{ color: on ? T.gold : T.text, fontWeight: 700 }}>{nd.label}</span>
        <span style={{ color: T.muted, marginLeft: 6, fontSize: 9 }}>{nd.kind === 'cash' ? 'OTR' : nd.group}</span>
      </td>
      <td style={{ ...TD, color: T.text }}>{pctYield(v.modelYield)}</td>
      <td style={{ ...TD, color: T.text }}>{px(nd.kind, v.modelPrice, mode, v.modelYield)}</td>
      <td style={{ ...TD, color: bidTone }}>{px(nd.kind, q.bid, mode, q.bidYield)}</td>
      <td style={{ ...TD, color: askTone }}>{px(nd.kind, q.ask, mode, q.askYield)}</td>
      <td style={{ ...TD, color: T.muted }}>{street(nd.kind, v.streetBid, mode)}</td>
      <td style={{ ...TD, color: T.muted }}>{street(nd.kind, v.streetAsk, mode)}</td>
      <td style={{ ...TD, color: q.bidSize || q.askSize ? T.text : T.muted }}>
        {q.bidSize}/{q.askSize}
      </td>
      <td style={{ ...TD, color: T.muted, fontSize: 9 }}>
        {nd.cusip}{nd.kind === 'cash' ? ` · ${(nd.coupon * 100).toFixed(3)}%` : ''}
      </td>
      <td style={{ ...TD, color: T.muted, fontSize: 9 }}>{nd.maturity}</td>
      <td style={{ ...TD, color: nd.kind === 'cash' ? (nd.aswBp < 0 ? WARN : T.text) : T.muted }}>
        {nd.kind === 'cash' ? `${nd.aswBp.toFixed(1)} bp` : '—'}
      </td>
      <td style={{ ...TD, color: T.text }}>${Math.round(dv).toLocaleString()}</td>
      <td style={{ ...TD, color: v.posMM > 0 ? GOOD : v.posMM < 0 ? BAD : T.muted }}>
        {v.posMM === 0 ? '—' : `${v.posMM > 0 ? '+' : ''}${v.posMM.toFixed(0)}${unit}`}
      </td>
    </tr>
  )
}

const pctYield = (y: number) => `${(y * 100).toFixed(3)}%`

/** The desk's own quote, in whichever space the trader has selected. */
function px(kind: string, price: number, mode: PriceMode, yld: number): string {
  if (mode === 'yield') return pctYield(yld)
  if (mode === 'decimal' || kind === 'stir') return price.toFixed(kind === 'stir' ? 4 : 3)
  return fmt32(price)
}

/** The inter-dealer screen prints finer than the desk quotes, so it keeps eighths. */
function street(kind: string, price: number, mode: PriceMode): string {
  if (mode === 'decimal' || kind === 'stir') return price.toFixed(kind === 'stir' ? 4 : 3)
  if (mode === 'yield') return price.toFixed(3)
  return fmt32Eighths(price)
}
