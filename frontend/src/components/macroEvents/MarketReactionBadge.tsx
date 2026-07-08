import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { T } from '../../lib/theme'
import type { MarketReaction } from '../../data/mockEventsData'

// One asset's immediate move after a release: asset label + signed change with an
// up/down glyph, tinted green for a rise and red for a fall. Yields read in bps,
// everything else in percent.
export default function MarketReactionBadge({ reaction }: { reaction: MarketReaction }) {
  const up = reaction.change >= 0
  const color = up ? T.pos : T.neg
  const Glyph = up ? ArrowUpRight : ArrowDownRight
  const mag = Math.abs(reaction.change)
  const value = reaction.unit === 'bp'
    ? `${mag.toFixed(0)}bp`
    : `${mag.toFixed(2)}%`

  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 9px',
        background: up ? T.posTint(10) : T.negTint(10),
        border: `1px solid ${up ? T.posTint(35) : T.negTint(35)}`,
        fontFamily: T.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: T.muted, letterSpacing: '0.02em' }}>{reaction.asset}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color, fontWeight: 700 }}>
        <Glyph size={12} strokeWidth={2.4} />
        {up ? '+' : '-'}{value}
      </span>
    </span>
  )
}
