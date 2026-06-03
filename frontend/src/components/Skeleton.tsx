interface SkeletonProps {
  width?: string | number
  height?: string | number
  className?: string
}

export function Skeleton({ width = '100%', height = 16, className = '' }: SkeletonProps) {
  return (
    <div
      className={className}
      style={{
        width,
        height,
        background: 'linear-gradient(90deg, #101c2e 25%, #1a2d45 50%, #101c2e 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 2s infinite',
      }}
    />
  )
}

export function SkeletonMetricRow() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} style={{ background: '#101c2e', border: '1px solid #2e394d', padding: '12px 14px' }}>
          <Skeleton height={9} width="60%" className="mb-2" />
          <Skeleton height={22} width="80%" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonChart({ height = 280 }: { height?: number }) {
  return (
    <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
      <div style={{ background: 'rgba(46,57,77,0.8)', width: 120, height: 24 }} />
      <div style={{ padding: '8px 8px 8px 8px', height }}>
        <Skeleton width="100%" height="100%" />
      </div>
    </div>
  )
}

export function SkeletonTable({ rows = 6, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ border: '1px solid #2e394d' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 0, borderBottom: '1px solid #2e394d', padding: '8px 10px' }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} height={9} width="70%" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, padding: '10px 10px', borderBottom: r < rows - 1 ? '1px solid rgba(46,57,77,0.4)' : 'none' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={11} width={c === 0 ? '80%' : '60%'} />
          ))}
        </div>
      ))}
    </div>
  )
}
