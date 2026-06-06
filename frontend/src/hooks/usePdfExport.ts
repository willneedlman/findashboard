export function usePdfExport() {
  const exportPdf = async (elementId: string, filename: string) => {
    const { default: html2canvas } = await import('html2canvas')
    const { default: jsPDF } = await import('jspdf')
    const el = document.getElementById(elementId)
    if (!el) return
    const canvas = await html2canvas(el, { backgroundColor: '#101c2e', scale: 2 })
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [canvas.width / 2, canvas.height / 2] })
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width / 2, canvas.height / 2)
    pdf.save(filename)
  }
  return { exportPdf }
}
