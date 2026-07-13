interface PageHeaderProps {
  title: string
  actions?: React.ReactNode
}

export default function PageHeader({ title, actions }: PageHeaderProps) {
  return (
    <div className="ft-page-header">
      <h1 className="ft-page-title">{title}</h1>
      {actions && <div className="ft-page-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{actions}</div>}
    </div>
  )
}
