import React from 'react'
import {
  ScatterChart, Scatter, LineChart, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import HelpTip from '../components/HelpTip'
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'

// Shared tokens, controls, and the side-rail shell for the Regression and
// Correlation tools so the two split pages read as one consistent system.

export const PERIODS = ['1mo', '3mo', '6mo', '1y', '2y', '3y', '5y']

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
  muted:  'var(--theme-text-dim)',
  blue:   'var(--theme-tertiary)',
  green:  'var(--theme-positive)',
  red:    'var(--theme-negative)',
  purple: '#bb9af7',
}

export const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', padding: '6px 10px', fontSize: 12,
  fontFamily: 'var(--theme-mono)', width: '100%', outline: 'none', boxSizing: 'border-box',
}

export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

export const btnStyle: React.CSSProperties = {
  background: 'var(--theme-bg)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', padding: '6px 14px', fontSize: 12,
  fontFamily: 'var(--theme-mono)', cursor: 'pointer',
}

export const railLabel: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: C.muted, marginBottom: 8, display: 'block',
}

export function StatCard({ label, value, sub, tip }: { label: string; value: string | number; sub?: string; tip?: string }) {
  return (
    <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 6, padding: '10px 14px', minWidth: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}{tip && <HelpTip text={tip} width={240} />}
      </div>
      <div style={{ color: C.gold, fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{sub}</div>}
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
        style={{ width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: `1px solid ${C.gold}`, color: C.gold, fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '10px 0', cursor: can ? 'pointer' : 'default', opacity: can ? 1 : 0.5 }}>
        {busy ? 'Running…' : label}
      </button>
    </div>
  )
}

// Tag-style multi-ticker input used by both rails.
export function TickerTags({ tickers, onRemove, color }: { tickers: string[]; onRemove: (t: string) => void; color: string }) {
  if (!tickers.length) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {tickers.map(t => (
        <span key={t} style={{ background: `${color}22`, border: `1px solid ${color}55`, padding: '2px 8px', fontSize: 11, fontFamily: 'var(--theme-mono)', color: C.text, display: 'flex', gap: 4, alignItems: 'center' }}>
          {t}<span onClick={() => onRemove(t)} style={{ cursor: 'pointer', color: C.muted }}>×</span>
        </span>
      ))}
    </div>
  )
}

// Scatter of strategy daily returns (y) vs benchmark daily returns (x) with the
// fitted OLS line. Shared by the Monte-Carlo and Import regression views.
export function ReturnsScatter({ x, y, line, xLabel, height = 280 }: {
  x: number[]; y: number[]; line: { x: number; y: number }[]; xLabel: string; height?: number
}) {
  const pts = x.map((xi, i) => ({ x: xi, y: y[i] }))
  const rp = (v: number) => `${(v * 100).toFixed(1)}%`
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 22 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="x" type="number" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={rp}
          label={{ value: `${xLabel} daily return`, fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -10 }} />
        <YAxis dataKey="y" type="number" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={rp}
          label={{ value: 'strategy daily return', fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }} formatter={(v: number) => `${(v * 100).toFixed(3)}%`} />
        <Scatter data={pts} fill={C.blue} opacity={0.22} />
        <Scatter data={line} line={{ stroke: C.gold, strokeWidth: 2 }} fill={C.gold} shape={() => null as any} />
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
        <Tooltip contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }}
          formatter={(v: unknown) => (v == null ? 'n/a' : Number(v).toFixed(3))} />
        <Line type="monotone" dataKey="beta" stroke={C.blue} strokeWidth={1.6} dot={false} />
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
        <aside style={{ width: isMobile ? '100%' : 230, flexShrink: 0, background: C.surf, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
          {rail}
        </aside>
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : 'auto' }}>
          {children}
        </div>
      </div>
    </PageWrapper>
  )
}
