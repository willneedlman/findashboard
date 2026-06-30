// Shared loading placeholder, visually paired with EmptyState/ErrorState so every
// tool reads the same way. A slow pulsing accent bar carries the wait; motion is
// dropped under prefers-reduced-motion.
interface LoadingStateProps {
  label?: string
}

export default function LoadingState({ label = 'Loading' }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '48px 24px', gap: 14, textAlign: 'center',
        background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        minHeight: 220,
      }}
    >
      <style>{`
        @keyframes fdb-load-pulse { 0%,100% { opacity: 0.25; transform: scaleY(0.4) } 50% { opacity: 1; transform: scaleY(1) } }
        @media (prefers-reduced-motion: reduce) { .fdb-load-bar { animation: none !important; opacity: 0.6 } }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 32 }}>
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className="fdb-load-bar"
            style={{
              width: 2, height: 32, transformOrigin: 'center',
              background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)',
              animation: `fdb-load-pulse 1.1s ease-in-out ${i * 0.15}s infinite`,
            }}
          />
        ))}
      </div>
      <div style={{
        fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700,
        letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))',
      }}>
        {label}
      </div>
    </div>
  )
}
