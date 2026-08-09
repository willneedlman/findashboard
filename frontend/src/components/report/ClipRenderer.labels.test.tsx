import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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

  it('prints ticker cells as clean logo marks without duplicate ticker text', () => {
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

    expect(markup).toContain('aria-label="NVDA"')
    expect(markup).toContain('aria-label="NVDA logo"')
    expect(markup).not.toContain('>NVDA<')
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
