import { useState, useEffect } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import TickerTagInput from '../components/TickerTagInput'
import { useAnalysis } from '../context/AnalysisContext'

const C = {
  bg: 'var(--theme-bg, #101c2e)', border: 'rgba(255,255,255,0.08)', header: 'var(--theme-surface, #0d1826)', surface: 'var(--theme-bg, #0a1220)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)', dim: '#3a4d62',
  pos: '#22C55E', neg: '#EF4444', warn: '#f59e0b', blue: '#60a5fa',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

const LABEL: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block' }

const TONE_COLOR: Record<string, string> = {
  bullish: C.pos, neutral: C.muted, cautious: C.warn, mixed: C.blue,
}

interface KeyMetric { name: string; value: string; vs_est?: string; yoy?: string }
interface Summary {
  quarter: string; verdict: string
  bull_points: string[]; bear_points: string[]; key_metrics: KeyMetric[]
  guidance: string; management_tone: string; key_themes: string[]
  risks: string[]; analyst_questions_focus: string
}
// Result interface is now defined in AnalysisContext.tsx
interface Filing { form: string; date: string; url: string }

// Move ResultCard outside to keep it clean (or define Result type here)
// For now, assume Result is correctly typed via context or local definition.
// If moving to context, ensure its definition is also robust.

interface Result { ticker: string; summary?: Summary; error?: string; sources?: number }

function ToneChip({ tone }: { tone: string }) {
  const color = TONE_COLOR[tone?.toLowerCase()] ?? C.muted
  return (
    <span style={{ fontFamily: C.mono, fontSize: 9, color, border: `1px solid ${color}40`, padding: '2px 8px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
      {tone}
    </span>
  )
}

function Pill({ label, color = C.muted }: { label: string; color?: string }) {
  return <span style={{ fontFamily: C.sans, fontSize: 9, color, background: `${color}15`, border: `1px solid ${color}30`, padding: '2px 7px', borderRadius: 2, whiteSpace: 'nowrap' }}>{label}</span>
}

function ResultCard({ result }: { result: Result }) {
  const [filings,       setFilings]       = useState<Filing[] | null>(null)
  const [loadingFilings,setLoadingFilings] = useState(false)
  const [filingsErr,    setFilingsErr]     = useState<string | null>(null)

  const fetchFilings = async () => {
    setLoadingFilings(true)
    setFilings(null)
    setFilingsErr(null)
    try {
      const res = await axios.get(`/api/filings/filings/${result.ticker}`)
      const list: Filing[] = res.data.filings ?? []
      setFilings(list)
      if (list.length === 0) setFilingsErr('No recent filings found on EDGAR')
    } catch {
      setFilings([])
      setFilingsErr('Could not reach SEC EDGAR — try again')
    } finally {
      setLoadingFilings(false)
    }
  }

  if (result.error) {
    return (
      <div style={{ border: `1px solid ${C.border}`, background: C.surface, padding: 16 }}>
        <div style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.gold, marginBottom: 8 }}>{result.ticker}</div>
        <div style={{ fontFamily: C.sans, fontSize: 11, color: C.neg }}>{result.error}</div>
      </div>
    )
  }

  const s = result.summary!
  return (
    <div style={{ border: `1px solid ${C.border}`, background: C.surface, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: C.header, borderBottom: `1px solid ${C.border}`, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.gold }}>{result.ticker}</span>
        <span style={{ fontFamily: C.sans, fontSize: 10, color: C.muted }}>{s.quarter}</span>
        <ToneChip tone={s.management_tone} />
        <span style={{ marginLeft: 'auto', fontFamily: C.sans, fontSize: 9, color: C.dim }}>{result.sources} source{result.sources !== 1 ? 's' : ''}</span>
      </div>

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Verdict */}
        <div style={{ fontFamily: C.sans, fontSize: 12, color: C.text, lineHeight: 1.55, fontStyle: 'italic', borderLeft: `3px solid ${C.gold}`, paddingLeft: 12 }}>
          {s.verdict}
        </div>

        {/* Key metrics */}
        {s.key_metrics?.length > 0 && (
          <div>
            <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>Key Metrics</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {s.key_metrics.map((m, i) => (
                <div key={i} style={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${C.border}`, padding: '7px 12px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 110 }}>
                  <span style={{ fontFamily: C.sans, fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{m.name}</span>
                  <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.text }}>{m.value}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {m.vs_est && <span style={{ fontFamily: C.sans, fontSize: 9, color: m.vs_est.startsWith('+') ? C.pos : m.vs_est.startsWith('-') ? C.neg : C.muted }}>vs est {m.vs_est}</span>}
                    {m.yoy && <span style={{ fontFamily: C.sans, fontSize: 9, color: m.yoy.startsWith('+') ? C.pos : m.yoy.startsWith('-') ? C.neg : C.muted }}>YoY {m.yoy}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bull / Bear */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontFamily: C.sans, fontSize: 9, color: C.pos, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>▲ Bull Case</div>
            <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {s.bull_points?.map((p, i) => (
                <li key={i} style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{p}</li>
              ))}
            </ul>
          </div>
          <div>
            <div style={{ fontFamily: C.sans, fontSize: 9, color: C.neg, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>▼ Bear Case</div>
            <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {s.bear_points?.map((p, i) => (
                <li key={i} style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{p}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* Guidance */}
        {s.guidance && s.guidance !== 'N/A' && (
          <div style={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${C.border}`, padding: '8px 12px' }}>
            <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 4 }}>Management Guidance</div>
            <div style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.55 }}>{s.guidance}</div>
          </div>
        )}

        {/* Themes + Risks + Q&A focus */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {s.key_themes?.length > 0 && (
            <div>
              <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Key Themes</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {s.key_themes.map((t, i) => <Pill key={i} label={t} color={C.blue} />)}
              </div>
            </div>
          )}
          {s.risks?.length > 0 && (
            <div>
              <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Risks</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {s.risks.map((r, i) => <Pill key={i} label={r} color={C.warn} />)}
              </div>
            </div>
          )}
        </div>

        {s.analyst_questions_focus && (
          <div style={{ fontFamily: C.sans, fontSize: 10, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <span style={{ color: C.dim, marginRight: 6, textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.1em' }}>Analyst Focus:</span>
            {s.analyst_questions_focus}
          </div>
        )}

        {/* SEC filings */}
        <div>
          <button onClick={fetchFilings} disabled={loadingFilings}
            style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 12px', cursor: loadingFilings ? 'default' : 'pointer', opacity: loadingFilings ? 0.6 : 1 }}>
            {loadingFilings ? 'Loading…' : filings && filings.length > 0 ? '↺ Refresh SEC Filings' : 'Fetch SEC Filings'}
          </button>
          {filings && filings.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {filings.map((f, i) => (
                <a key={i} href={f.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontFamily: C.sans, fontSize: 9, color: C.blue, border: `1px solid ${C.blue}30`, padding: '3px 8px', textDecoration: 'none' }}>
                  {f.form} · {f.date.slice(0, 7)} ↗
                </a>
              ))}
            </div>
          )}
          {filingsErr && (
            <span style={{ fontFamily: C.sans, fontSize: 9, color: C.warn, marginLeft: 8 }}>{filingsErr}</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default function EarningsSummarizer() {
  const [tickers,    setTickers]    = useState<string[]>(['NVDA', 'AAPL'])
  const [include10q, setInclude10q] = useState(true)
  const [include10k, setInclude10k] = useState(false)
  const [txLimit,    setTxLimit]    = useState(1)

  const [streamedResults, setStreamedResults] = useState<Result[]>([])
  const [inProgress,      setInProgress]      = useState(false)
  const [overallProgress, setOverallProgress] = useState(0)
  const [tickerProgress,  setTickerProgress]  = useState<Record<string, { stage: string; pct: number }>>({})
  const [error,           setError]           = useState<string | null>(null)

  const isPending = inProgress

  const startAnalysis = async () => {
    setError(null)
    setStreamedResults([])
    setInProgress(true)
    setOverallProgress(0)
    setTickerProgress({})

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
          transcript_limit: txLimit,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const result = await reader?.read()
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
    } catch (err) {
      console.error('Fetch/Stream failed:', err)
      setError('Analysis failed. Please check the console for more details or try again.')
    } finally {
      setInProgress(false)
    }
  }

  // Calculate overall progress
  useEffect(() => {
    const totalTickers = tickers.length
    if (totalTickers === 0 || !inProgress) {
      setOverallProgress(0)
      return
    }

    const sumPct = Object.values(tickerProgress).reduce((sum, tp) => sum + tp.pct, 0)
    setOverallProgress(Math.round(sumPct / totalTickers))
  }, [tickerProgress, tickers.length, inProgress])

  const check: React.CSSProperties = { width: 12, height: 12, flexShrink: 0, cursor: 'pointer' }

  return (
    <PageWrapper title="Earnings Summarizer">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Control bar */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={LABEL}>Tickers</label>
            <TickerTagInput tickers={tickers} onChange={setTickers} />
          </div>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Options */}
            <div style={{ display: 'flex', gap: 16 }}>
              {[
                { label: 'Include quarterly financials (10-Q)', val: include10q, set: setInclude10q },
                { label: 'Include annual data (10-K)',          val: include10k, set: setInclude10k },
              ].map(opt => (
                <label key={opt.label} onClick={() => opt.set(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                  <div style={{ ...check, border: `1px solid ${opt.val ? C.gold : C.dim}`, background: opt.val ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {opt.val && <div style={{ width: 5, height: 5, background: C.gold }} />}
                  </div>
                  <span style={{ fontFamily: C.sans, fontSize: 10, color: opt.val ? C.text : C.dim }}>{opt.label}</span>
                </label>
              ))}
            </div>

            {/* Transcript count */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Calls to include</span>
              {[1, 2, 4].map(n => (
                <button key={n} onClick={() => setTxLimit(n)} style={{ background: txLimit === n ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'transparent', border: `1px solid ${txLimit === n ? C.gold : C.border}`, color: txLimit === n ? C.gold : C.muted, fontFamily: C.mono, fontSize: 10, padding: '3px 9px', cursor: 'pointer' }}>{n}</button>
              ))}
            </div>

            {/* Run button */}
            <button onClick={startAnalysis} disabled={isPending || tickers.length === 0}
              style={{ marginLeft: 'auto', background: 'var(--theme-surface, #1f2a3d)', border: `1px solid ${C.gold}`, color: C.gold, fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '8px 20px', cursor: isPending || tickers.length === 0 ? 'default' : 'pointer', opacity: isPending || tickers.length === 0 ? 0.6 : 1 }}>
              {isPending ? `Analyzing… (${overallProgress}%)` : 'Analyze'}
            </button>
          </div>
        </div>


        {/* Error */}
        {error && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', padding: 12, fontFamily: C.sans, fontSize: 11, color: C.neg }}>
            {error}
          </div>
        )}

        {/* Overall Progress Bar */}
        {inProgress && (
          <div style={{ width: '100%', height: 8, background: C.dim, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${overallProgress}%`, height: '100%', background: C.gold, transition: 'width 0.3s ease-out' }} />
          </div>
        )}

        {/* Ticker-level Progress */}
        {inProgress && Object.keys(tickerProgress).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {Object.entries(tickerProgress).map(([ticker, progress]) => (
              <div key={ticker} style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1px solid ${C.border}`, padding: '4px 8px', borderRadius: 4, background: C.surface }}>
                <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: C.gold }}>{ticker}</span>
                <span style={{ fontFamily: C.sans, fontSize: 10, color: C.muted }}>{progress.stage} ({progress.pct}%)</span>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {streamedResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {streamedResults.map((r: Result) => <ResultCard key={r.ticker} result={r} />)}
          </div>
        )}

        {!inProgress && streamedResults.length === 0 && !error && (
          <div style={{ textAlign: 'center', padding: '48px 0', fontFamily: C.sans, fontSize: 12, color: C.dim }}>
            Add tickers above and press Analyze to generate AI-powered earnings summaries
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
