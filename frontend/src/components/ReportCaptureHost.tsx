import { Suspense, useEffect, useState } from 'react'
import { lazyWithReload } from '../lib/chunkReload'
import { onReportCapture, type ClipDraft } from '../lib/reportCreator'

// Always-mounted, near-zero-weight host for the capture modal. Listens for the
// ft:report-capture event any tool dispatches, then lazy-loads the modal (and
// its recharts dependency) only on first use, matching TickerDrawerHost.

const ReportCaptureModal = lazyWithReload(() => import('./ReportCaptureModal'))

export default function ReportCaptureHost() {
  const [pieces, setPieces] = useState<ClipDraft[] | null>(null)
  useEffect(() => onReportCapture(setPieces), [])
  if (!pieces) return null
  return (
    <Suspense fallback={null}>
      <ReportCaptureModal pieces={pieces} onClose={() => setPieces(null)} />
    </Suspense>
  )
}
