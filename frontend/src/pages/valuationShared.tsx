import { useState, useRef, useLayoutEffect } from 'react'

// Shared design tokens for the Stock Valuation tabs so every tool reads as one
// consistent, well-spaced system. Matches the DCF tab's density.

export const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12,
  padding: '6px 8px', width: '100%', outline: 'none', boxSizing: 'border-box',
}

// Native <select> styled to match INPUT: reset appearance, add a gold-muted chevron.
export const SELECT: React.CSSProperties = {
  ...INPUT,
  appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
  cursor: 'pointer', paddingRight: 26,
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2399907e' stroke-width='1.4' fill='none'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 9px center',
}

export const LABEL: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)',
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', marginBottom: 5, display: 'block',
}

export const HINT: React.CSSProperties = {
  fontSize: 9, lineHeight: 1.5, color: 'var(--theme-text-dim, rgba(255,255,255,0.42))',
  marginTop: 4, fontFamily: 'var(--theme-mono)',
}

// 14px inset + 14px between groups = the breathing room the DCF sidebar has.
export const SIDEBAR: React.CSSProperties = { padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }

export const SECTION: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
  color: 'var(--theme-text, #d7e3fc)', paddingBottom: 6,
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

export const PRIMARY_BTN: React.CSSProperties = {
  ...INPUT, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--theme-primary, #c9a84c)', borderColor: 'var(--theme-primary, #c9a84c)',
  background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
}

export const GHOST_BTN: React.CSSProperties = {
  ...INPUT, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)',
}

// Readout list (the small key/value stats under the inputs).
export const READOUT_ROW: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--theme-mono)',
  fontSize: 9.5, color: 'var(--theme-secondary, #99907e)', lineHeight: 2,
}

// Tooltip: explicit light text so it never renders gray-on-gray.
export const TOOLTIP_STYLE = {
  background: 'var(--theme-surface, #142032)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
  borderRadius: 0,
}
export const TOOLTIP_LABEL = { color: 'var(--theme-text, #d7e3fc)', fontWeight: 700 }
export const TOOLTIP_ITEM = { color: 'var(--theme-text, #d7e3fc)' }
export const TOOLTIP_CURSOR = { fill: 'rgba(255,255,255,0.05)' }
export const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

export const TH: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', padding: '9px 12px', textAlign: 'right',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
export const TD: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '9px 12px', textAlign: 'right',
  color: 'var(--theme-text, #d7e3fc)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.05))',
}

export const PANEL: React.CSSProperties = {
  background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

export const METRIC_GRID: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12,
}

export const STACK: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18 }

// Canonical collapsible rail section — the Asset Comparison sidebox pattern.
// Header is uppercase, gold when open / muted when closed, with an optional
// "· badge" count and a chevron; each section carries a full-width bottom rule.
// Use this to build every tool's side/parameter rail so they read as one system.
export function RailSection({ title, badge, open, onToggle, children }:
  { title: string; badge?: string | number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 12px',
        background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        color: open ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #99907e)', outline: 'none',
      }}>
        <span>{title}{badge != null && badge !== '' ? <span style={{ color: 'var(--theme-secondary, #99907e)', fontWeight: 400 }}> · {badge}</span> : null}</span>
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', color: 'var(--theme-secondary, #99907e)' }}>›</span>
      </button>
      {open && <div style={{ padding: '2px 12px 14px' }}>{children}</div>}
    </div>
  )
}

export function fmtM(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}T`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(1)}B`
  return `$${v.toFixed(0)}M`
}

// Labelled input group with an optional hint line.
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={LABEL}>{label}</label>
      {children}
      {hint && <div style={HINT}>{hint}</div>}
    </div>
  )
}

// Accent-topped metric card with an optional hover ⓘ tooltip — the shared
// readout used by the options/volatility tools (skew, GEX, implied probability).
// `color` overrides the gold top-border and value color (e.g. red for crash skew).
export function MetricCard({ label, value, sub, help, color }:
  { label: string; value: string; sub?: string; help?: string; color?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ background: 'var(--theme-surface, #142032)', border: '1px solid var(--theme-border, rgba(255,255,255,0.07))', borderTop: `3px solid ${color ?? 'var(--theme-primary, #c9a84c)'}`, padding: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>{label}</span>
        {help && <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', cursor: 'help' }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>ⓘ</span>}
        {show && help && (
          <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6, background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', padding: '6px 8px', width: 180, fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '15px', zIndex: 50, pointerEvents: 'none' }}>{help}</div>
        )}
      </div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: color ?? 'var(--theme-text, #d7e3fc)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ── Tool-redesign system ──────────────────────────────────────────────────────
// The shared chrome for the redesigned tool pages: a tracked title bar, an
// answer-first "verdict strip" (a big headline figure + supporting metric cells,
// optionally a gradient range track), and the recessed-strip label style. All
// token-driven so they adapt to the active theme and can later back the live
// pages (each takes plain props; the demo passes sample data, the real page
// passes its result object).

export type VerdictTone = 'gold' | 'pos' | 'neg' | 'blue' | 'text' | 'muted'

const TONE: Record<VerdictTone, string> = {
  gold:  'var(--theme-primary, #c9a84c)',
  pos:   'var(--theme-positive, #22c55e)',
  neg:   'var(--theme-negative, #ef4444)',
  blue:  'var(--theme-tertiary, #60a5fa)',
  text:  'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #8099b0)',
}
export const toneColor = (t: VerdictTone = 'text') => TONE[t]

// Shared valuation verdict from an upside-to-price %, so every valuation tool
// reads the same way (undervalued/fair/overvalued, with matching tone).
export function valuationVerdict(upside: number | null): { label: string; tone: VerdictTone } {
  if (upside == null) return { label: 'Fair value', tone: 'gold' }
  if (upside > 10) return { label: 'Undervalued', tone: 'pos' }
  if (upside > 2) return { label: 'Modestly undervalued', tone: 'pos' }
  if (upside >= -2) return { label: 'Fairly valued', tone: 'gold' }
  if (upside >= -10) return { label: 'Modestly overvalued', tone: 'neg' }
  return { label: 'Overvalued', tone: 'neg' }
}

// Standard answer-first VerdictStrip headline: verdict + upside hero with a
// "fair vs price" context. Falls back to the fair figure alone when no price.
export function upsidePrimary(upside: number | null, fair: string, price: string | null) {
  const v = valuationVerdict(upside)
  return upside != null && price != null
    ? { label: v.label, value: `${upside >= 0 ? '+' : '−'}${Math.abs(upside).toFixed(1)}%`, tone: v.tone, context: `Fair ${fair} vs ${price}`, contextTone: 'muted' as VerdictTone }
    : { label: 'Fair value', value: fair, tone: 'gold' as VerdictTone }
}

// Zero-anchored heatmap scale — forest-green above 0, maroon below — used by the
// sensitivity grid and the sector table. These are deliberate data-viz heat
// colors (not theme tokens); matches the existing heatColor() in DCFValuation.
export function heatColor(v: number, min: number, max: number): string {
  if (max === min) return 'rgba(94,118,143,0.3)'
  const t = (v - min) / (max - min)
  if (v < 0) {
    const intensity = max <= 0 ? 1 - t : Math.min(Math.abs(v) / Math.max(Math.abs(min), 1), 1)
    return `rgba(140,46,54,${0.2 + intensity * 0.7})`
  }
  const intensity = min >= 0 ? t : Math.min(v / Math.max(max, 1), 1)
  return `rgba(47,107,75,${0.2 + intensity * 0.7})`
}

// 9px uppercase eyebrow used by the verdict strip + recessed panel headers.
export const EYEBROW: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)',
}

// 54px tool title bar: mono gold name + sans muted subtitle, right actions slot.
export function TitleBar({ name, subtitle, right }:
  { name: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 22px', height: 54,
      borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, minWidth: 0 }}>
        <span style={{
          fontFamily: 'var(--theme-mono)', fontSize: 15, fontWeight: 700,
          letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)',
          whiteSpace: 'nowrap',
        }}>{name}</span>
        {subtitle && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-secondary, #8099b0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>}
      </div>
      {right && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{right}</div>}
    </div>
  )
}

// Small title-bar action chip: ghost (default) or gold (primary).
export function TitleAction({ label, primary }: { label: string; primary?: boolean }) {
  return (
    <span style={{
      fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
      textTransform: 'uppercase', padding: '6px 12px', whiteSpace: 'nowrap',
      color: primary ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
      border: `1px solid ${primary ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
      background: primary ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)' : 'transparent',
    }}>{label}</span>
  )
}

export interface RangeTick { pct: number; tone: VerdictTone }
export interface RangeLabel { text: string; pct: number; tone?: VerdictTone; anchor?: 'start' | 'center' | 'end' }

// Gradient range track (bear→fair→bull, floor→now→peak, …) with positioned
// ticks and a labels row. `gradient` is a token-built CSS string supplied by the
// caller so colors stay on-theme.
export function RangeTrack({ title, chip, gradient, ticks, labels }:
  { title: string; chip?: { text: string; tone: VerdictTone };
    gradient: string; ticks: RangeTick[]; labels: RangeLabel[] }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 9 }}>
        <span style={EYEBROW}>{title}</span>
        {chip && <span style={{ ...EYEBROW, letterSpacing: '0.12em', color: TONE[chip.tone] }}>{chip.text}</span>}
      </div>
      <div style={{ position: 'relative', height: 8, background: gradient, border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
        {ticks.map((t, i) => (
          <div key={i} style={{ position: 'absolute', left: `${t.pct}%`, top: -4, bottom: -4, width: 2, background: TONE[t.tone] }} />
        ))}
      </div>
      <RangeLabels labels={labels} />
    </>
  )
}

// Labels row for RangeTrack. Each label wants to sit centered on its `pct`, but
// when values cluster the text collides. After layout we measure each label's
// real width and nudge neighbours apart (left-to-right, then clamp the right
// edge and push back), so positions stay close to the data without overlapping.
function RangeLabels({ labels }: { labels: RangeLabel[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const spanRefs = useRef<(HTMLSpanElement | null)[]>([])
  const [lefts, setLefts] = useState<number[] | null>(null)

  useLayoutEffect(() => {
    const compute = () => {
      const cont = containerRef.current
      const W = cont?.clientWidth ?? 0
      if (!W) return
      const GAP = 8
      const items = labels.map((l, i) => {
        const w = spanRefs.current[i]?.offsetWidth ?? 0
        const anchor = l.anchor ?? (l.pct <= 3 ? 'start' : l.pct >= 97 ? 'end' : 'center')
        const left = anchor === 'start' ? 0
          : anchor === 'end' ? W - w
          : (l.pct / 100) * W - w / 2
        return { left, w }
      })
      const order = items.map((_, i) => i).sort((a, b) => items[a].left - items[b].left)
      // Forward: each label starts no earlier than the previous one's right edge.
      for (let k = 1; k < order.length; k++) {
        const prev = items[order[k - 1]], cur = items[order[k]]
        cur.left = Math.max(cur.left, prev.left + prev.w + GAP)
      }
      // Backward: keep the last label inside the track, then push earlier ones left.
      const last = items[order[order.length - 1]]
      if (last.left + last.w > W) last.left = W - last.w
      for (let k = order.length - 2; k >= 0; k--) {
        const next = items[order[k + 1]], cur = items[order[k]]
        cur.left = Math.min(cur.left, next.left - GAP - cur.w)
      }
      for (const it of items) it.left = Math.max(0, it.left)
      setLefts(items.map(it => it.left))
    }
    compute()
    const ro = new ResizeObserver(compute)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [labels])

  return (
    <div ref={containerRef} style={{ position: 'relative', height: 13, marginTop: 7 }}>
      {labels.map((l, i) => {
        const anchor = l.anchor ?? (l.pct <= 3 ? 'start' : l.pct >= 97 ? 'end' : 'center')
        const fallback: React.CSSProperties = anchor === 'start' ? { left: 0 }
          : anchor === 'end' ? { right: 0 } : { left: `${l.pct}%`, transform: 'translateX(-50%)' }
        const pos: React.CSSProperties = lefts ? { left: lefts[i] } : fallback
        return (
          <span key={i} ref={el => { spanRefs.current[i] = el }}
            style={{ position: 'absolute', top: 0, whiteSpace: 'nowrap', fontFamily: 'var(--theme-mono)', fontSize: 9, color: TONE[l.tone ?? 'muted'], ...pos }}>{l.text}</span>
        )
      })}
    </div>
  )
}

export interface VerdictCell { label: string; value: string; tone?: VerdictTone; labelTone?: VerdictTone; sub?: string }

// Answer-first verdict strip: a headline figure, an optional center range track,
// and supporting metric cells divided by vertical hairlines.
export function VerdictStrip({ primary, range, cells }:
  { primary: { label: string; value: string; tone?: VerdictTone; context?: string; contextTone?: VerdictTone };
    range?: React.ReactNode; cells?: VerdictCell[] }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', flexWrap: 'wrap',
      borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
      background: 'var(--theme-hover, rgba(0,0,0,0.12))',
    }}>
      <div style={{ padding: '11px 22px', borderRight: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', minWidth: 230 }}>
        <div style={{ ...EYEBROW, marginBottom: 5 }}>{primary.label}</div>
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 28, fontWeight: 700, lineHeight: 1, color: TONE[primary.tone ?? 'gold'] }}>{primary.value}</div>
        {primary.context && <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: TONE[primary.contextTone ?? 'muted'], marginTop: 4 }}>{primary.context}</div>}
      </div>
      {range && <div style={{ flex: 1, minWidth: 280, padding: '11px 22px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>{range}</div>}
      {cells && cells.length > 0 && (
        range
          // With a range track, cells are a compact group on the right.
          ? (
            <div style={{ flex: 'none', padding: '11px 22px', borderLeft: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', display: 'flex', gap: 26, alignItems: 'center', flexWrap: 'wrap' }}>
              {cells.map((c, i) => <VerdictCellView key={i} c={c} />)}
            </div>
          )
          // No range: cells fill the band as even, hairline-divided stat columns
          // so the space reads as an intentional stat bar, not empty gaps.
          : (
            <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
              {cells.map((c, i) => (
                <div key={i} style={{ flex: 1, minWidth: 0, padding: '11px 22px', borderLeft: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <VerdictCellView c={c} />
                </div>
              ))}
            </div>
          )
      )}
    </div>
  )
}

function VerdictCellView({ c }: { c: VerdictCell }) {
  return (
    <div>
      <div style={{ ...EYEBROW, marginBottom: 5, color: TONE[c.labelTone ?? 'muted'] }}>{c.label}</div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 16, fontWeight: 600, color: TONE[c.tone ?? 'text'] }}>{c.value}</div>
      {c.sub && <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-dim, #5e768f)', marginTop: 2 }}>{c.sub}</div>}
    </div>
  )
}

// Titled panel with the recessed corner label tab, auto-height (for hand-built
// DOM charts, unlike the fixed-height ChartPanel used for Recharts). Optional
// right-aligned caption in the tab strip.
export function LabeledPanel({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  const hair = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
  return (
    <div style={{ ...PANEL, position: 'relative', padding: '30px 16px 16px' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.85))',
        padding: '4px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
        color: 'var(--theme-text, #d7e3fc)', borderRight: hair, borderBottom: hair,
      }}>{title}</div>
      {right && <div style={{ position: 'absolute', top: 6, right: 12, fontFamily: 'var(--theme-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--theme-secondary, #99907e)' }}>{right}</div>}
      {children}
    </div>
  )
}

// Titled chart panel with the inset label tab used across the valuation charts.
export function ChartPanel({ title, height = 240, children }: { title: string; height?: number; children: React.ReactNode }) {
  return (
    <div style={{ ...PANEL, padding: '30px 10px 10px', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.85))',
        padding: '4px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
      }}>{title}</div>
      <div style={{ height }}>{children}</div>
    </div>
  )
}
