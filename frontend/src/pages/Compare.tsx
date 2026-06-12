import { useState, useMemo } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
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

const SERIES_COLORS = ['#c9a84c', '#60a5fa', '#34d399', '#f97316', '#a78bfa', '#38bdf8', '#fb7185', '#fbbf24']
const OVERLAY_COLORS = ['#94a3b8', '#5eead4', '#fca5a5', '#c4b5fd']

const PERIODS = ['1m', '3m', '6m', 'ytd', '1y', '5y'] as const
type Period = typeof PERIODS[number]
type Norm = 'indexed' | 'pct' | 'price'
const NORMS: { key: Norm; label: string }[] = [
  { key: 'indexed', label: 'Indexed 100' }, { key: 'pct', label: '% Change' }, { key: 'price', label: 'Price' },
]

const ASSET_PRESETS = ['SPY', 'QQQ', 'BTC-USD', 'GLD', 'TLT', '^GSPC', 'EURUSD=X', 'CL=F']
const MACRO = [
  { sym: '^TNX', label: '10Y Yield' }, { sym: '^FVX', label: '5Y Yield' }, { sym: '^IRX', label: '13W T-Bill' },
  { sym: '^VIX', label: 'VIX' }, { sym: 'DX-Y.NYB', label: 'US Dollar' }, { sym: 'GC=F', label: 'Gold' },
  { sym: 'CL=F', label: 'Crude Oil' }, { sym: '^GSPC', label: 'S&P 500' },
]

interface CompareResp {
  period: string; normalize: string; tickers: string[]; overlays: string[]
  series: Record<string, number | string | null>[]
  meta: Record<string, { start: number; last: number; change_pct: number | null }>
  axis: Record<string, 'left' | 'right'>
}

// ── client-side technicals (computed from the focus asset's series) ──────────
function sma(v: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = []; const q: number[] = []; let s = 0
  for (const x of v) {
    if (x == null) { out.push(null); continue }
    q.push(x); s += x; if (q.length > n) s -= q.shift()!
    out.push(q.length === n ? +(s / n).toFixed(4) : null)
  }
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
    const mean = mid[i] as number
    const sd = Math.sqrt(q.reduce((a, c) => a + (c - mean) ** 2, 0) / n)
    up.push(+(mean + m * sd).toFixed(4)); lo.push(+(mean - m * sd).toFixed(4))
  }
  return { up, lo }
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

const ctrlBtn = (active: boolean): React.CSSProperties => ({
  fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  padding: '5px 11px', cursor: 'pointer',
  background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
  border: `1px solid ${active ? T.gold : T.border}`, color: active ? T.gold : T.muted,
})

function CompareTooltip({ active, payload, label, norm, overlays }: any) {
  if (!active || !payload?.length) return null
  const ov = new Set(overlays)
  const fmt = (key: string, v: number) => ov.has(key.split('·')[0]) ? v.toFixed(2)
    : norm === 'pct' ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : v.toFixed(norm === 'price' ? 2 : 1)
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
  const [period, setPeriod]     = useState<Period>('1y')
  const [norm, setNorm]         = useState<Norm>('indexed')
  const [hidden, setHidden]     = useState<Set<string>>(new Set())
  const [focus, setFocus]       = useState('SPY')
  const [tech, setTech]         = useState({ sma50: false, sma200: false, ema20: false, bb: false })
  const [open, setOpen]         = useState({ assets: true, technicals: false, macro: false })
  const [aDraft, setADraft]     = useState('')

  const colorOf = (t: string) => SERIES_COLORS[Math.max(0, assets.indexOf(t)) % SERIES_COLORS.length]
  const ovColorOf = (t: string) => OVERLAY_COLORS[Math.max(0, overlays.indexOf(t)) % OVERLAY_COLORS.length]

  const { data, isFetching, isError } = useQuery<CompareResp>({
    queryKey: ['compare', assets, overlays, period, norm],
    queryFn: () => axios.get(`/api/market/compare?tickers=${encodeURIComponent(assets.join(','))}&overlays=${encodeURIComponent(overlays.join(','))}&period=${period}&normalize=${norm}`).then(r => r.data),
    enabled: assets.length > 0, staleTime: 300_000, retry: 1,
  })

  const addAsset = (raw?: string) => {
    const t = (raw ?? aDraft).trim().toUpperCase()
    if (!t || assets.includes(t) || assets.length >= 8) return
    setAssets([...assets, t]); setADraft('')
  }
  const removeAsset = (t: string) => {
    setAssets(assets.filter(x => x !== t))
    if (focus === t) setFocus(assets.filter(x => x !== t)[0] ?? '')
  }
  const toggleOverlay = (s: string) => setOverlays(prev => prev.includes(s) ? prev.filter(x => x !== s) : prev.length >= 4 ? prev : [...prev, s])
  const toggleHidden = (t: string) => setHidden(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })
  const toggleSection = (k: keyof typeof open) => setOpen(p => ({ ...p, [k]: !p[k] }))

  // chart data with client-side technicals on the focus asset
  const chartData = useMemo(() => {
    if (!data) return []
    const rows = data.series.map(p => ({ ...p })) as Record<string, number | string | null>[]
    if (focus && data.tickers.includes(focus)) {
      const vals = rows.map(r => r[focus] as number | null)
      if (tech.sma50)  { const a = sma(vals, 50);  rows.forEach((r, i) => r[`${focus}·SMA50`]  = a[i]) }
      if (tech.sma200) { const a = sma(vals, 200); rows.forEach((r, i) => r[`${focus}·SMA200`] = a[i]) }
      if (tech.ema20)  { const a = ema(vals, 20);  rows.forEach((r, i) => r[`${focus}·EMA20`]  = a[i]) }
      if (tech.bb)     { const b = bollinger(vals, 20, 2); rows.forEach((r, i) => { r[`${focus}·BB↑`] = b.up[i]; r[`${focus}·BB↓`] = b.lo[i] }) }
    }
    return rows
  }, [data, focus, tech])

  const baseline = norm === 'pct' ? 0 : norm === 'indexed' ? 100 : null
  const techLines = (() => {
    const out: string[] = []
    if (!data?.tickers.includes(focus)) return out
    if (tech.sma50)  out.push(`${focus}·SMA50`)
    if (tech.sma200) out.push(`${focus}·SMA200`)
    if (tech.ema20)  out.push(`${focus}·EMA20`)
    if (tech.bb)     { out.push(`${focus}·BB↑`, `${focus}·BB↓`) }
    return out
  })()

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <PageHeader
        title="Asset Comparison"
        subtitle="Overlay assets, technicals, and macro on one chart. Left axis: normalized assets. Right axis: raw macro series."
      />

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* ── Sidebar ───────────────────────────────────────────── */}
        <aside style={{ width: isMobile ? '100%' : 264, flexShrink: 0, background: T.surface, border: `1px solid ${T.border}` }}>
          <Section title="Assets" badge={`${assets.length}`} open={open.assets} onToggle={() => toggleSection('assets')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {assets.map(t => {
                const off = hidden.has(t); const ch = data?.meta?.[t]?.change_pct
                return (
                  <span key={t} onClick={() => toggleHidden(t)} title="Show/hide on chart" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    padding: '4px 7px', border: `1px solid ${off ? T.border : colorOf(t)}`, color: off ? T.muted : T.text,
                    background: off ? 'transparent' : `color-mix(in srgb, ${colorOf(t)} 12%, transparent)`, opacity: off ? 0.55 : 1,
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: colorOf(t) }} />{t}
                    {ch != null && <span style={{ color: ch >= 0 ? T.pos : T.neg, fontSize: 10 }}>{ch >= 0 ? '+' : ''}{ch.toFixed(1)}%</span>}
                    <span onClick={e => { e.stopPropagation(); removeAsset(t) }} style={{ color: T.muted, fontWeight: 400 }}>×</span>
                  </span>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input value={aDraft} onChange={e => setADraft(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') addAsset() }}
                placeholder="ADD SYMBOL" style={{ flex: 1, minWidth: 0, background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 700, padding: '6px 8px', outline: 'none' }} />
              <button onClick={() => addAsset()} style={ctrlBtn(false)}>+</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {ASSET_PRESETS.filter(p => !assets.includes(p)).map(p => (
                <button key={p} onClick={() => addAsset(p)} style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: `1px solid ${T.border}`, padding: '2px 6px', cursor: 'pointer' }}>{p}</button>
              ))}
            </div>
          </Section>

          <Section title="Technicals" badge={techLines.length ? 'on' : undefined} open={open.technicals} onToggle={() => toggleSection('technicals')}>
            <label style={{ display: 'block', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>Apply to</label>
            <select value={focus} onChange={e => setFocus(e.target.value)} style={{ width: '100%', background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 11, padding: '6px 8px', outline: 'none', marginBottom: 12 }}>
              {assets.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            {([['sma50', 'SMA 50'], ['sma200', 'SMA 200'], ['ema20', 'EMA 20'], ['bb', 'Bollinger (20, 2σ)']] as const).map(([k, lbl]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontFamily: T.mono, fontSize: 12, color: T.text }}>
                <input type="checkbox" checked={tech[k]} onChange={e => setTech(p => ({ ...p, [k]: e.target.checked }))} />
                {lbl}
              </label>
            ))}
          </Section>

          <Section title="Macro · right axis" badge={overlays.length ? `${overlays.length}` : undefined} open={open.macro} onToggle={() => toggleSection('macro')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {MACRO.map(m => {
                const on = overlays.includes(m.sym)
                return (
                  <label key={m.sym} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontFamily: T.mono, fontSize: 12, color: on ? T.text : T.muted }}>
                    <input type="checkbox" checked={on} onChange={() => toggleOverlay(m.sym)} />
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: on ? ovColorOf(m.sym) : T.border }} />
                    {m.label} <span style={{ color: T.muted, opacity: 0.7 }}>{m.sym}</span>
                  </label>
                )
              })}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.65, marginTop: 8, lineHeight: 1.5 }}>Plotted raw on the right axis. Use one scale at a time for clarity.</div>
          </Section>
        </aside>

        {/* ── Chart area ────────────────────────────────────────── */}
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
                  <LineChart data={chartData} margin={{ top: 6, right: overlays.length ? 8 : 16, left: 4, bottom: 4 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fill: '#5e768f' }} minTickGap={50} stroke={T.border} />
                    <YAxis yAxisId="left" tick={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fill: '#5e768f' }} width={46} stroke={T.border} domain={['auto', 'auto']} tickFormatter={(v: number) => norm === 'pct' ? `${v}%` : `${v}`} />
                    {overlays.length > 0 && (
                      <YAxis yAxisId="right" orientation="right" tick={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fill: '#94a3b8' }} width={46} stroke={T.border} domain={['auto', 'auto']} />
                    )}
                    {baseline != null && <ReferenceLine yAxisId="left" y={baseline} stroke={T.muted} strokeDasharray="3 3" />}
                    <Tooltip content={<CompareTooltip norm={norm} overlays={overlays} />} />
                    {/* assets */}
                    {assets.filter(t => !hidden.has(t) && data.tickers.includes(t)).map(t => (
                      <Line key={t} yAxisId="left" type="monotone" dataKey={t} stroke={colorOf(t)} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
                    ))}
                    {/* technicals on focus asset */}
                    {techLines.map(k => (
                      <Line key={k} yAxisId="left" type="monotone" dataKey={k} stroke={colorOf(focus)} strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.65} dot={false} isAnimationActive={false} connectNulls />
                    ))}
                    {/* macro overlays — right axis */}
                    {overlays.filter(o => data.overlays.includes(o)).map(o => (
                      <Line key={o} yAxisId="right" type="monotone" dataKey={o} stroke={ovColorOf(o)} strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, opacity: 0.6, marginTop: 10, lineHeight: 1.5 }}>
            Left axis: assets (normalized) + technicals. Right axis: macro (raw, dashed). Yahoo symbols — crypto BTC-USD, indices ^GSPC, FX EURUSD=X. Not investment advice.
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Compare() {
  return <PageWrapper><CompareContent /></PageWrapper>
}
