import { X, GripHorizontal, Settings } from 'lucide-react'
import { useState } from 'react'
import type { WidgetConfig, WidgetType } from '../../hooks/useDashboard'
import TickerTagInput from '../TickerTagInput'

function makeEqualWeights(tickers: string[]): Record<string, string> {
  const w = tickers.length ? (100 / tickers.length).toFixed(1) : '0'
  return Object.fromEntries(tickers.map(t => [t, w]))
}

interface WidgetFrameProps {
  config: WidgetConfig
  editMode: boolean
  onRemove: () => void
  onUpdate: (patch: Partial<WidgetConfig>) => void
  children: React.ReactNode
}

const TICKER_WIDGETS: WidgetType[]     = ['price-card', 'mini-chart', 'options-snapshot', 'options-pricer', 'delta-target', 'tradingview-chart']
const TICKERS_WIDGETS: WidgetType[]    = ['watchlist', 'earnings-calendar', 'news-feed', 'correlation-matrix']
const PORTFOLIO_WIDGETS: WidgetType[]  = ['portfolio-summary']
const YIELD_WIDGETS: WidgetType[]      = ['macro-strip']

const YIELD_OPTIONS: { key: string; label: string }[] = [
  { key: 'FED',         label: 'Fed Funds' },
  { key: '1Y',          label: '1Y Treasury' },
  { key: '2Y',          label: '2Y Treasury' },
  { key: '5Y',          label: '5Y Treasury' },
  { key: '10Y',         label: '10Y Treasury' },
  { key: '20Y',         label: '20Y Treasury' },
  { key: '30Y',         label: '30Y Treasury' },
  { key: 'SPREAD',      label: '2/10 Spread' },
  { key: 'SPREAD_5_30', label: '5/30 Spread' },
]

const DEFAULT_YIELDS = ['FED', '1Y', '2Y', '5Y', '10Y', 'SPREAD']

const S = {
  bg:     '#0d1b30',
  border: '#2e394d',
  gold:   '#c9a84c',
  muted:  '#5e768f',
  text:   '#d7e3fc',
  mono:   'JetBrains Mono, monospace',
  label:  'IBM Plex Sans, sans-serif',
}

function YieldCheckboxes({
  selected,
  onChange,
  onSave,
}: {
  selected: string[]
  onChange: (next: string[]) => void
  onSave: () => void
}) {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: S.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: S.muted }}>
        Select yields to display
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '5px 10px' }}>
        {YIELD_OPTIONS.map(({ key, label }) => {
          const checked = selected.includes(key)
          return (
            <label
              key={key}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                cursor: 'pointer', userSelect: 'none',
              }}
            >
              {/* Custom checkbox */}
              <div
                onClick={() => toggle(key)}
                style={{
                  width: 12, height: 12, flexShrink: 0,
                  border: `1px solid ${checked ? S.gold : S.border}`,
                  background: checked ? 'rgba(201,168,76,0.18)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.1s',
                }}
              >
                {checked && (
                  <div style={{ width: 6, height: 6, background: S.gold }} />
                )}
              </div>
              <span
                onClick={() => toggle(key)}
                style={{
                  fontFamily: S.mono, fontSize: 10,
                  color: checked ? S.text : S.muted,
                  transition: 'color 0.1s',
                }}
              >
                {label}
              </span>
            </label>
          )
        })}
      </div>
      <button
        onClick={onSave}
        style={{
          alignSelf: 'flex-end', background: S.gold, border: 'none',
          color: '#0a1628', fontSize: 9, fontWeight: 700,
          padding: '3px 12px', cursor: 'pointer',
          letterSpacing: '0.1em', fontFamily: S.label,
        }}
      >
        APPLY
      </button>
    </div>
  )
}

export default function WidgetFrame({ config, editMode, onRemove, onUpdate, children }: WidgetFrameProps) {
  const [configOpen, setConfigOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [tickerInput, setTickerInput] = useState(config.ticker || '')
  const [tagTickers, setTagTickers] = useState<string[]>(config.tickers ?? [])
  const [yieldSel, setYieldSel] = useState<string[]>(
    config.tickers && config.tickers.length > 0 ? config.tickers : DEFAULT_YIELDS
  )
  const [portTickers, setPortTickers] = useState<string[]>(config.tickers ?? [])
  const [portWeights, setPortWeights] = useState<Record<string, string>>(
    config.tickers && config.weights && config.weights.length === config.tickers.length
      ? Object.fromEntries(config.tickers.map((t, i) => [t, (config.weights![i] * 100).toFixed(1)]))
      : makeEqualWeights(config.tickers ?? [])
  )

  const handlePortTickersChange = (next: string[]) => {
    setPortTickers(next)
    setPortWeights(prev => {
      const updated: Record<string, string> = {}
      const newTickers = next.filter(t => !(t in prev))
      const eqW = next.length ? (100 / next.length).toFixed(1) : '0'
      next.forEach(t => { updated[t] = t in prev ? prev[t] : eqW })
      if (newTickers.length > 0) {
        const eq = makeEqualWeights(next)
        next.forEach(t => { updated[t] = eq[t] })
      }
      return updated
    })
  }

  const equalizeWeights = () => setPortWeights(makeEqualWeights(portTickers))

  const saveConfig = () => {
    const patch: Partial<WidgetConfig> = {}
    if (TICKER_WIDGETS.includes(config.type))
      patch.ticker = tickerInput.trim().toUpperCase()
    if (TICKERS_WIDGETS.includes(config.type))
      patch.tickers = tagTickers
    if (YIELD_WIDGETS.includes(config.type))
      patch.tickers = yieldSel
    if (PORTFOLIO_WIDGETS.includes(config.type)) {
      patch.tickers = portTickers
      const rawW = portTickers.map(t => parseFloat(portWeights[t] ?? '0') || 0)
      const sum = rawW.reduce((a, b) => a + b, 0)
      patch.weights = sum > 0 ? rawW.map(w => w / sum) : portTickers.map(() => 1 / portTickers.length)
    }
    onUpdate(patch)
    setConfigOpen(false)
  }

  const hasSettings =
    TICKER_WIDGETS.includes(config.type) ||
    TICKERS_WIDGETS.includes(config.type) ||
    PORTFOLIO_WIDGETS.includes(config.type) ||
    YIELD_WIDGETS.includes(config.type)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false) }}
      style={{
        position: 'relative', height: '100%', display: 'flex', flexDirection: 'column',
        background: '#101c2e',
        border: editMode ? '1px solid rgba(201,168,76,0.55)' : '1px solid #2e394d',
        boxShadow: editMode ? '0 0 0 1px rgba(201,168,76,0.08) inset' : 'none',
        transition: 'border-color 0.15s', overflow: 'hidden',
        cursor: editMode ? 'grab' : 'default',
      }}>
      {/* Edit-mode drag bar */}
      {editMode && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(201,168,76,0.12)', borderBottom: '1px solid rgba(201,168,76,0.25)',
          padding: '4px 8px', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <GripHorizontal size={13} style={{ color: 'rgba(201,168,76,0.7)', flexShrink: 0 }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(201,168,76,0.7)', fontFamily: 'IBM Plex Sans, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {config.ticker || config.type}
            </span>
          </div>
          <div className="widget-no-drag" style={{ display: 'flex', gap: 4 }}>
            {hasSettings && (
              <button onClick={() => setConfigOpen(o => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(201,168,76,0.6)', padding: 2, display: 'flex' }}>
                <Settings size={12} />
              </button>
            )}
            <button onClick={onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444', padding: 2, display: 'flex', opacity: 0.7 }}>
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Hover gear — visible in view mode only, fades in on hover */}
      {!editMode && hasSettings && (
        <button
          onClick={() => setConfigOpen(o => !o)}
          style={{
            position: 'absolute', top: 6, right: 6, zIndex: 10,
            background: configOpen ? 'rgba(201,168,76,0.18)' : 'rgba(13,24,38,0.85)',
            border: `1px solid ${configOpen ? 'rgba(201,168,76,0.5)' : 'rgba(46,57,77,0.8)'}`,
            borderRadius: 3, padding: '3px 4px',
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            opacity: hovered || configOpen ? 1 : 0,
            transition: 'opacity 0.15s, background 0.15s',
            pointerEvents: hovered || configOpen ? 'auto' : 'none',
          }}
        >
          <Settings size={11} style={{ color: configOpen ? '#c9a84c' : '#5e768f' }} />
        </button>
      )}

      {/* Config panel */}
      {configOpen && (
        <div className="widget-no-drag" style={{ background: '#0d1b30', borderBottom: '1px solid #2e394d', padding: 10, flexShrink: 0 }}>

          {TICKER_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: S.muted, fontFamily: S.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Ticker</span>
              <input
                value={tickerInput}
                onChange={e => setTickerInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && saveConfig()}
                style={{ flex: 1, background: '#101c2e', border: '1px solid #4d4637', color: S.text, fontFamily: S.mono, fontSize: 12, padding: '3px 6px', outline: 'none' }}
              />
              <button onClick={saveConfig} style={{ background: S.gold, border: 'none', color: '#0a1628', fontSize: 9, fontWeight: 700, padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>SAVE</button>
            </div>
          )}

          {TICKERS_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 9, color: S.muted, fontFamily: S.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Tickers</span>
              <TickerTagInput tickers={tagTickers} onChange={setTagTickers} />
              <button onClick={saveConfig} style={{ alignSelf: 'flex-end', background: S.gold, border: 'none', color: '#0a1628', fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
            </div>
          )}

          {PORTFOLIO_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 9, color: S.muted, fontFamily: S.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Tickers &amp; Weights</span>
              <TickerTagInput tickers={portTickers} onChange={handlePortTickersChange} />
              {portTickers.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 150, overflowY: 'auto' }}>
                  {portTickers.map(t => (
                    <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: S.mono, fontSize: 10, color: S.gold, minWidth: 52 }}>{t}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={portWeights[t] ?? ''}
                        onChange={e => setPortWeights(prev => ({ ...prev, [t]: e.target.value }))}
                        style={{ width: 60, background: '#101c2e', border: '1px solid #4d4637', color: S.text, fontFamily: S.mono, fontSize: 11, padding: '2px 5px', outline: 'none', textAlign: 'right' }}
                      />
                      <span style={{ fontFamily: S.label, fontSize: 9, color: S.muted }}>%</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={equalizeWeights} style={{ background: 'transparent', border: `1px solid ${S.border}`, color: S.muted, fontSize: 9, fontWeight: 700, padding: '2px 8px', cursor: 'pointer', fontFamily: S.label, letterSpacing: '0.08em' }}>EQUAL</button>
                <button onClick={saveConfig} style={{ background: S.gold, border: 'none', color: '#0a1628', fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
              </div>
            </div>
          )}

          {YIELD_WIDGETS.includes(config.type) && (
            <YieldCheckboxes
              selected={yieldSel}
              onChange={setYieldSel}
              onSave={saveConfig}
            />
          )}

        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, pointerEvents: editMode ? 'none' : 'auto' }}>
        {children}
      </div>
    </div>
  )
}
