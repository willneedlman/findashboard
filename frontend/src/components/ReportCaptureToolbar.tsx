import { useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'
import ReportCaptureButton from './ReportCaptureButton'
import { findToolByLocation } from '../lib/hubs'
import {
  getReportCapture,
  subscribeReportCapture,
  textClip,
} from '../lib/reportCaptureRegistry'
import type { ClipDraft } from '../lib/reportCreator'

// Shell-level "Send to Report" for every hub tool. Pages that call
// useReportCapture() supply rich multi-piece snapshots; others fall back to a
// named tool stub the user can annotate in the capture modal.

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

export default function ReportCaptureToolbar() {
  const location = useLocation()
  // Re-render when any page registers/unregisters a capture handler.
  useSyncExternalStore(subscribeReportCapture, () => {
    const e = getReportCapture(location.pathname, location.search)
    return `${location.pathname}${location.search}|${e ? '1' : '0'}|${e?.disabled ? 'd' : 'e'}`
  })

  const path = location.pathname
  if (SKIP.has(path) || path.startsWith('/hub/') || path.startsWith('/report-creator')) {
    return null
  }

  const tool = findToolByLocation(path, location.search)
  // Also allow non-hub utility pages with a registered capture.
  const entry = getReportCapture(path, location.search)
  if (!tool && !entry) return null

  const title = tool?.title ?? entry?.sourceTab ?? 'Tool'
  const getClip = (): ClipDraft[] | null => {
    // Prefer registered multi-piece snapshot (even if marked disabled—handler may
    // still return partial pieces once some panels have data).
    if (entry) {
      const d = entry.getClip()
      if (Array.isArray(d) && d.length) return d
      if (d && !Array.isArray(d)) return [d]
    }
    // No structured capture yet: single annotated stub so the modal still opens.
    if (tool) return [defaultClip(tool.title, tool.route, tool.desc)]
    return null
  }

  return (
    <div
      className="rc-shell-capture"
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 8,
        padding: '0 0 10px',
        marginBottom: 2,
      }}
    >
      <ReportCaptureButton
        getClip={getClip}
        compact
        title={
          entry && !entry.disabled
            ? `Clip displays from ${title} into a report`
            : `Clip ${title} into a report (add a note for which panels to use)`
        }
      />
    </div>
  )
}
