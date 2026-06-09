interface EmptyStateProps {
  title: string
  hint: string
}

export default function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', gap: 14, textAlign: 'center',
      background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.08)))',
      minHeight: 220,
    }}>
      <div style={{
        width: 2, height: 32, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
      }} />
      <div>
        <div style={{
          fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)', marginBottom: 6,
        }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--theme-text-faint, var(--theme-text-faint, rgba(255,255,255,0.22)))', letterSpacing: '0.04em', lineHeight: '16px' }}>
          {hint}
        </div>
      </div>
    </div>
  )
}
