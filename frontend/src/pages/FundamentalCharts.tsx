import { useMemo, useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'
import { Plus, X, Save } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { useTickerParam } from '../hooks/useTickerParam'
import { T } from '../lib/theme'
import { MONO, SANS, mix } from './cockpitKit'
import { compile, evaluate } from '../lib/formula'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'

// Reported fundamentals over time, plus metrics you define yourself.
//
// The data is SEC companyfacts, not FMP: FMP's free tier is exhausted and its
// absolute fundamentals return nothing, while companyfacts is free, unmetered
// and carries ~17 years for a large filer.

interface Field { key: string; label: string; unit: string; group: string }
interface Period { fiscalYear: number; date: string; [k: string]: number | string | null }
interface Resp { ticker: string; source: string; fields: Field[]; periods: Period[] }

interface Custom { id: string; name: string; expr: string }

const STORE = 'ft_custom_metrics_v1'
const loadCustom = (): Custom[] => {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]') } catch { return [] }
}
const saveCustom = (m: Custom[]) => {
  try { localStorage.setItem(STORE, JSON.stringify(m)) } catch { /* private mode */ }
}

const SERIES_COLORS = [T.gold, '#60a5fa', '#3fb37f', '#c084fc', '#e0864a', '#38bdf8', '#e5484d']

/** Dollar figures are read in billions; ratios are read as they are. */
function fmt(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (unit === '$') {
    const a = Math.abs(v)
    if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
    if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
    if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
    return `$${v.toFixed(0)}`
  }
  if (unit === 'sh') return `${(v / 1e9).toFixed(2)}B`
  if (unit === '$/sh') return `$${v.toFixed(2)}`
  return v.toFixed(2)
}

export default function FundamentalCharts() {
  const [ticker, setTicker] = useState('AAPL')
  const [draft, setDraft] = useState('AAPL')
  // Accepts a symbol handed over from another tool via ?ticker=.
  useTickerParam(sym => { setTicker(sym.toUpperCase()); setDraft(sym.toUpperCase()) })
  useEffect(() => { setDraft(ticker) }, [ticker])

  const [picked, setPicked] = useState<string[]>(['revenue', 'ebitda', 'netIncome'])
  const [custom, setCustom] = useState<Custom[]>(loadCustom)
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ['fundamental-history', ticker],
    queryFn: () => axios.get(`/api/corporate/fundamental-history?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: !!ticker,
    staleTime: 6 * 3600 * 1000,
    retry: 1,
  })

  const fields = data?.fields ?? []
  const known = useMemo(() => new Set(fields.map(f => f.key)), [fields])
  const check = useMemo(() => (expr.trim() ? compile(expr, known.size ? known : undefined) : null), [expr, known])

  const addCustom = () => {
    if (!check?.ok || !name.trim()) return
    const next = [...custom, { id: `c${Date.now()}`, name: name.trim(), expr: expr.trim() }]
    setCustom(next); saveCustom(next)
    setPicked(p => [...p, next[next.length - 1].id])
    setName(''); setExpr('')
  }
  const dropCustom = (id: string) => {
    const next = custom.filter(c => c.id !== id)
    setCustom(next); saveCustom(next)
    setPicked(p => p.filter(k => k !== id))
  }

  // Each selected series carries its own unit so dollars and ratios never share
  // an axis: a P/E of 30 beside a revenue of 4e11 would flatten the ratio to zero.
  const selected = useMemo(() => picked.map(key => {
    const f = fields.find(x => x.key === key)
    if (f) return { key, label: f.label, unit: f.unit, expr: null as string | null }
    const c = custom.find(x => x.id === key)
    return c ? { key, label: c.name, unit: 'x', expr: c.expr } : null
  }).filter(Boolean) as { key: string; label: string; unit: string; expr: string | null }[], [picked, fields, custom])

  const rows = useMemo(() => (data?.periods ?? []).map(p => {
    const row: Record<string, number | null | string> = { fy: String(p.fiscalYear) }
    for (const s of selected) {
      row[s.key] = s.expr ? evaluate(s.expr, p as never) : ((p[s.key] as number) ?? null)
    }
    return row
  }), [data, selected])

  const hasMoney = selected.some(s => s.unit === '$' || s.unit === 'sh')
  const hasRatio = selected.some(s => s.unit !== '$' && s.unit !== 'sh')

  const label = (t: string) => (
    <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
      textTransform: 'uppercase', color: T.muted, margin: '14px 0 6px' }}>{t}</div>
  )

  const sidebar = (
    <div style={{ padding: 13 }}>
      <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: T.muted, marginBottom: 5 }}>Company</div>
      <TickerInput value={draft} onChange={setDraft} onEnter={() => setTicker(draft.toUpperCase())}
        onSelect={s => setTicker(s.toUpperCase())} placeholder="Ticker" aria-label="Ticker" />

      {['Income', 'Balance', 'Cash flow', 'Market'].map(group => {
        const inGroup = fields.filter(f => f.group === group)
        if (!inGroup.length) return null
        return (
          <div key={group}>
            {label(group)}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {inGroup.map(f => {
                const on = picked.includes(f.key)
                return (
                  <button key={f.key} onClick={() => setPicked(p => on ? p.filter(k => k !== f.key) : [...p, f.key])}
                    style={{ fontFamily: SANS, fontSize: 10.5, padding: '4px 8px', cursor: 'pointer',
                      background: on ? mix(T.gold, 14) : 'transparent',
                      border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.muted }}>
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {label('Your metrics')}
      {custom.map(c => {
        const on = picked.includes(c.id)
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
            <button onClick={() => setPicked(p => on ? p.filter(k => k !== c.id) : [...p, c.id])}
              style={{ flex: 1, textAlign: 'left', fontFamily: SANS, fontSize: 10.5, padding: '4px 8px',
                cursor: 'pointer', background: on ? mix(T.gold, 14) : 'transparent',
                border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.text, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
              <div style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.expr}</div>
            </button>
            <button onClick={() => dropCustom(c.id)} aria-label={`Delete ${c.name}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, padding: 2, display: 'flex' }}>
              <X size={12} />
            </button>
          </div>
        )
      })}

      <div style={{ border: `1px solid ${T.border}`, padding: 9, marginTop: 6 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Metric name"
          className="ft-control" style={{ width: '100%', marginBottom: 5 }} />
        <textarea value={expr} onChange={e => setExpr(e.target.value)}
          placeholder="(revenue - costOfRevenue - capitalExpenditure) / enterpriseValue"
          rows={3} className="ft-control" style={{ width: '100%', resize: 'vertical', fontFamily: MONO, fontSize: 10.5 }} />
        {check && !check.ok && (
          <div style={{ fontFamily: SANS, fontSize: 10, color: T.neg, marginTop: 4 }}>{check.error}</div>
        )}
        {check?.ok && (
          <div style={{ fontFamily: SANS, fontSize: 10, color: T.pos, marginTop: 4 }}>
            uses {check.vars.join(', ')}
          </div>
        )}
        <button onClick={addCustom} disabled={!check?.ok || !name.trim()}
          style={{ marginTop: 6, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 6, padding: '6px 0', cursor: check?.ok && name.trim() ? 'pointer' : 'default',
            background: check?.ok && name.trim() ? T.gold : 'transparent',
            border: `1px solid ${check?.ok && name.trim() ? T.gold : T.border}`,
            color: check?.ok && name.trim() ? T.bg : T.muted,
            fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          <Save size={12} /> Save metric
        </button>
        <div style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted, marginTop: 7, lineHeight: 1.5 }}>
          Use any field name above, with + − * / ^ and parentheses. Saved to this browser.
        </div>
      </div>
    </div>
  )

  return (
    <PageWrapper>
      <PageHeader title="Fundamental Charts"
        meta={data ? `${data.periods.length} fiscal years · ${data.source}` : undefined} />
      <SidebarLayout sidebar={sidebar} sidebarTitle="Fields" sidebarWidth={244}>
        {isLoading && <EmptyState title="Fundamental Charts" variant="loading" hint={`Reading ${ticker} filings from SEC companyfacts.`} />}
        {!isLoading && error && (
          <EmptyState title="No filings found" variant="unavailable"
            hint={`SEC companyfacts has no usable us-gaap history for ${ticker}. Foreign issuers filing 20-F and most funds are not covered.`} />
        )}
        {!isLoading && !error && data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: `1px solid ${T.border}`, background: T.bg, padding: '14px 12px 6px',
              height: 'clamp(320px, calc(100vh - 420px), 620px)' }}>
              {selected.length === 0 ? (
                <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontFamily: SANS,
                  fontSize: 12, color: T.muted }}>Pick a field or a saved metric to plot.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 6, right: 14, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={T.borderFaint} vertical={false} />
                    <XAxis dataKey="fy" tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }} />
                    {hasMoney && <YAxis yAxisId="money" tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }}
                      width={62} tickFormatter={(v: number) => fmt(v, '$')} />}
                    {hasRatio && <YAxis yAxisId="ratio" orientation="right" width={52}
                      tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }}
                      tickFormatter={(v: number) => (Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1))} />}
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number, n: string) => {
                        const s = selected.find(x => x.label === n)
                        return [fmt(v, s?.unit ?? 'x'), n]
                      }} />
                    <Legend wrapperStyle={{ fontFamily: SANS, fontSize: 11 }} />
                    {selected.map((s, i) => (
                      <Line key={s.key} yAxisId={s.unit === '$' || s.unit === 'sh' ? 'money' : 'ratio'}
                        dataKey={s.key} name={s.label} stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                        strokeWidth={1.9} dot={false} isAnimationActive={false}
                        // A year SEC never tagged must stay a gap, not a joined line.
                        connectNulls={false} />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={{ border: `1px solid ${T.border}`, background: T.bg, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontFamily: SANS, fontSize: 8.5,
                      fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted,
                      borderBottom: `1px solid ${T.border}`, position: 'sticky', left: 0, background: T.bg }}>Metric</th>
                    {rows.map(r => (
                      <th key={r.fy as string} style={{ textAlign: 'right', padding: '7px 10px', fontFamily: MONO,
                        fontSize: 10, color: T.muted, borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{r.fy}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selected.map((s, i) => (
                    <tr key={s.key}>
                      <td style={{ padding: '5px 10px', fontFamily: SANS, fontSize: 11.5,
                        color: SERIES_COLORS[i % SERIES_COLORS.length], borderBottom: `1px solid ${T.borderFaint}`,
                        position: 'sticky', left: 0, background: T.bg, whiteSpace: 'nowrap' }}>{s.label}</td>
                      {rows.map(r => (
                        <td key={r.fy as string} style={{ textAlign: 'right', padding: '5px 10px', fontFamily: MONO,
                          fontSize: 11, color: T.text, borderBottom: `1px solid ${T.borderFaint}`, whiteSpace: 'nowrap' }}>
                          {fmt(r[s.key] as number, s.unit)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}
