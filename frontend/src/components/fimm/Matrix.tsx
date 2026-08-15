/*
 * The issue matrix: the hero of the rates desk.
 *
 * Twelve columns mirrored around the model yield. The market sits outermost,
 * our own quote just inside it, and theoretical forms the spine, so a row reads
 * outward from fair value and answers two things at once: how far our bid sits
 * from theoretical, and how much room is left before the market's bid.
 *
 * Everything quotes in yield. Once every cell is a yield, model yield and model
 * price are the same number, so Model is one column rather than two.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Canvas, useTokens, GOOD, BAD, WARN } from '../mm2/ui'
import { bucketOf, type Bucket, type FiEngine, type NodeView, type Quote } from '../../lib/fimm/engine'

const SURFACE_BAND = '#1a2438'      // Issue and Risk carried
const MODEL_BAND = '#1a1f2e'        // Model
const QUOTE_BAND = '#16202f'        // Bid and Ask

// ── Header ────────────────────────────────────────────────────────────────────

/**
 * The instrument panel (height 46).
 *
 * The benchmark ticker moved here from the command bar. A rates desk reads its
 * own risk against the anchor rate, so the anchor belongs on the instrument
 * panel rather than in with the run controls.
 */
export function MatrixHeader({ eng, tick, reviewT, onScrub }: {
  eng: FiEngine
  tick: number
  reviewT: number | null
  onScrub: (t: number | null) => void
}) {
  const tokens = useTokens()
  const bm = eng.benchmark()
  const series = eng.samples
  const lo = series.length ? Math.min(...series.map(s => s.tenY)) : bm.tenY
  const hi = series.length ? Math.max(...series.map(s => s.tenY)) : bm.tenY

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, height: 46, flexShrink: 0,
      padding: '0 12px', boxSizing: 'border-box',
      background: T.surface, borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ lineHeight: 1.1, flexShrink: 0 }}>
        <div style={{ ...LABEL, fontSize: 8, letterSpacing: '0.16em' }}>10Y benchmark</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ ...MONO, fontSize: 19, fontWeight: 700, color: T.gold }}>{pct(bm.tenY)}</span>
          <span style={{ ...MONO, fontSize: 10, color: bm.tenYChgBp >= 0 ? BAD : GOOD }}>
            {bm.tenYChgBp >= 0 ? '+' : ''}{bm.tenYChgBp.toFixed(1)} bp
          </span>
        </div>
      </div>

      <div style={{ ...MONO, fontSize: 10, lineHeight: 1.25, whiteSpace: 'nowrap', flexShrink: 0 }}>
        <div style={{ color: T.muted }}>SOFR <span style={{ color: T.text }}>{(bm.sofr * 100).toFixed(2)}%</span></div>
        <div style={{ color: T.muted }}>2s10s <span style={{ color: bm.slope < 0 ? WARN : T.text }}>
          {bm.slope >= 0 ? '+' : ''}{bm.slope.toFixed(0)} bp
        </span></div>
      </div>

      {/* Recessed plot. The chart had to become more noticeable without
          becoming the focal point, which is what the sunken box buys. */}
      <div style={{
        flex: 1, minWidth: 200, height: 38, position: 'relative', boxSizing: 'border-box',
        background: 'rgba(0,0,0,0.16)', padding: '3px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        borderLeft: `1px solid ${T.borderFaint}`, borderRight: `1px solid ${T.borderFaint}`,
      }}>
        <Canvas
          height={22}
          onPick={xFrac => {
            if (!series.length) return
            const i = Math.round(xFrac * (series.length - 1))
            onScrub(series[Math.max(0, Math.min(series.length - 1, i))].t)
          }}
          draw={(ctx, w, h) => {
            if (series.length < 2) return
            const gold = tokens['--theme-primary'] || '#c9a84c'
            const span = Math.max(hi - lo, 1e-6)
            const xAt = (i: number) => (i / (series.length - 1)) * w
            const yAt = (v: number) => h - ((v - lo) / span) * h
            ctx.beginPath()
            ctx.moveTo(0, h)
            series.forEach((s, i) => ctx.lineTo(xAt(i), yAt(s.tenY)))
            ctx.lineTo(w, h)
            ctx.closePath()
            ctx.fillStyle = alphaHex(gold, 0.14)
            ctx.fill()
            ctx.beginPath()
            series.forEach((s, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(s.tenY)) : ctx.lineTo(xAt(i), yAt(s.tenY))))
            ctx.strokeStyle = gold
            ctx.lineWidth = 1.8
            ctx.stroke()
            const last = series[series.length - 1]
            ctx.fillStyle = gold
            ctx.fillRect(w - 5, yAt(last.tenY) - 2.5, 5, 5)
          }}
        />
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.14em' }}>Session</span>
          <span style={{ ...MONO, fontSize: 9, color: T.muted }}>
            {series.length > 1 ? `${(lo * 100).toFixed(3)} to ${(hi * 100).toFixed(3)}` : 'building'}
          </span>
        </div>
      </div>

      <span
        onClick={() => reviewT !== null && onScrub(null)}
        style={{
          ...MONO, fontSize: 9, whiteSpace: 'nowrap', flexShrink: 0,
          color: reviewT !== null ? T.gold : alpha(T.muted, 70),
          cursor: reviewT !== null ? 'pointer' : 'default',
        }}
      >
        {reviewT !== null ? 'return to live' : 'click to rewind'}
      </span>
    </div>
  )
}

/** The scope line. It states what is on the board rather than offering a filter. */
export function ScopeLine({ quoted, total }: { quoted: number; total: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '4px 10px', flexShrink: 0,
      borderBottom: `1px solid ${T.border}`,
    }}>
      <span style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.16em' }}>Treasury book</span>
      <span style={{ ...MONO, fontSize: 9.5, color: T.muted, marginLeft: 'auto' }}>
        {quoted} of {total} issues quoted
      </span>
    </div>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

/**
 * Widths live on the name row, not on a colgroup.
 *
 * Percentage widths plus nowrap on every cell is what keeps the table inside
 * its box. A colgroup is fragile here, and table-layout: fixed distributes
 * wrongly when the band row above carries colspans.
 */
const NAMES: { label: string; w: string; kind?: 'yours' | 'model' }[] = [
  { label: 'asset', w: '7%' },
  { label: 'market', w: '8%' },
  { label: 'yours', w: '8.5%', kind: 'yours' },
  { label: 'yield', w: '8%', kind: 'model' },
  { label: 'yours', w: '8.5%', kind: 'yours' },
  { label: 'market', w: '8%' },
  { label: 'bid/ask', w: '6%' },
  { label: 'asw', w: '6%' },
  { label: 'dv01', w: '8%' },
  { label: 'position', w: '11%' },
  { label: 'cusip · coupon', w: '13.5%' },
  { label: 'maturity', w: '7.5%' },
]

const BANDS: { label: string; span: number; bg: string; color: string }[] = [
  { label: 'Issue', span: 1, bg: SURFACE_BAND, color: T.text },
  { label: 'Bid', span: 2, bg: QUOTE_BAND, color: T.blue },
  { label: 'Model', span: 1, bg: MODEL_BAND, color: T.gold },
  { label: 'Ask', span: 2, bg: QUOTE_BAND, color: T.blue },
  { label: 'Size', span: 1, bg: T.surface, color: alpha(T.muted, 90) },
  { label: 'Risk carried', span: 3, bg: SURFACE_BAND, color: T.text },
  { label: 'Reference', span: 2, bg: T.surface, color: alpha(T.muted, 70) },
]

export default function Matrix({ eng, rows, sel, onSel, traced }: {
  eng: FiEngine
  rows: NodeView[]
  sel: number
  onSel: (id: number) => void
  /** A bucket clicked in the risk column, traced through to its issues. */
  traced: Bucket | null
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {BANDS.map((b, i) => (
              <th key={b.label} colSpan={b.span} style={{
                position: 'sticky', top: 0, zIndex: 4,
                background: b.bg, color: b.color,
                fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700,
                letterSpacing: '0.18em', textTransform: 'uppercase', textAlign: 'center',
                padding: '4px 6px', whiteSpace: 'nowrap',
                borderLeft: i === 0 ? undefined : `1px solid ${T.border}`,
              }}>{b.label}</th>
            ))}
          </tr>
          <tr>
            {NAMES.map((n, i) => (
              <th key={`${n.label}-${i}`} style={{
                position: 'sticky', top: 22, zIndex: 3, width: n.w,
                background: n.kind === 'model' ? MODEL_BAND
                  : n.kind === 'yours' ? `color-mix(in srgb, ${T.blue} 10%, ${T.surface})`
                  : T.surface,
                color: n.kind === 'model' ? alpha(T.gold, 80)
                  : n.kind === 'yours' ? T.blue
                  : alpha(T.muted, 72),
                ...MONO, fontSize: 9, fontWeight: 600, textAlign: 'center',
                padding: '3px 6px', whiteSpace: 'nowrap',
              }}>{n.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(v => (
            <Row key={v.node.id} eng={eng} v={v} on={v.node.id === sel} onSel={onSel}
              dim={traced !== null && bucketOf(v.node.years) !== traced} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ eng, v, on, onSel, dim }: {
  eng: FiEngine; v: NodeView; on: boolean; onSel: (id: number) => void; dim: boolean
}) {
  const nd = v.node
  const q = v.quote
  const dv = eng.dv01(nd)
  const unit = nd.unit === 'MM' ? 'mm' : ' lots'
  return (
    <tr
      onClick={() => onSel(nd.id)}
      style={{
        cursor: 'pointer',
        // Tracing a bucket fades the issues outside it rather than hiding them,
        // so the trader keeps the whole curve in view while reading one part.
        opacity: dim ? 0.32 : 1,
        background: on ? alpha(T.gold, 12) : v.posMM !== 0 ? alpha(T.blue, 5) : 'transparent',
        borderTop: `1px solid ${on ? alpha(T.gold, 32) : T.borderFaint}`,
      }}
    >
      <Cell align="left" style={{ fontWeight: 700, color: on ? T.gold : T.text }}>{nd.label}</Cell>
      <MarketCell>{pctOrDash(v.streetBidYield)}</MarketCell>
      <QuoteCell q={q} side="bid" inside={v.bidInside} />
      <Cell style={{ color: T.gold, fontWeight: 600, background: alpha(T.gold, 6) }}>{pct(v.modelYield)}</Cell>
      <QuoteCell q={q} side="ask" inside={v.askInside} />
      <MarketCell>{pctOrDash(v.streetAskYield)}</MarketCell>
      <Cell style={{ fontSize: 10.5, color: alpha(T.text, 58), background: T.surface }}>
        {q.bidSize}/{q.askSize}
      </Cell>
      <Cell style={{ color: nd.kind !== 'cash' ? T.muted : nd.aswBp < -35 ? WARN : alpha(T.text, 72) }}>
        {nd.kind === 'cash' ? `${nd.aswBp.toFixed(1)}` : '—'}
      </Cell>
      <Cell style={{ color: alpha(T.text, 82) }}>${Math.round(dv).toLocaleString()}</Cell>
      <Cell style={{ color: v.posMM > 0 ? GOOD : v.posMM < 0 ? BAD : alpha(T.muted, 50), fontWeight: v.posMM ? 700 : 400 }}>
        {v.posMM === 0 ? '·' : `${v.posMM > 0 ? '+' : ''}${v.posMM.toFixed(0)}${unit}`}
      </Cell>
      <Cell style={{ fontSize: 9, color: T.muted }}>
        {nd.cusip}{nd.kind === 'cash' ? ` · ${(nd.coupon * 100).toFixed(3)}` : ''}
      </Cell>
      <Cell style={{ fontSize: 9, color: T.muted }}>{nd.maturity}</Cell>
    </tr>
  )
}

const TD_BASE: React.CSSProperties = {
  ...MONO, fontSize: 11, padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap',
}

function Cell({ children, style, align }: {
  children: React.ReactNode; style?: React.CSSProperties; align?: 'left' | 'right'
}) {
  return <td style={{ ...TD_BASE, textAlign: align ?? 'right', ...style }}>{children}</td>
}

/** The market is background. The recessed block is what makes it read that way. */
function MarketCell({ children }: { children: React.ReactNode }) {
  return <Cell style={{ color: alpha(T.text, 58), background: T.surface }}>{children}</Cell>
}

/**
 * Our own quote, tinted and bold when it is inside the market.
 *
 * A risk-blocked side keeps its price in the negative tone rather than
 * blanking: a gap reads as a data failure, not as a decision the desk made.
 */
function QuoteCell({ q, side, inside }: { q: Quote; side: 'bid' | 'ask'; inside: boolean }) {
  const size = side === 'bid' ? q.bidSize : q.askSize
  const state = side === 'bid' ? q.bidState : q.askState
  const y = side === 'bid' ? q.bidYield : q.askYield
  if (state === 'riskBlocked') {
    return <Cell style={{ color: BAD, fontWeight: 700, background: alpha(BAD, 8) }}>{pct(y)}</Cell>
  }
  if (size <= 0) {
    return <Cell style={{ color: alpha(T.muted, 42) }}>·</Cell>
  }
  return (
    <Cell style={{
      color: inside ? T.blue : alpha(T.blue, 60),
      fontWeight: inside ? 700 : 400,
      background: alpha(T.blue, inside ? 13 : 5),
    }}>{pct(y)}</Cell>
  )
}

const pct = (y: number) => `${(y * 100).toFixed(3)}`
const pctOrDash = (y: number | null) => (y == null ? '—' : pct(y))

/** Canvas cannot read a css variable, and it cannot read a token's alpha either. */
function alphaHex(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
