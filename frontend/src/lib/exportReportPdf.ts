// Rasterize the on-screen research note into a multi-page PDF without the
// browser's automatic print chrome (URL, clock, page X/Y). Filename is the
// download name the OS save dialog receives.
//
// html2canvas + jspdf are dynamic-imported so they stay out of the initial
// ReportPrint chunk until the user actually clicks Download PDF.

const PAGE_W_MM = 210 // A4
const PAGE_H_MM = 297
const MARGIN_MM = 10

export interface PdfKeepSpan {
  top: number
  bottom: number
  preferEarlierBreak?: boolean
  strict?: boolean
}

export interface PdfSlicePlan {
  pageHeight: number
  scaleFactor: number
  slices: Array<{ start: number; height: number }>
}

export function reportPdfBaseName(projectName: string): string {
  const safe = projectName
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\.alphatape)?\.pdf$/i, '')
    .replace(/\.alphatape$/i, '')
    .trim()
    .slice(0, 80) || 'Report'
  return `${safe}.alphatape`
}

export function computePdfSlices(
  totalHeight: number,
  pageHeight: number,
  keepSpans: PdfKeepSpan[],
): Array<{ start: number; height: number }> {
  const slices: Array<{ start: number; height: number }> = []
  let start = 0
  while (start < totalHeight) {
    const naturalEnd = Math.min(start + pageHeight, totalHeight)
    let end = naturalEnd
    if (naturalEnd < totalHeight) {
      const boundarySafety = pageHeight * 0.02
      const breakGap = Math.max(8, Math.ceil(pageHeight * 0.006))
      const clearsMinimumFill = (span: PdfKeepSpan) =>
        span.strict
          ? span.top > start + 1
          : span.top >= start + pageHeight * (span.preferEarlierBreak ? 0.5 : 0.58)
      const crossing = keepSpans
        .filter(span =>
          span.top < naturalEnd
          && span.bottom > naturalEnd - boundarySafety
          && clearsMinimumFill(span)
          && span.bottom - span.top < pageHeight * 0.985)
        .sort((a, b) => a.top - b.top)
      if (crossing.length) end = Math.max(start + 1, Math.floor(crossing[0].top) - breakGap)
      for (let guard = 0; guard < 8 && end < naturalEnd; guard += 1) {
        const newlyCrossed = keepSpans
          .filter(span =>
            span.top < end
            && (
              span.bottom > end
              || (span.preferEarlierBreak && span.bottom > end - boundarySafety)
            )
            && clearsMinimumFill(span)
            && span.bottom - span.top < pageHeight * 0.985)
          .sort((a, b) => a.top - b.top)
        if (!newlyCrossed.length) break
        const nextEnd = Math.max(start + 1, Math.floor(newlyCrossed[0].top) - breakGap)
        if (nextEnd >= end) break
        end = nextEnd
      }
    }
    slices.push({ start, height: Math.max(1, end - start) })
    start = end
  }
  return slices
}

export function choosePdfSlicePlan(
  totalHeight: number,
  basePageHeight: number,
  keepSpans: PdfKeepSpan[],
): PdfSlicePlan {
  const scaleFactors = [1, 1.025, 1.05, 1.075, 1.1, 1.125, 1.15]
  const plans = scaleFactors.map(scaleFactor => {
    const pageHeight = Math.floor(basePageHeight * scaleFactor)
    return {
      pageHeight,
      scaleFactor,
      slices: computePdfSlices(totalHeight, pageHeight, keepSpans),
    }
  })
  return plans.reduce((best, plan) => {
    if (plan.slices.length < best.slices.length) return plan
    if (plan.slices.length > best.slices.length) return best
    return plan.scaleFactor < best.scaleFactor ? plan : best
  })
}

async function waitForReportImages(pageEl: HTMLElement, timeoutMs = 1800): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let stablePasses = 0
  while (performance.now() < deadline) {
    const pending = Array.from(pageEl.querySelectorAll('img'))
      .some(image => !image.complete)
    stablePasses = pending ? 0 : stablePasses + 1
    if (stablePasses >= 2) return
    await new Promise<void>(resolve => setTimeout(resolve, 60))
  }
}

interface PdfTextRun {
  text: string
  left: number
  top: number
}

function collectPdfTextRuns(pageEl: HTMLElement): PdfTextRun[] {
  const pageRect = pageEl.getBoundingClientRect()
  const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT)
  const runs: PdfTextRun[] = []
  let node = walker.nextNode()
  while (node) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    const parent = node.parentElement
    if (text && parent && getComputedStyle(parent).visibility !== 'hidden') {
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        runs.push({ text, left: rect.left - pageRect.left, top: rect.top - pageRect.top })
      }
    }
    node = walker.nextNode()
  }
  return runs
}

export async function exportReportPdf(
  pageEl: HTMLElement,
  fileBaseName: string,
  /** Page background from the active theme preset (dark or light). */
  backgroundColor = '#ffffff',
): Promise<void> {
  const [{ default: html2canvas }, { jsPDF, GState }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ])

  await waitForReportImages(pageEl)
  await new Promise<void>(r => requestAnimationFrame(() => r()))
  const textRuns = collectPdfTextRuns(pageEl)

  const canvas = await html2canvas(pageEl, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor,
    logging: false,
    windowWidth: Math.max(document.documentElement.clientWidth, pageEl.scrollWidth),
    windowHeight: pageEl.scrollHeight,
  })

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  pdf.setProperties({
    title: fileBaseName,
    subject: 'Investment research report',
    author: 'Alphatape',
    creator: 'Alphatape Report Creator',
    keywords: 'portfolio, investment research, risk, performance',
  })
  pdf.setLanguage('en-US')
  const contentW = PAGE_W_MM - MARGIN_MM * 2
  const contentH = PAGE_H_MM - MARGIN_MM * 2

  const basePageHeightPx = Math.floor(contentH * (canvas.width / contentW))
  const pageCanvas = document.createElement('canvas')
  const pageCtx = pageCanvas.getContext('2d')
  if (!pageCtx) throw new Error('Canvas unsupported')

  const pageRect = pageEl.getBoundingClientRect()
  const domToCanvas = canvas.height / Math.max(1, pageEl.scrollHeight)
  const spanFor = (element: HTMLElement, preferEarlierBreak = false): PdfKeepSpan => {
    const rect = element.getBoundingClientRect()
    return {
      top: Math.max(0, (rect.top - pageRect.top) * domToCanvas),
      bottom: Math.min(canvas.height, (rect.bottom - pageRect.top) * domToCanvas),
      preferEarlierBreak,
      strict: element.classList.contains('rc-atomic'),
    }
  }
  const keepSpans = Array.from(pageEl.querySelectorAll<HTMLElement>('.rc-keep'))
    .filter(element => {
      const atomicParent = element.parentElement?.closest<HTMLElement>('.rc-atomic')
      return !atomicParent
    })
    .map(element => spanFor(element, element.classList.contains('rc-keep-tight')))
    .filter(span => span.bottom > span.top)
  for (const section of pageEl.querySelectorAll<HTMLElement>('.rc-section')) {
    const heading = section.querySelector<HTMLElement>('.rc-section-heading')
    if (!heading) continue
    const sectionSpan = spanFor(section)
    const headingSpan = spanFor(heading)
    keepSpans.push({
      top: headingSpan.top,
      bottom: Math.min(sectionSpan.bottom, headingSpan.bottom + 120 * domToCanvas),
      preferEarlierBreak: true,
    })
  }
  const plan = choosePdfSlicePlan(canvas.height, basePageHeightPx, keepSpans)
  const imgWmm = contentW / plan.scaleFactor
  const imgXmm = (PAGE_W_MM - imgWmm) / 2

  for (const [page, slice] of plan.slices.entries()) {
    const sliceH = slice.height
    pageCanvas.width = canvas.width
    pageCanvas.height = sliceH
    pageCtx.fillStyle = backgroundColor
    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    pageCtx.drawImage(
      canvas,
      0, slice.start, canvas.width, sliceH,
      0, 0, canvas.width, sliceH,
    )
    const sliceData = pageCanvas.toDataURL('image/png')
    const sliceHmm = (sliceH * imgWmm) / canvas.width
    if (page > 0) pdf.addPage()
    pdf.setFillColor(backgroundColor)
    pdf.rect(0, 0, PAGE_W_MM, PAGE_H_MM, 'F')
    pdf.addImage(sliceData, 'PNG', imgXmm, MARGIN_MM, imgWmm, sliceHmm, undefined, 'FAST')
    const domSliceStart = slice.start / domToCanvas
    const domSliceEnd = (slice.start + slice.height) / domToCanvas
    pdf.saveGraphicsState()
    pdf.setGState(new GState({ opacity: 0 }))
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(8)
    for (const run of textRuns) {
      if (run.top < domSliceStart || run.top >= domSliceEnd) continue
      const x = imgXmm + (run.left * domToCanvas * imgWmm) / canvas.width
      const y = MARGIN_MM + ((run.top * domToCanvas - slice.start) * imgWmm) / canvas.width
      pdf.text(run.text, x, y, { baseline: 'top' })
    }
    pdf.restoreGraphicsState()
  }

  const totalPages = pdf.getNumberOfPages()
  for (let page = 1; page <= totalPages; page += 1) {
    pdf.setPage(page)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(7)
    pdf.setTextColor(130, 138, 148)
    if (page > 1) pdf.text(fileBaseName.slice(0, 72), MARGIN_MM, 6)
    pdf.text(`${page} / ${totalPages}`, PAGE_W_MM - MARGIN_MM, PAGE_H_MM - 5, { align: 'right' })
  }

  const safe = fileBaseName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Report'
  pdf.save(`${safe}.pdf`)
}
