// Shared cockpit chrome for the two market-maker simulators (Options + Fixed
// Income). Presentational only. Colors route through --theme-* tokens.
const V = {
  surface: 'var(--theme-surface, #0d1826)',
  bg: 'var(--theme-bg, #101c2e)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  sec: 'var(--theme-secondary, #8099b0)',
  tertiary: 'var(--theme-tertiary, #60a5fa)',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  mono: 'var(--theme-mono)',
  sans: 'var(--theme-sans)',
}

const EYEBROW: React.CSSProperties = {
  fontFamily: V.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: V.sec,
}

export function Widget({ title, right, children, style, bodyStyle }: {
  title: string; right?: React.ReactNode; children: React.ReactNode
  style?: React.CSSProperties; bodyStyle?: React.CSSProperties
}) {
  return (
    <div style={{ background: V.surface, border: `1px solid ${V.border}`, display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        padding: '7px 12px', background: 'rgba(0,0,0,0.18)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0,
      }}>
        <span style={{ fontFamily: V.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: V.gold }}>{title}</span>
        {right}
      </div>
      <div style={{ minWidth: 0, ...bodyStyle }}>{children}</div>
    </div>
  )
}

export function DeskCoach({ text, over }: { text: string; over: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: 11, alignItems: 'center', padding: '9px 16px',
      background: over ? 'rgba(239,68,68,0.06)' : 'rgba(96,165,250,0.05)',
      border: `1px solid ${over ? V.neg : V.border}`,
    }}>
      <span style={{ ...EYEBROW, color: over ? V.neg : V.tertiary, whiteSpace: 'nowrap', flexShrink: 0 }}>Desk Coach</span>
      <span style={{ fontFamily: V.mono, fontSize: 11, color: over ? V.neg : V.text, lineHeight: 1.4 }}>{text}</span>
    </div>
  )
}

// Horizontal limit meter: red danger ends, green comfort band in the middle, a
// glowing gold marker at the current value. Used for Net Delta (Options) and
// Net DV01 (FI). fmt formats the hero and the scale labels.
export function RiskMeter({ value, limit, unit, over, fmt, footerRight }: {
  value: number; limit: number; unit: string; over: boolean
  fmt?: (n: number) => string; footerRight?: React.ReactNode
}) {
  const f = fmt || ((n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}`)
  const pct = Math.max(0, Math.min(100, ((value + limit) / (2 * limit)) * 100))
  return (
    <div style={{ padding: '11px 14px' }}>
      <div style={{ fontFamily: V.mono, fontSize: 27, fontWeight: 700, lineHeight: 1, color: over ? V.neg : V.gold, whiteSpace: 'nowrap' }}>
        {f(value)}<span style={{ fontSize: 11, color: V.sec, fontWeight: 400, marginLeft: 6 }}>{unit}</span>
      </div>
      <div style={{
        position: 'relative', height: 9, borderRadius: 5, margin: '12px 0 6px',
        background: 'linear-gradient(90deg, var(--theme-negative,#ef4444) 0%, var(--theme-negative,#ef4444) 12.5%, rgba(34,197,94,0.45) 12.5%, rgba(34,197,94,0.45) 87.5%, var(--theme-negative,#ef4444) 87.5%, var(--theme-negative,#ef4444) 100%)',
      }}>
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${pct}%`, width: 2, marginLeft: -1, background: V.gold, boxShadow: '0 0 6px rgba(201,168,76,0.7)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: V.mono, fontSize: 9, color: V.sec }}>
        <span>{f(-limit)}</span><span>0</span><span>{f(limit)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...EYEBROW, color: over ? V.neg : V.pos }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: over ? V.neg : V.pos }} />
          {over ? 'Over Limit' : 'Within Limits'}
        </span>
        {footerRight}
      </div>
    </div>
  )
}

// A labeled value row for the Greeks / Book-risk widget.
export function StatRow({ label, hint, value, last }: { label: string; hint: string; value: string; last?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 14px', borderBottom: last ? 'none' : `1px solid ${V.border}` }}>
      <span>
        <span style={{ ...EYEBROW, display: 'block' }}>{label}</span>
        <span style={{ fontFamily: V.mono, fontSize: 8, color: V.sec, opacity: 0.7 }}>{hint}</span>
      </span>
      <span style={{ fontFamily: V.mono, fontSize: 17, fontWeight: 700, color: V.text }}>{value}</span>
    </div>
  )
}

// One split bar for the P&L widget (Spread / Directional).
export function PnLBar({ label, value, fill, frac }: { label: string; value: string; fill: string; frac: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={EYEBROW}>{label}</span>
        <span style={{ fontFamily: V.mono, fontSize: 12, fontWeight: 700, color: fill }}>{value}</span>
      </div>
      <div style={{ height: 5, background: 'rgba(255,255,255,0.06)' }}>
        <div style={{ width: `${Math.max(0, Math.min(100, frac * 100))}%`, height: '100%', background: fill }} />
      </div>
    </div>
  )
}
