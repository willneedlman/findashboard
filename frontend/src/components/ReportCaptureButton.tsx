import { Send } from 'lucide-react'
import { T } from '../lib/theme'
import { sendToReportCreator, type ClipDraft } from '../lib/reportCreator'

// Drop-in "Send to Report Creator" control for any tool. Give it a getClip
// closure that snapshots the current view as a ClipDraft at click time (return
// null when there is nothing to capture yet). Clicking dispatches the capture
// event; the global ReportCaptureHost then collects a project and note. No
// prop-drilling, matching the ticker-drawer pattern.

interface Props {
  getClip: () => ClipDraft | ClipDraft[] | null
  label?: string
  title?: string
  disabled?: boolean
  compact?: boolean
}

export default function ReportCaptureButton({ getClip, label = 'Send to Report', title, disabled, compact }: Props) {
  const onClick = () => {
    if (disabled) return
    const draft = getClip()
    // Always hand the host an array so the capture modal can show multi-piece
    // previews and let the user pick which displays go into the report.
    if (!draft) return
    const list = Array.isArray(draft) ? draft : [draft]
    if (list.length) sendToReportCreator(list)
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? 'Clip this view into a Report Creator project'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'transparent', border: `1px solid ${T.border}`, color: disabled ? T.muted : T.text,
        fontFamily: T.label, fontSize: compact ? 8.5 : 9, fontWeight: 700,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        padding: compact ? '4px 8px' : '6px 10px',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
      }}
    >
      <Send size={compact ? 11 : 12} /> {label}
    </button>
  )
}
