import { T } from '../lib/theme'
import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'

// ── Theme ─────────────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  background: T.surface, border: `1px solid ${T.border}`,
  color: T.text, fontFamily: T.mono, fontSize: 11,
  padding: '5px 8px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

const SCENARIOS = [
  { key: 'gfc',              label: '2008 Financial Crisis',  period: 'Sep 2008 – Mar 2009' },
  { key: 'covid',            label: 'COVID Crash',            period: 'Feb – Mar 2020' },
  { key: 'rate_hike_2022',   label: '2022 Rate Hike Bear',    period: 'Jan – Oct 2022' },
  { key: 'dotcom',           label: 'Dot-com Bust',           period: 'Mar 2000 – Oct 2002' },
  { key: 'q4_2018',          label: '2018 Q4 Selloff',        period: 'Sep – Dec 2018' },
  { key: 'debt_ceiling_2011',label: '2011 Debt Ceiling',      period: 'Jul – Oct 2011' },
  { key: 'black_monday',     label: '1987 Black Monday',      period: 'Oct 14–20 1987' },
  { key: 'svb_2023',         label: 'SVB Banking Crisis',     period: 'Mar 2023' },
]

interface Holding { ticker: string; weight: string }

interface HoldingResult {
  ticker: string
  weight: number
  return: number | null
  contribution: number | null
}

interface ScenarioResult {
  key: string
  label: string
  period: string
  desc: string
  portfolio_return: number | null
  spy_return: number | null
  alpha: number | null
  holdings: HoldingResult[]
  partial: boolean
}

interface StressResponse {
  holdings: { ticker: string; weight: number }[]
  results: ScenarioResult[]
}

// ── Portfolio Manager integration ─────────────────────────────────────────────

interface PMHolding { ticker: string; shares: number; avgCost: number }

function loadFromPortfolioManager(): Holding[] | null {
  try {
    const raw = localStorage.getItem('ft-portfolio-manager')
    if (!raw) return null
    const pm: PMHolding[] = JSON.parse(raw)
    if (!pm.length) return null

    // Weight by cost basis (shares × avgCost); fall back to equal weights
    const values = pm.map(h => h.shares * (h.avgCost || 1))
    const total  = values.reduce((s, v) => s + v, 0)
    if (total === 0) return null

    return pm.map((h, i) => ({
      ticker: h.ticker,
      weight: String(Math.round((values[i] / total) * 1000) / 10), // 1 decimal
    }))
  } catch {
    return null
  }
}

function pct(v: number | null, showPlus = true) {
  if (v == null) return '—'
  return `${showPlus && v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function retColor(v: number | null) {
  if (v == null) return T.muted
  return v >= 0 ? T.pos : T.neg
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, borderBottom: `1px solid ${T.border}`, paddingBottom: 6, marginBottom: 14 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

export default function StressTester() {
  const [pmSource, setPmSource] = useState(false)

  const [holdings, setHoldings] = useState<Holding[]>(() => {
    const pm = loadFromPortfolioManager()
    if (pm) { return pm }
    return [
      { ticker: 'SPY', weight: '60' },
      { ticker: 'TLT', weight: '30' },
      { ticker: 'GLD', weight: '10' },
    ]
  })

  // Track whether portfolio manager data was used on mount
  useEffect(() => {
    if (loadFromPortfolioManager()) setPmSource(true)
  }, [])

  const reloadFromPortfolio = useCallback(() => {
    const pm = loadFromPortfolioManager()
    if (pm) { setHoldings(pm); setPmSource(true) }
  }, [])
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(
    new Set(SCENARIOS.map(s => s.key))
  )
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd]     = useState('')
  const [useCustom, setUseCustom]     = useState(false)
  const [result, setResult]           = useState<StressResponse | null>(null)
  const [loading, setLoading]         = useState(false)
  const [err, setErr]                 = useState('')
  const [activeScenario, setActiveScenario] = useState<string | null>(null)

  const totalWeight = holdings.reduce((s, h) => s + (parseFloat(h.weight) || 0), 0)
  const weightOk = Math.abs(totalWeight - 100) < 0.5

  const addHolding   = () => setHoldings(h => [...h, { ticker: '', weight: '' }])
  const removeHolding = (i: number) => setHoldings(h => h.filter((_, j) => j !== i))
  const updateHolding = (i: number, field: 'ticker' | 'weight', val: string) =>
    setHoldings(h => h.map((r, j) => j === i ? { ...r, [field]: val } : r))

  const toggleScenario = (key: string) =>
    setSelectedScenarios(prev => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  const run = async () => {
    setErr(''); setResult(null); setLoading(true); setActiveScenario(null)
    try {
      const res = await axios.post<StressResponse>('/api/portfolio/stress-test', {
        holdings: holdings
          .filter(h => h.ticker && h.weight)
          .map(h => ({ ticker: h.ticker.toUpperCase(), weight: parseFloat(h.weight) / 100 })),
        scenarios: [...selectedScenarios],
        custom_start: useCustom && customStart ? customStart : null,
        custom_end:   useCustom && customEnd   ? customEnd   : null,
      })
      setResult(res.data)
      if (res.data.results.length > 0) setActiveScenario(res.data.results[0].key)
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setErr(detail ?? 'Stress test failed')
    } finally { setLoading(false) }
  }

  const activeResult = result?.results.find(r => r.key === activeScenario) ?? null

  const chartData = result?.results.map(r => ({
    name:      r.label.replace('SVB Banking Crisis', 'SVB Crisis').replace('Financial Crisis', 'Crisis').replace('Rate Hike Bear', 'Rate Bear').replace('Black Monday', 'Blk Mon'),
    portfolio: r.portfolio_return,
    spy:       r.spy_return,
    key:       r.key,
  })) ?? []

  return (
    <PageWrapper>
      <div id="stress-tester-content" style={{ maxWidth: 1100, margin: '0 auto' }}>

        <PageHeader
          title="Portfolio Stress Tester"
          subtitle="Simulate how your portfolio would have performed during major historical market shocks."
        />

        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, alignItems: 'start' }}>

          {/* ── Left panel: inputs ── */}
          <div>
            <Section title={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Holdings</span>
                {pmSource && (
                  <button onClick={reloadFromPortfolio} style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)', border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)`, color: T.gold, padding: '2px 8px', cursor: 'pointer' }}>
                    ↺ Reload Portfolio
                  </button>
                )}
              </div>
            }>
              {holdings.map((h, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input
                    value={h.ticker}
                    onChange={e => updateHolding(i, 'ticker', e.target.value.toUpperCase())}
                    placeholder="TICKER"
                    style={{ ...inp, width: 90, textTransform: 'uppercase' }}
                  />
                  <input
                    value={h.weight}
                    onChange={e => updateHolding(i, 'weight', e.target.value)}
                    placeholder="Weight %"
                    style={{ ...inp, flex: 1 }}
                    type="number" min="0" max="100"
                  />
                  <button
                    onClick={() => removeHolding(i)}
                    style={{ background: 'none', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', padding: '0 8px', fontSize: 14 }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <button
                  onClick={addHolding}
                  style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'none', border: `1px solid ${T.border}`, color: T.muted, padding: '4px 10px', cursor: 'pointer' }}
                >
                  + Add
                </button>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: weightOk ? T.pos : T.neg }}>
                  {totalWeight.toFixed(1)}% {weightOk ? 'OK' : '≠ 100%'}
                </span>
              </div>
            </Section>

            <Section title="Scenarios">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {SCENARIOS.map(s => {
                  const on = selectedScenarios.has(s.key)
                  return (
                    <label key={s.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                      <div
                        onClick={() => toggleScenario(s.key)}
                        style={{ width: 11, height: 11, flexShrink: 0, marginTop: 1, border: `1px solid ${on ? T.gold : T.muted}`, background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                      >
                        {on && <div style={{ width: 5, height: 5, background: T.gold }} />}
                      </div>
                      <div>
                        <div style={{ fontFamily: T.label, fontSize: 10, color: on ? T.text : T.muted }}>{s.label}</div>
                        <div style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>{s.period}</div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </Section>

            <Section title="Custom Period">
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, cursor: 'pointer' }}>
                <div
                  onClick={() => setUseCustom(v => !v)}
                  style={{ width: 11, height: 11, flexShrink: 0, border: `1px solid ${useCustom ? T.gold : T.muted}`, background: useCustom ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                >
                  {useCustom && <div style={{ width: 5, height: 5, background: T.gold }} />}
                </div>
                <span style={{ fontFamily: T.label, fontSize: 10, color: T.muted }}>Add custom period</span>
              </label>
              {useCustom && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={inp} />
                  <input type="date" value={customEnd}   onChange={e => setCustomEnd(e.target.value)}   style={inp} />
                </div>
              )}
            </Section>

            <button
              onClick={run}
              disabled={loading || !weightOk || holdings.filter(h => h.ticker).length === 0}
              style={{
                width: '100%', padding: '9px 0',
                background: loading || !weightOk ? 'var(--theme-border-faint, rgba(255,255,255,0.05))' : T.gold,
                border: 'none', color: loading || !weightOk ? T.muted : '#0a1220',
                fontFamily: T.label, fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                cursor: loading || !weightOk ? 'default' : 'pointer',
              }}
            >
              {loading ? 'Running…' : 'Run Stress Test'}
            </button>

            {err && <p style={{ fontFamily: T.mono, fontSize: 10, color: T.neg, marginTop: 10 }}>{err}</p>}
          </div>

          {/* ── Right panel: results ── */}
          <div>
            {!result && !loading && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11 }}>
                Configure holdings and run the test
              </div>
            )}

            {loading && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11 }}>
                Fetching historical data…
              </div>
            )}

            {result && (
              <>
                {/* Bar chart */}
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 16px', marginBottom: 16 }}>
                  <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 12 }}>
                    Portfolio vs SPY — All Scenarios
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={chartData} barGap={2} margin={{ left: -10, right: 8, top: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                      <XAxis dataKey="name" tick={{ fontFamily: T.mono, fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} />
                      <YAxis tickFormatter={v => `${v}%`} tick={{ fontFamily: T.mono, fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} />
                      <ReferenceLine y={0} stroke={T.border} />
                      <Tooltip
                        cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }}
                        formatter={(v: number, name: string) => [`${v?.toFixed(2)}%`, name === 'portfolio' ? 'Portfolio' : 'SPY']}
                        contentStyle={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', fontFamily: 'var(--theme-mono)', fontSize: 10, padding: '8px 10px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
                        labelStyle={{ color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-sans)', fontWeight: 700, marginBottom: 4 }}
                      />
                      <Bar dataKey="portfolio" name="portfolio" radius={[2, 2, 0, 0]}>
                        {chartData.map((d, i) => (
                          <Cell key={i} fill={(d.portfolio ?? 0) >= 0 ? T.pos : T.neg} opacity={activeScenario === d.key ? 1 : 0.6}
                            onClick={() => setActiveScenario(d.key)} style={{ cursor: 'pointer' }} />
                        ))}
                      </Bar>
                      <Bar dataKey="spy" name="spy" radius={[2, 2, 0, 0]}>
                        {chartData.map((d, i) => (
                          <Cell key={i} fill="var(--theme-chart-neutral, #4a7fa5)" opacity={0.45} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Summary table */}
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, marginBottom: 16, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                        {['Scenario', 'Period', 'Portfolio', 'SPY', 'Alpha'].map(h => (
                          <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.results.map(r => (
                        <tr
                          key={r.key}
                          onClick={() => setActiveScenario(r.key)}
                          style={{
                            borderBottom: `1px solid ${T.border}`, cursor: 'pointer',
                            background: activeScenario === r.key ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, transparent)' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '7px 12px', color: activeScenario === r.key ? T.gold : T.text, fontFamily: T.label, fontWeight: activeScenario === r.key ? 700 : 400 }}>{r.label}</td>
                          <td style={{ padding: '7px 12px', color: T.muted, fontSize: 9 }}>{r.period}</td>
                          <td style={{ padding: '7px 12px', color: retColor(r.portfolio_return), fontWeight: 700 }}>{pct(r.portfolio_return)}</td>
                          <td style={{ padding: '7px 12px', color: retColor(r.spy_return) }}>{pct(r.spy_return)}</td>
                          <td style={{ padding: '7px 12px', color: r.alpha == null ? T.muted : r.alpha >= 0 ? T.pos : T.neg, fontWeight: 700 }}>
                            {r.alpha != null ? `${r.alpha >= 0 ? '+' : ''}${r.alpha.toFixed(2)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Per-holding breakdown for selected scenario */}
                {activeResult && (
                  <div style={{ background: T.surface, border: `1px solid ${T.border}` }}>
                    <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border}` }}>
                      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>{activeResult.label}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginLeft: 10 }}>{activeResult.desc}</span>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                          {['Holding', 'Weight', 'Return', 'Contribution'].map(h => (
                            <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeResult.holdings.map(h => (
                          <tr key={h.ticker} style={{ borderBottom: `1px solid ${T.border}` }}>
                            <td style={{ padding: '6px 12px', color: T.gold, fontWeight: 700, fontFamily: T.label, letterSpacing: '0.06em' }}>{h.ticker}</td>
                            <td style={{ padding: '6px 12px', color: T.muted }}>{h.weight}%</td>
                            <td style={{ padding: '6px 12px', color: retColor(h.return), fontWeight: 700 }}>{pct(h.return)}</td>
                            <td style={{ padding: '6px 12px', color: retColor(h.contribution) }}>
                              {h.contribution != null ? `${h.contribution >= 0 ? '+' : ''}${h.contribution.toFixed(2)}%` : '—'}
                            </td>
                          </tr>
                        ))}
                        <tr style={{ background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, transparent)' }}>
                          <td style={{ padding: '7px 12px', color: T.gold, fontFamily: T.label, fontWeight: 700, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' }} colSpan={2}>Portfolio Total</td>
                          <td style={{ padding: '7px 12px' }} />
                          <td style={{ padding: '7px 12px', color: retColor(activeResult.portfolio_return), fontWeight: 700 }}>{pct(activeResult.portfolio_return)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}
