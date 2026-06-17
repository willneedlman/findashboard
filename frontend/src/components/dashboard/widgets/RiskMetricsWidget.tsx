import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}

const STATS: { l: string; v: string; sub?: string; c: string }[] = [
  { l: 'VaR 95% · 1d', v: '-$8,420', sub: '-3.4% NAV', c: T.neg },
  { l: 'Beta vs SPY', v: '1.12', c: T.text },
  { l: 'Sharpe', v: '1.84', c: T.pos },
  { l: 'Ann. Vol', v: '18.6%', c: T.gold },
  { l: 'Max Drawdown', v: '-12.3%', c: T.neg },
  { l: 'Sortino', v: '2.41', c: T.pos },
]
// Factor betas, roughly -1..1 from a center zero.
const FACTORS = [
  { name: 'Market', beta: 0.92 },
  { name: 'Size', beta: -0.34 },
  { name: 'Value', beta: 0.18 },
  { name: 'Momentum', beta: 0.56 },
  { name: 'Quality', beta: -0.12 },
]
const RISK_BUDGET = 0.68

const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }

export default function RiskMetricsWidget({ config: _c }: { config: WidgetConfig }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', flexShrink: 0 }}>
        {STATS.map((s, i) => (
          <div key={s.l} style={{ padding: '8px 10px', borderRight: i % 3 !== 2 ? `1px solid ${T.border}` : 'none', borderBottom: `1px solid ${T.border}` }}>
            <div style={cap}>{s.l}</div>
            <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: s.c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{s.v}</div>
            {s.sub && <div style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '9px 10px' }}>
        <div style={{ ...cap, color: T.gold, letterSpacing: '0.16em', marginBottom: 8 }}>Factor Exposure</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {FACTORS.map(f => {
            const pct = Math.min(Math.abs(f.beta), 1) * 50
            const up = f.beta >= 0
            return (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, width: 64, flexShrink: 0 }}>{f.name}</span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 10 }}>
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ width: `${up ? 0 : pct}%`, height: 8, background: 'rgba(239,68,68,0.55)' }} />
                  </div>
                  <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.16)', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}>
                    <div style={{ width: `${up ? pct : 0}%`, height: 8, background: 'rgba(34,197,94,0.55)' }} />
                  </div>
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: up ? T.pos : T.neg, width: 36, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {up ? '+' : ''}{f.beta.toFixed(2)}
                </span>
              </div>
            )
          })}
        </div>

        <div style={{ ...cap, color: T.gold, letterSpacing: '0.16em', margin: '14px 0 6px' }}>Risk Budget Used</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ width: `${RISK_BUDGET * 100}%`, height: '100%', background: T.gold }} />
          </div>
          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.gold, fontVariantNumeric: 'tabular-nums' }}>{(RISK_BUDGET * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>
  )
}
