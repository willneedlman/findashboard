import { useState, useEffect, useRef } from 'react'

export default function useContainerSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setSize({ width: Math.round(width), height: Math.round(height) })
    })
    ro.observe(el)
    const { width, height } = el.getBoundingClientRect()
    setSize({ width: Math.round(width), height: Math.round(height) })
    return () => ro.disconnect()
  }, [])

  return { ref, ...size }
}
