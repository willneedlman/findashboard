import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Cell, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import SidebarLayout from '../components/SidebarLayout'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'
import useIsMobile from '../hooks/useIsMobile'
function fmtM(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}T`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(1)}B`
  return `$${v.toFixed(0)}M`
}

function heatColor(v: number, min: number, max: number) {
  if (max === min) return 'rgba(94,118,143,0.3)'
  const t = (v - min) / (max - min)
  // Zero-anchored: green above 0, red below — regardless of where min/max sit
  if (v < 0) {
    const intensity = max <= 0 ? 1 - t : Math.min(Math.abs(v) / Math.max(Math.abs(min), 1), 1)
    return `rgba(140,46,54,${0.2 + intensity * 0.7})`
  }
  const intensity = min >= 0 ? t : Math.min(v / Math.max(max, 1), 1)
  return `rgba(47,107,75,${0.2 + intensity * 0.7})`
}

function computeDCF(
  revenue: number, opMargin: number, targetMargin: number, taxRate: number,
  capexPct: number, daPct: number, wcPct: number,
  growthRates: number[], wacc: number, terminalGrowth: number, netDebt: number, shares: number
) {
  const rw = wacc / 100
  const rt = terminalGrowth / 100
  let rev = revenue

  // Pre-profit model (Damodaran approach): operating costs are treated as a fixed base
  // (R&D, headcount) that gets absorbed as revenue scales up.
  // EBIT = variable_component - declining_fixed_cost
  //   variable: rev × targetMargin% × (yr/10)    → builds as company matures
  //   fixed:    actual_abs_loss × (1 − yr/10)     → declines to zero by yr 10
  // This ensures higher growth always accelerates profitability (as it should).
  // For normal companies (op_margin >= -100%) standard margin interpolation is used.
  const isPreProfit = opMargin < -100
  const baseLoss    = isPreProfit ? revenue * Math.abs(opMargin) / 100 : 0   // actual absolute loss
  const startMargin = isPreProfit ? -100 : opMargin

  const fcfs: { year: number; revenue: number; fcf: number; pv_fcf: number }[] = []
  for (let yr = 1; yr <= 10; yr++) {
    rev = rev * (1 + growthRates[yr - 1])
    let ebit: number
    if (isPreProfit) {
      // Fixed loss shrinks to 0; variable margin component grows with revenue
      const fixedLoss      = -baseLoss * (1 - yr / 10)
      const variableIncome =  rev * (targetMargin / 100) * (yr / 10)
      ebit = fixedLoss + variableIncome
    } else {
      const margin = startMargin + (targetMargin - startMargin) * (yr / 10)
      ebit = rev * (margin / 100)
    }
    const nopat = ebit * (1 - taxRate / 100)
    const da = rev * (daPct / 100)
    const capex = rev * (capexPct / 100)
    const dwc = rev * (wcPct / 100)
    const fcf = nopat + da - capex - dwc
    fcfs.push({ year: yr, revenue: Math.round(rev), fcf: Math.round(fcf), pv_fcf: Math.round(fcf / (1 + rw) ** yr) })
  }
  const pvFcfs = fcfs.reduce((s, r) => s + r.pv_fcf, 0)
  const lastFcf = fcfs[9].fcf
  const terminalValue = rw > rt ? lastFcf * (1 + rt) / (rw - rt) / (1 + rw) ** 10 : 0
  const ev = pvFcfs + terminalValue
  const equity = ev - netDebt
  const ips = shares > 0 ? equity / shares : 0
  return { fcfs, pvFcfs, terminalValue, ev, equity, ips }
}

import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
      }}>
        {label}
      </div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

export function DCFValuationContent() {
  const isMobile = useIsMobile()
  const cc = useChartColors()
  const [searchParams, setSearchParams] = useSearchParams()
  const [ticker, setTickerRaw] = useState(searchParams.get('ticker') || 'AAPL')
  const setTicker = (v: string) => { setTickerRaw(v); setSearchParams(p => { p.set('ticker', v); return p }) }
  const [fetching, setFetching] = useState(false)
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(true)
  const [aiRationale, setAiRationale] = useState<{ growth: string; margin: string; wacc: string } | null>(null)
  const [aiSuggested, setAiSuggested] = useState<Partial<typeof p> | null>(null)
  const [p, setP] = useState({
    revenue: 0, op_margin: 15, target_margin: 15, rev_growth_1: 15, rev_growth_2: 10, rev_growth_3: 5,
    wacc: 9, terminal_growth: 2.5, shares: 100, net_debt: 0,
    tax_rate: 21, capex_pct: 5, da_pct: 4, wc_pct: 0.5,
  })

  const { mutate: calculate, data, isPending, isError } = useMutation({
    mutationFn: async () => {
      const growthRates = [
        ...Array(3).fill(p.rev_growth_1 / 100),
        ...Array(4).fill(p.rev_growth_2 / 100),
        ...Array(3).fill(p.rev_growth_3 / 100),
      ]
      const base = computeDCF(p.revenue, p.op_margin, p.target_margin, p.tax_rate, p.capex_pct, p.da_pct, p.wc_pct,
        growthRates, p.wacc, p.terminal_growth, p.net_debt, p.shares)

      const gDeltas = [-6, -4, -2, 0, 2, 4, 6]
      const mDeltas = [-6, -4, -2, 0, 2, 4, 6]
      const sensitivity: { gi: number; mi: number; g: number; m: number; value: number }[] = []
      for (let gi = 0; gi < gDeltas.length; gi++) {
        for (let mi = 0; mi < mDeltas.length; mi++) {
          const g = p.rev_growth_1 + gDeltas[gi]
          // Always sweep target_margin — it's what drives value for pre-profit companies
          const tm = p.target_margin + mDeltas[mi]
          const gr = [...Array(3).fill(g / 100), ...Array(4).fill(p.rev_growth_2 / 100), ...Array(3).fill(p.rev_growth_3 / 100)]
          const { ips } = computeDCF(p.revenue, p.op_margin, tm, p.tax_rate, p.capex_pct, p.da_pct, p.wc_pct,
            gr, p.wacc, p.terminal_growth, p.net_debt, p.shares)
          sensitivity.push({ gi, mi, g: Math.round(g * 10) / 10, m: Math.round(tm * 10) / 10, value: Math.round(ips * 100) / 100 })
        }
      }

      let market_price: number | undefined
      try {
        const { data: hist } = await axios.get(`/api/market/history?ticker=${ticker}`)
        market_price = hist?.metrics?.current_price
      } catch { /* no market price */ }

      return {
        fcfs: base.fcfs,
        pv_fcfs: Math.round(base.pvFcfs),
        terminal_value: Math.round(base.terminalValue),
        enterprise_value: Math.round(base.ev),
        equity_value: Math.round(base.equity),
        intrinsic_per_share: Math.round(base.ips * 100) / 100,
        market_price,
        sensitivity,
        gDeltas, mDeltas,
        baseGrowth: p.rev_growth_1,
        baseMargin: p.target_margin,
        isPreProfit: p.op_margin < -100,
      }
    },
  })

  const autoFill = async () => {
    setFetching(true)
    try {
      const [{ data: f }, { data: rf }] = await Promise.all([
        axios.get(`/api/dcf/fundamentals?ticker=${ticker}`),
        axios.get('/api/rates/risk-free'),
      ])
      const erp = 0.055
      const ke = rf.rate + (f.beta ?? 1) * erp
      const kd = rf.rate + 0.02
      const de = f.de_ratio ?? 0
      const ew = de > 0 ? 1 / (1 + de) : 1
      const dw = de > 0 ? de / (1 + de) : 0
      const wacc = Math.max(5, Math.min(20, (ke * ew + kd * (1 - f.tax_rate / 100) * dw) * 100))
      const g = Math.min(f.rev_growth ?? 10, 35)
      // Use analyst-consensus target margin if available, else sector default
      const targetMargin = f.target_margin ?? (f.op_margin >= 0 ? f.op_margin : 15)
      setP(prev => ({
        ...prev,
        revenue: f.revenue, op_margin: f.op_margin, target_margin: targetMargin, shares: f.shares,
        net_debt: f.net_debt, tax_rate: f.tax_rate, capex_pct: f.capex_pct, da_pct: f.da_pct,
        wc_pct: f.wc_pct ?? 0.5,
        wacc: Math.round(wacc * 100) / 100,
        rev_growth_1: Math.round(g * 10) / 10,
        rev_growth_2: Math.round(g * 0.6 * 10) / 10,
        rev_growth_3: Math.round(g * 0.3 * 10) / 10,
      }))
    } catch (e) { console.error('Fetch failed:', e) }
    setFetching(false)
  }

  const aiSuggest = async () => {
    setAiSuggesting(true)
    setAiRationale(null)
    setAiSuggested(null)
    try {
      const { data: f } = await axios.get(`/api/dcf/fundamentals?ticker=${ticker}`)
      const { data: r } = await axios.post('/api/ai/dcf-assumptions', {
        ticker, revenue: p.revenue || f.revenue, op_margin: p.op_margin || f.op_margin,
        rev_growth: p.rev_growth_1 || f.rev_growth, beta: f.beta ?? 1, sector: f.sector ?? '',
        wacc: p.wacc,
      })
      const suggested: Partial<typeof p> = {}
      if (r.rev_growth_1   != null) suggested.rev_growth_1   = r.rev_growth_1
      if (r.rev_growth_2   != null) suggested.rev_growth_2   = r.rev_growth_2
      if (r.rev_growth_3   != null) suggested.rev_growth_3   = r.rev_growth_3
      if (r.target_margin  != null) suggested.target_margin  = r.target_margin
      if (r.wacc           != null) suggested.wacc           = r.wacc
      if (r.terminal_growth != null) suggested.terminal_growth = r.terminal_growth
      setAiSuggested(suggested)
      if (r.rationale) setAiRationale(r.rationale)
    } catch (e) { console.error('AI suggest failed:', e) }
    setAiSuggesting(false)
  }

  const applyAiSuggestions = () => {
    if (!aiSuggested) return
    setP(prev => ({ ...prev, ...aiSuggested }))
    setAiSuggested(null)
    setAiRationale(null)
  }

  const set = (k: keyof typeof p) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP(prev => ({ ...prev, [k]: +e.target.value }))

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')

  const upside = data?.market_price && data.intrinsic_per_share
    ? (data.intrinsic_per_share / data.market_price - 1) * 100 : null

  const sensiValues = data?.sensitivity?.map(s => s.value) ?? []
  const sensiMin = sensiValues.length ? Math.min(...sensiValues) : 0
  const sensiMax = sensiValues.length ? Math.max(...sensiValues) : 0

  return (
      <SidebarLayout sidebarWidth={220} sidebarTitle="" sidebar={<>
          <RailSection title="Model Inputs" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Ticker + fetch */}
            <div>
              <label style={LABEL}>Ticker</label>
              <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
                onFocus={focus} onBlur={blur} placeholder="AAPL" />
              <button onClick={autoFill} disabled={fetching} style={{
                marginTop: 6, width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', color: 'var(--theme-secondary, #99907e)',
                fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                textTransform: 'uppercase', padding: '5px 0', cursor: fetching ? 'default' : 'pointer',
                opacity: fetching ? 0.6 : 1,
              }}>
                {fetching ? 'Loading…' : 'Fetch Fundamentals'}
              </button>
              <button onClick={aiSuggest} disabled={aiSuggesting || fetching} style={{
                marginTop: 4, width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
                color: 'var(--theme-primary, #c9a84c)', fontFamily: 'inherit', fontSize: 10,
                fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                padding: '5px 0', cursor: aiSuggesting ? 'default' : 'pointer', opacity: aiSuggesting ? 0.6 : 1,
              }}>
                {aiSuggesting ? 'AI Analyzing…' : 'AI Suggest Assumptions'}
              </button>
              {aiSuggested && (() => {
                const LABELS: Record<string, string> = {
                  rev_growth_1: 'Yr 1–3 Growth %', rev_growth_2: 'Yr 4–7 Growth %',
                  rev_growth_3: 'Yr 8–10 Growth %', target_margin: 'Target Margin %',
                  wacc: 'WACC %', terminal_growth: 'Terminal Growth %',
                }
                const changes = Object.entries(aiSuggested) as [keyof typeof p, number][]
                return (
                  <div style={{ marginTop: 6, background: 'rgba(201,168,76,0.05)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', padding: '8px' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)', marginBottom: 6 }}>
                      AI Suggestions
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                      {changes.map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, fontFamily: 'var(--theme-mono)' }}>
                          <span style={{ color: 'var(--theme-secondary, #99907e)' }}>{LABELS[k] ?? k}</span>
                          <span>
                            <span style={{ color: 'var(--theme-text-dim, rgba(255,255,255,0.3))', textDecoration: 'line-through', marginRight: 6 }}>{p[k]}</span>
                            <span style={{ color: v > (p[k] as number) ? 'var(--theme-positive)' : 'var(--theme-negative)', fontWeight: 700 }}>{v}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    {aiRationale && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8, paddingTop: 6, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                        {Object.entries(aiRationale).map(([k, v]) => (
                          <div key={k} style={{ fontSize: 8, color: 'var(--theme-secondary, #99907e)', lineHeight: '12px' }}>
                            <span style={{ color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}: </span>{v as string}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={applyAiSuggestions} style={{
                        flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', fontFamily: 'inherit', cursor: 'pointer',
                        background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
                        border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
                      }}>
                        Apply Changes
                      </button>
                      <button onClick={() => { setAiSuggested(null); setAiRationale(null) }} style={{
                        flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', fontFamily: 'inherit', cursor: 'pointer',
                        background: 'transparent', border: '1px solid var(--theme-text-subtle, rgba(255,255,255,0.12))', color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
                      }}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )
              })()}
              {!aiSuggested && aiRationale && (
                <div style={{ marginTop: 6, background: 'rgba(201,168,76,0.05)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 25%, transparent)', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {Object.entries(aiRationale).map(([k, v]) => (
                    <div key={k} style={{ fontSize: 9, color: 'var(--theme-secondary, #99907e)', lineHeight: '13px' }}>
                      <span style={{ color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{k}: </span>{v as string}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {([
                ['Base Revenue ($M)', 'revenue', 1000],
                ['Op. Margin % (Current)', 'op_margin', 0.5],
                ['Target Margin % (Yr 10)', 'target_margin', 0.5],
                ['Shares (M)', 'shares', 10],
                ['Net Debt ($M)', 'net_debt', 100],
                ['Tax Rate %', 'tax_rate', 0.5],
                ['CapEx % Rev', 'capex_pct', 0.25],
                ['D&A % Rev', 'da_pct', 0.25],
                ['Working Capital % Rev', 'wc_pct', 0.25],
              ] as [string, keyof typeof p, number][]).map(([label, key, step]) => (
                <div key={key}>
                  <label style={LABEL}>{label}</label>
                  <input type="number" style={INPUT} value={p[key]} step={step}
                    onChange={set(key)} onFocus={focus} onBlur={blur} />
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {([
                ['Yr 1–3 Growth %', 'rev_growth_1', 0.5],
                ['Yr 4–7 Growth %', 'rev_growth_2', 0.5],
                ['Yr 8–10 Growth %', 'rev_growth_3', 0.5],
                ['WACC %', 'wacc', 0.25],
                ['Terminal Growth %', 'terminal_growth', 0.25],
              ] as [string, keyof typeof p, number][]).map(([label, key, step]) => (
                <div key={key}>
                  <label style={LABEL}>{label}</label>
                  <input type="number" style={INPUT} value={p[key]} step={step}
                    onChange={set(key)} onFocus={focus} onBlur={blur} />
                </div>
              ))}
            </div>
          </div>
          </RailSection>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={() => calculate()} disabled={isPending} style={{
              width: '100%', background: isPending ? 'var(--theme-hover, rgba(255,255,255,0.04))' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
              border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1, transition: 'opacity 0.15s',
            }}>
              {isPending ? 'Running…' : 'Run DCF Model'}
            </button>
            {isError && <div style={{ fontSize: 9, color: '#ef4444', textAlign: 'center', fontFamily: 'var(--theme-sans)' }}>Server unavailable — is the backend running?</div>}
          </div>

      {/* Right panel */}
      </>}>

          {!data && (
            <EmptyState title="DCF Valuation Engine" hint="Enter a ticker and press Auto-Fill, or enter assumptions manually, then press Run DCF." />
          )}

          {data && (
            <>
              {/* Pre-profit warning */}
              {data.isPreProfit && (
                <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderLeft: '4px solid #c9a84c', padding: '8px 14px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', marginBottom: 3 }}>
                    Pre-Profit Company — Margin Model Active
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', lineHeight: '14px' }}>
                    Current op. margin is below −100%. The model floors year-0 at −100% and interpolates to your Target Margin (Yr 10). Adjust the target to reflect your profitability thesis.
                  </div>
                </div>
              )}
              {/* Terminal-dominated warning: when the explicit window adds nothing (or
                  subtracts), the whole valuation rests on the terminal assumption and the
                  per-share number is not trustworthy on its own. */}
              {(data.pv_fcfs < 0 || data.enterprise_value <= 0 ||
                (data.enterprise_value > 0 && data.terminal_value / data.enterprise_value > 0.85)) && (
                <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-negative) 35%, transparent)', borderLeft: '4px solid var(--theme-negative)', padding: '8px 14px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-negative)', marginBottom: 3 }}>
                    Terminal-Dominated Result: Treat With Caution
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', lineHeight: '14px' }}>
                    {data.pv_fcfs < 0
                      ? 'The projected cash flows are negative across the explicit window, so all value (and more) comes from the terminal year. '
                      : 'Over 85% of enterprise value sits in the terminal value. '}
                    The intrinsic figure depends almost entirely on the Target Margin and terminal-growth assumptions, not near-term fundamentals. For a cash-burning name, cross-check with Multiples or Reverse DCF.
                  </div>
                </div>
              )}
              {/* Summary metrics */}
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 5},1fr)`, gap: 8 }}>
                <MetricCard label="Enterprise Value" value={fmtM(data.enterprise_value)} />
                <MetricCard label="Equity Value" value={fmtM(data.equity_value)} />
                <MetricCard label="Intrinsic / Share" value={`$${data.intrinsic_per_share.toLocaleString()}`} />
                {data.market_price != null && (
                  <MetricCard label="Market Price" value={`$${data.market_price.toLocaleString()}`} />
                )}
                {upside != null && (
                  <MetricCard label="Upside / Downside"
                    value={`${upside > 0 ? '+' : ''}${upside.toFixed(1)}%`}
                    deltaPositive={upside > 0} />
                )}
              </div>

              {/* Summary sub-line */}
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 12px', display: 'flex', gap: 20 }}>
                {[
                  ['Terminal Value', fmtM(data.terminal_value)],
                  ['PV of FCFs', fmtM(data.pv_fcfs)],
                  ['Terminal % of EV', data.enterprise_value > 0 ? `${(data.terminal_value / data.enterprise_value * 100).toFixed(1)}%` : '—'],
                ].map(([label, val]) => (
                  <div key={label}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>{label}</span>
                    <span style={{ marginLeft: 8, fontFamily: 'var(--theme-mono)', fontSize: 12, color: 'var(--theme-text, #d7e3fc)' }}>{val}</span>
                  </div>
                ))}
              </div>

              {/* FCF chart — Revenue bars (left axis) + FCF/PV lines (right axis) */}
              <ChartPanel label="10-Year Free Cash Flow Projections ($M)" height={268}>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={data.fcfs}>
                    <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                    <XAxis dataKey="year" tick={TICK} tickFormatter={y => `Y${y}`} />
                    <YAxis yAxisId="rev" orientation="left"  tick={TICK} tickFormatter={v => `$${(v / 1000).toFixed(0)}B`} width={44} />
                    <YAxis yAxisId="fcf" orientation="right" tick={TICK} tickFormatter={v => fmtM(v)} width={56} />
                    <Tooltip formatter={(v: number, name: string) => [fmtM(v), name]} contentStyle={cc.tooltipStyle} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <ReferenceLine yAxisId="fcf" y={0} stroke="var(--theme-text-faint, rgba(255,255,255,0.15))" />
                    <Bar yAxisId="rev" dataKey="revenue" name="Revenue" fill={cc.c2} opacity={0.55} />
                    <Line yAxisId="fcf" type="monotone" dataKey="fcf"    name="Free Cash Flow" stroke={cc.gain}    strokeWidth={2} dot={{ r: 3, fill: cc.gain }}    activeDot={{ r: 5 }} />
                    <Line yAxisId="fcf" type="monotone" dataKey="pv_fcf" name="PV of FCF"      stroke={cc.primary} strokeWidth={2} dot={{ r: 3, fill: cc.primary }} activeDot={{ r: 5 }} strokeDasharray="4 2" />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartPanel>

              {/* Sensitivity heatmap */}
              {data.sensitivity && data.gDeltas && (
                <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  <div style={{
                    padding: '8px 12px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
                      Sensitivity — Yr 1–3 Growth × {data.isPreProfit ? 'Target Margin (Yr 10)' : 'Operating Margin'}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.08em' }}>Intrinsic $/share</span>
                  </div>
                  <div style={{ padding: 16, overflowX: 'auto' }}>
                    <table style={{ borderSpacing: 3, borderCollapse: 'separate', margin: '0 auto' }}>
                      <thead>
                        <tr>
                          <th style={{ paddingRight: 12, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', textAlign: 'right', paddingBottom: 8 }}>
                            Growth ↓ / Margin →
                          </th>
                          {data.mDeltas.map((md: number, mi: number) => {
                            const m = Math.round((data.baseMargin + md) * 10) / 10
                            return (
                              <th key={mi} style={{ paddingLeft: 3, paddingRight: 3, paddingBottom: 8, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', textAlign: 'center', color: md === 0 ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.18))' }}>
                                {m.toFixed(1)}%
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {data.gDeltas.map((gd: number, gi: number) => {
                          const g = Math.round((data.baseGrowth + gd) * 10) / 10
                          return (
                            <tr key={gi}>
                              <td style={{ paddingRight: 12, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', textAlign: 'right', paddingTop: 2, paddingBottom: 2, color: gd === 0 ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text-faint, rgba(255,255,255,0.18))' }}>
                                {g.toFixed(1)}%
                              </td>
                              {data.mDeltas.map((_: number, mi: number) => {
                                const cell = data.sensitivity.find((s: any) => s.gi === gi && s.mi === mi)
                                const v = cell?.value ?? 0
                                return (
                                  <td key={mi} style={{ padding: 2 }}>
                                    <div style={{
                                      width: 64, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      background: heatColor(v, sensiMin, sensiMax), color: '#dce3ed',
                                      fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 600,
                                    }}>
                                      {v >= 0 ? `$${v.toFixed(0)}` : `$${v.toFixed(0)}`}
                                    </div>
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
      </SidebarLayout>
  )
}

export default function DCFValuation() {
  return <PageWrapper title="DCF Valuation"><DCFValuationContent /></PageWrapper>
}
