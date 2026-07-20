// Shared error placeholder, paired with EmptyState/LoadingState. Uses role=alert
// so the message is announced, and offers an optional retry.
interface ErrorStateProps {
  title?: string
  message: string
  onRetry?: () => void
}

export default function ErrorState({ title = 'Something went wrong', message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '48px 24px', gap: 14, textAlign: 'center',
        background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        minHeight: 220,
      }}
    >
      <div style={{ width: 2, height: 32, background: 'color-mix(in srgb, var(--theme-negative, #ef4444) 55%, transparent)' }} />
      <div>
        <div style={{
          fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-negative, #ef4444)', marginBottom: 6,
        }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', letterSpacing: '0.04em', lineHeight: '16px', maxWidth: 360 }}>
          {message}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)', cursor: 'pointer',
            background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)',
            padding: '7px 16px',
          }}
        >
          Try again
        </button>
      )}
    </div>
  )
}
