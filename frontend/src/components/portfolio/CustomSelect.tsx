import type { CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import { pfInput, PF } from './styles'

export interface SelectOption { value: string; label: string }

// Styled dropdown that matches the Compare input aesthetic: a native <select>
// (keeps keyboard/native a11y) with the app chrome stripped and a single
// consistent chevron. Replaces the assorted bare <select>s across the tools.
export default function CustomSelect({
  value, onChange, options, style, disabled, ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  style?: CSSProperties
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        style={{
          ...pfInput,
          cursor: disabled ? 'not-allowed' : 'pointer',
          appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
          paddingRight: 26,
          textOverflow: 'ellipsis',
          ...style,
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown
        size={13}
        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: PF.muted }}
      />
    </div>
  )
}
