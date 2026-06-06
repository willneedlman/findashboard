interface PanelProps {
  title?: string
  actions?: React.ReactNode
  children: React.ReactNode
  noPad?: boolean
  style?: React.CSSProperties
}

export default function Panel({ title, actions, children, noPad, style }: PanelProps) {
  return (
    <div className="ft-panel" style={style}>
      {title && (
        <div className="ft-panel-header">
          <span>{title}</span>
          {actions && <span>{actions}</span>}
        </div>
      )}
      {noPad ? children : <div style={{ padding: '14px 16px' }}>{children}</div>}
    </div>
  )
}
