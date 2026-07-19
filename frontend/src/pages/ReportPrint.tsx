import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Download, ArrowLeft } from 'lucide-react'
import ClipRenderer from '../components/report/ClipRenderer'
import SectionLayout, { FillGrid, assignBodyVisuals } from '../components/report/SectionLayout'
import {
  useReportCreator, timeframeLabel, clipTitle,
  type ReportClip, type ClipPayload,
} from '../lib/reportCreator'
import { exportReportPdf } from '../lib/exportReportPdf'
import { useTheme } from '../contexts/ThemeContext'
import { buildReportPalette, toClipPalette, type ReportPalette } from '../lib/reportTheme'

// Print-ready research note at /report-creator/print/:id.
// Colors and fonts follow the active Settings color preset so the PDF matches
// the terminal theme (Terminal Gold, Bloomberg, Linen, etc.).

function fmtDateLong(d = new Date()): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

function fmtDateFile(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sanitizeFilePart(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Report'
}

function pdfBaseName(reportName: string, d = new Date()): string {
  return `${sanitizeFilePart(reportName)} — ${fmtDateFile(d)}`
}

function AppendixBlock({ clip, palette }: { clip: ReportClip; palette: ReportPalette }) {
  const p = clip.payload
  const title = p.title || clipTitle(clip)
  const clipPal = toClipPalette(palette)
  const frame: React.CSSProperties = {
    border: `1px solid ${palette.border}`, background: palette.panel, marginTop: 2,
  }
  const head: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase',
    padding: '5px 10px', borderBottom: `1px solid ${palette.border}`,
    background: palette.cellBg, color: palette.accent,
  }
  if (p.kind === 'table') {
    const slim: ClipPayload = { ...p, rows: p.rows.slice(0, 10) }
    return (
      <div style={frame}>
        <div style={head}>{title}</div>
        <div style={{ padding: '6px 10px 8px', background: palette.cellBg }}>
          <ClipRenderer payload={slim} mode="print" maxTableRows={10} palette={clipPal} />
          {p.rows.length > 10 && (
            <div style={{ fontFamily: palette.mono, fontSize: 8, color: palette.muted, marginTop: 4 }}>
              Showing 10 of {p.rows.length} rows.
            </div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div style={frame}>
      <div style={head}>{title}</div>
      <div style={{ padding: '6px 10px 8px', background: palette.cellBg }}>
        <ClipRenderer payload={p} mode="print" maxTableRows={10} palette={clipPal} />
      </div>
    </div>
  )
}

export default function ReportPrint() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { theme } = useTheme()
  const palette = useMemo(() => buildReportPalette(theme), [theme])
  const projects = useReportCreator()
  const project = projects.find(p => p.id === id)
  const gen = project?.generated
  const pageRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const clipById = useMemo(
    () => new Map((project?.clips ?? []).map(c => [c.id, c])),
    [project?.clips],
  )
  const allClips = project?.clips ?? []

  const bodyVisuals = useMemo(() => {
    if (!gen) return new Map<string, { visual: ReportClip | undefined; showKeyFigures: boolean }>()
    return assignBodyVisuals(gen.sections, clipById, allClips)
  }, [gen, clipById, allClips])

  const chartsUsedInBody = useMemo(() => {
    const ids = new Set<string>()
    for (const v of bodyVisuals.values()) {
      if (v.visual?.payload.kind === 'chart') ids.add(v.visual.id)
    }
    return ids
  }, [bodyVisuals])

  const appendixClips: ReportClip[] = (() => {
    if (!gen) return []
    const raw = gen.appendixClipIds.map(cid => clipById.get(cid)).filter((c): c is ReportClip => !!c)
    const isStub = (c: ReportClip) =>
      c.payload.kind === 'text' && /no structured panels|add a note describing/i.test(c.payload.body)
    const rank = (c: ReportClip) =>
      c.payload.kind === 'chart' ? 0 : c.payload.kind === 'kpi' ? 2 : c.payload.kind === 'table' ? 3 : 4
    return raw
      .filter(c => !isStub(c) && !chartsUsedInBody.has(c.id))
      .sort((a, b) => rank(a) - rank(b))
  })()

  const reportDate = useMemo(() => {
    if (gen?.generatedAt) {
      const d = new Date(gen.generatedAt)
      if (!Number.isNaN(d.getTime())) return d
    }
    return new Date()
  }, [gen?.generatedAt])

  const dateLong = fmtDateLong(reportDate)
  const fileName = project ? pdfBaseName(project.name, reportDate) : 'Report'

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

  const keyData: { label: string; value: string; sub?: string }[] = []
  if (gen?.keyResult) {
    keyData.push({
      label: gen.keyResult.label,
      value: gen.keyResult.value,
      sub: gen.keyResult.context,
    })
  }
  const seen = new Set(keyData.map(k => k.label.toLowerCase()))
  for (const s of gen?.sections ?? []) {
    for (const f of s.keyFigures ?? []) {
      const k = f.label.toLowerCase()
      if (!seen.has(k) && keyData.length < 5) {
        seen.add(k)
        keyData.push({ label: f.label, value: f.value })
      }
    }
  }

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
              <Download size={14} /> {exporting ? 'Building PDF…' : 'Download PDF'}
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
          <header className="rc-keep" style={{ background: palette.masthead, color: palette.onMasthead }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 28px 0', gap: 16,
            }}>
              <div style={{
                fontFamily: palette.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.22em',
                textTransform: 'uppercase', color: palette.accent,
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
                  {project.name}
                </h1>
                {gen?.headline && (
                  <p style={{
                    fontFamily: palette.sans, fontSize: 13.5, fontWeight: 500, color: palette.onMastheadDim,
                    margin: '8px 0 0', lineHeight: 1.4, maxWidth: 420,
                  }}>
                    {gen.headline}
                  </p>
                )}
              </div>

              {gen?.keyResult && (
                <div style={{
                  borderLeft: `2px solid ${palette.accent}`,
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
                    fontFamily: palette.mono, fontSize: 20, fontWeight: 700, color: palette.accent,
                    marginTop: 4, lineHeight: 1.15, wordBreak: 'break-word',
                  }}>
                    {gen.keyResult.value}
                  </div>
                  {gen.keyResult.context && (
                    <div style={{
                      fontFamily: palette.sans, fontSize: 9.5, color: palette.onMastheadDim,
                      marginTop: 5, lineHeight: 1.35,
                    }}>
                      {gen.keyResult.context}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ height: 3, background: `linear-gradient(90deg, ${palette.accent} 0%, ${palette.accent} 28%, transparent 100%)` }} />
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
              {timeframeLabel(project.scope)}
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
              <div>
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
                    <h2 style={bandHead}>Key Data</h2>
                    <FillGrid
                      items={keyData.map((k, i) => ({ key: i, ...k }))}
                      preferCols={Math.min(keyData.length, 4)}
                      palette={palette}
                      render={(item) => {
                        const k = item as { key: number; label: string; value: string; sub?: string }
                        const hero = k.key === 0 && !!gen.keyResult
                        return (
                          <div style={{
                            background: hero ? palette.heroTint : palette.cellBg,
                            margin: '-6px -10px', padding: '7px 10px',
                          }}>
                            <div style={{ ...eyebrow, lineHeight: 1.25 }}>{k.label}</div>
                            <div style={{
                              fontFamily: palette.mono, fontSize: 14, fontWeight: 700,
                              color: hero ? palette.accent : palette.ink,
                              marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>{k.value}</div>
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

                <section className="rc-keep" style={{ marginBottom: 14 }}>
                  <h2 style={bandHead}>Investment Summary</h2>
                  <p style={prose}>{gen.executiveSummary || '—'}</p>
                </section>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {gen.sections.map((s, i) => {
                    const clip = clipById.get(s.clipId)
                    const assigned = bodyVisuals.get(s.clipId)
                    return (
                      <section key={s.clipId} className="rc-section" style={{ breakInside: 'avoid' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 0 }}>
                          <span style={{ fontFamily: palette.mono, fontSize: 11, fontWeight: 700, color: palette.accent }}>
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <h3 style={secTitle}>{s.heading}</h3>
                        </div>
                        {clip && (
                          <div style={secMeta}>
                            {clip.sourceTab}
                          </div>
                        )}
                        <SectionLayout
                          analysis={s.analysis}
                          clip={clip}
                          keyFigures={s.keyFigures}
                          index={i}
                          projectClips={allClips}
                          visual={assigned?.visual}
                          showKeyFigures={assigned?.showKeyFigures}
                          palette={palette}
                        />
                      </section>
                    )
                  })}
                </div>

                <section className="rc-keep" style={{
                  marginTop: 16, borderLeft: `3px solid ${palette.accent}`,
                  background: palette.panel, padding: '12px 14px 12px 14px',
                }}>
                  <h2 style={{
                    ...bandHead, border: 'none', margin: '0 0 6px', paddingBottom: 0,
                  }}>
                    Conclusion and Recommendation
                  </h2>
                  <p style={prose}>{gen.conclusion || '—'}</p>
                </section>

                {appendixClips.length > 0 && (
                  <section style={{ marginTop: 20 }}>
                    <h2 style={bandHead}>Appendix — Charts & Supporting Data</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 2 }}>
                      {appendixClips.map(c => (
                        <div key={c.id} className="rc-keep">
                          <h3 style={{ ...secTitle, fontSize: 12.5, marginBottom: 0 }}>{clipTitle(c)}</h3>
                          <div style={secMeta}>{c.sourceTab} · {c.dataType}</div>
                          <AppendixBlock clip={c} palette={palette} />
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {project.clips.map((c, i) => (
                  <section key={c.id} className="rc-section" style={{ breakInside: 'avoid' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ fontFamily: palette.mono, fontSize: 11, fontWeight: 700, color: palette.accent }}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <h3 style={secTitle}>{clipTitle(c)}</h3>
                    </div>
                    <div style={secMeta}>
                      {c.sourceTab}
                      <span style={{ color: palette.border, margin: '0 6px' }}>·</span>
                      {c.dataType}
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
                {project.clips.length === 0 && (
                  <p style={{ fontFamily: palette.mono, fontSize: 11, color: palette.muted }}>No clips in this report yet.</p>
                )}
              </div>
            )}

            <footer style={{
              marginTop: 20, borderTop: `1px solid ${palette.border}`, paddingTop: 10,
              fontFamily: palette.sans, fontSize: 8.5, color: palette.muted, lineHeight: 1.45,
            }}>
              Generated by Alphatape for research and educational purposes. Not investment advice.
              Verify all figures against primary sources before acting.
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
