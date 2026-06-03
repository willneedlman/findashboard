import { useState, useEffect, useRef } from 'react'

interface Opts {
  gap?:          number   // px gap between tiles
  padding?:      number   // px padding inside container (each side)
  minW?:         number   // minimum tile width before trying fewer columns
  minH?:         number   // minimum tile height before trying fewer rows
  targetAspect?: number   // preferred tile w/h ratio (score penalty if far from this)
}

/**
 * Computes the column count that fills the container most efficiently.
 *
 * Algorithm: for each possible column count 1…N, calculate the resulting
 * tile dimensions, score by (empty fraction × 8 + log-aspect-ratio deviation),
 * and pick the lowest-scoring layout. Returns the ref to attach to the grid
 * container and the column count to use in gridTemplateColumns.
 */
export function useOptimalGrid(
  count: number,
  opts: Opts = {}
): { cols: number; gridRef: React.RefObject<HTMLDivElement> } {
  const {
    gap          = 6,
    padding      = 8,
    minW         = 130,
    minH         = 60,
    targetAspect = 1.8,
  } = opts

  const gridRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(() => Math.max(1, Math.min(count, 3)))

  useEffect(() => {
    const el = gridRef.current
    if (!el || count === 0) return

    const compute = (W: number, H: number): number => {
      const innerW = Math.max(0, W - padding * 2)
      const innerH = Math.max(0, H - padding * 2)

      let bestCols  = 1
      let bestScore = Infinity

      for (let c = 1; c <= count; c++) {
        const r  = Math.ceil(count / c)
        const tw = (innerW - gap * (c - 1)) / c
        const th = (innerH - gap * (r - 1)) / r

        if (tw < minW || th < minH) continue

        const emptyFrac   = (c * r - count) / (c * r)
        const aspectScore = Math.abs(Math.log((tw / th) / targetAspect))
        const score       = emptyFrac * 8 + aspectScore

        if (score < bestScore) {
          bestScore = score
          bestCols  = c
        }
      }

      return Math.max(1, bestCols)
    }

    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      if (width > 0 && height > 0) setCols(compute(width, height))
    }

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure() // initial pass before first resize event
    return () => ro.disconnect()
  }, [count, gap, padding, minW, minH, targetAspect])

  return { cols, gridRef }
}
