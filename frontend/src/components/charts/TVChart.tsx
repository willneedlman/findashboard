import { useEffect, useRef } from 'react'
import { createChart, ColorType, LineStyle } from 'lightweight-charts'

interface TVChartProps {
  data: { date: string; value: number }[]
  color?: string
  height?: number
  fillArea?: boolean
  formatValue?: (v: number) => string
}

export default function TVChart({
  data,
  color = '#1f5673',
  height = 260,
  fillArea = false,
  formatValue,
}: TVChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || !data.length) return

    const textColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--theme-secondary').trim() || '#5e768f'

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor,
        fontFamily: 'Lora, serif',
      },
      grid: {
        vertLines: { color: 'rgba(128,128,128,0.08)' },
        horzLines: { color: 'rgba(128,128,128,0.08)' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: {
        borderColor: 'var(--theme-border, rgba(255,255,255,0.06))',
        textColor,
      },
      timeScale: {
        borderColor: 'var(--theme-border, rgba(255,255,255,0.06))',
        timeVisible: true,
      },
      width: containerRef.current.clientWidth,
      height,
    })

    const series = fillArea
      ? chart.addAreaSeries({
          lineColor: color,
          topColor: color.replace(')', ', 0.2)').replace('rgb', 'rgba'),
          bottomColor: 'transparent',
          lineWidth: 2,
        })
      : chart.addLineSeries({
          color,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
        })

    const mapped = data
      .filter(d => d.value !== null && !isNaN(d.value))
      .map(d => ({ time: d.date as any, value: d.value }))

    series.setData(mapped)
    chart.timeScale().fitContent()

    if (formatValue) {
      chart.applyOptions({
        localization: {
          priceFormatter: formatValue,
        },
      })
    }

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [data, color, height, fillArea])

  return <div ref={containerRef} className="w-full" />
}
