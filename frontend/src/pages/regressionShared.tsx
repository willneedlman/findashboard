import React from 'react'
import {
  ScatterChart, Scatter, LineChart, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import HelpTip from '../components/HelpTip'
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'

// Shared tokens, controls, and the side-rail shell for the Regression and
// Correlation tools so the two split pages read as one consistent system.

export const PERIODS = ['1mo', '3mo', '6mo', '1y', '2y', '3y', '5y', '10y', 'max']

// The three regression tool modes, shared so every view's ModeToggle matches.
export type RegMode = 'ols' | 'mc' | 'import'
export const REG_MODES: { id: RegMode; label: string }[] = [
  { id: 'ols', label: 'Asset OLS' },
  { id: 'mc', label: 'Options Selling' },
  { id: 'import', label: 'Import' },
]

export const C = {
  bg:     'var(--theme-bg)',
  surf:   'var(--theme-surface)',
  border: 'var(--theme-border)',
  gold:   'var(--theme-primary)',
  text:   'var(--theme-text, #d7e3fc)',
  muted:  'var(--theme-secondary)',
  blue:   'var(--theme-tertiary)',
  green:  'var(--theme-positive)',
  red:    'var(--theme-negative)',
  purple: 'var(--at-series-purple, #7b5ea7)',
}

export const inputStyle: React.CSSProperties = {
  height: 32, minHeight: 32, borderRadius: 0,
  background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', padding: '6px 10px', fontSize: 12,
  fontFamily: 'var(--theme-mono)', width: '100%', outline: 'none', boxSizing: 'border-box',
}

export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

export const btnStyle: React.CSSProperties = {
  height: 32, minHeight: 32, borderRadius: 0,
  background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', padding: '6px 14px', fontSize: 12,
  fontFamily: 'var(--theme-mono)', cursor: 'pointer',
}

export const railLabel: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: C.muted, marginBottom: 5, display: 'block',
}

export function StatCard({ label, value, sub, tip }: { label: string; value: string | number; sub?: string; tip?: string }) {
  return (
    <div className="ft-metric" style={{ minWidth: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', color: C.muted, fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 6 }}>
        {label}{tip && <HelpTip text={tip} width={240} />}
      </div>
      <div style={{ color: C.text, fontFamily: 'var(--theme-mono)', fontSize: 20, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ color: C.muted, fontSize: 10, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// Result/chart panel on the shared chrome: caption strip on top, inset body.
// These four pages had grown their own rounded, gold-captioned box, which is a
// second panel style and a second heading style on the same screen as .ft-panel.
export function ChartPanel({ title, hint, children, style, bodyStyle }: {
  title: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  style?: React.CSSProperties
  bodyStyle?: React.CSSProperties
}) {
  return (
    <div className="ft-chart-panel" style={style}>
      <div className="ft-chart-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{title}</div>
      <div style={{ padding: '14px 16px', ...bodyStyle }}>
        {hint && <div style={{ color: C.muted, fontSize: 11, lineHeight: 1.5, marginBottom: 12 }}>{hint}</div>}
        {children}
      </div>
    </div>
  )
}

// Segmented control at the top of a rail, switching the whole tool's mode.
export function ModeToggle<T extends string>(
  { value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] },
) {
  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
      <label style={railLabel}>Mode</label>
      <div style={{ display: 'flex', border: `1px solid ${C.border}` }}>
        {options.map(o => {
          const on = value === o.id
          return (
            <button key={o.id} onClick={() => onChange(o.id)} style={{
              flex: 1, padding: '7px 4px', fontSize: 9.5, fontFamily: 'var(--theme-sans)', fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer', border: 'none',
              background: on ? C.gold : 'transparent', color: on ? C.bg : C.muted,
            }}>{o.label}</button>
          )
        })}
      </div>
    </div>
  )
}

// One labelled group inside the rail.
export function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
      <label style={railLabel}>{label}</label>
      {children}
    </div>
  )
}

export function RunButton({ onClick, disabled, busy, label }: { onClick: () => void; disabled: boolean; busy: boolean; label: string }) {
  const can = !disabled && !busy
  return (
    <div style={{ padding: '14px 16px' }}>
      <button onClick={onClick} disabled={!can}
        style={{ width: '100%', minHeight: 32, boxSizing: 'border-box', background: 'color-mix(in srgb, var(--theme-primary) 8%, transparent)', border: `1px solid ${C.gold}`, color: C.gold, fontFamily: 'var(--theme-sans)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '6px 14px', cursor: can ? 'pointer' : 'default', opacity: can ? 1 : 0.5 }}>
        {busy ? 'Running…' : label}
      </button>
    </div>
  )
}

// Same per-ticker color palette and swatch as the Asset Overlay tab (Compare.tsx),
// so tags read the same way across the Regression, Correlation, and Compare tools.
export const TAG_COLORS = ['var(--theme-primary, #c9a84c)', '#60a5fa', '#34d399', '#f97316', '#a78bfa', '#38bdf8', '#fb7185', '#fbbf24']

function TagSwatch({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return <input type="color" value={value} title="Tag color" onClick={e => e.stopPropagation()}
    onChange={e => onChange(e.target.value)}
    style={{ width: 13, height: 13, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }} />
}

// Tag-style multi-ticker input used by both rails. Each tag gets a colorized
// swatch + tinted border/background (defaulting to TAG_COLORS by position,
// overridable per-ticker via the swatch) — matches the Asset Overlay tab.
export function TickerTags({ tickers, onRemove, colors, onColorChange }: {
  tickers: string[]; onRemove: (t: string) => void
  colors?: Record<string, string>; onColorChange?: (t: string, c: string) => void
}) {
  if (!tickers.length) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {tickers.map((t, i) => {
        const c = colors?.[t] ?? TAG_COLORS[i % TAG_COLORS.length]
        return (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: `color-mix(in srgb, ${c} 12%, transparent)`, border: `1px solid ${c}`, padding: '4px 7px', fontSize: 11, fontFamily: 'var(--theme-mono)', fontWeight: 700, color: C.text }}>
            {onColorChange ? <TagSwatch value={c} onChange={v => onColorChange(t, v)} /> : <span style={{ width: 8, height: 8, background: c, flexShrink: 0 }} />}
            {t}
            <span onClick={() => onRemove(t)} style={{ cursor: 'pointer', color: C.muted, fontWeight: 400 }}>×</span>
          </span>
        )
      })}
    </div>
  )
}

// Derive a quick OLS regression (daily y-returns vs x-returns) from a series of
// paired cumulative values (equity curve, base-100 index, etc) — no backend
// round-trip. Feeds ReturnsScatter for an in-context "regression dotplot" on
// any results panel that already has a strategy/benchmark curve.
export interface QuickRegression {
  x: number[]; y: number[]; line: { x: number; y: number }[]
  beta: number; alpha: number; correlation: number; rSquared: number
  betaPValue: number | null; alphaPValue: number | null; observations: number
}

function logGamma(z: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
  let value = 0.9999999999998099
  const shifted = z - 1
  for (let i = 0; i < coefficients.length; i++) value += coefficients[i] / (shifted + i + 1)
  const t = shifted + coefficients.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(value)
}

function betaFraction(a: number, b: number, x: number): number {
  const epsilon = 3e-7, min = 1e-30
  let c = 1, d = 1 - (a + b) * x / (a + 1)
  d = 1 / (Math.abs(d) < min ? min : d)
  let h = d
  for (let m = 1; m <= 100; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d; d = 1 / (Math.abs(d) < min ? min : d)
    c = 1 + aa / c; c = Math.abs(c) < min ? min : c
    h *= d * c
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d; d = 1 / (Math.abs(d) < min ? min : d)
    c = 1 + aa / c; c = Math.abs(c) < min ? min : c
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < epsilon) break
  }
  return h
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logGamma(a) - logGamma(b) + logGamma(a + b))
  return x < (a + 1) / (a + b + 2) ? front * betaFraction(a, b, x) / a : 1 - front * betaFraction(b, a, 1 - x) / b
}

function twoSidedTPValue(t: number, degreesOfFreedom: number): number | null {
  if (degreesOfFreedom <= 0 || !Number.isFinite(t)) return null
  return regularizedBeta(degreesOfFreedom / (degreesOfFreedom + t ** 2), degreesOfFreedom / 2, 0.5)
}

// Day-over-day % change pairs from a raw {x,y} value curve — the diffing
// step quickRegression normally does internally, split out so a caller can
// filter which DAYS' returns feed the regression (e.g. active-position-only)
// without re-differencing already-differenced values.
export function dailyReturnPairs(curve: { x: number; y: number }[]): { x: number; y: number }[] {
  const pairs: { x: number; y: number }[] = []
  for (let i = 1; i < curve.length; i++) {
    const px = curve[i - 1].x, py = curve[i - 1].y
    if (px > 0 && py > 0) pairs.push({ x: curve[i].x / px - 1, y: curve[i].y / py - 1 })
  }
  return pairs
}

export function quickRegression(curve: { x: number; y: number }[]): QuickRegression {
  return regressReturnPairs(dailyReturnPairs(curve))
}

export function regressReturnPairs(pairs: { x: number; y: number }[]): QuickRegression {
  const x = pairs.map(p => p.x), y = pairs.map(p => p.y)
  const n = x.length
  if (n < 2) return { x, y, line: [], beta: 0, alpha: 0, correlation: 0, rSquared: 0, betaPValue: null, alphaPValue: null, observations: n }
  const mx = x.reduce((s, v) => s + v, 0) / n
  const my = y.reduce((s, v) => s + v, 0) / n
  let num = 0, den = 0, yDen = 0
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; yDen += (y[i] - my) ** 2 }
  const beta = den > 0 ? num / den : 0
  const alpha = my - beta * mx
  const correlation = den > 0 && yDen > 0 ? num / Math.sqrt(den * yDen) : 0
  const rSquared = correlation ** 2
  const residualSumSquares = y.reduce((sum, value, i) => sum + (value - (alpha + beta * x[i])) ** 2, 0)
  const residualVariance = n > 2 ? residualSumSquares / (n - 2) : 0
  const betaSE = den > 0 ? Math.sqrt(residualVariance / den) : Infinity
  const alphaSE = den > 0 ? Math.sqrt(residualVariance * (1 / n + mx ** 2 / den)) : Infinity
  const xMin = Math.min(...x), xMax = Math.max(...x)
  return {
    x, y, line: [{ x: xMin, y: alpha + beta * xMin }, { x: xMax, y: alpha + beta * xMax }], beta, alpha,
    correlation, rSquared, betaPValue: twoSidedTPValue(beta / betaSE, n - 2), alphaPValue: twoSidedTPValue(alpha / alphaSE, n - 2), observations: n,
  }
}

// Scatter of strategy daily returns (y) vs benchmark daily returns (x) with the
// fitted OLS line. Shared by the Monte-Carlo and Import regression views.
export function ReturnsScatter({ x, y, line, xLabel, yLabel = 'strategy daily return', height = 280 }: {
  x: number[]; y: number[]; line: { x: number; y: number }[]; xLabel: string; yLabel?: string; height?: number
}) {
  const pts = x.map((xi, i) => ({ x: xi, y: y[i] }))
  const rp = (v: number) => `${(v * 100).toFixed(1)}%`
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 10, right: 20, left: 12, bottom: 34 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="x" type="number" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={rp}
          label={{ value: `${xLabel} daily return`, fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -4 }} />
        <YAxis dataKey="y" type="number" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={rp} width={64}
          label={{ value: yLabel, fill: C.muted, fontSize: 11, angle: -90, position: 'center', dx: -28 }} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ ...TOOLTIP_STYLE }} formatter={(v: number) => `${(v * 100).toFixed(3)}%`} />
        <Scatter isAnimationActive={false} data={pts} fill={C.blue} opacity={0.22} />
        <Scatter isAnimationActive={false} data={line} line={{ stroke: C.gold, strokeWidth: 2 }} fill={C.gold} shape={() => null as any} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

// Rolling-beta line with a full-sample reference line. Shared by the
// Monte-Carlo and Import views. `beta` values may be null (cash-only windows);
// the line gaps them and the tooltip formatter tolerates null.
export function RollingBetaChart({ data, xKey, xLabel, refValue, refLabel, height = 220 }: {
  data: Record<string, unknown>[]; xKey: string; xLabel?: string
  refValue: number; refLabel: string; height?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 16, left: 0, bottom: 16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey={xKey} stroke={C.muted} tick={{ fill: C.muted, fontSize: 9 }} minTickGap={40}
          label={xLabel ? { value: xLabel, fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -8 } : undefined} />
        <YAxis stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} domain={['auto', 'auto']} />
        <ReferenceLine y={refValue} stroke={C.gold} strokeDasharray="4 2"
          label={{ value: refLabel, fill: C.gold, fontSize: 10, position: 'right' }} />
        <Tooltip contentStyle={{ ...TOOLTIP_STYLE }}
          formatter={(v: unknown) => (v == null ? 'n/a' : Number(v).toFixed(3))} />
        <Line isAnimationActive={false} type="monotone" dataKey="beta" stroke={C.blue} strokeWidth={1.6} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// Page shell: title, left rail (inputs), right content.
export function ToolShell({ title, rail, children }: { title: string; rail: React.ReactNode; children: React.ReactNode }) {
  const isMobile = useIsMobile()
  return (
    <PageWrapper title={title}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row', color: C.text }}>
        <aside style={{ width: isMobile ? '100%' : 210, flexShrink: 0, background: C.surf, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
          <div className="ft-sidebar-title">Parameters</div>
          {rail}
        </aside>
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : 'auto' }}>
          {children}
        </div>
      </div>
    </PageWrapper>
  )
}
