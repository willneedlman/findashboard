// One keyboard-shortcut badge for the whole shell.
//
// Two things go wrong when this is inlined per surface, and both had: the label
// gets hardcoded to the Mac glyph so Windows and Linux are told to press a key
// they do not have, and it gets styled with the theme mono font, where ⌘ has no
// glyph and renders as tofu. The font stack below is a system stack for exactly
// that reason, and it is why this is a component rather than a style object.

const KEY_FONT = '-apple-system, "Segoe UI", system-ui, sans-serif'

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '')

/** The palette shortcut, written the way this OS writes it. */
export const commandKeyLabel = () => (isMac() ? '⌘K' : 'Ctrl K')

export default function ShortcutKey({ label }: { label?: string }) {
  return (
    <span style={{
      fontFamily: KEY_FONT, fontSize: 10, fontWeight: 600,
      letterSpacing: '0.05em', lineHeight: '14px', whiteSpace: 'nowrap',
      color: 'var(--theme-secondary, #8099b0)',
      border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
      padding: '1px 6px',
    }}>
      {label ?? commandKeyLabel()}
    </span>
  )
}
