import { useState, useEffect } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TickerTagInput from '../components/TickerTagInput'
import useIsMobile from '../hooks/useIsMobile'
import { useAnalysis } from '../context/AnalysisContext'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, textClip } from '../lib/reportCaptureRegistry'

const C = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', header: 'var(--theme-surface, #0d1826)', surface: 'var(--theme-bg, #101c2e)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)',
  // Dimmer than muted, but theme-aware: a faded secondary toward the bg so it
  // never renders as a fixed navy on light themes (Paper White).
  dim: 'color-mix(in srgb, var(--theme-secondary, #5e768f) 62%, var(--theme-bg, #101c2e))',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)', warn: '#f59e0b', blue: 'var(--theme-tertiary, #60a5fa)',
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
interface MetricVal { value: string; yoy?: string | null; prior?: string | null; delta_bps?: number | null; basis?: string }
interface ReportedMetric { name: string; actual: string; estimate?: string | null; variance?: string | null; variance_pct?: string | null; yoy?: string | null }
interface Metrics { eps?: MetricVal; revenue?: MetricVal; rev_yoy?: MetricVal; gross_margin?: MetricVal; reported_vs_consensus?: ReportedMetric[] }
interface Segment { name: string; value: number }
interface Filing { form: string; date: string; url: string }

interface Reaction { date: string; pct: number }
interface Result {
  ticker: string; id?: string; company?: string; period?: string; form?: string; filed?: string; url?: string
  metrics?: Metrics | null; segments?: Segment[] | null; reaction?: Reaction | null
  summary?: Summary; error?: string; sources?: number
}

// Green for a positive change, red for a negative one, muted otherwise.
function signColor(s?: string | null): string {
  if (!s) return C.muted
  if (/^\+/.test(s) && !/^\+0(\.0+)?%?$/.test(s)) return C.pos
  if (/^[-−]/.test(s)) return C.neg
  return C.muted
}

function fmtB(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${v.toFixed(0)}`
}

function MetricTile({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '12px 16px', borderLeft: `1px solid ${C.border}` }}>
      <div style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.muted, marginBottom: 7 }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: 24, fontWeight: 700, color: C.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: C.mono, fontSize: 10, color: subColor ?? C.muted, marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function MetricStrip({ m }: { m: Metrics }) {
  const tiles: React.ReactNode[] = []
  if (m.eps) tiles.push(<MetricTile key="eps" label="EPS" value={m.eps.value} sub={m.eps.yoy ? `${m.eps.yoy} YoY` : undefined} subColor={signColor(m.eps.yoy)} />)
  if (m.revenue) tiles.push(<MetricTile key="rev" label="Revenue" value={m.revenue.value} sub={m.revenue.yoy ? `${m.revenue.yoy} YoY` : undefined} subColor={signColor(m.revenue.yoy)} />)
  if (m.rev_yoy) tiles.push(<MetricTile key="ry" label="Rev YoY" value={m.rev_yoy.value} sub={m.rev_yoy.prior ? `vs ${m.rev_yoy.prior} prior` : undefined} subColor={signColor(m.rev_yoy.value)} />)
  if (m.gross_margin) {
    const d = m.gross_margin.delta_bps
    const sub = d != null ? `${d >= 0 ? '+' : ''}${d}bps ${m.gross_margin.basis ?? ''}`.trim() : undefined
    tiles.push(<MetricTile key="gm" label="Gross Margin" value={m.gross_margin.value} sub={sub} subColor={d == null ? C.muted : d >= 0 ? C.pos : C.neg} />)
  }
  if (!tiles.length) return null
  return <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, background: 'var(--theme-bg, #101c2e)' }}>{tiles}</div>
}

function ReportedVsConsensus({ metrics }: { metrics: ReportedMetric[] }) {
  if (!metrics.length) return null
  return (
    <div style={{ border: `1px solid ${C.border}`, background: 'var(--theme-bg, #101c2e)' }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, color: C.gold, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Reported Results vs Consensus</span>
        <span style={{ fontFamily: C.mono, fontSize: 9, color: C.dim }}>Consensus appears where a contemporaneous estimate is available</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {metrics.map(metric => {
          const varianceText = metric.variance_pct ?? metric.variance
          const varianceColor = signColor(varianceText)
          return (
            <div key={metric.name} style={{ minWidth: 0, padding: '10px 12px', borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.muted, marginBottom: 6 }}>{metric.name}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: C.mono, fontSize: 17, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>{metric.actual}</span>
                {varianceText && <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: varianceColor, whiteSpace: 'nowrap' }}>{varianceText} vs est.</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 5, fontFamily: C.mono, fontSize: 9, color: C.dim }}>
                {metric.estimate && <span>Est. <strong style={{ color: C.muted, fontWeight: 700 }}>{metric.estimate}</strong></span>}
                {metric.yoy && <span style={{ color: signColor(metric.yoy) }}>{metric.yoy} YoY</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SegmentBars({ segments }: { segments: Segment[] }) {
  const max = Math.max(...segments.map(s => s.value), 1)
  return (
    <div>
      <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>Segment Revenue</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {segments.map(s => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.muted, width: 96, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.name}>{s.name}</span>
            <div style={{ flex: 1, height: 9, background: 'var(--theme-surface, #0d1826)', border: `1px solid ${C.border}` }}>
              <div style={{ width: `${Math.max(2, (s.value / max) * 100)}%`, height: '100%', background: C.blue }} />
            </div>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.text, width: 56, flexShrink: 0, textAlign: 'right' }}>{fmtB(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
  const subline = [result.period, result.form && result.filed ? `${result.form} · filed ${result.filed}` : null].filter(Boolean).join(' · ')
  return (
    <div style={{ border: `1px solid ${C.border}`, background: C.surface, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: C.header, borderBottom: `1px solid ${C.border}`, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 700, color: C.gold, border: `1px solid ${C.gold}55`, padding: '4px 6px', flexShrink: 0, letterSpacing: '0.04em' }}>{result.ticker.slice(0, 2)}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: C.mono, fontSize: 15, fontWeight: 700, color: C.text }}>{result.ticker}</span>
            {result.company && <span style={{ fontFamily: C.sans, fontSize: 12, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{result.company}</span>}
          </div>
          <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 3 }}>{subline}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          <ToneChip tone={s.management_tone} />
          {result.reaction && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted, marginBottom: 3 }}>Reaction</div>
              <div style={{ fontFamily: C.mono, fontSize: 16, fontWeight: 700, color: result.reaction.pct >= 0 ? C.pos : C.neg, lineHeight: 1 }}>
                {result.reaction.pct >= 0 ? '+' : ''}{result.reaction.pct.toFixed(1)}%
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Metric strip */}
      {result.metrics && <MetricStrip m={result.metrics} />}

      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {result.metrics?.reported_vs_consensus && <ReportedVsConsensus metrics={result.metrics.reported_vs_consensus} />}
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {/* Left: AI summary + bull/bear */}
          <div style={{ flex: '1.5 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, color: C.gold, textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 8 }}>AI Summary</div>
              <div style={{ fontFamily: C.sans, fontSize: 12.5, color: C.text, lineHeight: 1.6 }}>{s.verdict}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontFamily: C.sans, fontSize: 9, color: C.pos, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>▲ Bull Case</div>
                <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {s.bull_points?.map((p, i) => <li key={i} style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{p}</li>)}
                </ul>
              </div>
              <div>
                <div style={{ fontFamily: C.sans, fontSize: 9, color: C.neg, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>▼ Bear Case</div>
                <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {s.bear_points?.map((p, i) => <li key={i} style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{p}</li>)}
                </ul>
              </div>
            </div>
          </div>

          {/* Right: segment revenue + guidance + themes/risks */}
          <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {result.segments && result.segments.length > 0 && <SegmentBars segments={result.segments} />}
            {s.guidance && s.guidance !== 'N/A' && (
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: `1px solid ${C.gold}40`, padding: '10px 12px' }}>
                <div style={{ fontFamily: C.sans, fontSize: 9, color: C.gold, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 5 }}>Management Guidance</div>
                <div style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{s.guidance}</div>
              </div>
            )}
            {(s.key_themes?.length > 0 || s.risks?.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {s.key_themes?.length > 0 && (
                  <div>
                    <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Key Themes</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{s.key_themes.map((t, i) => <Pill key={i} label={t} color={C.blue} />)}</div>
                  </div>
                )}
                {s.risks?.length > 0 && (
                  <div>
                    <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Risks</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{s.risks.map((r, i) => <Pill key={i} label={r} color={C.warn} />)}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {s.analyst_questions_focus && (
          <div style={{ fontFamily: C.sans, fontSize: 10, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <span style={{ color: C.dim, marginRight: 6, textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.1em' }}>Analyst Focus:</span>
            {s.analyst_questions_focus}
          </div>
        )}

        {/* SEC filings — this card's own filing links directly; the button pulls the rest */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {result.url && (
            <a href={result.url} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.gold, border: `1px solid ${C.gold}40`, padding: '4px 12px', textDecoration: 'none' }}>
              View {result.form ?? 'filing'} on SEC ↗
            </a>
          )}
          <button onClick={fetchFilings} disabled={loadingFilings}
            style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 12px', cursor: loadingFilings ? 'default' : 'pointer', opacity: loadingFilings ? 0.6 : 1 }}>
            {loadingFilings ? 'Loading…' : filings && filings.length > 0 ? '↺ Refresh SEC Filings' : 'All SEC Filings'}
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
  const isMobile = useIsMobile()
  const [tickers,    setTickers]    = useState<string[]>([])
  const [include10q, setInclude10q] = useState(true)
  const [include10k, setInclude10k] = useState(false)
  const [txLimit,    setTxLimit]    = useState(1)

  const [streamedResults, setStreamedResults] = useState<Result[]>([])
  const [inProgress,      setInProgress]      = useState(false)
  const [overallProgress, setOverallProgress] = useState(0)
  const [tickerProgress,  setTickerProgress]  = useState<Record<string, { stage: string; pct: number }>>({})
  const [error,           setError]           = useState<string | null>(null)

  const isPending = inProgress

  const okResults = streamedResults.filter(r => r.summary && !r.error)

  useReportCapture(() => {
    if (!okResults.length) return null
    const pieces: ClipDraft[] = []
    for (const result of okResults.slice(0, 5)) {
      const s = result.summary!
      const tkr = result.ticker
      const cells: { label: string; value: string; sub?: string }[] = [
        { label: 'Ticker', value: tkr, sub: result.company ?? result.period ?? undefined },
        { label: 'Tone', value: s.management_tone || '—' },
      ]
      if (result.metrics?.eps) cells.push({ label: 'EPS', value: result.metrics.eps.value, sub: result.metrics.eps.yoy ? `${result.metrics.eps.yoy} YoY` : undefined })
      if (result.metrics?.revenue) cells.push({ label: 'Revenue', value: result.metrics.revenue.value, sub: result.metrics.revenue.yoy ? `${result.metrics.revenue.yoy} YoY` : undefined })
      if (result.metrics?.gross_margin) cells.push({ label: 'Gross Margin', value: result.metrics.gross_margin.value })
      if (result.reaction) cells.push({ label: 'Reaction', value: `${result.reaction.pct >= 0 ? '+' : ''}${result.reaction.pct.toFixed(1)}%` })
      pieces.push(kpiClip('Earnings AI', `Earnings Snapshot · ${tkr}`, cells))
      if (s.verdict) {
        pieces.push(textClip('Earnings AI', `AI Summary · ${tkr}`, s.verdict))
      }
      const bullets: string[] = []
      if (s.bull_points?.length) bullets.push('Bull case:\n' + s.bull_points.map(p => `• ${p}`).join('\n'))
      if (s.bear_points?.length) bullets.push('Bear case:\n' + s.bear_points.map(p => `• ${p}`).join('\n'))
      if (s.guidance && s.guidance !== 'N/A') bullets.push(`Guidance: ${s.guidance}`)
      if (s.key_themes?.length) bullets.push(`Themes: ${s.key_themes.join(', ')}`)
      if (s.risks?.length) bullets.push(`Risks: ${s.risks.join(', ')}`)
      if (s.analyst_questions_focus) bullets.push(`Analyst focus: ${s.analyst_questions_focus}`)
      if (bullets.length) {
        pieces.push(textClip('Earnings AI', `Bull / Bear · ${tkr}`, bullets.join('\n\n')))
      }
      if (s.key_metrics?.length) {
        pieces.push(tableClip(
          'Earnings AI',
          `Key Metrics · ${tkr}`,
          ['Metric', 'Value', 'vs Est', 'YoY'],
          s.key_metrics.map(m => [m.name, m.value, m.vs_est ?? null, m.yoy ?? null]),
        ))
      }
      if (result.segments?.length) {
        pieces.push(tableClip(
          'Earnings AI',
          `Segment Revenue · ${tkr}`,
          ['Segment', 'Revenue'],
          result.segments.map(seg => [seg.name, fmtB(seg.value)]),
        ))
      }
    }
    return pieces
  }, { disabled: !okResults.length, sourceTab: 'Earnings AI' })

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
  const railLabel: React.CSSProperties = { ...LABEL, marginBottom: 8 }
  const canRun = !isPending && tickers.length > 0

  return (
    <PageWrapper title="Earnings AI">
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row' }}>

        <aside style={{ width: isMobile ? '100%' : 272, flexShrink: 0, background: C.surface, border: `1px solid ${C.border}` }}>
          <div style={{ padding: '13px 20px', background: 'color-mix(in srgb, var(--theme-bg, #101c2e) 58%, var(--theme-surface, #0d1826))', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, color: C.gold, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Analysis inputs</span>
            <span style={{ fontFamily: C.mono, fontSize: 9, color: C.dim }}>{tickers.length || 'No'} ticker{tickers.length === 1 ? '' : 's'}</span>
          </div>

          <div style={{ padding: '20px', borderBottom: `1px solid ${C.border}` }}>
            <label style={railLabel}>Tickers</label>
            <TickerTagInput tickers={tickers} onChange={setTickers} />
          </div>

          <div style={{ padding: '20px', borderBottom: `1px solid ${C.border}` }}>
            <label style={railLabel}>Source filings</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[
                { label: 'Quarterly reports (10-Q)', val: include10q, set: setInclude10q },
                { label: 'Annual reports (10-K)',    val: include10k, set: setInclude10k },
              ].map(opt => (
                <label key={opt.label} onClick={() => opt.set(v => !v)} style={{ minWidth: 0, minHeight: 44, padding: '10px 12px', border: `1px solid ${opt.val ? C.gold : C.border}`, background: opt.val ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', userSelect: 'none' }}>
                  <div style={{ ...check, border: `1px solid ${opt.val ? C.gold : C.dim}`, background: opt.val ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {opt.val && <div style={{ width: 5, height: 5, background: C.gold }} />}
                  </div>
                  <span style={{ fontFamily: C.sans, fontSize: 11, lineHeight: 1.25, color: opt.val ? C.text : C.dim }}>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ padding: '20px', borderBottom: `1px solid ${C.border}` }}>
            <label style={railLabel}>Filings per ticker</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
              {[1, 2, 4].map(n => (
                <button key={n} onClick={() => setTxLimit(n)} style={{ background: txLimit === n ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'transparent', border: `1px solid ${txLimit === n ? C.gold : C.border}`, color: txLimit === n ? C.gold : C.muted, fontFamily: C.mono, fontSize: 10, padding: '8px 2px', cursor: 'pointer' }}>{n} {n === 1 ? 'filing' : 'filings'}</button>
              ))}
            </div>
            <div style={{ fontFamily: C.sans, fontSize: 9, color: C.dim, marginTop: 9, lineHeight: 1.5 }}>
              Each ticker returns one note per recent {include10k && !include10q ? '10-K' : '10-Q'} filing.
            </div>
          </div>

          <div style={{ padding: '20px' }}>
            <button onClick={startAnalysis} disabled={!canRun}
              style={{ width: '100%', background: canRun ? C.gold : 'transparent', border: `1px solid ${C.gold}`, color: canRun ? C.surface : C.gold, fontFamily: C.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '11px 0', cursor: canRun ? 'pointer' : 'default', opacity: canRun ? 1 : 0.5 }}>
              {isPending ? `Analyzing… (${overallProgress}%)` : 'Analyze'}
            </button>
          </div>
        </aside>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <div style={{ background: 'color-mix(in srgb, var(--theme-negative) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 30%, transparent)', padding: 12, fontFamily: C.sans, fontSize: 11, color: C.neg }}>
              {error}
            </div>
          )}

          {inProgress && (
            <div style={{ width: '100%', height: 8, background: C.dim, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${overallProgress}%`, height: '100%', background: C.gold, transition: 'width 0.3s ease-out' }} />
            </div>
          )}

          {inProgress && Object.keys(tickerProgress).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Object.entries(tickerProgress).map(([ticker, progress]) => (
                <div key={ticker} style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1px solid ${C.border}`, padding: '4px 8px', borderRadius: 4, background: C.surface }}>
                  <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: C.gold }}>{ticker}</span>
                  <span style={{ fontFamily: C.sans, fontSize: 10, color: C.muted }}>{progress.stage} ({progress.pct}%)</span>
                </div>
              ))}
            </div>
          )}

          {streamedResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {streamedResults.map((r: Result) => <ResultCard key={r.id ?? r.ticker} result={r} />)}
            </div>
          )}

          {!inProgress && streamedResults.length === 0 && !error && (
            <EmptyState title="Earnings Notes" hint="Add tickers, then analyze their latest filings and earnings commentary."
              action="Analyze"
              kpis={['Filing', 'Key Metric', 'Guidance', 'Tone']}
              preview="table" previewLabel="Earnings Notes" columns={['Ticker', 'Filing', 'Key Read', 'Tone']} />
          )}
        </div>
      </div>
    </PageWrapper>
  )
}
