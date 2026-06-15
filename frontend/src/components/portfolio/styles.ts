// Shared input/label/button styling for the Portfolio Skills tools, lifted
// verbatim from Compare Portfolios so Monte Carlo and the Backtester match it
// exactly. One source of truth, no per-page copies.
import type { CSSProperties } from 'react'

export const PF = {
  bg:     'var(--theme-bg)',
  surf:   'var(--theme-surface)',
  border: 'var(--theme-border)',
  gold:   'var(--theme-primary, #c9a84c)',
  text:   'var(--theme-text, #d7e3fc)',
  muted:  'var(--theme-text-dim)',
  label:  'var(--theme-secondary, #99907e)',
  green:  'var(--theme-positive)',
  red:    'var(--theme-negative)',
}

// Sleek, sharp, dark rectangular input with a thin gold-tinted border.
export const pfInput: CSSProperties = {
  background: 'var(--theme-bg)',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)',
  padding: '5px 8px',
  fontSize: 12,
  fontFamily: 'var(--theme-mono)',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
}

// Uppercase, tracked section/field label.
export const pfLabel: CSSProperties = {
  color: 'var(--theme-secondary, #99907e)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  marginBottom: 4,
  display: 'block',
}

export const pfPanel: CSSProperties = {
  background: PF.surf,
  border: `1px solid ${PF.border}`,
  padding: 16,
}

export const pfPanelTitle: CSSProperties = {
  color: PF.gold,
  fontSize: 12,
  marginBottom: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
}

// Solid gold primary action ("COMPARE", "RUN SIMULATION", "BACKTEST").
export const pfPrimaryBtn: CSSProperties = {
  ...pfInput,
  cursor: 'pointer',
  background: PF.gold,
  color: 'var(--theme-bg)',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  padding: '8px 0',
  textAlign: 'center',
}

// Quiet full-width "+ Add ticker" / "+ Add Portfolio" text button.
export const pfGhostBtn: CSSProperties = {
  ...pfInput,
  cursor: 'pointer',
  color: PF.muted,
  padding: '3px 0',
  fontSize: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
}
