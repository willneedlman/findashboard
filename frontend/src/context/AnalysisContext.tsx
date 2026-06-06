import React, { createContext, useState, useContext, useRef, useEffect, useCallback } from 'react'

interface Result { ticker: string; summary?: any; error?: string; sources?: number }

interface AnalysisContextType {
  inProgress: boolean;
  overallProgress: number;
  tickerProgress: Record<string, { stage: string; pct: number }>;
  streamedResults: Result[];
  analysisError: string | null;
  startAnalysis: (
    tickers: string[],
    include10q: boolean,
    include10k: boolean,
    transcriptLimit: number
  ) => Promise<void>;
  cancelAnalysis: () => void;
}

const AnalysisContext = createContext<AnalysisContextType | undefined>(undefined)

export const AnalysisProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [inProgress,      setInProgress]      = useState(false)
  const [overallProgress, setOverallProgress] = useState(0)
  const [tickerProgress,  setTickerProgress]  = useState<Record<string, { stage: string; pct: number }>>({})
  const [streamedResults, setStreamedResults] = useState<Result[]>([])
  const [analysisError,   setAnalysisError]   = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startAnalysis = useCallback(async (
    tickers: string[],
    include10q: boolean,
    include10k: boolean,
    transcriptLimit: number
  ) => {
    if (inProgress) {
      console.warn('Analysis already in progress. Ignoring new request.')
      return
    }

    setAnalysisError(null)
    setStreamedResults([])
    setInProgress(true)
    setOverallProgress(0)
    setTickerProgress({})

    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    try {
      const response = await fetch('/api/filings/summarise-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tickers,
          include_10q: include10q,
          include_10k: include10k,
          transcript_limit: transcriptLimit,
        }),
        signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const result = await reader?.read()
        if (signal.aborted) {
          console.log('Analysis aborted by user.')
          break
        }
        if (result?.done) break

        buffer += decoder.decode(result?.value, { stream: true })
        const lines = buffer.split('\n')

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i]
          if (line.startsWith('data: ')) {
            try {
              const parsedData = JSON.parse(line.substring(6))
              switch (parsedData.type) {
                case 'start':
                  const initialProgress: Record<string, { stage: string; pct: number }> = {}
                  parsedData.tickers.forEach((t: string) => {
                    initialProgress[t] = { stage: 'Queued', pct: 0 }
                  })
                  setTickerProgress(initialProgress)
                  break
                case 'progress':
                  setTickerProgress(prev => ({
                    ...prev,
                    [parsedData.ticker]: { stage: parsedData.stage, pct: parsedData.pct },
                  }))
                  break
                case 'result':
                  setStreamedResults(prev => [...prev, parsedData.data])
                  setTickerProgress(prev => ({
                    ...prev,
                    [parsedData.ticker]: { stage: 'Completed', pct: 100 },
                  }))
                  break
                case 'done':
                  setInProgress(false)
                  break
                default:
                  break
              }
            } catch (jsonErr) {
              console.error('JSON parsing error:', jsonErr)
            }
          }
        }
        buffer = lines[lines.length - 1] // Keep the last incomplete line in the buffer
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Fetch aborted.')
      } else {
        console.error('Fetch/Stream failed:', err)
        setAnalysisError('Analysis failed. Please check the console for more details or try again: ' + err.message)
      }
    } finally {
      setInProgress(false)
      abortControllerRef.current = null
    }
  }, [inProgress]) // Depend on inProgress to prevent re-creating startAnalysis if it isn't truly changing

  const cancelAnalysis = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      setInProgress(false) // Immediately set inProgress to false on manual cancellation
      setAnalysisError('Analysis cancelled by user.')
    }
  }, [])

  // Calculate overall progress
  useEffect(() => {
    const totalTickers = Object.keys(tickerProgress).length
    if (totalTickers === 0 || !inProgress) {
      setOverallProgress(0)
      return
    }

    const sumPct = Object.values(tickerProgress).reduce((sum, tp) => sum + tp.pct, 0)
    setOverallProgress(Math.round(sumPct / totalTickers))
  }, [tickerProgress, inProgress])

  const contextValue = {
    inProgress,
    overallProgress,
    tickerProgress,
    streamedResults,
    analysisError,
    startAnalysis,
    cancelAnalysis,
  }

  return (
    <AnalysisContext.Provider value={contextValue}>
      {children}
    </AnalysisContext.Provider>
  )
}

export const useAnalysis = () => {
  const context = useContext(AnalysisContext)
  if (context === undefined) {
    throw new Error('useAnalysis must be used within an AnalysisProvider')
  }
  return context
}
