interface PageHeaderProps {
  title: string
  /** Right-aligned status or context line — as-of stamps, row counts, the
   *  source a screen is reading. The reason ~55 pages hand-rolled their own
   *  title bar instead of adopting this one, so adoption stays lossless. */
  meta?: React.ReactNode
  actions?: React.ReactNode
}

export default function PageHeader({ title, meta, actions }: PageHeaderProps) {
  return (
    <div className="ft-page-header">
      <h1 className="ft-page-title">{title}</h1>
      {(meta || actions) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          {meta && (
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary)', letterSpacing: '0.04em' }}>
              {meta}
            </div>
          )}
          {actions && <div className="ft-page-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div>}
        </div>
      )}
    </div>
  )
}
