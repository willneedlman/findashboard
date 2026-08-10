import { describe, expect, it } from 'vitest'
import { buildSemanticPrintDocument, reportPdfBaseName, semanticPrintCss } from './exportReportPdf'
import portfolioReviewFixture from '../fixtures/portfolioReview16.json'

describe('reportPdfBaseName', () => {
  it('uses the entered project name with the alphatape PDF suffix', () => {
    expect(reportPdfBaseName('Portfolio Analysis 7')).toBe('Portfolio Analysis 7.alphatape')
    expect(reportPdfBaseName('Portfolio Analysis 7.pdf')).toBe('Portfolio Analysis 7.alphatape')
    expect(reportPdfBaseName('Portfolio Analysis 7.alphatape.pdf')).toBe('Portfolio Analysis 7.alphatape')
  })
})

describe('semantic report pagination', () => {
  it('uses native pages, repeated table headers, and protected rows', () => {
    const css = semanticPrintCss('#101c2e')

    // A zero page margin is what removes the browser's own running head and
    // foot, which printed a timestamp and the raw print URL on every page.
    expect(css).toContain('@page { size: A4 portrait; margin: 0; }')
    expect(css).toContain('padding: 10mm 9mm !important;')
    expect(css).toContain('thead { display: table-header-group; }')
    expect(css).toContain('tr { break-inside: avoid-page;')
    expect(css).toContain('.rc-section { break-inside: auto;')
    expect(css).not.toContain('canvas')
  })

  it('preserves semantic tables and Unicode text in the print document', () => {
    const symbols = portfolioReviewFixture.symbols
    const previousDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        querySelectorAll: () => [{ outerHTML: '<style>.report { font-family: "Hanken Grotesk"; }</style>' }],
        documentElement: { attributes: [] },
        body: { className: 'theme-terminal' },
      },
    })
    const page = {
      outerHTML: `<main class="rc-page"><table><thead><tr><th>Position</th></tr></thead><tbody>${symbols.map((symbol, index) => `<tr><td>${symbol} · ${index === 14 ? '−3.2%' : '1.0%'}</td></tr>`).join('')}</tbody></table></main>`,
    } as HTMLElement
    const output = buildSemanticPrintDocument(page, 'Portfolio Review.alphatape', '#fff')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })

    expect(output).toContain('<meta charset="utf-8"')
    expect(output).toContain('<thead>')
    expect(output).toContain('MU · −3.2%')
    expect((output.match(/<tr>/g) ?? [])).toHaveLength(17)
    expect(output).toContain('Hanken Grotesk')
    expect(output).not.toContain('<canvas')
  })
})
