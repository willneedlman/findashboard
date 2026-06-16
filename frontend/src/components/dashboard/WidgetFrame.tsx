import { X, GripHorizontal, Settings } from 'lucide-react'
import { useState } from 'react'
import type { WidgetConfig, WidgetType } from '../../hooks/useDashboard'
import TickerTagInput from '../TickerTagInput'
import ExpirySelect from '../ExpirySelect'

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

const TICKER_WIDGETS: WidgetType[]        = ['price-card', 'mini-chart', 'options-snapshot', 'options-pricer', 'delta-target', 'tradingview-chart', 'dealer-gex', 'vol-skew']
const TICKERS_WIDGETS: WidgetType[]       = ['watchlist', 'earnings-calendar', 'news-feed', 'correlation-matrix']
const PORTFOLIO_WIDGETS: WidgetType[]     = ['portfolio-summary']
const YIELD_WIDGETS: WidgetType[]         = ['macro-strip']
const GLOBAL_MACRO_WIDGETS: WidgetType[]    = ['global-macro']
const CREDIT_SPREADS_WIDGETS: WidgetType[]  = ['credit-spreads']
const MACRO_CALENDAR_WIDGETS: WidgetType[]  = ['macro-calendar']
const EXPIRY_WIDGETS: WidgetType[]          = ['dealer-gex', 'vol-skew']
// Frame supplies the title (no gear) for widgets that host their own inline
// controls in the body, à la Price Card's period row.
const HEADER_WIDGETS: WidgetType[]          = ['sector-rotation', 'sentiment-gauge', 'screener', 'pm-portfolios', 'paper-trade']

const MACRO_CAT_OPTIONS: { key: string; label: string; color: string }[] = [
  { key: 'equity',    label: 'Equity', color: '#22c55e' },
  { key: 'fx',        label: 'FX',     color: '#60a5fa' },
  { key: 'bond',      label: 'Rates',  color: '#a78bfa' },
  { key: 'commodity', label: 'Cmdty',  color: '#f97316' },
  { key: 'vol',       label: 'Vol',    color: '#ef4444' },
]
const DEFAULT_MACRO_CATS = ['equity', 'fx', 'bond', 'commodity', 'vol']

const MACRO_CAL_CAT_OPTIONS: { key: string; label: string; color: string }[] = [
  { key: 'monetary',   label: 'Fed / Monetary', color: 'var(--theme-primary, #c9a84c)' },
  { key: 'inflation',  label: 'Inflation',      color: '#ef4444' },
  { key: 'employment', label: 'Employment',     color: '#22c55e' },
  { key: 'growth',     label: 'Growth / GDP',   color: '#60a5fa' },
  { key: 'housing',    label: 'Housing',        color: '#f97316' },
  { key: 'sentiment',  label: 'Sentiment',      color: '#a78bfa' },
]
const DEFAULT_MACRO_CAL_CATS = ['monetary', 'inflation', 'employment', 'growth', 'housing', 'sentiment']

const SPREAD_SERIES_OPTIONS: { key: string; label: string; color: string }[] = [
  { key: 'ig',     label: 'IG OAS',   color: '#60a5fa' },
  { key: 'hy',     label: 'HY OAS',   color: '#ef4444' },
  { key: 'ig_3_5', label: 'IG 3–5Y',  color: '#818cf8' },
  { key: 'hy_b',   label: 'HY B',     color: '#f97316' },
  { key: 'hy_ccc', label: 'HY CCC',   color: '#fb7185' },
  { key: 'vix',    label: 'VIX',      color: 'var(--theme-primary)' },
]
const DEFAULT_SPREAD_SERIES = ['ig', 'hy', 'vix']

const LOOKBACK_OPTIONS = [
  { val: 30,  label: '30D'  },
  { val: 90,  label: '90D'  },
  { val: 180, label: '180D' },
  { val: 365, label: '1Y'   },
]

const YIELD_OPTIONS: { key: string; label: string }[] = [
  { key: 'FED',         label: 'Fed Funds'  },
  { key: '1M',          label: '1M Bill'    },
  { key: '3M',          label: '3M Bill'    },
  { key: '6M',          label: '6M Bill'    },
  { key: '1Y',          label: '1Y Note'    },
  { key: '2Y',          label: '2Y Note'    },
  { key: '3Y',          label: '3Y Note'    },
  { key: '5Y',          label: '5Y Note'    },
  { key: '7Y',          label: '7Y Note'    },
  { key: '10Y',         label: '10Y Note'   },
  { key: '20Y',         label: '20Y Bond'   },
  { key: '30Y',         label: '30Y Bond'   },
  { key: 'SPREAD',      label: '2/10 Spread'},
  { key: 'SPREAD_5_30', label: '5/30 Spread'},
]

const DEFAULT_YIELDS = ['FED', '1Y', '2Y', '5Y', '10Y', 'SPREAD']

const WIDGET_LABELS: Record<string, string> = {
  'price-card':         'Price Card',
  'mini-chart':         'Mini Chart',
  'tradingview-chart':  'Chart',
  'options-snapshot':   'Options Snapshot',
  'options-pricer':     'Options Pricer',
  'delta-target':       'Delta Target',
  'watchlist':          'Watchlist',
  'earnings-calendar':  'Earnings Calendar',
  'news-feed':          'News Feed',
  'correlation-matrix': 'Correlation Matrix',
  'portfolio-summary':  'Portfolio',
  'macro-strip':        'Macro Strip',
  'global-macro':       'Global Macro',
  'credit-spreads':     'Credit Spreads',
  'macro-calendar':     'Macro Calendar',
  'yield-curve':        'Yield Curve',
  'sector-rotation':    'Sector Rotation',
  'dealer-gex':         'Dealer GEX',
  'vol-skew':           'Vol Skew',
  'sentiment-gauge':    'Market Sentiment',
  'screener':           'Screener',
  'pm-portfolios':      'Portfolios',
  'paper-trade':        'Paper Trade',
}

function widgetTitle(config: WidgetConfig): string {
  const label = WIDGET_LABELS[config.type] ?? config.type
  if (config.ticker && TICKER_WIDGETS.includes(config.type as WidgetType)) {
    return `${config.ticker} · ${label}`
  }
  return label
}

const S = {
  bg:     'var(--theme-surface, #0d1b30)',
  border: 'rgba(255,255,255,0.08)',
  gold:   'var(--theme-primary, #c9a84c)',
  muted:  'var(--theme-secondary, #5e768f)',
  text:   'var(--theme-text, #d7e3fc)',
  mono:   'var(--theme-mono)',
  label:  'var(--theme-sans)',
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
              <div
                onClick={() => toggle(key)}
                style={{
                  width: 12, height: 12, flexShrink: 0,
                  border: `1px solid ${checked ? S.gold : S.border}`,
                  background: checked ? 'color-mix(in srgb, var(--theme-primary) 35%, transparent)' : 'transparent',
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
                  color: checked ? S.gold : S.muted,
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
          color: 'var(--theme-bg)', fontSize: 9, fontWeight: 700,
          padding: '3px 12px', cursor: 'pointer',
          letterSpacing: '0.1em', fontFamily: S.label,
        }}
      >
        APPLY
      </button>
    </div>
  )
}

function ColorCheckboxes({
  options,
  selected,
  onChange,
}: {
  options: { key: string; label: string; color: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key])
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 12px' }}>
      {options.map(({ key, label, color }) => {
        const checked = selected.includes(key)
        return (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <div onClick={() => toggle(key)} style={{
              width: 12, height: 12, flexShrink: 0,
              border: `1px solid ${checked ? color : S.border}`,
              background: checked ? `color-mix(in srgb, ${color} 35%, transparent)` : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.1s',
            }}>
              {checked && <div style={{ width: 6, height: 6, background: color }} />}
            </div>
            <span onClick={() => toggle(key)} style={{ fontFamily: S.mono, fontSize: 10, color: checked ? color : S.muted, transition: 'color 0.1s' }}>
              {label}
            </span>
          </label>
        )
      })}
    </div>
  )
}

function MacroCatSettings({
  selected,
  onChange,
  onSave,
}: { selected: string[]; onChange: (v: string[]) => void; onSave: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: S.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: S.muted }}>Categories to display</span>
      <ColorCheckboxes options={MACRO_CAT_OPTIONS} selected={selected} onChange={onChange} />
      <button onClick={onSave} style={{ alignSelf: 'flex-end', background: S.gold, border: 'none', color: 'var(--theme-bg)', fontSize: 9, fontWeight: 700, padding: '3px 12px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
    </div>
  )
}

function CreditSpreadsSettings({
  series,
  onSeriesChange,
  lookback,
  onLookbackChange,
  onSave,
}: { series: string[]; onSeriesChange: (v: string[]) => void; lookback: number; onLookbackChange: (v: number) => void; onSave: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: S.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: S.muted }}>Series</span>
      <ColorCheckboxes options={SPREAD_SERIES_OPTIONS} selected={series} onChange={onSeriesChange} />
      <span style={{ fontFamily: S.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: S.muted, marginTop: 2 }}>Chart lookback</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {LOOKBACK_OPTIONS.map(({ val, label }) => (
          <button key={val} onClick={() => onLookbackChange(val)} style={{
            fontFamily: S.mono, fontSize: 9, fontWeight: 700, padding: '2px 8px',
            border: lookback === val ? `1px solid ${S.gold}` : `1px solid ${S.border}`,
            background: lookback === val ? `color-mix(in srgb, var(--theme-primary) 30%, transparent)` : 'transparent',
            color: lookback === val ? 'var(--theme-bg, #0a1628)' : S.muted,
            cursor: 'pointer', letterSpacing: '0.08em', transition: 'all 0.1s',
          }}>{label}</button>
        ))}
      </div>
      <button onClick={onSave} style={{ alignSelf: 'flex-end', background: S.gold, border: 'none', color: 'var(--theme-bg)', fontSize: 9, fontWeight: 700, padding: '3px 12px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
    </div>
  )
}

export default function WidgetFrame({ config, editMode, onRemove, onUpdate, children }: WidgetFrameProps) {
  const [configOpen, setConfigOpen] = useState(false)
  const [tickerInput, setTickerInput] = useState(config.ticker || '')
  const [tagTickers, setTagTickers] = useState<string[]>(config.tickers ?? [])
  const [yieldSel, setYieldSel] = useState<string[]>(
    config.tickers && config.tickers.length > 0 ? config.tickers : DEFAULT_YIELDS
  )
  const [macroCatSel, setMacroCatSel]         = useState<string[]>(config.categories ?? DEFAULT_MACRO_CATS)
  const [macroCalCatSel, setMacroCalCatSel]   = useState<string[]>(config.categories ?? DEFAULT_MACRO_CAL_CATS)
  const [spreadSerSel, setSpreadSerSel]       = useState<string[]>(config.categories ?? DEFAULT_SPREAD_SERIES)
  const [spreadLookback, setSpreadLookback] = useState<number>(config.lookback ?? 90)
  const [portTickers, setPortTickers] = useState<string[]>(config.tickers ?? [])
  const [portWeights, setPortWeights] = useState<Record<string, string>>(
    config.tickers && config.weights && config.weights.length === config.tickers.length
      ? Object.fromEntries(config.tickers.map((t, i) => [t, (config.weights![i] * 100).toFixed(1)]))
      : makeEqualWeights(config.tickers ?? [])
  )

  const [expirySel, setExpirySel] = useState(config.expiry || '')

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
    if (GLOBAL_MACRO_WIDGETS.includes(config.type))
      patch.categories = macroCatSel
    if (MACRO_CALENDAR_WIDGETS.includes(config.type))
      patch.categories = macroCalCatSel
    if (CREDIT_SPREADS_WIDGETS.includes(config.type)) {
      patch.categories = spreadSerSel
      patch.lookback   = spreadLookback
    }
    if (EXPIRY_WIDGETS.includes(config.type))
      patch.expiry = expirySel
    onUpdate(patch)
    setConfigOpen(false)
  }

  // These widgets self-configure via their inline ticker input — show header title but no gear
  const SELF_CONFIGURED: WidgetType[] = ['options-pricer', 'delta-target']

  const hasSettings =
    (TICKER_WIDGETS.includes(config.type) && !SELF_CONFIGURED.includes(config.type as WidgetType)) ||
    TICKERS_WIDGETS.includes(config.type) ||
    PORTFOLIO_WIDGETS.includes(config.type) ||
    YIELD_WIDGETS.includes(config.type) ||
    GLOBAL_MACRO_WIDGETS.includes(config.type) ||
    CREDIT_SPREADS_WIDGETS.includes(config.type) ||
    MACRO_CALENDAR_WIDGETS.includes(config.type)

  const hasHeader = hasSettings || SELF_CONFIGURED.includes(config.type as WidgetType) || HEADER_WIDGETS.includes(config.type)

  return (
    <div
      style={{
        position: 'relative', height: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--theme-bg, #101c2e)',
        border: editMode ? '1px solid rgba(201,168,76,0.55)' : '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        boxShadow: editMode ? '0 0 0 1px rgba(201,168,76,0.08) inset' : 'none',
        transition: 'border-color 0.15s', overflow: 'hidden',
        cursor: editMode ? 'grab' : 'default',
      }}>
      {/* Header bar */}
      {(hasHeader || editMode) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: editMode ? 'rgba(201,168,76,0.12)' : 'var(--theme-surface, #0d1826)',
          borderBottom: editMode ? '1px solid rgba(201,168,76,0.25)' : '1px solid var(--theme-border, rgba(255,255,255,0.08))',
          padding: '4px 8px', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            {editMode && <GripHorizontal size={13} style={{ color: 'rgba(201,168,76,0.7)', flexShrink: 0 }} />}
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: editMode ? 'rgba(201,168,76,0.7)' : 'var(--theme-text, #d7e3fc)',
              fontFamily: S.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {widgetTitle(config)}
            </span>
          </div>
          <div className="widget-no-drag" style={{ display: 'flex', gap: 4 }}>
            {hasSettings && (
              <button
                onClick={() => setConfigOpen(o => !o)}
                style={{
                  background: configOpen ? 'var(--theme-primary, #c9a84c)' : 'transparent',
                  border: configOpen ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid transparent',
                  borderRadius: 3, padding: '3px 4px',
                  cursor: 'pointer', color: configOpen ? 'var(--theme-bg, #0a1628)' : 'var(--theme-secondary, #5e768f)',
                  display: 'flex', alignItems: 'center',
                  transition: 'all 0.15s',
                }}
              >
                <Settings size={11} />
              </button>
            )}
            {editMode && (
              <button onClick={onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-negative)', padding: 2, display: 'flex', opacity: 0.7 }}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Config panel */}
      {configOpen && (
        <div className="widget-no-drag" style={{ position: 'absolute', top: 26, left: 0, right: 0, bottom: 0, zIndex: 20, background: 'var(--theme-surface, #0d1b30)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: 10, overflowY: 'auto' }}>

          {TICKER_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: S.muted, fontFamily: S.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Ticker</span>
              <input
                value={tickerInput}
                onChange={e => setTickerInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && saveConfig()}
                style={{ flex: 1, background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.10)', color: S.text, fontFamily: S.mono, fontSize: 12, padding: '3px 6px', outline: 'none' }}
              />
              <button onClick={saveConfig} style={{ background: S.gold, border: 'none', color: 'var(--theme-bg, #0a1628)', fontSize: 9, fontWeight: 700, padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>SAVE</button>
            </div>
          )}

          {EXPIRY_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 9, color: S.muted, fontFamily: S.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Expiry</span>
              <ExpirySelect
                ticker={config.ticker || ''}
                value={expirySel}
                autoSelect={false}
                onChange={e => { setExpirySel(e); onUpdate({ expiry: e }) }}
                style={{ flex: 1, background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.10)', color: S.text, fontFamily: S.mono, fontSize: 12, padding: '3px 6px', outline: 'none' }}
              />
            </div>
          )}

          {TICKERS_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 9, color: S.muted, fontFamily: S.label, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Tickers</span>
              <TickerTagInput tickers={tagTickers} onChange={setTagTickers} />
              <button onClick={saveConfig} style={{ alignSelf: 'flex-end', background: S.gold, border: 'none', color: 'var(--theme-bg, #0a1628)', fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
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
                        style={{ width: 60, background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.10)', color: S.text, fontFamily: S.mono, fontSize: 11, padding: '2px 5px', outline: 'none', textAlign: 'right' }}
                      />
                      <span style={{ fontFamily: S.label, fontSize: 9, color: S.muted }}>%</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={equalizeWeights} style={{ background: 'transparent', border: `1px solid ${S.border}`, color: S.muted, fontSize: 9, fontWeight: 700, padding: '2px 8px', cursor: 'pointer', fontFamily: S.label, letterSpacing: '0.08em' }}>EQUAL</button>
                <button onClick={saveConfig} style={{ background: S.gold, border: 'none', color: 'var(--theme-bg, #0a1628)', fontSize: 9, fontWeight: 700, padding: '3px 10px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
              </div>
            </div>
          )}

          {YIELD_WIDGETS.includes(config.type) && (
            <YieldCheckboxes selected={yieldSel} onChange={setYieldSel} onSave={saveConfig} />
          )}

          {GLOBAL_MACRO_WIDGETS.includes(config.type) && (
            <MacroCatSettings selected={macroCatSel} onChange={setMacroCatSel} onSave={saveConfig} />
          )}

          {CREDIT_SPREADS_WIDGETS.includes(config.type) && (
            <CreditSpreadsSettings
              series={spreadSerSel}
              onSeriesChange={setSpreadSerSel}
              lookback={spreadLookback}
              onLookbackChange={setSpreadLookback}
              onSave={saveConfig}
            />
          )}

          {MACRO_CALENDAR_WIDGETS.includes(config.type) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontFamily: S.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: S.muted }}>Event categories</span>
              <ColorCheckboxes options={MACRO_CAL_CAT_OPTIONS} selected={macroCalCatSel} onChange={setMacroCalCatSel} />
              <button onClick={saveConfig} style={{ alignSelf: 'flex-end', background: S.gold, border: 'none', color: 'var(--theme-bg)', fontSize: 9, fontWeight: 700, padding: '3px 12px', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: S.label }}>APPLY</button>
            </div>
          )}

        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, pointerEvents: editMode ? 'none' : 'auto' }}>
        {children}
      </div>
    </div>
  )
}