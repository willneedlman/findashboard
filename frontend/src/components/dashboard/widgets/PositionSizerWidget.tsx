import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { usePaperAccount } from './usePortfolio'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}
const money = (v: number, d = 0) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d })
const cap: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }

function Stepper({ value, step, onChange }: { value: number; step: number; onChange: (v: number) => void }) {
  const btn: React.CSSProperties = { fontFamily: T.mono, fontSize: 12, fontWeight: 700, width: 22, flexShrink: 0, cursor: 'pointer', border: `1px solid ${T.border}`, background: 'transparent', color: T.gold }
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid rgba(201,168,76,0.4)', height: 26 }}>
      <button onClick={() => onChange(Math.max(0, +(value - step).toFixed(2)))} style={btn}>−</button>
      <input type="number" value={value} step={step} onChange={e => onChange(Math.max(0, Number(e.target.value)))}
        style={{ flex: 1, minWidth: 0, background: 'var(--theme-bg, #101c2e)', border: 'none', borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 12, textAlign: 'center', outline: 'none' }} />
      <button onClick={() => onChange(+(value + step).toFixed(2))} style={btn}>+</button>
    </div>
  )
}

export default function PositionSizerWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()
  const { data: acct } = usePaperAccount(config.accountValue == null)
  const account = config.accountValue ?? acct?.equity ?? 100000
  const [riskPct, setRiskPct] = useState(config.riskPct ?? 1)
  const [entry, setEntry] = useState(config.entry ?? 100)
  const [stop, setStop] = useState(config.stop ?? 96)

  const riskDollar = account * riskPct / 100
  const dist = Math.abs(entry - stop)
  const distPct = entry > 0 ? (dist / entry) * 100 : 0
  const shares = dist > 0 ? Math.floor(riskDollar / dist) : 0
  const posValue = shares * entry
  const pctAcct = account > 0 ? (posValue / account) * 100 : 0
  const long = stop < entry
  const target2R = long ? entry + 2 * dist : entry - 2 * dist

  const out = (l: string, v: string, c = T.text) => (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={cap}>{l}</span>
      <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto', background: T.bg, padding: '8px 10px', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ ...cap, color: T.gold, letterSpacing: '0.16em' }}>{ticker} · Sizer</span>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>Acct {money(account)}</span>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={cap}>Risk %</span>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>{riskPct.toFixed(2)}%</span>
        </div>
        <input type="range" min={0.25} max={5} step={0.25} value={riskPct} onChange={e => setRiskPct(Number(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--theme-primary, #c9a84c)', marginTop: 3 }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div><div style={{ ...cap, marginBottom: 3 }}>Entry</div><Stepper value={entry} step={0.25} onChange={setEntry} /></div>
        <div><div style={{ ...cap, marginBottom: 3 }}>Stop</div><Stepper value={stop} step={0.25} onChange={setStop} /></div>
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 6, textAlign: 'center' }}>
        <div style={cap}>Shares</div>
        <div style={{ fontFamily: T.mono, fontSize: 28, fontWeight: 700, color: T.gold, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{shares.toLocaleString()}</div>
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 4 }}>
        {out('Risk $', money(riskDollar), T.neg)}
        {out('Stop distance', `${money(dist, 2)} · ${distPct.toFixed(1)}%`)}
        {out('Position value', money(posValue))}
        {out('% of account', `${pctAcct.toFixed(1)}%`, pctAcct > 35 ? T.neg : T.text)}
        {out('2R target', dist > 0 ? money(target2R, 2) : '—', T.pos)}
      </div>
    </div>
  )
}
