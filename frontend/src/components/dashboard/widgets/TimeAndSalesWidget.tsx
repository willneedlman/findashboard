import { useEffect, useRef, useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))', gold: 'var(--theme-primary, #c9a84c)',
  muted: 'var(--theme-secondary, #5e768f)', text: 'var(--theme-text, #d7e3fc)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)', pos: '#22c55e', neg: '#ef4444',
}

interface Print { id: number; time: string; price: number; size: number; venue: string; dir: 1 | -1 | 0; dark: boolean }
const VENUES = ['ARCA', 'NSDQ', 'EDGX', 'BATS', 'IEX']
const baseSpot = (t: string) => 80 + ([...t].reduce((s, c) => s + c.charCodeAt(0), 0) % 240)
const hhmmss = (d: Date) => d.toTimeString().slice(0, 8)

export default function TimeAndSalesWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()
  const spotRef = useRef(baseSpot(ticker))
  const idRef = useRef(0)
  const lastRef = useRef(spotRef.current)
  const [prints, setPrints] = useState<Print[]>([])

  useEffect(() => {
    spotRef.current = baseSpot(ticker)
    lastRef.current = spotRef.current
    idRef.current = 0
    setPrints([])
    const tick = () => {
      const drift = (Math.random() - 0.5) * 0.12
      const price = Math.max(0.5, spotRef.current + drift)
      spotRef.current = price
      const dir: 1 | -1 | 0 = price > lastRef.current ? 1 : price < lastRef.current ? -1 : 0
      lastRef.current = price
      const big = Math.random() < 0.12
      const dark = Math.random() < 0.18
      const size = big ? 200 + Math.floor(Math.random() * 1800) : 1 + Math.floor(Math.random() * 200)
      const p: Print = { id: idRef.current++, time: hhmmss(new Date()), price, size, venue: dark ? 'DARK' : VENUES[Math.floor(Math.random() * VENUES.length)], dir, dark }
      setPrints(prev => [p, ...prev].slice(0, 60))
    }
    tick()
    const interval = window.setInterval(tick, 1500)
    return () => window.clearInterval(interval)
  }, [ticker])

  const last = prints[0]?.price ?? spotRef.current
  const bid = last - 0.02, ask = last + 0.02
  const lbl: React.CSSProperties = { fontFamily: T.label, fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {[{ l: 'Bid', v: bid, c: T.neg }, { l: 'Last', v: last, c: T.text }, { l: 'Ask', v: ask, c: T.pos }].map((s, i) => (
          <div key={s.l} style={{ padding: '5px 8px', borderRight: i < 2 ? `1px solid ${T.border}` : 'none' }}>
            <div style={lbl}>{s.l}</div>
            <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: s.c, fontVariantNumeric: 'tabular-nums' }}>{s.v.toFixed(2)}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '3px 8px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {['Time', 'Price', 'Size', 'Ven'].map((h, i) => (
          <span key={h} style={{ ...lbl, flex: i === 0 ? '0 0 58px' : i === 3 ? '0 0 40px' : 1, textAlign: i === 0 ? 'left' : 'right' }}>{h}</span>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {prints.map(p => {
          const c = p.dir === 1 ? T.pos : p.dir === -1 ? T.neg : T.muted
          const big = p.size >= 200
          return (
            <div key={p.id} style={{ display: 'flex', gap: 8, padding: '2px 8px', borderBottom: `1px solid rgba(255,255,255,0.03)`, opacity: p.dark ? 0.6 : 1, background: big ? 'rgba(201,168,76,0.06)' : 'transparent' }}>
              <span style={{ flex: '0 0 58px', fontFamily: T.mono, fontSize: 9, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{p.time}</span>
              <span style={{ flex: 1, textAlign: 'right', fontFamily: T.mono, fontSize: 10, fontWeight: big ? 700 : 400, color: c, fontVariantNumeric: 'tabular-nums' }}>{p.price.toFixed(2)}</span>
              <span style={{ flex: 1, textAlign: 'right', fontFamily: T.mono, fontSize: 10, color: big ? T.text : T.muted, fontVariantNumeric: 'tabular-nums' }}>{p.size.toLocaleString()}</span>
              <span style={{ flex: '0 0 40px', textAlign: 'right', fontFamily: T.mono, fontSize: 8, color: p.dark ? T.gold : T.muted }}>{p.dark ? 'D' : p.venue.slice(0, 4)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
