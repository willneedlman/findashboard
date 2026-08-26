import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { divergingBarLabel } from './chartLabels'
import type { ClipPalette } from '../../lib/reportTheme'
import TickerLogo from '../TickerLogo'
import ClipRenderer, { categoricalAxisIsCrowded, HorizontalCategoryTick, reportChartHeight } from './ClipRenderer'

const palette: ClipPalette = {
  ink: '#d7e3fc',
  muted: '#8099b0',
  border: '#243246',
  accent: '#c9a84c',
  pos: '#22c55e',
  neg: '#ef4444',
  gridStroke: '#243246',
  headBg: '#152235',
  cellBg: '#0d1826',
  series: ['#c9a84c'],
}

describe('horizontal chart SVG labels', () => {
  it('renders ticker and sector on one controlled line without the raw delimiter', () => {
    const markup = renderToStaticMarkup(
      <svg>
        <HorizontalCategoryTick
          x={140}
          y={20}
          payload={{ value: 'Consumer Staples · XLP' }}
          pal={palette}
          print
        />
      </svg>,
    )
    expect(markup).toContain('aria-label="XLP Consumer Staples"')
    expect(markup).toContain('>XLP</tspan>')
    expect(markup).toContain('>Consumer Staples</tspan>')
    expect(markup).not.toContain('·')
  })

  it('sizes short horizontal comparisons to their evidence instead of a generic chart height', () => {
    const shortChart = {
      kind: 'chart' as const,
      chartType: 'bar' as const,
      barOrientation: 'horizontal' as const,
      xKey: 'metric',
      data: [
        { metric: 'MCD Forward P/E', value: 19.2 },
        { metric: 'YUM Forward P/E', value: 20.4 },
        { metric: 'WEN Forward P/E', value: 12 },
        { metric: 'QSR Forward P/E', value: 17.1 },
      ],
      series: [{ key: 'value', label: 'Forward P/E' }],
    }
    const denseChart = {
      ...shortChart,
      data: Array.from({ length: 12 }, (_, index) => ({ metric: `Peer ${index + 1}`, value: index + 1 })),
    }

    expect(reportChartHeight(shortChart, true)).toBe(138)
    expect(reportChartHeight(shortChart, true, true)).toBe(124)
    expect(reportChartHeight(denseChart, true)).toBe(262)
  })

  it('names the ticker in the ticker column, with the mark beside it', () => {
    // The mark alone rendered a peer table's identity column as six unlabelled
    // logos, so a reader could not tell which row was which.
    const markup = renderToStaticMarkup(
      <ClipRenderer
        payload={{
          kind: 'table',
          title: 'Current allocation',
          columns: ['Ticker', 'Weight %'],
          rows: [['NVDA', 13.13]],
        }}
        mode="print"
        palette={palette}
      />,
    )

    expect(markup).toContain('>NVDA<')
    expect(markup).toContain('aria-label="NVDA logo"')
  })

  it('does not paint fallback letters underneath a loading logo', () => {
    const markup = renderToStaticMarkup(<TickerLogo ticker="NVDA" showFallbackText />)

    expect(markup).toContain('<img')
    expect(markup).not.toContain('>NV<')
  })
})

describe('print table wrapping', () => {
  const table = (columns: string[], rows: (string | number | null)[][]) => renderToStaticMarkup(
    <ClipRenderer
      mode="print"
      palette={palette}
      payload={{ kind: 'table', title: 'Correlation matrix', columns, rows }}
    />,
  )

  it('does not offer mid-word break points in a wide matrix header', () => {
    // overflow-wrap:anywhere let the browser count breaks inside a word when
    // sizing the column, so a twelve-ticker matrix split QCOM into "QCO / M".
    const markup = table(['', 'NVDA', 'QCOM', 'AVGO'], [['NVDA', '1.00', '0.14', '0.35']])
    expect(markup).not.toContain('anywhere')
    expect(markup).toContain('break-word')
  })

  it('keeps every correlation cell at the same precision', () => {
    // The producer emits strings for this reason: +(1).toFixed(2) is 1, so the
    // diagonal printed as "1" beside "0.42" and the column would not line up.
    const markup = table(['', 'NVDA', 'QCOM'], [['NVDA', '1.00', '0.40']])
    expect(markup).toContain('1.00')
    expect(markup).toContain('0.40')
  })
})

describe('categorical axis crowding', () => {
  it('angles short labels once there are too many to sit side by side', () => {
    // Ten four-character tickers passed the length-only test and rendered flat,
    // running NVDA and AVGO together into "NVDAAVGO".
    expect(categoricalAxisIsCrowded(
      ['NVDA', 'AVGO', 'MU', 'AMD', 'INTC', 'TXN', 'MRVL', 'ADI', 'QCOM', 'ON'],
    )).toBe(true)
  })

  it('leaves a sparse axis horizontal, which is easier to read', () => {
    expect(categoricalAxisIsCrowded(['NVDA', 'AVGO', 'MU'])).toBe(false)
  })

  it('still angles a few long labels', () => {
    expect(categoricalAxisIsCrowded(['Communication Services', 'Cash'])).toBe(true)
  })
})

describe('expanded chart repertoire', () => {
  // The promotion path can now emit scatter, histogram and dot payloads that
  // never reached this renderer before. A throw here is a blank report.
  const render = (payload: Parameters<typeof ClipRenderer>[0]['payload']) =>
    renderToStaticMarkup(<ClipRenderer payload={payload} mode="print" palette={palette} />)

  it('renders a risk-against-size scatter without throwing', () => {
    expect(() => render({
      kind: 'chart',
      chartType: 'scatter',
      title: 'Holding beta against weight',
      xKey: 'Weight %',
      xUnit: 'percent',
      data: [
        { 'Weight %': 13.9, value: 1.49, label: 'NVDA' },
        { 'Weight %': 9.8, value: 1.67, label: 'ORCL' },
        { 'Weight %': 7.4, value: 1.08, label: 'MSFT' },
      ],
      series: [{ key: 'value', label: 'Market beta', unit: 'beta' }],
    })).not.toThrow()
  })

  it('renders a distribution histogram without throwing', () => {
    expect(() => render({
      kind: 'chart',
      chartType: 'histogram',
      title: 'Market beta · Distribution',
      xKey: 'bucket',
      data: [
        { bucket: '0.7–1.4', value: 6 },
        { bucket: '1.4–2.1', value: 7 },
        { bucket: '2.1–2.8', value: 3 },
      ],
      series: [{ key: 'value', label: 'Holdings per Market Beta band', unit: 'number' }],
    })).not.toThrow()
  })

  it('keeps an all-negative bar axis anchored at zero', () => {
    // A -175%..-35% axis made every bar start at the right edge, so its length
    // measured distance from -175 rather than from nothing.
    const markup = render({
      kind: 'chart',
      chartType: 'bar',
      barOrientation: 'horizontal',
      title: 'Upside to intrinsic',
      xKey: 'metric',
      data: [
        { metric: 'AMZN', value: -91.9 },
        { metric: 'MSFT', value: -59.8 },
      ],
      series: [{ key: 'value', label: 'Upside', unit: 'percent' }],
    })
    expect(markup).toContain('0%')
  })
})

// Printed in a real report as "XLU Utiliti-4.41 pp": the value label read back
// across its own bar and out of the plot, onto the category axis.
describe('diverging bar value labels', () => {
  const PLOT_LEFT = 90

  it('anchors a negative label to the bar tip, not the zero line', () => {
    // Recharts gives [x, x + width] with width positive, so for a negative bar
    // x + width is ZERO and x is the outer tip.
    const place = divergingBarLabel({ x: 200, width: 60, value: -4.41, plotLeft: PLOT_LEFT, text: '-4.41 pp' })
    expect(place.x).toBeLessThan(200)
    expect(place.anchor).toBe('end')
  })

  it('anchors a positive label past the far end of the bar', () => {
    const place = divergingBarLabel({ x: 260, width: 80, value: 7.47, plotLeft: PLOT_LEFT, text: '+7.47 pp' })
    expect(place.x).toBeGreaterThan(340)
    expect(place.anchor).toBe('start')
  })

  it('never lets a label cross into the category axis', () => {
    // A long bar reaching near the axis has no room to its left.
    const place = divergingBarLabel({ x: PLOT_LEFT + 6, width: 120, value: -4.41, plotLeft: PLOT_LEFT, text: '-4.41 pp' })
    expect(place.inside).toBe(true)
    expect(place.x).toBeGreaterThanOrEqual(PLOT_LEFT)
  })

  it('keeps a label outside the bar when there is room for it', () => {
    const place = divergingBarLabel({ x: 300, width: 40, value: -1.88, plotLeft: PLOT_LEFT, text: '-1.88 pp' })
    expect(place.inside).toBe(false)
  })
})
