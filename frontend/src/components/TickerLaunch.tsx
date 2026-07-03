import { useState } from 'react'
import { Search } from 'lucide-react'
import { T } from '../lib/theme'
import { getRecentTickers } from '../lib/recentTickers'

const POPULAR = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'TSLA', 'JPM']

// Launch state for ticker tools: replaces the dead "enter a ticker" line with a
// focused input, your recent tickers, and a liquid-names row. No auto-load: the
// user picks the name.
export default function TickerLaunch({ hint, onLoad }: { hint: string; onLoad: (sym: string) => void }) {
  const [v, setV] = useState('')
  const recents = getRecentTickers().filter(s => !POPULAR.includes(s)).slice(0, 5)
  const go = (sym?: string) => { const s = (sym ?? v).trim().toUpperCase(); if (s) onLoad(s) }

  const chip = (sym: string) => (
    <button key={sym} onClick={() => go(sym)}
      style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: T.text, background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`, padding: '6px 14px', cursor: 'pointer', transition: 'all 0.12s' }}
      onMouseEnter={e => { e.currentTarget.style.color = T.gold; e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' }}
      onMouseLeave={e => { e.currentTarget.style.color = T.text; e.currentTarget.style.borderColor = T.border }}>
      {sym}
    </button>
  )
  const rowLabel: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.muted, width: 64, flex: 'none', textAlign: 'right' }

  return (
    <div className="ft-panel" style={{ maxWidth: 620, margin: '4px 0 0', borderTop: `2px solid ${T.gold}` }}>
      <div style={{ padding: '30px 34px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)', paddingBottom: 10 }}>
          <Search size={16} style={{ color: T.gold, flexShrink: 0 }} />
          <input autoFocus value={v} onChange={e => setV(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && go()} spellCheck={false} aria-label="Ticker"
            placeholder="Ticker or company"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: T.text, fontFamily: T.mono, fontSize: 19, fontWeight: 700, letterSpacing: '0.06em' }} />
          <button onClick={() => go()}
            style={{ height: 30, boxSizing: 'border-box', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)', border: `1px solid ${T.gold}60`, color: T.gold, fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', padding: '0 16px', cursor: 'pointer' }}>
            LOAD
          </button>
        </div>
        <div style={{ fontFamily: T.label, fontSize: 11.5, color: T.muted, marginTop: 14, lineHeight: 1.6 }}>{hint}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          {recents.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={rowLabel}>Recent</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{recents.map(chip)}</div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={rowLabel}>Liquid</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{POPULAR.map(chip)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
