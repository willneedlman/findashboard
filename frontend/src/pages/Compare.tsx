import { useState, useMemo } from 'react'
import axios from 'axios'
import { useQuery, useQueries } from '@tanstack/react-query'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import useIsMobile from '../hooks/useIsMobile'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive)',
  neg:     'var(--theme-negative)',
}

const SERIES_COLORS  = ['#c9a84c', '#60a5fa', '#34d399', '#f97316', '#a78bfa', '#38bdf8', '#fb7185', '#fbbf24']
const OVERLAY_COLORS = ['#94a3b8', '#5eead4', '#fca5a5', '#c4b5fd']
const RATIO_COLORS   = ['#e879f9', '#22d3ee', '#facc15', '#a3e635']

const PERIODS = ['1m', '3m', '6m', 'ytd', '1y', '5y'] as const
type Period = typeof PERIODS[number]
type Norm = 'indexed' | 'pct' | 'price'
const NORMS: { key: Norm; label: string }[] = [
  { key: 'indexed', label: 'Indexed 100' }, { key: 'pct', label: '% Change' }, { key: 'price', label: 'Price' },
]

const ASSET_PRESETS = ['SPY', 'QQQ', 'BTC-USD', 'ETH-USD', 'GLD', 'TLT', '^GSPC', 'EURUSD=X']
const MACRO_GROUPS: { group: string; items: { sym: string; label: string }[] }[] = [
  { group: 'Rates', items: [{ sym: '^TNX', label: '10Y Yield' }, { sym: '^FVX', label: '5Y Yield' }, { sym: '^TYX', label: '30Y Yield' }, { sym: '^IRX', label: '13W T-Bill' }] },
  { group: 'Volatility', items: [{ sym: '^VIX', label: 'VIX' }, { sym: '^VXN', label: 'Nasdaq VIX' }, { sym: '^OVX', label: 'Oil VIX' }, { sym: '^VVIX', label: 'Vol-of-Vol' }] },
  { group: 'Commodities', items: [{ sym: 'GC=F', label: 'Gold' }, { sym: 'SI=F', label: 'Silver' }, { sym: 'HG=F', label: 'Copper' }, { sym: 'CL=F', label: 'Crude (WTI)' }, { sym: 'BZ=F', label: 'Brent' }, { sym: 'NG=F', label: 'Nat Gas' }, { sym: 'PL=F', label: 'Platinum' }] },
  { group: 'FX & Dollar', items: [{ sym: 'DX-Y.NYB', label: 'US Dollar' }, { sym: 'EURUSD=X', label: 'EUR/USD' }, { sym: 'USDJPY=X', label: 'USD/JPY' }, { sym: 'GBPUSD=X', label: 'GBP/USD' }] },
  { group: 'Indices', items: [{ sym: '^GSPC', label: 'S&P 500' }, { sym: '^IXIC', label: 'Nasdaq' }, { sym: '^DJI', label: 'Dow' }, { sym: '^RUT', label: 'Russell 2000' }] },
]
// Standardized, size-neutral metrics only (no absolute $ or EPS — not fairly comparable)
const METRIC_GROUPS: { group: string; items: { key: string; label: string; short: string; unit: 'x' | '%' }[] }[] = [
  { group: 'Valuation', items: [
    { key: 'pe', label: 'P/E', short: 'P/E', unit: 'x' }, { key: 'ps', label: 'P/S', short: 'P/S', unit: 'x' }, { key: 'pb', label: 'P/B', short: 'P/B', unit: 'x' },
    { key: 'ev_ebitda', label: 'EV/EBITDA', short: 'EV/EBITDA', unit: 'x' }, { key: 'ev_sales', label: 'EV/Sales', short: 'EV/Sales', unit: 'x' }, { key: 'p_fcf', label: 'P/FCF', short: 'P/FCF', unit: 'x' },
  ]},
  { group: 'Profitability', items: [
    { key: 'gross_margin', label: 'Gross Margin', short: 'GM', unit: '%' }, { key: 'operating_margin', label: 'Operating Margin', short: 'OM', unit: '%' }, { key: 'net_margin', label: 'Net Margin', short: 'NM', unit: '%' },
    { key: 'roe', label: 'ROE', short: 'ROE', unit: '%' }, { key: 'roa', label: 'ROA', short: 'ROA', unit: '%' }, { key: 'roic', label: 'ROIC', short: 'ROIC', unit: '%' },
  ]},
  { group: 'Leverage & Yield', items: [
    { key: 'debt_equity', label: 'Debt / Equity', short: 'D/E', unit: 'x' }, { key: 'current_ratio', label: 'Current Ratio', short: 'CR', unit: 'x' },
    { key: 'dividend_yield', label: 'Dividend Yield', short: 'Div', unit: '%' }, { key: 'fcf_yield', label: 'FCF Yield', short: 'FCF', unit: '%' },
  ]},
]
const METRIC_SHORT: Record<string, string> = {}
const METRIC_UNIT: Record<string, 'x' | '%'> = {}
METRIC_GROUPS.forEach(g => g.items.forEach(m => { METRIC_SHORT[m.key] = m.short; METRIC_UNIT[m.key] = m.unit }))

interface CompareResp {
  period: string; normalize: string; tickers: string[]; overlays: string[]
  series: Record<string, number | string | null>[]
  meta: Record<string, { start: number; last: number; change_pct: number | null }>
}
interface RatioSeries { ticker: string; metric: string; unit: string; points: { date: string; value: number }[] }
interface Ratio { ticker: string; metric: string }

function sma(v: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = []; const q: number[] = []; let s = 0
  for (const x of v) { if (x == null) { out.push(null); continue } q.push(x); s += x; if (q.length > n) s -= q.shift()!; out.push(q.length === n ? +(s / n).toFixed(4) : null) }
  return out
}
function ema(v: (number | null)[], n: number): (number | null)[] {
  const k = 2 / (n + 1); let p: number | null = null
  return v.map(x => { if (x == null) return null; p = p == null ? x : x * k + p * (1 - k); return +p.toFixed(4) })
}
function bollinger(v: (number | null)[], n = 20, m = 2) {
  const mid = sma(v, n); const up: (number | null)[] = []; const lo: (number | null)[] = []; const q: number[] = []
  for (let i = 0; i < v.length; i++) {
    const x = v[i]; if (x != null) { q.push(x); if (q.length > n) q.shift() }
    if (mid[i] == null || q.length < n) { up.push(null); lo.push(null); continue }
    const mean = mid[i] as number; const sd = Math.sqrt(q.reduce((a, c) => a + (c - mean) ** 2, 0) / n)
    up.push(+(mean + m * sd).toFixed(4)); lo.push(+(mean - m * sd).toFixed(4))
  }
  return { up, lo }
}
// step-align a sparse (quarterly/annual) series onto the chart's dates — raw values
function alignStep(points: { date: string; value: number }[], dates: string[]): (number | null)[] {
  const pts = [...points].sort((a, b) => a.date.localeCompare(b.date))
  const out: (number | null)[] = []; let i = 0; let cur: number | null = null
  for (const d of dates) { while (i < pts.length && pts[i].date <= d) { cur = pts[i].value; i++ } out.push(cur) }
  return out
}

function Section({ title, badge, open, onToggle, children }: { title: string; badge?: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: `1px solid ${T.border}` }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 12px',
        background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.label, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: open ? T.gold : T.muted, outline: 'none',
      }}>
        <span>{title}{badge ? <span style={{ color: T.muted, fontWeight: 400 }}> · {badge}</span> : ''}</span>
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', color: T.muted }}>›</span>
      </button>
      {open && <div style={{ padding: '2px 12px 14px' }}>{children}</div>}
    </div>
  )
}

function Swatch({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return <input type="color" value={value} title="Line color" onClick={e => e.stopPropagation()}
    onChange={e => onChange(e.target.value)}
    style={{ width: 13, height: 13, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }} />
}

const ctrlBtn = (active: boolean): React.CSSProperties => ({
  fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  padding: '5px 11px', cursor: 'pointer',
  background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
  border: `1px solid ${active ? T.gold : T.border}`, color: active ? T.gold : T.muted,
})
const selStyle: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 11, padding: '6px 8px', outline: 'none' }

function CompareTooltip({ active, payload, label, norm, overlaySet, ratioUnits }: any) {
  if (!active || !payload?.length) return null
  const fmt = (key: string, v: number) => {
    if (ratioUnits[key]) return ratioUnits[key] === '%' ? `${v.toFixed(1)}%` : `${v.toFixed(2)}x`
    if (overlaySet.has(key)) return v.toFixed(2)
    return norm === 'pct' ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : v.toFixed(norm === 'price' ? 2 : 1)
  }
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '8px 10px', fontFamily: T.mono, fontSize: 11 }}>
      <div style={{ color: T.muted, marginBottom: 5 }}>{label}</div>
      {payload.filter((p: any) => p.value != null).map((p: any) => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: p.color }}>
          <span style={{ fontWeight: 700 }}>{p.dataKey}</span><span>{fmt(p.dataKey, p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export function CompareContent() {
  const isMobile = useIsMobile()
  const [assets, setAssets]     = useState<string[]>(['SPY', 'QQQ', 'BTC-USD'])
  const [overlays, setOverlays] = useState<string[]>([])
  const [ratios, setRatios]     = useState<Ratio[]>([])
  const [colors, setColors]     = useState<Record<string, string>>({})
  const [period, setPeriod]     = useState<Period>('1y')
  const [norm, setNorm]         = useState<Norm>('indexed')
  const [hidden, setHidden]     = useState<Set<string>>(new Set())
  const [focus, setFocus]       = useState('SPY')
  const [tech, setTech]         = useState({ sma50: false, sma200: false, ema20: false, bb: false })
  const [open, setOpen]         = useState({ assets: true, technicals: false, ratios: false, macro: false })
  const [aDraft, setADraft]     = useState('')
  const [rTicker, setRTicker]   = useState('')
  const [rMetric, setRMetric]   = useState('pe')

  // generic colour resolver — override map keyed by series key, else palette default
  const assetDef  = (t: string) => SERIES_COLORS[Math.max(0, assets.indexOf(t)) % SERIES_COLORS.length]
  const ovDef     = (s: string) => OVERLAY_COLORS[Math.max(0, overlays.indexOf(s)) % OVERLAY_COLORS.length]
  const ratioKey  = (r: Ratio) => `${r.ticker}·${METRIC_SHORT[r.metric] || r.metric}`
  const ratioDef  = (r: Ratio) => RATIO_COLORS[Math.max(0, ratios.findIndex(x => x.ticker === r.ticker && x.metric === r.metric)) % RATIO_COLORS.length]
  const colorOf   = (key: string, def: string) => colors[key] ?? def
  const setColor  = (key: string, c: string) => setColors(prev => ({ ...prev, [key]: c }))

  const { data, isFetching, isError } = useQuery<CompareResp>({
    queryKey: ['compare', assets, overlays, period, norm],
    queryFn: () => axios.get(`/api/market/compare?tickers=${encodeURIComponent(assets.join(','))}&overlays=${encodeURIComponent(overlays.join(','))}&period=${period}&normalize=${norm}`).then(r => r.data),
    enabled: assets.length > 0, staleTime: 300_000, retry: 1,
  })

  const ratioResults = useQueries({
    queries: ratios.map(r => ({
      queryKey: ['ratio', r.ticker, r.metric],
      queryFn: () => axios.get(`/api/market/fundamental-series?ticker=${encodeURIComponent(r.ticker)}&metric=${r.metric}&period=quarter`).then(x => x.data as RatioSeries),
      staleTime: 3_600_000, retry: 1,
    })),
  })

  const addAsset = (raw?: string) => { const t = (raw ?? aDraft).trim().toUpperCase(); if (!t || assets.includes(t) || assets.length >= 8) return; setAssets([...assets, t]); setADraft('') }
  const removeAsset = (t: string) => { setAssets(assets.filter(x => x !== t)); if (focus === t) setFocus(assets.filter(x => x !== t)[0] ?? '') }
  const toggleOverlay = (s: string) => setOverlays(prev => prev.includes(s) ? prev.filter(x => x !== s) : prev.length >= 4 ? prev : [...prev, s])
  const addRatio = () => { const t = (rTicker || focus || assets[0] || '').trim().toUpperCase(); if (!t || ratios.some(r => r.ticker === t && r.metric === rMetric) || ratios.length >= 5) return; setRatios([...ratios, { ticker: t, metric: rMetric }]); setRTicker('') }
  const removeRatio = (r: Ratio) => setRatios(ratios.filter(x => !(x.ticker === r.ticker && x.metric === r.metric)))
  const toggleHidden = (t: string) => setHidden(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })
  const toggleSection = (k: keyof typeof open) => setOpen(p => ({ ...p, [k]: !p[k] }))

  const chartData = useMemo(() => {
    if (!data) return []
    const rows = data.series.map(p => ({ ...p })) as Record<string, number | string | null>[]
    const dates = rows.map(r => r.date as string)
    if (focus && data.tickers.includes(focus)) {
      const vals = rows.map(r => r[focus] as number | null)
      if (tech.sma50)  { const a = sma(vals, 50);  rows.forEach((r, i) => r[`${focus}·SMA50`]  = a[i]) }
      if (tech.sma200) { const a = sma(vals, 200); rows.forEach((r, i) => r[`${focus}·SMA200`] = a[i]) }
      if (tech.ema20)  { const a = ema(vals, 20);  rows.forEach((r, i) => r[`${focus}·EMA20`]  = a[i]) }
      if (tech.bb)     { const b = bollinger(vals, 20, 2); rows.forEach((r, i) => { r[`${focus}·BB↑`] = b.up[i]; r[`${focus}·BB↓`] = b.lo[i] }) }
    }
    ratios.forEach((r, idx) => {
      const res = ratioResults[idx]
      if (res?.data?.points?.length) {
        const aligned = alignStep(res.data.points, dates)
        const key = ratioKey(r)
        rows.forEach((row, i) => row[key] = aligned[i])
      }
    })
    return rows
  }, [data, focus, tech, ratios, ratioResults.map(r => r.dataUpdatedAt).join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const baseline = norm === 'pct' ? 0 : norm === 'indexed' ? 100 : null
  const techLines = (() => {
    const out: string[] = []
    if (!data?.tickers.includes(focus)) return out
    if (tech.sma50) out.push(`${focus}·SMA50`); if (tech.sma200) out.push(`${focus}·SMA200`)
    if (tech.ema20) out.push(`${focus}·EMA20`); if (tech.bb) out.push(`${focus}·BB↑`, `${focus}·BB↓`)
    return out
  })()
  const overlaySet = new Set(overlays)
  const ratioUnits: Record<string, string> = {}
  ratios.forEach(r => { ratioUnits[ratioKey(r)] = METRIC_UNIT[r.metric] })
  const hasRight = overlays.length > 0 || ratios.length > 0

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <PageHeader
        title="Asset Comparison"
        subtitle="Overlay assets, technicals, valuation multiples & ratios, and macro on one chart. Left axis: normalized assets + technicals. Right axis: raw multiples/ratios & macro."
      />

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row' }}>
        <aside style={{ width: isMobile ? '100%' : 268, flexShrink: 0, background: T.surface, border: `1px solid ${T.border}` }}>
          <Section title="Assets" badge={`${assets.length}`} open={open.assets} onToggle={() => toggleSection('assets')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {assets.map(t => {
                const off = hidden.has(t); const ch = data?.meta?.[t]?.change_pct; const c = colorOf(t, assetDef(t))
                return (
                  <span key={t} onClick={() => toggleHidden(t)} title="Show/hide on chart" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    padding: '4px 7px', border: `1px solid ${off ? T.border : c}`, color: off ? T.muted : T.text,
                    background: off ? 'transparent' : `color-mix(in srgb, ${c} 12%, transparent)`, opacity: off ? 0.55 : 1,
                  }}>
                    <Swatch value={c} onChange={v => setColor(t, v)} />{t}
                    {ch != null && <span style={{ color: ch >= 0 ? T.pos : T.neg, fontSize: 10 }}>{ch >= 0 ? '+' : ''}{ch.toFixed(1)}%</span>}
                    <span onClick={e => { e.stopPropagation(); removeAsset(t) }} style={{ color: T.muted, fontWeight: 400 }}>×</span>
                  </span>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input value={aDraft} onChange={e => setADraft(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') addAsset() }} placeholder="ADD SYMBOL" style={{ ...selStyle, flex: 1, minWidth: 0, fontWeight: 700 }} />
              <button onClick={() => addAsset()} style={ctrlBtn(false)}>+</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {ASSET_PRESETS.filter(p => !assets.includes(p)).map(p => <button key={p} onClick={() => addAsset(p)} style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`, padding: '2px 6px', cursor: 'pointer' }}>{p}</button>)}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.6, marginTop: 8 }}>Click any swatch to recolor a line.</div>
          </Section>

          <Section title="Technicals" badge={techLines.length ? 'on' : undefined} open={open.technicals} onToggle={() => toggleSection('technicals')}>
            <label style={{ display: 'block', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>Apply to</label>
            <select value={focus} onChange={e => setFocus(e.target.value)} style={{ ...selStyle, width: '100%', marginBottom: 12 }}>{assets.map(a => <option key={a} value={a}>{a}</option>)}</select>
            {([['sma50', 'SMA 50'], ['sma200', 'SMA 200'], ['ema20', 'EMA 20'], ['bb', 'Bollinger (20, 2σ)']] as const).map(([k, lbl]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontFamily: T.mono, fontSize: 12, color: T.text }}>
                <input type="checkbox" checked={tech[k]} onChange={e => setTech(p => ({ ...p, [k]: e.target.checked }))} />{lbl}
              </label>
            ))}
          </Section>

          <Section title="Multiples & Ratios · right axis" badge={ratios.length ? `${ratios.length}` : undefined} open={open.ratios} onToggle={() => toggleSection('ratios')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {ratios.map(r => { const c = colorOf(ratioKey(r), ratioDef(r)); return (
                <span key={ratioKey(r)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: T.mono, fontSize: 11, padding: '4px 7px', border: `1px solid ${c}55`, color: T.text }}>
                  <Swatch value={c} onChange={v => setColor(ratioKey(r), v)} />{r.ticker} {METRIC_SHORT[r.metric]}
                  <span onClick={() => removeRatio(r)} style={{ color: T.muted, cursor: 'pointer', marginLeft: 'auto' }}>×</span>
                </span>
              )})}
            </div>
            <input value={rTicker} onChange={e => setRTicker(e.target.value.toUpperCase())} placeholder={`TICKER (e.g. ${focus || 'AAPL'})`} style={{ ...selStyle, width: '100%', fontWeight: 700, marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={rMetric} onChange={e => setRMetric(e.target.value)} style={{ ...selStyle, flex: 1, minWidth: 0 }}>
                {METRIC_GROUPS.map(g => <optgroup key={g.group} label={g.group}>{g.items.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>)}
              </select>
              <button onClick={addRatio} style={ctrlBtn(false)}>+ Add</button>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.6, marginTop: 8, lineHeight: 1.5 }}>Size-neutral metrics, plotted at their real level on the right axis — overlay the same multiple across tickers to compare directly.</div>
          </Section>

          <Section title="Macro · right axis" badge={overlays.length ? `${overlays.length}` : undefined} open={open.macro} onToggle={() => toggleSection('macro')}>
            {MACRO_GROUPS.map(g => (
              <div key={g.group} style={{ marginBottom: 8 }}>
                <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, margin: '6px 0 3px' }}>{g.group}</div>
                {g.items.map(m => { const on = overlays.includes(m.sym); const c = colorOf(m.sym, ovDef(m.sym)); return (
                  <div key={m.sym} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: T.mono, fontSize: 11.5, color: on ? T.text : T.muted, flex: 1 }}>
                      <input type="checkbox" checked={on} onChange={() => toggleOverlay(m.sym)} />
                      {on ? <Swatch value={c} onChange={v => setColor(m.sym, v)} /> : <span style={{ width: 13, height: 13, borderRadius: 2, background: T.border, flexShrink: 0 }} />}
                      {m.label} <span style={{ color: T.muted, opacity: 0.6, fontSize: 9 }}>{m.sym}</span>
                    </label>
                  </div>
                )})}
              </div>
            ))}
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.65, marginTop: 4, lineHeight: 1.5 }}>Raw on the right axis — one scale family at a time reads best.</div>
          </Section>
        </aside>

        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            <div style={{ display: 'flex' }}>{NORMS.map(n => <button key={n.key} onClick={() => setNorm(n.key)} style={ctrlBtn(norm === n.key)}>{n.label}</button>)}</div>
            <div style={{ display: 'flex' }}>{PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} style={ctrlBtn(period === p)}>{p.toUpperCase()}</button>)}</div>
          </div>

          <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 12px 6px', position: 'relative', minHeight: 440 }}>
            {isError && <div style={{ fontFamily: T.mono, fontSize: 12, color: T.neg, padding: 40, textAlign: 'center' }}>Could not load data. Check the symbols and try again.</div>}
            {!isError && data && (
              <>
                {isFetching && <div style={{ position: 'absolute', top: 10, right: 14, fontFamily: T.mono, fontSize: 10, color: T.gold, zIndex: 2 }}>updating…</div>}
                <ResponsiveContainer width="100%" height={430}>
                  <LineChart data={chartData} margin={{ top: 6, right: hasRight ? 8 : 16, left: 4, bottom: 4 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fill: '#5e768f' }} minTickGap={50} stroke={T.border} />
                    <YAxis yAxisId="left" tick={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fill: '#5e768f' }} width={46} stroke={T.border} domain={['auto', 'auto']} tickFormatter={(v: number) => norm === 'pct' ? `${v}%` : `${v}`} />
                    {hasRight && <YAxis yAxisId="right" orientation="right" tick={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fill: '#94a3b8' }} width={46} stroke={T.border} domain={['auto', 'auto']} />}
                    {baseline != null && <ReferenceLine yAxisId="left" y={baseline} stroke={T.muted} strokeDasharray="3 3" />}
                    <Tooltip content={<CompareTooltip norm={norm} overlaySet={overlaySet} ratioUnits={ratioUnits} />} />
                    {assets.filter(t => !hidden.has(t) && data.tickers.includes(t)).map(t => (
                      <Line key={t} yAxisId="left" type="monotone" dataKey={t} stroke={colorOf(t, assetDef(t))} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
                    ))}
                    {techLines.map(k => (
                      <Line key={k} yAxisId="left" type="monotone" dataKey={k} stroke={colorOf(focus, assetDef(focus))} strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.65} dot={false} isAnimationActive={false} connectNulls />
                    ))}
                    {ratios.map(r => (
                      <Line key={ratioKey(r)} yAxisId="right" type="monotone" dataKey={ratioKey(r)} stroke={colorOf(ratioKey(r), ratioDef(r))} strokeWidth={1.5} strokeDasharray="1 3" dot={false} isAnimationActive={false} connectNulls />
                    ))}
                    {overlays.filter(o => data.overlays.includes(o)).map(o => (
                      <Line key={o} yAxisId="right" type="monotone" dataKey={o} stroke={colorOf(o, ovDef(o))} strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.6, marginTop: 10, lineHeight: 1.5 }}>
            Left axis: assets (normalized) + technicals. Right axis (raw): valuation multiples/ratios and macro. Multiples are step-held between quarterly reports. Not investment advice.
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Compare() {
  return <PageWrapper><CompareContent /></PageWrapper>
}
