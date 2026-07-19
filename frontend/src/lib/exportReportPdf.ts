import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

// Rasterize the on-screen research note into a multi-page PDF without the
// browser's automatic print chrome (URL, clock, page X/Y). Filename is the
// download name the OS save dialog receives.

const PAGE_W_MM = 210 // A4
const PAGE_H_MM = 297
const MARGIN_MM = 10

export async function exportReportPdf(
  pageEl: HTMLElement,
  fileBaseName: string,
  /** Page background from the active theme preset (dark or light). */
  backgroundColor = '#ffffff',
): Promise<void> {
  // Wait a frame so Recharts / fonts settle before capture.
  await new Promise<void>(r => requestAnimationFrame(() => r()))

  const canvas = await html2canvas(pageEl, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor,
    logging: false,
    // Capture full scroll height of the note, not the viewport.
    windowWidth: pageEl.scrollWidth,
    windowHeight: pageEl.scrollHeight,
  })

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const contentW = PAGE_W_MM - MARGIN_MM * 2
  const contentH = PAGE_H_MM - MARGIN_MM * 2

  const imgWmm = contentW

  // Slice the tall canvas into page-height chunks.
  const pageCanvas = document.createElement('canvas')
  const pageCtx = pageCanvas.getContext('2d')
  if (!pageCtx) throw new Error('Canvas unsupported')

  const pxPerMm = canvas.width / imgWmm
  const pageHeightPx = Math.floor(contentH * pxPerMm)
  let srcY = 0
  let page = 0

  while (srcY < canvas.height) {
    const sliceH = Math.min(pageHeightPx, canvas.height - srcY)
    pageCanvas.width = canvas.width
    pageCanvas.height = sliceH
    pageCtx.fillStyle = backgroundColor
    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    pageCtx.drawImage(
      canvas,
      0, srcY, canvas.width, sliceH,
      0, 0, canvas.width, sliceH,
    )
    const sliceData = pageCanvas.toDataURL('image/jpeg', 0.92)
    const sliceHmm = (sliceH * contentW) / canvas.width
    if (page > 0) pdf.addPage()
    pdf.addImage(sliceData, 'JPEG', MARGIN_MM, MARGIN_MM, contentW, sliceHmm)
    srcY += sliceH
    page += 1
  }

  const safe = fileBaseName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Report'
  pdf.save(`${safe}.pdf`)
}
