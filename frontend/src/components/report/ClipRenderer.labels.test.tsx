import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ClipPalette } from '../../lib/reportTheme'
import { HorizontalCategoryTick, reportChartHeight } from './ClipRenderer'

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
})
