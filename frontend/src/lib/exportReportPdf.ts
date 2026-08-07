// Reports are printed as semantic HTML instead of canvas screenshots. The
// browser therefore paginates real text, repeats table headers, preserves SVG
// charts, and embeds the loaded Unicode web fonts in the saved PDF.

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

export function semanticPrintCss(backgroundColor = '#ffffff'): string {
  return `
    @page { size: A4 portrait; margin: 10mm; }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: auto !important;
      min-width: 0 !important;
      background: ${backgroundColor} !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .rc-page {
      width: auto !important;
      max-width: none !important;
      min-height: 0 !important;
      margin: 0 !important;
      box-shadow: none !important;
      overflow: visible !important;
    }
    .rc-report-sections { display: block !important; }
    .rc-report-section-half { width: auto !important; margin-bottom: 12px !important; }
    .rc-section { break-inside: auto; page-break-inside: auto; }
    .rc-section-heading, .rc-keep-tight {
      break-after: avoid-page;
      page-break-after: avoid;
    }
    .rc-atomic, .rc-figure, figure, svg, img {
      break-inside: avoid-page;
      page-break-inside: avoid;
    }
    .rc-appendix-table { break-inside: auto; page-break-inside: auto; }
    table { width: 100% !important; break-inside: auto; page-break-inside: auto; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { break-inside: avoid-page; page-break-inside: avoid; }
    a { color: inherit !important; text-decoration: none !important; }
  `
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function waitForImages(root: ParentNode, timeoutMs = 3500): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.race([
    Promise.all(images.map(image => image.complete
      ? Promise.resolve()
      : new Promise<void>(resolve => {
        image.addEventListener('load', () => resolve(), { once: true })
        image.addEventListener('error', () => resolve(), { once: true })
      }))),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ])
}

export function buildSemanticPrintDocument(
  pageEl: HTMLElement,
  fileBaseName: string,
  backgroundColor = '#ffffff',
): string {
  const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
    .map(node => node.outerHTML)
    .join('\n')
  const htmlAttributes = Array.from(document.documentElement.attributes)
    .filter(attribute => attribute.name !== 'style')
    .map(attribute => `${attribute.name}="${escapeHtml(attribute.value)}"`)
    .join(' ')
  return `<!doctype html>
    <html ${htmlAttributes}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(fileBaseName)}</title>
        ${styles}
        <style>${semanticPrintCss(backgroundColor)}</style>
      </head>
      <body class="${escapeHtml(document.body.className)}">${pageEl.outerHTML}</body>
    </html>`
}

export async function exportReportPdf(
  pageEl: HTMLElement,
  fileBaseName: string,
  backgroundColor = '#ffffff',
): Promise<void> {
  await document.fonts?.ready
  await waitForImages(pageEl)

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '1px'
  frame.style.height = '1px'
  frame.style.border = '0'
  frame.style.opacity = '0'
  document.body.appendChild(frame)

  const printWindow = frame.contentWindow
  const printDocument = frame.contentDocument
  if (!printWindow || !printDocument) {
    frame.remove()
    throw new Error('Print document could not be created')
  }

  printDocument.open()
  printDocument.write(buildSemanticPrintDocument(pageEl, fileBaseName, backgroundColor))
  printDocument.close()
  await printDocument.fonts?.ready
  await waitForImages(printDocument)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    frame.remove()
  }
  printWindow.addEventListener('afterprint', cleanup, { once: true })
  printWindow.focus()
  printWindow.print()
  setTimeout(cleanup, 60_000)
}
