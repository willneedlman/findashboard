import { X } from 'lucide-react'
import { pfInput, PF } from './styles'

// One holding row: ticker + weight + remove, in the Compare aesthetic. The
// per-ticker strategy select (when a tool has one) is rendered by the parent
// below this row, matching the screenshots.
export default function PortfolioInputRow({
  ticker, weight, onTicker, onWeight, onRemove, removable = true, placeholder = 'AAPL',
}: {
  ticker: string
  weight: number | string
  onTicker: (v: string) => void
  onWeight: (v: string) => void
  onRemove: () => void
  removable?: boolean
  placeholder?: string
}) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input
        style={{ ...pfInput, flex: 1 }}
        placeholder={placeholder}
        value={ticker}
        onChange={e => onTicker(e.target.value.toUpperCase())}
      />
      <input
        type="number" min={0} step={1}
        style={{ ...pfInput, width: 52, textAlign: 'right' }}
        value={weight}
        onChange={e => onWeight(e.target.value)}
      />
      <X
        size={13}
        style={{ cursor: removable ? 'pointer' : 'default', color: removable ? PF.muted : 'transparent', flexShrink: 0 }}
        onClick={removable ? onRemove : undefined}
      />
    </div>
  )
}
