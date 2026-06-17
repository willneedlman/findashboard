import { useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useDashboardControls } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
}

// An addable tile version of the header ticker control: type a symbol and
// broadcast it to every ticker-driven widget on this dashboard.
export default function UniversalTickerWidget({ config }: { config: WidgetConfig }) {
  const controls = useDashboardControls()
  const [val, setVal] = useState(config.ticker || '')

  const apply = () => {
    const sym = val.trim().toUpperCase()
    if (sym) controls?.setAllTickers(sym)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, height: '100%', background: T.bg, padding: '10px 12px' }}>
      <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.gold }}>
        Dashboard Ticker
      </div>
      <div style={{ display: 'flex', alignItems: 'stretch', height: 30 }}>
        <input
          value={val}
          onChange={e => setVal(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') apply() }}
          placeholder="AAPL"
          style={{ flex: 1, minWidth: 0, background: T.surface, border: `1px solid ${T.border}`, borderRight: 'none', color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', padding: '0 10px', outline: 'none' }}
        />
        <button onClick={apply}
          style={{ flexShrink: 0, background: 'rgba(201,168,76,0.14)', border: `1px solid rgba(201,168,76,0.5)`, color: T.gold, padding: '0 14px', cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          Apply
        </button>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>
        {controls ? 'Applies to every ticker widget here' : 'Add to a dashboard to use'}
      </div>
    </div>
  )
}
