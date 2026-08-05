import { useEffect, useRef, useState } from 'react'

export default function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth < breakpoint : false)
  const isPrintingRef = useRef(false)
  const screenValueRef = useRef(isMobile)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const printMq = window.matchMedia('print')
    const updateScreenValue = (matches: boolean) => {
      if (isPrintingRef.current || printMq.matches) return
      screenValueRef.current = matches
      setIsMobile(matches)
    }
    const handler = (e: MediaQueryListEvent) => updateScreenValue(e.matches)
    const handleBeforePrint = () => {
      isPrintingRef.current = true
      setIsMobile(screenValueRef.current)
    }
    const handleAfterPrint = () => {
      isPrintingRef.current = false
      updateScreenValue(mq.matches)
    }

    mq.addEventListener('change', handler)
    window.addEventListener('beforeprint', handleBeforePrint)
    window.addEventListener('afterprint', handleAfterPrint)
    updateScreenValue(mq.matches)

    return () => {
      mq.removeEventListener('change', handler)
      window.removeEventListener('beforeprint', handleBeforePrint)
      window.removeEventListener('afterprint', handleAfterPrint)
    }
  }, [breakpoint])

  return isMobile
}
