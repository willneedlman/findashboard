interface EmptyStateProps {
  title: string
  hint: string
}

export default function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', gap: 14, textAlign: 'center',
      background: '#101c2e', border: '1px solid #2e394d',
      minHeight: 220,
    }}>
      <div style={{
        width: 2, height: 32, background: 'rgba(201,168,76,0.35)',
      }} />
      <div>
        <div style={{
          fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc', marginBottom: 6,
        }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: '#4d4637', letterSpacing: '0.04em', lineHeight: '16px' }}>
          {hint}
        </div>
      </div>
    </div>
  )
}
