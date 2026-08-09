import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Download, ArrowLeft } from 'lucide-react'
import TickerLogo from '../components/TickerLogo'
import ClipRenderer from '../components/report/ClipRenderer'
import SectionLayout, {
  assignReportBodyVisuals,
  FillGrid,
  promoteTableToChart,
  reportSectionAssignmentKey,
} from '../components/report/SectionLayout'
import {
  useReportCreator, timeframeLabel, clipTitle,
  type ReportClip, type ClipPayload,
} from '../lib/reportCreator'
import { exportReportPdf, reportPdfBaseName } from '../lib/exportReportPdf'
import { selectReportAppendixData } from '../lib/reportPresentation'
import { useTheme } from '../contexts/ThemeContext'
import { buildReportPalette, toClipPalette, type ReportPalette } from '../lib/reportTheme'
import { reportTickerSymbols } from '../lib/tickerLogos'

// Print-ready research note at /report-creator/print/:id.
// Colors and fonts follow the active Settings color preset so the PDF matches
// the terminal theme (Terminal Gold, Bloomberg, Linen, etc.).

function fmtDateLong(d = new Date()): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

// Enough marks to read as the book's character without becoming a logo wall.
const MASTHEAD_LOGO_LIMIT = 6

function allocationHoldingCount(clips: ReportClip[]): number {
  return allocationTickers(clips, Number.MAX_SAFE_INTEGER).length
}

function allocationTickers(clips: ReportClip[], max = MASTHEAD_LOGO_LIMIT): string[] {
  const allocation = clips.find(clip => clip.payload.kind === 'table' && /\bcurrent allocation\b/i.test(clip.payload.title || ''))
  if (!allocation || allocation.payload.kind !== 'table') return []
  const tickerIndex = allocation.payload.columns.findIndex(column => /^ticker$/i.test(column))
  const weightIndex = allocation.payload.columns.findIndex(column => /weight/i.test(column))
  if (tickerIndex < 0) return []
  return allocation.payload.rows
    .filter(row => {
      if (weightIndex < 0) return true
      const weight = Number(String(row[weightIndex] ?? '').replace(/[%+,]/g, '').trim())
      return Number.isFinite(weight) && weight > 0
    })
    .map(row => String(row[tickerIndex] ?? '').trim().toUpperCase())
    .filter(ticker => ticker && ticker !== 'CASH')
    .slice(0, max)
}

function kpiCell(clip: ReportClip | undefined, pattern: RegExp) {
  if (!clip || clip.payload.kind !== 'kpi') return undefined
  return clip.payload.cells.find(cell => pattern.test(cell.label))
}

// keyResult.value ranges from a short "$280–$310" to a longer open-mode
// verdict phrase — scale down instead of hard-truncating so long text still
// reads cleanly in a box sized for short ones.
function heroFontSize(value: string, base: number, min: number): number {
  const len = (value || '').length
  if (len <= 12) return base
  if (len <= 24) return Math.round(base * 0.82)
  if (len <= 40) return Math.round(base * 0.66)
  return min
}

function AppendixBlock({ clip, palette, compact = false }: { clip: ReportClip; palette: ReportPalette; compact?: boolean }) {
  const p = clip.payload
  const title = p.title || clipTitle(clip)
  const clipPal = toClipPalette(palette)
  const promoted = p.kind === 'table' && /\bsector (?:leadership|rotation)\b/i.test(p.title || '')
    ? promoteTableToChart(p)
    : undefined
  const frame: React.CSSProperties = {
    border: `1px solid ${palette.border}`, background: palette.panel, marginTop: 2,
  }
  const head: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase',
    padding: '5px 10px', borderBottom: `1px solid ${palette.border}`,
    background: palette.cellBg, color: palette.accent,
  }
  if (promoted) {
    return (
      <div style={frame}>
        <div style={head}>{title}</div>
        <div style={{ padding: '6px 10px 8px', background: palette.cellBg }}>
          <ClipRenderer payload={promoted} mode="print" compact={compact} palette={clipPal} />
        </div>
      </div>
    )
  }
  if (p.kind === 'table') {
    const allocation = /\bcurrent allocation\b/i.test(p.title || '')
    let semanticTable: ClipPayload = p
    if (allocation) {
      const columnIndex = (pattern: RegExp) => p.columns.findIndex(column => pattern.test(column))
      const ticker = columnIndex(/^ticker$/i)
      const marketValue = columnIndex(/market value/i)
      const weight = columnIndex(/weight/i)
      const sector = columnIndex(/sector classification/i)
      if ([ticker, marketValue, weight, sector].every(index => index >= 0)) {
        semanticTable = {
          kind: 'table',
          title: p.title,
          columns: ['Ticker', 'Market value', 'Weight %', 'Asset class', 'Sector'],
          rows: p.rows.map(row => {
            const classification = String(row[sector] ?? 'Unclassified')
            const isFund = /exchange[- ]traded fund|\betf\b/i.test(classification)
            return [
              row[ticker],
              row[marketValue],
              row[weight],
              isFund ? 'ETF' : row[ticker] === 'CASH' ? 'Cash' : 'Equity',
              isFund ? 'Look-through required' : classification,
            ]
          }),
        }
      }
    }
    return (
      <div style={frame}>
        <div style={head}>{title}</div>
        <div style={{ padding: '6px 10px 8px', background: palette.cellBg }}>
          <ClipRenderer payload={semanticTable} mode="print" compact={compact} palette={clipPal} />
        </div>
      </div>
    )
  }
  return (
    <div style={frame}>
      <div style={head}>{title}</div>
      <div style={{ padding: '6px 10px 8px', background: palette.cellBg }}>
        <ClipRenderer payload={p} mode="print" compact={compact} palette={clipPal} />
      </div>
    </div>
  )
}

export default function ReportPrint() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const snapshotId = searchParams.get('snapshot')
  const autoDownload = searchParams.get('download') === '1'
  const navigate = useNavigate()
  const { theme } = useTheme()
  const palette = useMemo(() => buildReportPalette(theme), [theme])
  const projects = useReportCreator()
  const project = projects.find(p => p.id === id)
  // Render either the live report (project.generated + current clips) or a
  // specific archived snapshot when ?snapshot= is passed. A snapshot carries
  // its own frozen clips/scope/name so a past report renders as it was.
  const snapshot = snapshotId ? project?.history?.find(h => h.id === snapshotId) : undefined
  const gen = snapshot ? snapshot.generated : project?.generated
  const renderName = snapshot ? snapshot.name : project?.name
  const renderScope = snapshot ? snapshot.scope : project?.scope
  const renderClips = useMemo(
    () => (snapshot ? snapshot.clips : project?.clips) ?? [],
    [snapshot, project?.clips],
  )
  const pageRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const clipById = useMemo(
    () => new Map(renderClips.map(c => [c.id, c])),
    [renderClips],
  )
  const allClips = renderClips
  // How many holdings the masthead is not showing, so four marks under a
  // sixteen-holding book cannot read as the whole book.
  const reportTickerOverflow = useMemo(
    () => Math.max(0, allocationHoldingCount(allClips) - MASTHEAD_LOGO_LIMIT),
    [allClips],
  )

  const reportTickers = useMemo(
    () => {
      const portfolioSubjects = allocationTickers(allClips)
      if (portfolioSubjects.length) return portfolioSubjects
      const multiSubject = /\b(compare|comparison|versus|vs\.?|screen|ranking|rank|portfolio|holdings|book)\b/i
        .test(`${renderScope?.goal ?? ''} ${renderScope?.purpose ?? ''}`)
      return reportTickerSymbols(
        renderScope?.researchSymbols ?? '',
        allClips.map(clip => clip.researchKey),
        multiSubject ? 4 : 1,
      )
    },
    [allClips, renderScope?.goal, renderScope?.purpose, renderScope?.researchSymbols],
  )

  const bodyVisuals = useMemo(() => {
    if (!gen) return new Map<string, { visual: ReportClip | undefined; showKeyFigures: boolean }>()
    return assignReportBodyVisuals(gen.sections, clipById, allClips, {
      projectId: project?.id ?? '',
      generatedAt: gen.generatedAt,
      objective: `${renderScope?.goal ?? ''} ${renderScope?.purpose ?? ''}`,
      domainCoveragePct: gen.pipeline?.coverage?.domainCoveragePct,
    })
  }, [allClips, clipById, gen, project?.id, renderScope?.goal, renderScope?.purpose])
  const figureNumbers = useMemo(() => {
    const numbers = new Map<string, number>()
    if (!gen) return numbers
    let next = 1
    for (const [index] of gen.sections.entries()) {
      const key = reportSectionAssignmentKey(gen.sections, index)
      const visual = bodyVisuals.get(key)?.visual
      if (visual && visual.payload.kind !== 'text') {
        numbers.set(key, next)
        next += 1
      }
    }
    return numbers
  }, [bodyVisuals, gen])

  const appendixData = useMemo(
    () => gen ? selectReportAppendixData(gen.appendixClipIds, allClips) : [],
    [allClips, gen],
  )

  const reportDate = useMemo(() => {
    if (gen?.generatedAt) {
      const d = new Date(gen.generatedAt)
      if (!Number.isNaN(d.getTime())) return d
    }
    return new Date()
  }, [gen?.generatedAt])

  const dateLong = fmtDateLong(reportDate)
  const reviewDate = fmtDateLong(addDays(reportDate, 90))
  const reportTitle = gen?.headline?.trim() || renderName || 'Report'
  const fileName = reportPdfBaseName(renderName || reportTitle)

  const eyebrow: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: palette.muted,
  }
  const bandHead: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em',
    textTransform: 'uppercase', color: palette.accent, margin: '0 0 8px',
    borderBottom: `1px solid ${palette.accent}`, paddingBottom: 5,
  }
  const secTitle: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 14, fontWeight: 700, color: palette.ink, margin: 0, letterSpacing: '-0.01em',
  }
  const secMeta: React.CSSProperties = {
    fontFamily: palette.mono, fontSize: 8, color: palette.muted, letterSpacing: '0.08em',
    textTransform: 'uppercase', margin: '1px 0 4px',
  }
  const prose: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 11.5, lineHeight: 1.45, color: palette.ink, margin: 0, whiteSpace: 'pre-wrap',
  }

  useEffect(() => {
    if (!project) return
    const prev = document.title
    document.title = fileName
    return () => { document.title = prev }
  }, [project, fileName])

  const handleDownloadPdf = async () => {
    if (!pageRef.current || exporting) return
    setExporting(true)
    setExportErr(null)
    try {
      await new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 280)))
      await exportReportPdf(pageRef.current, fileName, palette.pageBg)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'PDF export failed')
    } finally {
      setExporting(false)
    }
  }

  // Opened with ?download=1 (from the History list's Download button): kick off
  // the PDF export once the page has painted, then never re-fire.
  const autoRan = useRef(false)
  useEffect(() => {
    if (!autoDownload || autoRan.current || !gen || !pageRef.current) return
    autoRan.current = true
    const t = setTimeout(() => { handleDownloadPdf() }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDownload, gen])

  const portfolioRiskClip = allClips.find(clip => clip.payload.kind === 'kpi' && /\brisk metrics\b/i.test(clip.payload.title || ''))
  const allocationClip = allClips.find(clip => clip.payload.kind === 'table' && /\bcurrent allocation\b/i.test(clip.payload.title || ''))

  const keyData = useMemo(() => {
    const result: { label: string; value: string; sub?: string }[] = []
    if (portfolioRiskClip && allocationClip?.payload.kind === 'table') {
      const weightIndex = allocationClip.payload.columns.findIndex(column => /weight/i.test(column))
      const tickerIndex = allocationClip.payload.columns.findIndex(column => /^ticker$/i.test(column))
      const largest = weightIndex >= 0
        ? [...allocationClip.payload.rows]
          .filter(row => String(row[tickerIndex] ?? '').toUpperCase() !== 'CASH')
          .sort((a, b) => (
            Number(String(b[weightIndex] ?? 0).replace(/[%+,]/g, ''))
            - Number(String(a[weightIndex] ?? 0).replace(/[%+,]/g, ''))
          ))[0]
        : undefined
      if (largest) result.push({
        label: 'Largest position',
        value: `${largest[tickerIndex]} · ${largest[weightIndex]}%`,
      })
      for (const [label, pattern] of [
        ['Active return vs SPY', /^Active return vs SPY$/i],
        ['Maximum drawdown', /^Portfolio max drawdown$/i],
        ['Static beta vs SPY', /^Portfolio single-factor beta vs SPY$/i],
      ] as const) {
        const cell = kpiCell(portfolioRiskClip, pattern)
        if (cell) result.push({ label, value: cell.value })
      }
    }
    const seen = new Set(result.map(item => item.label.toLowerCase()))
    for (const section of gen?.sections ?? []) {
      for (const figure of section.keyFigures ?? []) {
        const label = figure.label.toLowerCase()
        if (!seen.has(label) && result.length < 4) {
          seen.add(label)
          result.push({ label: figure.label, value: figure.value })
        }
      }
    }
    return result.slice(0, 4)
  }, [allocationClip, gen?.sections, portfolioRiskClip])
  return (
    <div style={{ minHeight: '100vh', background: 'var(--theme-bg, #101c2e)', padding: '20px 16px 60px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/report-creator')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-secondary, #8099b0)', fontFamily: palette.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '7px 12px', cursor: 'pointer' }}>
          <ArrowLeft size={13} /> Back
        </button>
        {project && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {exportErr && (
              <span style={{ fontFamily: palette.mono, fontSize: 10, color: 'var(--theme-negative, #ef4444)' }}>{exportErr}</span>
            )}
            <button onClick={handleDownloadPdf} disabled={exporting}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--theme-primary, #c9a84c)', border: 'none', color: 'var(--theme-bg, #101c2e)', fontFamily: palette.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 16px', cursor: exporting ? 'wait' : 'pointer', opacity: exporting ? 0.7 : 1 }}>
              <Download size={14} /> {exporting ? 'Opening print…' : 'Print / Save PDF'}
            </button>
          </div>
        )}
      </div>

      {!project ? (
        <div style={{ maxWidth: 720, margin: '0 auto', background: palette.pageBg, padding: 40, textAlign: 'center', fontFamily: palette.mono, fontSize: 12, color: palette.ink }}>
          Report not found. It may have been deleted.
        </div>
      ) : (
        <div
          ref={pageRef}
          className="rc-page"
          style={{
            width: 720, maxWidth: '100%', margin: '0 auto',
            background: palette.pageBg, color: palette.ink,
            boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
            fontFamily: palette.sans,
          }}
        >
          <style>{`
            @media (max-width: 640px) {
              .rc-report-sections { display: block !important; }
              .rc-report-section-half { margin-bottom: 12px; }
            }
            .rc-atomic { break-inside: avoid; page-break-inside: avoid; }
            /* Mirrors the export stylesheet so the on-screen print preview and
               the generated PDF break in the same places. */
            .rc-keep { break-inside: avoid; page-break-inside: avoid; }
            .rc-section-heading, .rc-keep-tight { break-after: avoid; page-break-after: avoid; }
          `}</style>
          <header className="rc-keep" style={{ background: palette.masthead, color: palette.onMasthead }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 28px 0', gap: 16,
            }}>
              <div style={{
                fontFamily: palette.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.22em',
                textTransform: 'uppercase', color: palette.mastheadAccent,
              }}>
                Alphatape Research
              </div>
              <div style={{
                fontFamily: palette.mono, fontSize: 10, color: palette.onMastheadDim, letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
              }}>
                {dateLong}
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: gen?.keyResult ? '1fr minmax(168px, 200px)' : '1fr',
              gap: 20,
              padding: '16px 28px 20px',
              alignItems: 'end',
            }}>
              <div style={{ minWidth: 0 }}>
                <h1 style={{
                  fontFamily: palette.sans, fontSize: 24, fontWeight: 700, color: palette.onMasthead,
                  margin: 0, lineHeight: 1.2, letterSpacing: '-0.02em',
                }}>
                  {reportTitle}
                </h1>
                {gen?.headline && renderName && gen.headline.trim() !== renderName.trim() && (
                  <p style={{
                    fontFamily: palette.sans, fontSize: 13.5, fontWeight: 500, color: palette.onMastheadDim,
                    margin: '8px 0 0', lineHeight: 1.4, maxWidth: 420,
                  }}>
                    Workspace · {renderName}
                  </p>
                )}
                {reportTickers.length > 0 && (
                  // Brand marks are every shape there is. `cover` in a circle
                  // cropped a wide wordmark into a coloured pill and a square
                  // grid into a disc, and the hashed dark backing made a dark
                  // mark invisible on this masthead. Contain-fit on one light
                  // tile shows each mark whole, at a consistent visual weight,
                  // against the same field.
                  <div aria-label="Report companies" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginTop: 12 }}>
                    {reportTickers.map(ticker => (
                      <span key={ticker} title={ticker}>
                        <TickerLogo
                          ticker={ticker}
                          size={26}
                          crossOrigin="anonymous"
                          fit="contain"
                          padding={4}
                          cornerRadius={5}
                          logoBackground={palette.logoTile}
                          normalizeVisualWeight
                          showFallbackText
                        />
                      </span>
                    ))}
                    {reportTickerOverflow > 0 && (
                      // Four marks under a sixteen-holding book read as the whole
                      // book. Say how many are not shown.
                      <span style={{
                        fontFamily: palette.mono, fontSize: 9.5, fontWeight: 700,
                        color: palette.onMastheadDim, letterSpacing: '0.04em',
                        border: `1px solid ${palette.mastheadRule}`, borderRadius: 5,
                        padding: '0 7px', height: 26, display: 'inline-flex', alignItems: 'center',
                      }}>+{reportTickerOverflow}</span>
                    )}
                  </div>
                )}
              </div>

              {gen?.keyResult && (
                <div style={{
                  borderLeft: `2px solid ${palette.mastheadAccent}`,
                  padding: '2px 0 2px 14px',
                  minWidth: 0,
                }}>
                  <div style={{
                    fontFamily: palette.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em',
                    textTransform: 'uppercase', color: palette.onMastheadDim, lineHeight: 1.3,
                  }}>
                    {gen.keyResult.label}
                  </div>
                  <div style={{
                    fontFamily: palette.mono, fontWeight: 700, color: palette.mastheadAccent,
                    fontSize: heroFontSize(gen.keyResult.value, 20, 12),
                    marginTop: 4, lineHeight: 1.35, minHeight: 28, wordBreak: 'break-word',
                    overflow: 'visible',
                  } as React.CSSProperties}>
                    {gen.keyResult.value}
                  </div>
                  <div style={{ fontFamily: palette.sans, fontSize: 7.5, color: palette.onMastheadDim, marginTop: 4 }}>
                    Research note · Not investment advice
                  </div>
                </div>
              )}
            </div>

            <div style={{ height: 3, background: `linear-gradient(90deg, ${palette.mastheadAccent} 0%, ${palette.mastheadAccent} 28%, transparent 100%)` }} />
          </header>

          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '0 28px',
            padding: '10px 28px',
            borderBottom: `1px solid ${palette.border}`,
            background: palette.panel,
            fontFamily: palette.mono, fontSize: 10, color: palette.ink,
          }}>
            <div>
              <span style={{ ...eyebrow, display: 'inline', marginRight: 8 }}>Date</span>
              {dateLong}
            </div>
            <div>
              <span style={{ ...eyebrow, display: 'inline', marginRight: 8 }}>Horizon</span>
              {renderScope ? timeframeLabel(renderScope) : ''}
              {renderScope?.lookforwardPreset === 'unlimited' ? ` · Review ${reviewDate}` : ''}
            </div>
            {gen?.stance?.lean && (
              <div>
                <span style={{ ...eyebrow, display: 'inline', marginRight: 8 }}>Lean</span>
                <span style={{ textTransform: 'capitalize' }}>{gen.stance.lean}</span>
                {gen.stance.conviction && (
                  <span style={{ color: palette.muted }}> · {gen.stance.conviction} conviction</span>
                )}
              </div>
            )}
            {gen?.stance?.baseCase && (
              <div style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
                <span style={{ ...eyebrow, display: 'inline', marginRight: 8 }}>Base</span>
                {gen.stance.baseCase}
              </div>
            )}
          </div>

          <div style={{ padding: '16px 28px 22px', background: palette.pageBg }}>
            {gen ? (
              <>
                {keyData.length > 0 && (
                  <section className="rc-keep" style={{ marginBottom: 12 }}>
                    <h2 style={bandHead}>Key Evidence</h2>
                    <FillGrid
                      items={keyData.map((k, i) => ({ key: i, ...k }))}
                      preferCols={Math.min(keyData.length, 5)}
                      palette={palette}
                      render={(item) => {
                        const k = item as { key: number; label: string; value: string; sub?: string }
                        return (
                          <div style={{
                            background: palette.cellBg,
                            margin: '-6px -10px', padding: '7px 10px',
                          }}>
                            <div style={{ ...eyebrow, lineHeight: 1.25 }}>{k.label}</div>
                            <div style={{
                              fontFamily: palette.mono, fontWeight: 700,
                              color: palette.ink,
                              marginTop: 3, lineHeight: 1.35, minHeight: 20,
                              fontSize: k.value.length > 20 ? 11.5 : 14,
                              whiteSpace: 'normal',
                              overflowWrap: 'anywhere',
                              wordBreak: 'break-word',
                            } as React.CSSProperties}>{k.value}</div>
                            {k.sub && (
                              <div style={{ fontFamily: palette.sans, fontSize: 9, color: palette.muted, marginTop: 2, lineHeight: 1.25 }}>
                                {k.sub}
                              </div>
                            )}
                          </div>
                        )
                      }}
                    />
                  </section>
                )}

                <section className="rc-keep rc-atomic" style={{ marginBottom: 16 }}>
                  <h2 style={bandHead}>Investment View</h2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {(gen.executiveSummary || '—').split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3).map((sentence, index) => (
                      <p key={index} style={prose}>{sentence}</p>
                    ))}
                  </div>
                </section>

                <div
                  className="rc-report-sections"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 16,
                  }}
                >
                  {gen.sections.map((s, i) => {
                    const clip = clipById.get(s.clipId)
                    const sectionKey = reportSectionAssignmentKey(gen.sections, i)
                    const assigned = bodyVisuals.get(sectionKey)
                    return (
                      <section
                        key={sectionKey}
                        className={`rc-section${s.placement === 'half' ? ' rc-report-section-half' : ''}`}
                        data-placement={s.placement ?? 'full'}
                        style={{
                          minWidth: 0,
                          gridColumn: s.placement === 'half' ? 'span 1' : '1 / -1',
                          borderTop: `1px solid ${palette.border}`,
                          paddingTop: 10,
                        }}
                      >
                        <div className="rc-section-heading" style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 8,
                          marginBottom: 7,
                          paddingTop: 2,
                        }}>
                          <h3 style={secTitle}>{s.heading}</h3>
                        </div>
                        <SectionLayout
                          analysis={s.analysis}
                          clip={clip}
                          keyFigures={s.keyFigures}
                          index={i}
                          layout={s.layout}
                          layoutPreset={renderScope?.layoutPreset}
                          projectClips={allClips}
                          visual={assigned?.visual}
                          showKeyFigures={assigned?.showKeyFigures}
                          column={s.placement === 'half'}
                          figureNumber={figureNumbers.get(sectionKey)}
                          palette={palette}
                        />
                      </section>
                    )
                  })}
                </div>

                <section className="rc-keep rc-atomic" style={{
                  marginTop: 14,
                  border: `1px solid ${palette.border}`,
                  background: palette.panel,
                  padding: '11px 13px',
                }}>
                  <h2 style={{
                    ...bandHead, border: 'none', margin: '0 0 6px', paddingBottom: 0,
                  }}>
                    Conclusion &amp; Evidence Limits
                  </h2>
                  <p style={prose}>{gen.conclusion || '—'}</p>
                </section>

                {appendixData.length > 0 && (
                  <section style={{ marginTop: 20 }}>
                    <h2 className="rc-keep rc-keep-tight" style={bandHead}>Data Appendix</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 2 }}>
                      {appendixData.map(c => (
                        <div key={c.id} className={c.payload.kind === 'table' ? 'rc-appendix-table' : 'rc-keep rc-atomic'}>
                          <AppendixBlock clip={c} palette={palette} />
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {renderClips.map((c, i) => (
                  <section key={c.id} className="rc-section">
                    <div className="rc-section-heading" style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 12,
                      marginBottom: 5,
                    }}>
                      <h3 style={secTitle}>{clipTitle(c)}</h3>
                      <span style={{ ...secMeta, margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                        {c.sourceTab} · {c.dataType}
                      </span>
                    </div>
                    {c.userDescription ? (
                      <SectionLayout
                        analysis={c.userDescription}
                        clip={c}
                        index={i}
                        projectClips={allClips}
                        palette={palette}
                      />
                    ) : (
                      <AppendixBlock clip={c} palette={palette} />
                    )}
                  </section>
                ))}
                {renderClips.length === 0 && (
                  <p style={{ fontFamily: palette.mono, fontSize: 11, color: palette.muted }}>No clips in this report yet.</p>
                )}
              </div>
            )}

            <footer style={{
              marginTop: 20, borderTop: `1px solid ${palette.border}`, paddingTop: 10,
              fontFamily: palette.sans, fontSize: 8.5, color: palette.muted, lineHeight: 1.45,
            }}>
              Generated by Alphatape for research and educational purposes. Not investment advice.
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
