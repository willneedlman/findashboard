import { useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Send, Settings } from 'lucide-react'
import { T } from '../lib/theme'
import { findToolByLocation } from '../lib/hubs'
import {
  getReportCapture,
  subscribeReportCapture,
  textClip,
} from '../lib/reportCaptureRegistry'
import { sendToReportCreator, type ClipDraft } from '../lib/reportCreator'

// Shell chrome for every tool page: clip the open view into a report, and reach
// settings. Rendered at zero height so the cluster overlays the page's own
// header row instead of spending a row of vertical budget on two icons.

const SKIP = new Set([
  '/app',
  '/dashboard',
  '/report-creator',
  '/settings',
  '/admin',
  '/login',
  '/signup',
  '/reset-password',
])

function defaultClip(toolTitle: string, route: string, desc: string): ClipDraft {
  const when = new Date().toLocaleString()
  return textClip(
    toolTitle,
    `${toolTitle} snapshot`,
    [
      desc,
      '',
      `Tool: ${toolTitle}`,
      `Route: ${route}`,
      `Captured: ${when}`,
      '',
      'No structured panels were registered for this tool yet. Add a note describing which figures or charts from the open view belong in the report.',
    ].join('\n'),
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, padding: 0,
        background: T.bg, border: `1px solid ${T.border}`, color: T.muted,
        cursor: 'pointer', transition: 'color 0.12s ease, border-color 0.12s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = T.gold; e.currentTarget.style.borderColor = T.goldTint(55) }}
      onMouseLeave={e => { e.currentTarget.style.color = T.muted; e.currentTarget.style.borderColor = T.border }}
    >
      {children}
    </button>
  )
}

export default function ShellActions() {
  const location = useLocation()
  const navigate = useNavigate()
  // Re-render when any page registers/unregisters a capture handler.
  useSyncExternalStore(subscribeReportCapture, () => {
    const e = getReportCapture(location.pathname, location.search)
    return `${location.pathname}${location.search}|${e ? '1' : '0'}|${e?.disabled ? 'd' : 'e'}`
  })

  const path = location.pathname
  const onTool = !SKIP.has(path) && !path.startsWith('/hub/') && !path.startsWith('/report-creator')

  const tool = onTool ? findToolByLocation(path, location.search) : undefined
  const entry = onTool ? getReportCapture(path, location.search) : null
  const canCapture = onTool && (!!tool || !!entry)

  const capture = () => {
    // Prefer the registered multi-piece snapshot even when marked disabled: the
    // handler may still return the panels that have loaded.
    if (entry) {
      const d = entry.getClip()
      const list = Array.isArray(d) ? d : d ? [d] : []
      if (list.length) return sendToReportCreator(list)
    }
    if (tool) sendToReportCreator([defaultClip(tool.title, tool.route, tool.desc)])
  }

  const title = tool?.title ?? entry?.sourceTab ?? 'this tool'

  return (
    <div className="ft-shell-actions" style={{ height: 0, display: 'flex', justifyContent: 'flex-end', position: 'relative', zIndex: 20 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {canCapture && (
          <IconButton label={`Send ${title} to a report`} onClick={capture}>
            <Send size={13} />
          </IconButton>
        )}
        <IconButton label="Settings" onClick={() => navigate('/settings')}>
          <Settings size={13} />
        </IconButton>
      </div>
    </div>
  )
}
