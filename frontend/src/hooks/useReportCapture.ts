import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import type { ClipDraft } from '../lib/reportCreator'
import { normalizeCapturePath, registerReportCapture } from '../lib/reportCaptureRegistry'

/**
 * Register a tool's capture snapshot for the shell "Send to Report" button.
 * Call from any tool page with a stable getClip that closes over current data.
 */
export function useReportCapture(
  getClip: () => ClipDraft | ClipDraft[] | null,
  options?: { disabled?: boolean; sourceTab?: string; path?: string },
) {
  const location = useLocation()
  const path = options?.path ?? normalizeCapturePath(location.pathname, location.search)
  // Keep the latest getClip without re-registering every render.
  const getClipRef = useRef(getClip)
  getClipRef.current = getClip
  const disabled = options?.disabled
  const sourceTab = options?.sourceTab

  useEffect(() => {
    return registerReportCapture(path, {
      getClip: () => getClipRef.current(),
      disabled,
      sourceTab,
    })
  }, [path, disabled, sourceTab])
}
