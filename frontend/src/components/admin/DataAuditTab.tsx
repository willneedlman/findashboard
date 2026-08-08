import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import EmptyState from '../EmptyState'

// Data Audit — cross-source, multi-domain reconciliation console for the Admin
// Hub. A domain selector (Equities / FX / Crypto / Macro) drives a table whose
// source columns and metrics adapt per domain: color-coded status badges, quick
// filters, an inspect/resolve drawer per row, per-domain settings, and history.

const RED = 'var(--theme-negative, #ef4444)'
const RED_DIM = 'color-mix(in srgb, var(--theme-negative) 12%, transparent)'
const RED_BORDER = 'color-mix(in srgb, var(--theme-negative) 25%, transparent)'
const AMBER = 'var(--theme-warning, #eab308)'
const GREEN = 'var(--theme-positive, #22c55e)'
const DIM = 'var(--theme-text-dim, #7a8aa0)'
const MONO = 'var(--theme-mono)'

const STATUS_STYLE: Record<string, { fg: string; label: string }> = {
  conflict: { fg: '#ef4444', label: 'Conflict' },
  stale: { fg: '#eab308', label: 'Stale' },
  outlier: { fg: '#f97316', label: 'Outlier' },
  ok: { fg: '#22c55e', label: 'OK' },
  error: { fg: DIM, label: 'No data' },
}

type SourceCell = {
  source: string; value: number | null; fetchedAt: number | null; ageSec: number | null
  stale: boolean; outlier: boolean; deviationPct: number | null; error: string | null; raw?: Record<string, unknown>
}
type Row = {
  key: string; domain: string; entity: string; metric: string; primaryValue: number | null; median: number | null
  spreadPct: number; status: string; validCount: number; sourceCount: number; sources: SourceCell[]
  runId: string; updatedAt: number; resolvedSource: string | null; resolvedBy: string | null; resolvedAt: number | null
}
type DomainCfg = {
  enabled: boolean; universe: string[]; enabled_sources: string[]
  variance_pct: number; outlier_pct: number; default_ttl_s: number; source_ttl: Record<string, number>
}
type DomainMeta = {
  key: string; label: string; metrics: string[]; metricLabels: Record<string, string>
  allSources: string[]; availableSources: string[]; config: DomainCfg
}
type Status = {
  schedulerRunning: boolean; auditInFlight: boolean; intervalS: number; autoRun: number
  domains: DomainMeta[]; rowCount: number
  lastRun: { runId: string; trigger: string; durationMs: number; summary: Record<string, number> } | null
}

function fmtBig(v: number, dollar: boolean): string {
  const a = Math.abs(v), s = dollar ? '$' : ''
  if (a >= 1e12) return s + (v / 1e12).toFixed(2) + 'T'
  if (a >= 1e9) return s + (v / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return s + (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return s + (v / 1e3).toFixed(1) + 'K'
  return s + v.toFixed(0)
}

function fmtVal(metric: string, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  switch (metric) {
    case 'price': case 'prev_close': case 'eps': return '$' + v.toFixed(2)
    case 'rate': return v.toFixed(v < 10 ? 4 : 2)
    case 'market_cap': case 'revenue': return fmtBig(v, true)
    case 'shares': return fmtBig(v, false)
    case 'pe': return v.toFixed(1) + 'x'
    case 'beta': return v.toFixed(2)
    case 'value': return Math.abs(v) >= 1e6 ? fmtBig(v, false) : v.toFixed(2)
    default: return String(v)
  }
}

function fmtAge(sec: number | null): string {
  if (sec == null) return 'live'
  if (sec < 90) return `${Math.round(sec)}s ago`
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

const btn = (active = true): React.CSSProperties => ({
  background: active ? RED : 'var(--theme-hover, rgba(255,255,255,0.04))',
  border: `1px solid ${active ? RED : RED_BORDER}`, color: active ? '#fff' : DIM,
  fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  padding: '5px 12px', cursor: 'pointer',
})
const chip = (on: boolean): React.CSSProperties => ({
  background: on ? RED : 'transparent', border: `1px solid ${on ? RED : RED_BORDER}`,
  color: on ? '#fff' : DIM, fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
  textTransform: 'uppercase', padding: '5px 11px', cursor: 'pointer',
})
const inp: React.CSSProperties = {
  background: 'var(--theme-bg)', border: `1px solid ${RED_BORDER}`, color: 'var(--theme-text)',
  fontFamily: MONO, fontSize: 11, padding: '5px 8px', outline: 'none',
}
const th: React.CSSProperties = {
  fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: DIM, textAlign: 'right', padding: '6px 8px', borderBottom: `1px solid ${RED_BORDER}`, whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontFamily: MONO, fontSize: 11, color: 'var(--theme-text)', textAlign: 'right', padding: '6px 8px',
  borderBottom: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap',
}

function Badge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.error
  return (
    <span style={{ display: 'inline-block', color: s.fg, fontFamily: MONO, fontSize: 9, fontWeight: 700,
      letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 7px', border: `1px solid ${s.fg}`,
      background: `color-mix(in srgb, ${s.fg} 15%, transparent)` }}>{s.label}</span>
  )
}

export default function DataAuditTab({ secret }: { secret: string }) {
  const hdrs = useMemo(() => ({ 'x-admin-secret': secret }), [secret])
  const [status, setStatus] = useState<Status | null>(null)
  const [domain, setDomain] = useState('equity')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<'all' | 'conflict' | 'stale' | 'flagged'>('all')
  const [sourceFilter, setSourceFilter] = useState('')
  const [metricFilter, setMetricFilter] = useState('')
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const domainMeta = status?.domains.find(d => d.key === domain) ?? null

  const loadStatus = useCallback(async () => {
    try { const r = await axios.get('/api/data-audit/status', { headers: hdrs }); setStatus(r.data) }
    catch (e: any) { setErr(e?.response?.data?.detail || 'status failed') }
  }, [hdrs])

  const loadRows = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const r = await axios.get('/api/data-audit/results', { headers: hdrs, params: { domain, status: filter, source: sourceFilter, metric: metricFilter, q } })
      setRows(r.data.rows)
    } catch (e: any) { setErr(e?.response?.data?.detail || 'results failed') }
    finally { setLoading(false) }
  }, [hdrs, domain, filter, sourceFilter, metricFilter, q])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadRows() }, [loadRows])
  // Reset metric/source filters when switching domains.
  useEffect(() => { setMetricFilter(''); setSourceFilter(''); setExpanded(null) }, [domain])

  const runNow = async (onlyDomain?: string) => {
    setRunning(true); setErr('')
    try { await axios.post('/api/data-audit/run', {}, { headers: hdrs, params: { trigger: 'manual', domain: onlyDomain ?? '' } }); await loadStatus(); await loadRows() }
    catch (e: any) { setErr(e?.response?.data?.detail || 'run failed') }
    finally { setRunning(false) }
  }

  const resolve = async (row: Row, action: 'override' | 'accept' | 'clear', source?: string) => {
    try {
      await axios.post('/api/data-audit/resolve', { domain: row.domain, entity: row.entity, metric: row.metric, action, source }, { headers: hdrs })
      await loadRows()
    } catch (e: any) { setErr(e?.response?.data?.detail || 'resolve failed') }
  }

  const sourceCols = domainMeta?.config.enabled_sources ?? []
  const metricLabels = domainMeta?.metricLabels ?? {}
  const summ = status?.lastRun?.summary

  return (
    <div>
      {/* Pipeline status bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={() => runNow()} disabled={running} style={{ ...btn(true), opacity: running ? 0.6 : 1 }}>
          {running ? 'Auditing…' : 'Run All Now'}
        </button>
        <button onClick={() => runNow(domain)} disabled={running} style={{ ...chip(false), padding: '5px 11px' }}>
          Run {domainMeta?.label ?? domain}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 10, color: DIM }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status?.schedulerRunning ? GREEN : DIM }} />
          scheduler {status?.schedulerRunning ? 'live' : 'off'} · every {Math.round((status?.intervalS ?? 21600) / 3600)}h · {status?.rowCount ?? 0} tracked
        </span>
        {summ && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>
            last run: {summ.total} metrics · <span style={{ color: RED }}>{summ.conflict} conflict</span> · <span style={{ color: AMBER }}>{summ.stale} stale</span> · {summ.ok} ok
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => setShowSettings(s => !s)} style={chip(showSettings)}>Settings</button>
          <button onClick={() => setShowHistory(s => !s)} style={chip(showHistory)}>History</button>
        </div>
      </div>

      {/* Domain selector */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {(status?.domains ?? []).map(d => (
          <button key={d.key} onClick={() => setDomain(d.key)} style={chip(domain === d.key)}>{d.label}</button>
        ))}
      </div>

      {err && <p style={{ fontFamily: MONO, fontSize: 10, color: RED, marginBottom: 10 }}>{err}</p>}

      {showSettings && domainMeta && status && <SettingsPanel status={status} domainMeta={domainMeta} hdrs={hdrs} onSaved={() => { loadStatus(); loadRows() }} />}
      {showHistory && <HistoryPanel hdrs={hdrs} />}

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {(['all', 'conflict', 'stale', 'flagged'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={chip(filter === f)}>
            {f === 'all' ? 'All' : f === 'conflict' ? 'Conflicts Only' : f === 'stale' ? 'Stale Only' : 'All Flagged'}
          </button>
        ))}
        <select value={metricFilter} onChange={e => setMetricFilter(e.target.value)} style={inp}>
          <option value="">All metrics</option>
          {(domainMeta?.metrics ?? []).map(m => <option key={m} value={m}>{metricLabels[m] ?? m}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={inp}>
          <option value="">By source…</option>
          {(domainMeta?.allSources ?? []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter entity…" style={{ ...inp, width: 120 }} />
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: DIM }}>{rows.length} rows{loading ? ' · loading' : ''}</span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', border: `1px solid ${RED_BORDER}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Entity</th>
              <th style={{ ...th, textAlign: 'left' }}>Metric</th>
              <th style={th}>Primary</th>
              {sourceCols.map(s => <th key={s} style={th}>{s}</th>)}
              <th style={th}>Spread</th>
              <th style={th}>Updated</th>
              <th style={{ ...th, textAlign: 'center' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={sourceCols.length + 6} style={{ ...td, textAlign: 'center', color: DIM, padding: 18 }}>
                {loading ? <EmptyState variant="loading" size="compact" title="Loading audit rows" /> : 'No rows. Run an audit or widen the filter.'}
              </td></tr>
            )}
            {rows.map(row => {
              const bySource = new Map(row.sources.map(s => [s.source, s]))
              const isOpen = expanded === row.key
              return (
                <Fragment key={row.key}>
                  <tr onClick={() => setExpanded(isOpen ? null : row.key)} style={{ cursor: 'pointer', background: isOpen ? RED_DIM : 'transparent' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{row.entity}</td>
                    <td style={{ ...td, textAlign: 'left', color: DIM }}>{metricLabels[row.metric] ?? row.metric}</td>
                    <td style={{ ...td, color: 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>
                      {fmtVal(row.metric, row.primaryValue)}
                      {row.resolvedSource && <span title={`Override: ${row.resolvedSource}`} style={{ color: GREEN, marginLeft: 4 }}>◆</span>}
                    </td>
                    {sourceCols.map(sc => {
                      const cell = bySource.get(sc)
                      const bad = cell?.outlier, stale = cell?.stale
                      return (
                        <td key={sc} style={{ ...td, color: bad ? RED : stale ? AMBER : cell?.value == null ? DIM : 'var(--theme-text)',
                          background: bad ? 'color-mix(in srgb, #ef4444 12%, transparent)' : stale ? 'color-mix(in srgb, #eab308 10%, transparent)' : 'transparent' }}>
                          {cell ? fmtVal(row.metric, cell.value) : '—'}
                        </td>
                      )
                    })}
                    <td style={{ ...td, color: row.spreadPct > (domainMeta?.config.variance_pct ?? 0.5) ? RED : DIM }}>{row.spreadPct.toFixed(2)}%</td>
                    <td style={{ ...td, color: DIM, fontSize: 10 }}>{row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleTimeString() : '—'}</td>
                    <td style={{ ...td, textAlign: 'center' }}><Badge status={row.status} /></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={sourceCols.length + 6} style={{ padding: 0, background: 'var(--theme-bg)' }}>
                        <RowDetail row={row} onResolve={resolve} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RowDetail({ row, onResolve }: { row: Row; onResolve: (r: Row, a: 'override' | 'accept' | 'clear', s?: string) => void }) {
  const valued = row.sources.filter(s => s.value != null)
  return (
    <div style={{ padding: 14, borderTop: `1px solid ${RED_BORDER}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
        {row.sources.map(s => (
          <div key={s.source} style={{ border: `1px solid ${s.outlier ? RED : s.stale ? AMBER : RED_BORDER}`, padding: '8px 10px', background: RED_DIM }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: 'var(--theme-text)', letterSpacing: '0.06em' }}>{s.source}</span>
              {s.outlier && <span style={{ fontFamily: MONO, fontSize: 8, color: RED }}>OUTLIER</span>}
              {s.stale && !s.outlier && <span style={{ fontFamily: MONO, fontSize: 8, color: AMBER }}>STALE</span>}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: s.value == null ? DIM : 'var(--theme-primary, #c9a84c)' }}>
              {fmtVal(row.metric, s.value)}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 9, color: DIM, marginTop: 2 }}>
              {s.error ? s.error : `${fmtAge(s.ageSec)}${s.deviationPct != null ? ` · ${s.deviationPct.toFixed(2)}% from median` : ''}`}
            </div>
            {s.raw && Object.keys(s.raw).length > 0 && (
              <pre style={{ margin: '6px 0 0', fontFamily: MONO, fontSize: 8.5, color: DIM, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 90, overflow: 'auto' }}>
                {JSON.stringify(s.raw, null, 1)}
              </pre>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: DIM, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Source of truth:</span>
        {valued.map(s => (
          <button key={s.source} onClick={() => onResolve(row, 'override', s.source)} style={{ ...chip(row.resolvedSource === s.source), padding: '4px 9px' }}>{s.source}</button>
        ))}
        <button onClick={() => onResolve(row, 'accept')} style={{ ...chip(false), padding: '4px 9px', borderColor: GREEN, color: GREEN }}>Accept as reviewed</button>
        {row.resolvedSource && <button onClick={() => onResolve(row, 'clear')} style={{ ...chip(false), padding: '4px 9px' }}>Clear override</button>}
        {row.resolvedBy && <span style={{ fontFamily: MONO, fontSize: 9, color: GREEN }}>resolved by {row.resolvedBy}{row.resolvedAt ? ` · ${new Date(row.resolvedAt * 1000).toLocaleString()}` : ''}</span>}
      </div>
    </div>
  )
}

function SettingsPanel({ status, domainMeta, hdrs, onSaved }: { status: Status; domainMeta: DomainMeta; hdrs: Record<string, string>; onSaved: () => void }) {
  const c = domainMeta.config
  const [enabled, setEnabled] = useState(c.enabled)
  const [variance, setVariance] = useState(String(c.variance_pct))
  const [outlier, setOutlier] = useState(String(c.outlier_pct))
  const [ttl, setTtl] = useState(String(Math.round(c.default_ttl_s / 3600)))
  const [universe, setUniverse] = useState(c.universe.join(', '))
  const [sources, setSources] = useState<string[]>(c.enabled_sources)
  const [interval, setInterval] = useState(String(Math.round(status.intervalS / 3600)))
  const [autoRun, setAutoRun] = useState(!!status.autoRun)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Re-seed when the selected domain changes.
  useEffect(() => {
    setEnabled(c.enabled); setVariance(String(c.variance_pct)); setOutlier(String(c.outlier_pct))
    setTtl(String(Math.round(c.default_ttl_s / 3600))); setUniverse(c.universe.join(', ')); setSources(c.enabled_sources)
  }, [domainMeta.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (s: string) => setSources(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])

  const save = async () => {
    setSaving(true); setSaved(false)
    try {
      await axios.put('/api/data-audit/config', {
        interval_s: Math.max(5, parseInt(interval) || 6) * 3600,
        auto_run: autoRun ? 1 : 0,
        domain: domainMeta.key,
        enabled,
        variance_pct: parseFloat(variance) || c.variance_pct,
        outlier_pct: parseFloat(outlier) || c.outlier_pct,
        default_ttl_s: Math.max(1, parseInt(ttl) || 24) * 3600,
        universe: universe.split(',').map(s => s.trim()).filter(Boolean),
        enabled_sources: sources,
      }, { headers: hdrs })
      setSaved(true); onSaved()
    } finally { setSaving(false) }
  }

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontFamily: MONO, fontSize: 8.5, color: DIM, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      {node}
    </label>
  )

  return (
    <div style={{ border: `1px solid ${RED_BORDER}`, background: RED_DIM, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: 'var(--theme-text)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{domainMeta.label} settings</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, color: 'var(--theme-text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> domain enabled
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 10 }}>
        {field('Variance % (conflict)', <input value={variance} onChange={e => setVariance(e.target.value)} style={inp} />)}
        {field('Outlier %', <input value={outlier} onChange={e => setOutlier(e.target.value)} style={inp} />)}
        {field('TTL (hours, stale)', <input value={ttl} onChange={e => setTtl(e.target.value)} style={inp} />)}
        {field('Interval (hours, global)', <input value={interval} onChange={e => setInterval(e.target.value)} style={inp} />)}
      </div>
      {field(domainMeta.key === 'macro' ? 'Universe (FRED series IDs)' : domainMeta.key === 'fx' ? 'Universe (pairs, e.g. EURUSD=X)' : 'Universe (comma-separated)',
        <textarea value={universe} onChange={e => setUniverse(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} />)}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 8.5, color: DIM, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Sources:</span>
        {domainMeta.allSources.map(s => {
          const avail = domainMeta.availableSources.includes(s)
          return (
            <label key={s} title={avail ? '' : 'no API key configured'} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, color: avail ? 'var(--theme-text)' : DIM, cursor: 'pointer' }}>
              <input type="checkbox" checked={sources.includes(s)} onChange={() => toggle(s)} /> {s}{avail ? '' : ' (no key)'}
            </label>
          )
        })}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, color: 'var(--theme-text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)} /> auto-run
        </label>
        <button onClick={save} disabled={saving} style={{ ...btn(true), marginLeft: 'auto' }}>{saving ? 'Saving…' : 'Save config'}</button>
        {saved && <span style={{ fontFamily: MONO, fontSize: 9, color: GREEN }}>saved</span>}
      </div>
    </div>
  )
}

function HistoryPanel({ hdrs }: { hdrs: Record<string, string> }) {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => {
    axios.get('/api/data-audit/history', { headers: hdrs, params: { limit: 100 } }).then(r => setRows(r.data.rows)).catch(() => setRows([]))
  }, [hdrs])
  return (
    <div style={{ border: `1px solid ${RED_BORDER}`, background: RED_DIM, padding: 14, marginBottom: 14 }}>
      <div style={{ fontFamily: MONO, fontSize: 9, color: DIM, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Resolution history</div>
      {rows.length === 0 ? (
        <p style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>No resolutions logged yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}>
          {rows.map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 10, fontFamily: MONO, fontSize: 10, color: 'var(--theme-text)' }}>
              <span style={{ color: DIM, minWidth: 130 }}>{new Date(r.ts * 1000).toLocaleString()}</span>
              <span style={{ fontWeight: 700, minWidth: 150 }}>{r.domain} · {r.entity} · {r.metric}</span>
              <span style={{ color: r.action === 'override' ? GREEN : DIM }}>{r.action}{r.chosen_source ? ` → ${r.chosen_source}` : ''}</span>
              <span style={{ color: DIM }}>(was {r.prior_status})</span>
              {r.note && <span style={{ color: DIM }}>· {r.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
