import { useState, useCallback, useEffect, lazy, Suspense } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import DataAuditTab from '../components/admin/DataAuditTab'
import TemporaryFileDrop from '../components/admin/TemporaryFileDrop'
import WidgetRenderer from '../components/dashboard/WidgetRenderer'
import { WIDGET_DEFAULT_SIZE, WIDGET_LABELS } from '../hooks/useDashboard'
import type { WidgetType, WidgetConfig } from '../hooks/useDashboard'

const RegressionAnalysis = lazy(() => import('./RegressionAnalysis'))
const StressTester       = lazy(() => import('./StressTester'))
const AlgoRunner         = lazy(() => import('./AlgoRunner'))

// New dashboard widgets surfaced here as a live preview gallery so they can be
// inspected in isolation without building a dashboard. Configs mirror the
// Risk/Flow Desk presets.
const PREVIEW_WIDGETS: { type: WidgetType; config: Partial<WidgetConfig> }[] = [
  { type: 'risk-metrics',    config: {} },
  { type: 'factor-decomposition', config: { factorModel: 'macro', lookback: 365 } },
  { type: 'position-sizer',  config: { ticker: 'AAPL' } },
  { type: 'pnl-attribution', config: {} },
  { type: 'unusual-flow',    config: {} },
  { type: 'trade-blotter',   config: {} },
  { type: 'time-and-sales',  config: { ticker: 'AAPL' } },
  { type: 'heatmap',         config: {} },
]

const SAMPLE_CSV = `timestamp,side,price,size,order_id
2024-01-02 09:30:00.000,A,150.30,200,ORD001
2024-01-02 09:30:00.010,A,150.35,150,ORD002
2024-01-02 09:30:00.020,A,150.40,300,ORD003
2024-01-02 09:30:00.030,A,150.45,100,ORD004
2024-01-02 09:30:00.040,A,150.50,250,ORD005
2024-01-02 09:30:00.050,B,150.25,400,ORD006
2024-01-02 09:30:00.060,B,150.20,300,ORD007
2024-01-02 09:30:00.070,B,150.15,200,ORD008
2024-01-02 09:30:00.080,B,150.10,100,ORD009
2024-01-02 09:30:00.090,B,150.05,500,ORD010
2024-01-02 09:30:00.100,A,150.30,0,ORD001
2024-01-02 09:30:00.110,B,150.25,0,ORD006
2024-01-02 09:30:00.120,A,150.28,180,ORD011
2024-01-02 09:30:00.130,B,150.26,220,ORD012
2024-01-02 09:30:00.140,A,150.32,130,ORD013
2024-01-02 09:30:00.150,B,150.24,170,ORD014
2024-01-02 09:30:00.160,A,150.29,90,ORD015
2024-01-02 09:30:00.170,B,150.27,310,ORD016
2024-01-02 09:30:00.180,A,150.31,200,ORD017
2024-01-02 09:30:00.190,B,150.23,140,ORD018
2024-01-02 09:30:00.200,A,150.33,160,ORD019
2024-01-02 09:30:00.210,B,150.22,280,ORD020
2024-01-02 09:30:00.220,A,150.28,0,ORD011
2024-01-02 09:30:00.230,B,150.26,0,ORD012
2024-01-02 09:30:00.240,A,150.27,350,ORD021
2024-01-02 09:30:00.250,B,150.28,400,ORD022
2024-01-02 09:30:00.260,A,150.35,0,ORD002
2024-01-02 09:30:00.270,B,150.20,0,ORD007
2024-01-02 09:30:00.280,A,150.26,500,ORD023
2024-01-02 09:30:00.290,B,150.29,600,ORD024
2024-01-02 09:30:00.300,A,150.40,0,ORD003
2024-01-02 09:30:00.310,B,150.15,0,ORD008
2024-01-02 09:30:00.320,A,150.25,450,ORD025
2024-01-02 09:30:00.330,B,150.30,550,ORD026
2024-01-02 09:30:00.340,A,150.45,0,ORD004
2024-01-02 09:30:00.350,B,150.10,0,ORD009
2024-01-02 09:30:00.360,A,150.24,300,ORD027
2024-01-02 09:30:00.370,B,150.31,350,ORD028
2024-01-02 09:30:00.380,A,150.50,0,ORD005
2024-01-02 09:30:00.390,B,150.05,0,ORD010
2024-01-02 09:30:00.400,A,150.23,200,ORD029
2024-01-02 09:30:00.410,B,150.32,250,ORD030
2024-01-02 09:30:00.420,A,150.22,150,ORD031
2024-01-02 09:30:00.430,B,150.33,300,ORD032
2024-01-02 09:30:00.440,A,150.21,100,ORD033
2024-01-02 09:30:00.450,B,150.34,400,ORD034
2024-01-02 09:30:00.460,A,150.20,350,ORD035
2024-01-02 09:30:00.470,B,150.35,450,ORD036
2024-01-02 09:30:00.480,A,150.19,200,ORD037
2024-01-02 09:30:00.490,B,150.36,500,ORD038
2024-01-02 09:30:00.500,A,150.27,0,ORD021
2024-01-02 09:30:00.510,B,150.28,0,ORD022
2024-01-02 09:30:00.520,A,150.18,250,ORD039
2024-01-02 09:30:00.530,B,150.37,300,ORD040
2024-01-02 09:30:00.540,A,150.29,0,ORD015
2024-01-02 09:30:00.550,B,150.27,0,ORD016
2024-01-02 09:30:00.560,A,150.17,180,ORD041
2024-01-02 09:30:00.570,B,150.38,220,ORD042
2024-01-02 09:30:00.580,A,150.31,0,ORD017
2024-01-02 09:30:00.590,B,150.23,0,ORD018
2024-01-02 09:30:00.600,A,150.16,130,ORD043
2024-01-02 09:30:00.610,B,150.39,160,ORD044
2024-01-02 09:30:00.620,A,150.33,0,ORD019
2024-01-02 09:30:00.630,B,150.22,0,ORD020
2024-01-02 09:30:00.640,A,150.15,90,ORD045
2024-01-02 09:30:00.650,B,150.40,110,ORD046
2024-01-02 09:30:00.660,A,150.26,0,ORD023
2024-01-02 09:30:00.670,B,150.29,0,ORD024
2024-01-02 09:30:00.680,A,150.14,70,ORD047
2024-01-02 09:30:00.690,B,150.41,85,ORD048
2024-01-02 09:30:00.700,A,150.25,0,ORD025
2024-01-02 09:30:00.710,B,150.30,0,ORD026
2024-01-02 09:30:00.720,A,150.13,60,ORD049
2024-01-02 09:30:00.730,B,150.42,75,ORD050
2024-01-02 09:30:00.740,A,150.24,0,ORD027
2024-01-02 09:30:00.750,B,150.31,0,ORD028
2024-01-02 09:30:00.760,A,150.12,50,ORD051
2024-01-02 09:30:00.770,B,150.43,65,ORD052
2024-01-02 09:30:00.780,A,150.23,0,ORD029
2024-01-02 09:30:00.790,B,150.32,0,ORD030
2024-01-02 09:30:00.800,A,150.11,40,ORD053
2024-01-02 09:30:00.810,B,150.44,55,ORD054
2024-01-02 09:30:00.820,A,150.22,0,ORD031
2024-01-02 09:30:00.830,B,150.33,0,ORD032
2024-01-02 09:30:00.840,A,150.10,30,ORD055
2024-01-02 09:30:00.850,B,150.45,45,ORD056
2024-01-02 09:30:00.860,A,150.21,0,ORD033
2024-01-02 09:30:00.870,B,150.34,0,ORD034
2024-01-02 09:30:00.880,A,150.32,120,ORD057
2024-01-02 09:30:00.890,B,150.09,140,ORD058
2024-01-02 09:30:00.900,A,150.20,0,ORD035
2024-01-02 09:30:00.910,B,150.35,0,ORD036
2024-01-02 09:30:00.920,A,150.33,200,ORD059
2024-01-02 09:30:00.930,B,150.08,250,ORD060
2024-01-02 09:30:00.940,A,150.19,0,ORD037
2024-01-02 09:30:00.950,B,150.36,0,ORD038
2024-01-02 09:30:00.960,A,150.34,300,ORD061
2024-01-02 09:30:00.970,B,150.07,350,ORD062
2024-01-02 09:30:00.980,A,150.18,0,ORD039
2024-01-02 09:30:00.990,B,150.37,0,ORD040
2024-01-02 09:30:01.000,A,150.35,400,ORD063`.trim()

const RED = 'var(--theme-negative, #ef4444)'
const RED_DIM = 'color-mix(in srgb, var(--theme-negative) 12%, transparent)'
const RED_BORDER = 'color-mix(in srgb, var(--theme-negative) 25%, transparent)'

const inp: React.CSSProperties = {
  background: 'var(--theme-bg)', border: `1px solid ${RED_BORDER}`,
  color: 'var(--theme-negative)', fontFamily: 'var(--theme-mono)', fontSize: 11,
  padding: '5px 9px', outline: 'none', flex: 1,
}

const btn = (active = true): React.CSSProperties => ({
  background: active ? RED : 'var(--theme-hover, rgba(255,255,255,0.04))',
  border: `1px solid ${active ? RED : RED_BORDER}`,
  color: active ? '#fff' : 'var(--theme-text-dim)',
  fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  padding: '5px 14px', cursor: active ? 'pointer' : 'default',
  transition: 'opacity 0.15s',
})

const card: React.CSSProperties = {
  background: RED_DIM, border: `1px solid ${RED_BORDER}`,
  padding: '14px 16px', marginBottom: 12,
}

function fmtUptime(secs: number): string {
  const s = Math.floor(secs)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

// Semantic status palette for dependency probes (independent of the red admin chrome).
function depColor(status: string): { fg: string; bg: string; border: string } {
  switch (status) {
    case 'up':
    case 'configured':   return { fg: 'var(--theme-positive, #22c55e)', bg: 'color-mix(in srgb, var(--theme-positive) 12%, transparent)',  border: 'color-mix(in srgb, var(--theme-positive) 30%, transparent)' }
    case 'degraded':     return { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)' }
    case 'unconfigured': return { fg: '#8b98a8', bg: 'rgba(139,152,168,0.1)', border: 'rgba(139,152,168,0.25)' }
    default:             return { fg: 'var(--theme-negative, #ef4444)', bg: 'color-mix(in srgb, var(--theme-negative) 12%, transparent)',  border: RED_BORDER }   // down
  }
}

// Inline request-per-minute sparkline (last 60 min).
function Spark({ data, color = 'var(--theme-negative, #ef4444)' }: { data: number[]; color?: string }) {
  const max = Math.max(1, ...data)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 34 }}>
      {data.map((v, i) => (
        <div key={i} title={`${v} req`} style={{
          width: 4, height: `${Math.max(2, (v / max) * 34)}px`,
          background: v > 0 ? color : 'rgba(255,255,255,0.06)',
        }} />
      ))}
    </div>
  )
}

interface DepStatus { status: string; latency_ms: number | null; detail: string }
interface HealthData {
  python: string
  users_db: string
  cache_entries: number
  cache_size_kb: number
  api_keys: Record<string, boolean>
  metrics?: {
    uptime_seconds: number
    total_requests: number
    requests_per_min: number
    error_count: number
    error_rate: number
    avg_latency_ms: number
    max_latency_ms: number
    slow_requests: number
    by_status: Record<string, number>
    by_path: { path: string; count: number; errors: number; avg_ms: number; max_ms: number }[]
    sparkline: number[]
    ai: { groq: { ok: number; fail: number }; cerebras: { ok: number; fail: number }; last_error: string | null }
  }
  dependencies?: { checked_at: number; services: Record<string, DepStatus> }
}

interface UserStats {
  total_users: number
  new_last_7d: number
  new_last_30d: number
  users_with_email?: number
  users: { id: string; username: string; display_name: string; email: string | null; created_at: string; last_login_at: string | null; login_count: number }[]
}

type Tab = 'traffic' | 'files' | 'health' | 'users' | 'cache' | 'endpoints' | 'lob' | 'widgets' | 'regression' | 'stress' | 'algo' | 'reports' | 'market' | 'audit'

interface LOBSnapshot {
  msg: number
  mid: number | null
  imbalance: number | null
  bids: [number, number][]
  asks: [number, number][]
}

interface LOBResult {
  total_messages: number
  parse_errors: number
  snapshots: LOBSnapshot[]
}

const ENDPOINT_PRESETS = [
  { label: 'GET /api/users/stats',         method: 'GET',  url: '/api/users/stats',             requiresAdmin: true },
  { label: 'GET /api/users/admin/health',  method: 'GET',  url: '/api/users/admin/health',      requiresAdmin: true },
  { label: 'POST /api/users/admin/cache/evict', method: 'POST', url: '/api/users/admin/cache/evict', requiresAdmin: true },
  { label: 'GET /api/market/quote/AAPL',   method: 'GET',  url: '/api/market/quote/AAPL',       requiresAdmin: false },
  { label: 'GET /api/corporate/overview/AAPL', method: 'GET', url: '/api/corporate/overview/AAPL', requiresAdmin: false },
]

const SECRET_KEY = 'alphatape-admin-secret'

export default function AdminTester() {
  // Persist the secret for the browser-tab session so the console only asks
  // once: sessionStorage clears when the tab closes (safer than localStorage).
  const [secret, setSecret] = useState(() => sessionStorage.getItem(SECRET_KEY) ?? '')
  const [unlocked, setUnlocked] = useState(false)
  const [authErr, setAuthErr] = useState('')
  const [tab, setTab] = useState<Tab>('traffic')

  const [health, setHealth] = useState<HealthData | null>(null)
  const [stats, setStats] = useState<UserStats | null>(null)
  const [traffic, setTraffic] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)

  // Endpoint tester
  const [epUrl, setEpUrl] = useState('')
  const [epMethod, setEpMethod] = useState('GET')
  const [epResult, setEpResult] = useState('')
  const [epLoading, setEpLoading] = useState(false)

  // Market Sizing tab — free-form BCC Research test harness.
  const [mktQuery, setMktQuery] = useState('semiconductor market size and forecast')
  const [mktCount, setMktCount] = useState(5)
  const [mktResult, setMktResult] = useState<any[] | null>(null)
  const [mktLoading, setMktLoading] = useState(false)
  const [mktErr, setMktErr] = useState('')
  const runMarket = async () => {
    setMktLoading(true); setMktErr('')
    try {
      const res = await axios.get('/api/bcc/market-size', { params: { query: mktQuery, count: mktCount } })
      setMktResult(res.data.reports || [])
    } catch (e: any) {
      setMktErr(e?.response?.data?.detail || 'Search failed'); setMktResult(null)
    } finally { setMktLoading(false) }
  }

  // LOB replay
  const [lobCsv, setLobCsv] = useState('')
  const [lobInterval, setLobInterval] = useState(50)
  const [lobTopN, setLobTopN] = useState(5)
  const [lobResult, setLobResult] = useState<LOBResult | null>(null)
  const [lobLoading, setLobLoading] = useState(false)
  const [lobErr, setLobErr] = useState('')
  const [lobSnap, setLobSnap] = useState(0)

  const hdrs = { 'x-admin-secret': secret }

  // Embedded admin tools (Regression, Stress) call the API via the global axios
  // instance. While unlocked, attach the secret so the now-locked endpoints
  // authenticate; clear it on lock or when leaving the console.
  useEffect(() => {
    if (unlocked && secret) {
      axios.defaults.headers.common['x-admin-secret'] = secret
    } else {
      delete axios.defaults.headers.common['x-admin-secret']
    }
    return () => { delete axios.defaults.headers.common['x-admin-secret'] }
  }, [unlocked, secret])

  const unlock = useCallback(async () => {
    setAuthErr('')
    try {
      await axios.get('/api/users/admin/health', { headers: { 'x-admin-secret': secret } })
      sessionStorage.setItem(SECRET_KEY, secret)
      setUnlocked(true)
    } catch {
      sessionStorage.removeItem(SECRET_KEY)
      setAuthErr('Invalid secret — access denied')
    }
  }, [secret])

  const lock = useCallback(() => {
    sessionStorage.removeItem(SECRET_KEY)
    setUnlocked(false)
  }, [])

  // Auto-unlock on mount if a secret from earlier this session is still valid,
  // so navigating back into the console doesn't re-prompt.
  useEffect(() => {
    const saved = sessionStorage.getItem(SECRET_KEY)
    if (!saved || unlocked) return
    axios.get('/api/users/admin/health', { headers: { 'x-admin-secret': saved } })
      .then(() => setUnlocked(true))
      .catch(() => sessionStorage.removeItem(SECRET_KEY))
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadHealth = useCallback(async () => {
    setLoading(true)
    try {
      const res = await axios.get('/api/users/admin/health', { headers: hdrs })
      setHealth(res.data)
    } finally { setLoading(false) }
  }, [secret])

  const loadStats = useCallback(async () => {
    setLoading(true)
    try {
      const res = await axios.get('/api/users/stats', { headers: hdrs })
      setStats(res.data)
    } finally { setLoading(false) }
  }, [secret])

  const loadTraffic = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await axios.get('/api/analytics/summary?days=30', { headers: hdrs })
      setTraffic(res.data)
    } catch { /* keep the last good snapshot on a transient poll failure */ }
    finally { if (!silent) setLoading(false) }
  }, [secret])

  // Live-refresh while the traffic tab is open so today's numbers stay current
  // (load on open, then poll quietly every 30s).
  useEffect(() => {
    if (!unlocked || tab !== 'traffic') return
    loadTraffic()
    const id = setInterval(() => loadTraffic(true), 30_000)
    return () => clearInterval(id)
  }, [unlocked, tab, loadTraffic])

  // Health tab is a live view: load on open, then refresh every 10s while it's
  // the active tab (dependency probes are server-cached so this is cheap).
  useEffect(() => {
    if (!unlocked || tab !== 'health') return
    loadHealth()
    const id = setInterval(loadHealth, 10_000)
    return () => clearInterval(id)
  }, [unlocked, tab, loadHealth])

  // Sentiment mis-score reports
  const [reports, setReports] = useState<any[]>([])
  const loadReports = useCallback(async () => {
    try {
      const res = await axios.get('/api/sentiment/reports', { headers: { 'x-admin-secret': secret } })
      setReports(res.data.reports || [])
    } catch { setReports([]) }
  }, [secret])
  useEffect(() => { if (unlocked && tab === 'reports') loadReports() }, [unlocked, tab, loadReports])
  const clearReports = useCallback(async () => {
    try { await axios.delete('/api/sentiment/reports', { headers: { 'x-admin-secret': secret } }); loadReports() } catch { /* noop */ }
  }, [secret, loadReports])
  const deleteReport = useCallback(async (rid: string) => {
    try { await axios.delete(`/api/sentiment/reports/${rid}`, { headers: { 'x-admin-secret': secret } }); loadReports() } catch { /* noop */ }
  }, [secret, loadReports])

  // Export as a self-contained markdown brief to hand to Claude (copy or file).
  const [copied, setCopied] = useState(false)
  const buildExport = useCallback(() => {
    const L: string[] = [
      `# Sentiment mis-score reports (${reports.length})`,
      `Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from the Alphatape sentiment tracker.`,
      '',
      'Each item is a headline the engine scored wrong. Adjust the lexicon, the LLM correction overlay, or the horizon rules so the scored read matches "should be".',
      '',
    ]
    reports.forEach((r, i) => {
      const s = r.scored || {}
      L.push(`## ${i + 1}. ${r.text}`)
      L.push(`- source: ${r.source || '—'}`)
      L.push(`- scored: ${s.sentiment} (direction ${s.direction ?? '—'}, confidence ${s.confidence != null ? Math.round(s.confidence * 100) + '%' : '—'})`)
      L.push(`- should be: ${r.correct_sentiment || '—'}`)
      L.push(`- reasoning tag: ${s.reasoning_tag ?? '—'} · macro tier T${s.macro_tier ?? '?'} · forward-looking ${s.forward_looking_weight != null ? Math.round(s.forward_looking_weight * 100) + '%' : '—'}`)
      if (s.corrected) L.push(`- LLM-corrected: yes (lexicon direction ${s.lexicon_direction ?? 'null'})`)
      if (s.asset_directions && Object.keys(s.asset_directions).length) L.push(`- asset directions: ${JSON.stringify(s.asset_directions)}`)
      if (Array.isArray(s.entities) && s.entities.length) L.push(`- entities: ${s.entities.map((e: any) => e.name || e).join(', ')}`)
      if (r.note) L.push(`- note: ${r.note}`)
      if (r.url) L.push(`- url: ${r.url}`)
      L.push('')
    })
    return L.join('\n')
  }, [reports])
  const copyExport = useCallback(async () => {
    try { await navigator.clipboard.writeText(buildExport()); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* noop */ }
  }, [buildExport])
  const downloadExport = useCallback(() => {
    const blob = new Blob([buildExport()], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `sentiment-reports-${new Date().toISOString().slice(0, 10)}.md`
    a.click(); URL.revokeObjectURL(url)
  }, [buildExport])

  const evictCache = useCallback(async () => {
    setMsg(''); setMsgErr(false)
    try {
      await axios.post('/api/users/admin/cache/evict', {}, { headers: hdrs })
      setMsg('Cache evicted successfully')
      loadHealth()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setMsg(detail ?? 'Eviction failed')
      setMsgErr(true)
    }
  }, [secret])

  const runEndpoint = useCallback(async () => {
    if (!epUrl) return
    setEpLoading(true); setEpResult('')
    try {
      const res = epMethod === 'GET'
        ? await axios.get(epUrl, { headers: hdrs })
        : await axios.post(epUrl, {}, { headers: hdrs })
      setEpResult(JSON.stringify(res.data, null, 2))
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string }; status?: number } })?.response
      setEpResult(JSON.stringify({ error: detail?.data?.detail ?? 'Request failed', status: detail?.status }, null, 2))
    } finally { setEpLoading(false) }
  }, [epUrl, epMethod, secret])

  const runLob = useCallback(async () => {
    if (!lobCsv.trim()) return
    setLobLoading(true); setLobErr(''); setLobResult(null); setLobSnap(0)
    try {
      const res = await axios.post('/api/admin/lob/replay', {
        csv_content: lobCsv,
        snapshot_interval: lobInterval,
        top_n: lobTopN,
      }, { headers: hdrs })
      setLobResult(res.data)
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setLobErr(detail ?? 'Replay failed')
    } finally { setLobLoading(false) }
  }, [lobCsv, lobInterval, lobTopN, secret])

  const label = (text: string): React.CSSProperties => ({
    fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase',
    color: 'color-mix(in srgb, var(--theme-negative) 55%, transparent)', marginBottom: 6, fontFamily: 'var(--theme-mono)',
  })

  if (!unlocked) {
    return (
      <PageWrapper>
        <div style={{ maxWidth: 420, margin: '60px auto', padding: 32, background: RED_DIM, border: `1px solid ${RED_BORDER}` }}>
          <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: RED, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 20 }}>
            Admin Access Required
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && unlock()}
              placeholder="ADMIN_SECRET"
              style={inp}
              // Keep password managers from autofilling a stale saved password
              // over the field. "new-password" + ignore hints are what Chrome,
              // 1Password, and LastPass actually respect.
              name="ft-admin-secret"
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
            />
            <button onClick={unlock} disabled={!secret} style={btn(!!secret)}>Unlock</button>
          </div>
          {authErr && <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: RED, marginTop: 10 }}>{authErr}</p>}
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div style={{ maxWidth: 900 }}>
        {/* Header bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24, padding: '8px 14px', background: RED_DIM, border: `1px solid ${RED_BORDER}` }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: RED, display: 'inline-block', boxShadow: `0 0 6px ${RED}` }} />
          <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: RED, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Admin Mode Active
          </span>
          <button onClick={lock} style={{ ...btn(), marginLeft: 'auto', background: 'none', border: `1px solid ${RED_BORDER}`, color: 'var(--theme-text-dim)', fontSize: 9 }}>
            Lock
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${RED_BORDER}`, marginBottom: 20, overflowX: 'auto' }}>
          {(['traffic', 'files', 'health', 'users', 'cache', 'endpoints', 'lob', 'widgets', 'regression', 'stress', 'algo', 'reports', 'market', 'audit'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', borderBottom: tab === t ? `2px solid ${RED}` : '2px solid transparent',
              color: tab === t ? RED : 'var(--theme-text-dim)', fontFamily: 'var(--theme-mono)', fontSize: 10,
              fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '8px 16px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              {t === 'files' ? 'file drop' : t}
            </button>
          ))}
        </div>

        {tab === 'files' && <TemporaryFileDrop secret={secret} />}

        {/* ── Health tab ── */}
        {tab === 'traffic' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={() => loadTraffic()} disabled={loading} style={btn()}>
                {loading ? '…' : 'Refresh Traffic'}
              </button>
              {traffic?.as_of && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-text-dim)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--theme-positive)', flexShrink: 0 }} />
                  live · today = {traffic.tz?.split('/').pop()?.replace('_', ' ')} · updated {new Date(traffic.as_of).toLocaleTimeString()}
                </span>
              )}
            </div>
            {traffic && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
                  {[
                    ['Today · Views', traffic.today_views],
                    ['Today · Visitors', traffic.today_visitors],
                    [`${traffic.window_days}d · Views`, traffic.window_views],
                    [`${traffic.window_days}d · Visitors`, traffic.window_visitors],
                  ].map(([k, v]) => (
                    <div key={String(k)} style={card}>
                      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-dim)' }}>{k}</span>
                      <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 22, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', margin: '4px 0 0' }}>{v ?? 0}</p>
                    </div>
                  ))}
                </div>
                <div style={card}>
                  <p style={label('Views by day')}>Views by day</p>
                  {(traffic.by_day ?? []).length === 0 ? (
                    <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text-dim)' }}>No traffic yet — share the link and check back.</p>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80 }}>
                      {traffic.by_day.map((d: { day: string; views: number; visitors: number }) => {
                        const max = Math.max(...traffic.by_day.map((x: { views: number }) => x.views), 1)
                        return <div key={d.day} title={`${d.day}: ${d.views} views, ${d.visitors} visitors`}
                          style={{ flex: 1, minWidth: 4, background: 'var(--theme-primary, #c9a84c)', height: `${(d.views / max) * 100}%`, opacity: 0.85 }} />
                      })}
                    </div>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div style={card}>
                    <p style={label('Top pages')}>Top pages</p>
                    {(traffic.top_paths ?? []).map((p: { path: string; views: number; visitors: number }) => (
                      <div key={p.path} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text)', padding: '2px 0' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</span>
                        <span style={{ color: 'var(--theme-text-dim)', whiteSpace: 'nowrap' }}>{p.views} · {p.visitors}u</span>
                      </div>
                    ))}
                  </div>
                  <div style={card}>
                    <p style={label('Top referrers')}>Top referrers</p>
                    {(traffic.top_referrers ?? []).length === 0 ? (
                      <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text-dim)' }}>Direct / none yet.</p>
                    ) : traffic.top_referrers.map((r: { referrer: string; views: number }) => (
                      <div key={r.referrer} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text)', padding: '2px 0' }}>
                        <span>{r.referrer}</span><span style={{ color: 'var(--theme-text-dim)' }}>{r.views}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-dim)', marginTop: 10 }}>
                  Cookieless first-party analytics · IP hashed, no PII · {traffic.total_views} views all-time
                </p>
              </>
            )}
          </div>
        )}

        {tab === 'health' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={loadHealth} disabled={loading} style={btn()}>
                {loading ? '…' : 'Refresh'}
              </button>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-dim)' }}>
                Live · auto-refresh 10s
                {health?.metrics && <> · up {fmtUptime(health.metrics.uptime_seconds)}</>}
              </span>
            </div>
            {health?.metrics && (() => {
              const m = health.metrics
              const kpis: [string, string, string?][] = [
                ['Requests', m.total_requests.toLocaleString(), undefined],
                ['Req / min', String(m.requests_per_min), undefined],
                ['Error rate', `${m.error_rate}%`, m.error_rate > 2 ? 'var(--theme-negative, #ef4444)' : 'var(--theme-positive, #22c55e)'],
                ['5xx errors', String(m.error_count), m.error_count > 0 ? 'var(--theme-negative, #ef4444)' : undefined],
                ['Avg latency', `${m.avg_latency_ms} ms`, m.avg_latency_ms > 800 ? '#f59e0b' : undefined],
                ['Max latency', `${m.max_latency_ms} ms`, undefined],
              ]
              return (
              <>
                {/* KPI row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 12 }}>
                  {kpis.map(([k, v, c]) => (
                    <div key={k} style={card}>
                      <p style={label(k)}>{k}</p>
                      <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, margin: '4px 0 0', color: c ?? 'var(--theme-text)' }}>{v}</p>
                    </div>
                  ))}
                </div>

                {/* Sparkline + status breakdown */}
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div style={card}>
                    <p style={label('Requests / min (last 60m)')}>Requests / min (last 60m)</p>
                    <Spark data={m.sparkline} />
                  </div>
                  <div style={card}>
                    <p style={label('Status codes')}>Status codes</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {Object.entries(m.by_status).map(([cls, n]) => {
                        const c = cls === '2xx' ? 'var(--theme-positive, #22c55e)' : cls === '5xx' ? 'var(--theme-negative, #ef4444)' : cls === '4xx' ? '#f59e0b' : '#8b98a8'
                        return (
                          <span key={cls} style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, padding: '3px 8px', color: c, border: `1px solid ${c}40`, background: `${c}18` }}>
                            {cls} {n}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>

                {/* Dependency health */}
                {health.dependencies && (
                  <div style={card}>
                    <p style={label('Dependencies')}>Dependencies</p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                      {Object.entries(health.dependencies.services).map(([name, d]) => {
                        const col = depColor(d.status)
                        return (
                          <div key={name} style={{ border: `1px solid ${col.border}`, background: col.bg, padding: '8px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text)' }}>{name}</span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--theme-mono)', fontSize: 9, color: col.fg, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                <span style={{ width: 6, height: 6, borderRadius: 6, background: col.fg }} />
                                {d.status}
                              </span>
                            </div>
                            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, color: 'var(--theme-text-dim)', marginTop: 4 }}>
                              {d.detail}{d.latency_ms != null && ` · ${d.latency_ms}ms`}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* AI provider usage */}
                <div style={card}>
                  <p style={label('AI providers (Groq → Cerebras failover)')}>AI providers (Groq → Cerebras failover)</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>
                    {(['groq', 'cerebras'] as const).map(p => {
                      const s = m.ai[p]
                      return (
                        <div key={p}>
                          <span style={{ color: 'var(--theme-text)', textTransform: 'capitalize' }}>{p}</span>
                          <span style={{ color: 'var(--theme-positive, #22c55e)', marginLeft: 8 }}>{s.ok} ok</span>
                          <span style={{ color: s.fail > 0 ? 'var(--theme-negative, #ef4444)' : 'var(--theme-text-dim)', marginLeft: 8 }}>{s.fail} fail</span>
                        </div>
                      )
                    })}
                  </div>
                  {m.ai.last_error && (
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: '#f59e0b', marginTop: 6 }}>
                      last error → {m.ai.last_error}
                    </div>
                  )}
                </div>

                {/* Top endpoints */}
                <div style={card}>
                  <p style={label('Top endpoints by volume')}>Top endpoints by volume</p>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 6, color: 'var(--theme-text-dim)', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: 5, borderBottom: `1px solid ${RED_BORDER}` }}>
                      <span>Path</span><span style={{ textAlign: 'right' }}>Count</span><span style={{ textAlign: 'right' }}>5xx</span><span style={{ textAlign: 'right' }}>Avg ms</span><span style={{ textAlign: 'right' }}>Max ms</span>
                    </div>
                    {m.by_path.length === 0 && <div style={{ color: 'var(--theme-text-dim)', padding: '8px 0' }}>No API traffic recorded yet.</div>}
                    {m.by_path.map(r => (
                      <div key={r.path} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 6, padding: '4px 0', color: 'var(--theme-text)' }}>
                        <span>{r.path}</span>
                        <span style={{ textAlign: 'right' }}>{r.count.toLocaleString()}</span>
                        <span style={{ textAlign: 'right', color: r.errors > 0 ? 'var(--theme-negative, #ef4444)' : 'var(--theme-text-dim)' }}>{r.errors}</span>
                        <span style={{ textAlign: 'right', color: r.avg_ms > 800 ? '#f59e0b' : 'var(--theme-text)' }}>{r.avg_ms}</span>
                        <span style={{ textAlign: 'right', color: 'var(--theme-text-dim)' }}>{r.max_ms}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
              )
            })()}
            {health && (
              <>
                <div style={card}>
                  <p style={label('System')}>System</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {[
                      ['Python', health.python],
                      ['Users DB', health.users_db],
                      ['Cache Entries', health.cache_entries],
                      ['Cache Size', `${health.cache_size_kb} KB`],
                    ].map(([k, v]) => (
                      <div key={String(k)}>
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-dim)' }}>{k}</span>
                        <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: 'var(--theme-text)', margin: '2px 0 0' }}>{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={card}>
                  <p style={label('API Keys')}>API Keys</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {Object.entries(health.api_keys).map(([key, ok]) => (
                      <span key={key} style={{
                        fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '3px 8px',
                        background: ok ? 'color-mix(in srgb, var(--theme-positive) 12%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 15%, transparent)',
                        border: `1px solid ${ok ? 'color-mix(in srgb, var(--theme-positive) 30%, transparent)' : RED_BORDER}`,
                        color: ok ? 'var(--theme-positive)' : 'var(--theme-negative)',
                      }}>
                        {key} {ok ? 'OK' : 'FAIL'}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Users tab ── */}
        {tab === 'users' && (
          <div>
            <button onClick={loadStats} disabled={loading} style={{ ...btn(), marginBottom: 16 }}>
              {loading ? '…' : 'Load Users'}
            </button>
            {stats && (() => {
              const emails = stats.users.map(u => u.email).filter((e): e is string => !!e)
              const copyEmails = () => navigator.clipboard?.writeText(emails.join('\n'))
              const downloadCsv = () => {
                const rows = [['email', 'username', 'display_name', 'created_at'],
                  ...stats.users.map(u => [u.email ?? '', u.username, u.display_name, u.created_at])]
                const csv = rows.map(r => r.map(f => `"${String(f).replace(/"/g, '""')}"`).join(',')).join('\n')
                const a = document.createElement('a')
                a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
                a.download = 'alphatape-users.csv'; a.click(); URL.revokeObjectURL(a.href)
              }
              return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
                  {[
                    ['Total Users', stats.total_users],
                    ['With Email', stats.users_with_email ?? emails.length],
                    ['New (7d)', stats.new_last_7d],
                    ['New (30d)', stats.new_last_30d],
                  ].map(([k, v]) => (
                    <div key={String(k)} style={card}>
                      <p style={label(String(k))}>{k}</p>
                      <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 22, color: RED, margin: 0 }}>{v}</p>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <button onClick={copyEmails} disabled={!emails.length} style={btn(!!emails.length)}>Copy {emails.length} Emails</button>
                  <button onClick={downloadCsv} disabled={!stats.users.length} style={btn(!!stats.users.length)}>Download CSV</button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${RED_BORDER}` }}>
                        {['Username', 'Email', 'Display Name', 'Created', 'Last Login', 'Logins'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: 'color-mix(in srgb, var(--theme-negative) 60%, transparent)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stats.users.map(u => (
                        <tr key={u.id} style={{ borderBottom: `1px solid color-mix(in srgb, var(--theme-negative) 7%, transparent)` }}>
                          <td style={{ padding: '6px 8px', color: 'var(--theme-negative)' }}>@{u.username}</td>
                          <td style={{ padding: '6px 8px', color: u.email ? 'var(--theme-text)' : 'var(--theme-text-dim)' }}>{u.email ?? '—'}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--theme-text)' }}>{u.display_name}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--theme-text-dim)' }}>{u.created_at?.slice(0, 10)}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--theme-text-dim)' }}>{u.last_login_at?.slice(0, 10) ?? '—'}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--theme-text)' }}>{u.login_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
              )
            })()}
          </div>
        )}

        {/* ── Cache tab ── */}
        {tab === 'cache' && (
          <div>
            {msg && (
              <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: msgErr ? RED : 'var(--theme-positive)', marginBottom: 12 }}>{msg}</p>
            )}
            <div style={card}>
              <p style={label('Cache Control')}>Cache Control</p>
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text-dim)', marginBottom: 14 }}>
                Evicts all expired entries from the in-memory cache. Use after restarting the backend or rotating API keys.
              </p>
              <button onClick={evictCache} style={btn()}>Evict Expired Cache</button>
            </div>
            <div style={card}>
              <p style={label('Info')}>How caching works</p>
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text-dim)', lineHeight: 1.7 }}>
                Market data responses are cached in-memory with TTLs per endpoint type.
                Eviction removes entries past their TTL — active entries remain.
                Check the Health tab for current entry count and size.
              </p>
            </div>
          </div>
        )}

        {/* ── Endpoint tester tab ── */}
        {tab === 'endpoints' && (
          <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <select
                value={epMethod}
                onChange={e => setEpMethod(e.target.value)}
                style={{ ...inp, flex: 'none', width: 70 }}
              >
                <option>GET</option>
                <option>POST</option>
              </select>
              <input
                value={epUrl}
                onChange={e => setEpUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runEndpoint()}
                placeholder="/api/..."
                style={inp}
              />
              <button onClick={runEndpoint} disabled={!epUrl || epLoading} style={btn(!!epUrl && !epLoading)}>
                {epLoading ? '…' : 'Send'}
              </button>
            </div>

            {/* Presets */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {ENDPOINT_PRESETS.map(p => (
                <button
                  key={p.url}
                  onClick={() => { setEpUrl(p.url); setEpMethod(p.method) }}
                  style={{
                    fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '3px 8px',
                    background: 'color-mix(in srgb, var(--theme-negative) 7%, transparent)', border: `1px solid ${RED_BORDER}`,
                    color: 'var(--theme-negative)', cursor: 'pointer',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {epResult && (
              <pre style={{
                background: '#0a0505', border: `1px solid ${RED_BORDER}`,
                color: 'var(--theme-negative)', fontFamily: 'var(--theme-mono)', fontSize: 10,
                padding: 14, overflowX: 'auto', maxHeight: 400, lineHeight: 1.6,
              }}>
                {epResult}
              </pre>
            )}
          </div>
        )}

        {/* ── LOB Replay tab ── */}
        {tab === 'lob' && (
          <div>
            <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text-dim)', marginBottom: 10 }}>
              Paste CSV with columns: <code style={{ fontFamily: 'var(--theme-mono)', color: 'var(--theme-negative)', fontSize: 10 }}>timestamp, side, price, size, order_id</code>
            </p>

            {/* Load options */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                onClick={() => setLobCsv(SAMPLE_CSV)}
                style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '4px 10px', background: 'color-mix(in srgb, var(--theme-negative) 10%, transparent)', border: `1px solid ${RED_BORDER}`, color: 'var(--theme-negative)', cursor: 'pointer' }}
              >
                Load Sample Data
              </button>
              <label style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '4px 10px', background: 'color-mix(in srgb, var(--theme-negative) 7%, transparent)', border: `1px solid ${RED_BORDER}`, color: 'var(--theme-negative)', cursor: 'pointer' }}>
                Upload CSV
                <input type="file" accept=".csv" style={{ display: 'none' }} onChange={e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = ev => setLobCsv(ev.target?.result as string ?? '')
                  reader.readAsText(file)
                  e.target.value = ''
                }} />
              </label>
              {lobCsv && (
                <button onClick={() => { setLobCsv(''); setLobResult(null); setLobErr('') }}
                  style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '4px 10px', background: 'transparent', border: `1px solid ${RED_BORDER}`, color: 'var(--theme-text-dim)', cursor: 'pointer' }}>
                  Clear
                </button>
              )}
            </div>

            {/* Config row */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={label('Snapshot every N msgs')}>Snapshot every N msgs</span>
                <input type="number" min={1} max={10000} value={lobInterval}
                  onChange={e => setLobInterval(Number(e.target.value))}
                  style={{ ...inp, flex: 'none', width: 70 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={label('Top N levels')}>Top N levels</span>
                <input type="number" min={1} max={20} value={lobTopN}
                  onChange={e => setLobTopN(Number(e.target.value))}
                  style={{ ...inp, flex: 'none', width: 60 }} />
              </div>
              <button onClick={runLob} disabled={!lobCsv.trim() || lobLoading}
                style={{ ...btn(!!lobCsv.trim() && !lobLoading), alignSelf: 'flex-end' }}>
                {lobLoading ? '…' : 'Run Replay'}
              </button>
            </div>

            {/* CSV paste area */}
            <textarea
              value={lobCsv}
              onChange={e => setLobCsv(e.target.value)}
              placeholder={'timestamp,side,price,size,order_id\n2024-01-02 09:30:00.000,A,150.30,200,ORD001\n...'}
              rows={6}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                background: '#0a0505', border: `1px solid ${RED_BORDER}`,
                color: 'var(--theme-negative)', fontFamily: 'var(--theme-mono)', fontSize: 10,
                padding: 10, outline: 'none', lineHeight: 1.6, marginBottom: 12,
              }}
            />

            {lobErr && <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: RED, marginBottom: 10 }}>{lobErr}</p>}

            {lobResult && (
              <>
                {/* Summary bar */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  {[
                    ['Messages', lobResult.total_messages],
                    ['Snapshots', lobResult.snapshots.length],
                    ['Parse Errors', lobResult.parse_errors],
                  ].map(([k, v]) => (
                    <div key={String(k)} style={{ ...card, flex: 1, marginBottom: 0, textAlign: 'center' }}>
                      <p style={label(String(k))}>{k}</p>
                      <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, color: RED, margin: 0 }}>{v}</p>
                    </div>
                  ))}
                </div>

                {/* Snapshot navigator */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <button onClick={() => setLobSnap(s => Math.max(0, s - 1))} disabled={lobSnap === 0} style={btn(lobSnap > 0)}>◀</button>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-negative)' }}>
                    Snapshot {lobSnap + 1} / {lobResult.snapshots.length} &nbsp;·&nbsp; msg #{lobResult.snapshots[lobSnap]?.msg}
                  </span>
                  <button onClick={() => setLobSnap(s => Math.min(lobResult.snapshots.length - 1, s + 1))} disabled={lobSnap >= lobResult.snapshots.length - 1} style={btn(lobSnap < lobResult.snapshots.length - 1)}>▶</button>
                </div>

                {/* Order book display */}
                {(() => {
                  const snap = lobResult.snapshots[lobSnap]
                  if (!snap) return null
                  const maxSize = Math.max(...snap.bids.map(b => b[1]), ...snap.asks.map(a => a[1]), 1)
                  return (
                    <div style={{ ...card, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                        <span style={{ color: 'var(--theme-text-dim)' }}>
                          Mid: <span style={{ color: 'var(--theme-negative)' }}>{snap.mid?.toFixed(4) ?? 'N/A'}</span>
                        </span>
                        <span style={{ color: 'var(--theme-text-dim)' }}>
                          Imbalance: <span style={{ color: snap.imbalance != null && snap.imbalance > 0 ? 'var(--theme-positive)' : 'var(--theme-negative)' }}>
                            {snap.imbalance != null ? (snap.imbalance >= 0 ? '+' : '') + snap.imbalance.toFixed(3) : 'N/A'}
                          </span>
                        </span>
                      </div>
                      {/* Asks (reversed so best ask is closest to mid) */}
                      {[...snap.asks].reverse().map(([price, size]) => (
                        <div key={price} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span style={{ color: 'var(--theme-negative)', width: 80, textAlign: 'right' }}>{price.toFixed(4)}</span>
                          <div style={{ flex: 1, background: 'color-mix(in srgb, var(--theme-negative) 8%, transparent)', height: 12, position: 'relative' }}>
                            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(size / maxSize) * 100}%`, background: 'color-mix(in srgb, var(--theme-negative) 40%, transparent)' }} />
                          </div>
                          <span style={{ color: 'var(--theme-text-dim)', width: 60 }}>{size.toFixed(0)}</span>
                        </div>
                      ))}
                      <div style={{ borderTop: `1px solid ${RED_BORDER}`, margin: '6px 0' }} />
                      {snap.bids.map(([price, size]) => (
                        <div key={price} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span style={{ color: 'var(--theme-positive)', width: 80, textAlign: 'right' }}>{price.toFixed(4)}</span>
                          <div style={{ flex: 1, background: 'color-mix(in srgb, var(--theme-positive) 8%, transparent)', height: 12, position: 'relative' }}>
                            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(size / maxSize) * 100}%`, background: 'color-mix(in srgb, var(--theme-positive) 35%, transparent)' }} />
                          </div>
                          <span style={{ color: 'var(--theme-text-dim)', width: 60 }}>{size.toFixed(0)}</span>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        )}
        {/* ── Widget preview gallery ── */}
        {tab === 'widgets' && (
          <div>
            <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text-dim)', marginBottom: 16, lineHeight: 1.6 }}>
              Live preview of the new dashboard widgets at their default grid size.
              They pull real data (portfolio, market, options); the portfolio and blotter widgets
              need a saved Portfolio Manager book or a signed-in paper account and otherwise show an empty state.
              Add any of these to a board from My Dashboard → +NEW, or via the Risk Desk / Flow Desk presets.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 12 }}>
              {PREVIEW_WIDGETS.map(({ type, config }) => {
                const { w, h } = WIDGET_DEFAULT_SIZE[type]
                const cfg: WidgetConfig = { id: `preview-${type}`, type, ...config }
                return (
                  <div key={type} style={{ gridColumn: `span ${Math.min(w, 12)}`, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'color-mix(in srgb, var(--theme-negative) 60%, transparent)' }}>
                        {WIDGET_LABELS[type]}
                      </span>
                      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, color: 'var(--theme-text-dim)' }}>{type} · {w}×{h}</span>
                    </div>
                    <div style={{ height: h * 52, border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', overflow: 'hidden', background: 'var(--theme-surface, #0d1826)' }}>
                      <WidgetRenderer config={cfg} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {tab === 'regression' && (
          <Suspense fallback={<div style={{ color: 'var(--theme-text-dim)', padding: 32 }}>Loading…</div>}>
            <RegressionAnalysis />
          </Suspense>
        )}
        {tab === 'stress' && (
          <Suspense fallback={<div style={{ color: 'var(--theme-text-dim)', padding: 32 }}>Loading…</div>}>
            <StressTester />
          </Suspense>
        )}
        {tab === 'algo' && (
          <Suspense fallback={<div style={{ color: 'var(--theme-text-dim)', padding: 32 }}>Loading…</div>}>
            <AlgoRunner />
          </Suspense>
        )}
        {tab === 'reports' && (
          <div style={{ fontFamily: 'var(--theme-mono)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ color: 'var(--theme-text-dim)', fontSize: 12 }}>
                Sentiment mis-score reports filed from the tracker · <b style={{ color: 'var(--theme-text)' }}>{reports.length}</b>
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={loadReports} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', background: 'none', color: 'var(--theme-secondary)', border: '1px solid var(--theme-border)' }}>Refresh</button>
                {reports.length > 0 && <>
                  <button onClick={copyExport} title="Copy a markdown brief to paste to Claude" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', background: 'none', color: copied ? 'var(--theme-positive)' : 'var(--theme-primary)', border: `1px solid ${copied ? 'var(--theme-positive)' : 'var(--theme-primary)'}` }}>{copied ? 'Copied ✓' : 'Copy for Claude'}</button>
                  <button onClick={downloadExport} title="Download the reports as a .md file" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', background: 'none', color: 'var(--theme-secondary)', border: '1px solid var(--theme-border)' }}>Download</button>
                  <button onClick={clearReports} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', background: 'none', color: RED, border: `1px solid ${RED_BORDER}` }}>Clear all</button>
                </>}
              </div>
            </div>
            {reports.length === 0 && <div style={{ color: 'var(--theme-text-dim)', padding: 24, fontSize: 12 }}>No reports. Sign in as admin on the Sentiment Tracker and hit Report on a mis-scored headline.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {reports.map(r => {
                const s = r.scored || {}
                return (
                  <div key={r.id} style={{ border: '1px solid var(--theme-border)', background: 'var(--theme-surface)', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--theme-text)', fontSize: 12, lineHeight: '17px' }}>
                        {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>{r.text}</a> : r.text}
                      </span>
                      <button onClick={() => deleteReport(r.id)} title="Delete" style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--theme-secondary)', cursor: 'pointer', fontSize: 13 }}>✕</button>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--theme-secondary)', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      <span>src <b style={{ color: 'var(--theme-text)' }}>{r.source || '—'}</b></span>
                      <span>scored <b style={{ color: s.sentiment === 'bullish' ? 'var(--theme-positive)' : s.sentiment === 'bearish' ? 'var(--theme-negative)' : 'var(--theme-secondary)' }}>{s.sentiment}</b> ({typeof s.direction === 'number' ? s.direction.toFixed(2) : '—'}, conf {typeof s.confidence === 'number' ? Math.round(s.confidence * 100) : '—'}%)</span>
                      <span style={{ color: 'var(--theme-primary)' }}>should be <b>{r.correct_sentiment || '—'}</b></span>
                      {s.corrected && <span style={{ color: '#9d8cf0' }}>LLM-corrected (lex {s.lexicon_direction ?? '—'})</span>}
                      <span>tag [{s.reasoning_tag}]</span>
                      <span>T{s.macro_tier}</span>
                    </div>
                    {r.note && <div style={{ marginTop: 5, fontSize: 11, color: 'var(--theme-text)', fontStyle: 'italic' }}>“{r.note}”</div>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'market' && (
          <div style={{ fontFamily: 'var(--theme-mono)' }}>
            <div style={{ color: 'var(--theme-text-dim)', fontSize: 11, marginBottom: 12 }}>
              Free-form BCC Research market-sizing search (public MCP). Same backend the Company Profile panel uses.
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <input value={mktQuery} onChange={e => setMktQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runMarket()} placeholder="e.g. AI in drug discovery" style={{ ...inp, minWidth: 320, flex: 1 }} />
              <input type="number" min={1} max={20} value={mktCount} onChange={e => setMktCount(Math.max(1, Math.min(20, +e.target.value || 5)))} style={{ ...inp, width: 70, flex: 'none' }} />
              <button onClick={runMarket} disabled={mktLoading || !mktQuery.trim()} style={btn(!mktLoading && !!mktQuery.trim())}>{mktLoading ? '…' : 'Search'}</button>
            </div>
            {mktErr && <div style={{ color: RED, fontSize: 11, marginBottom: 10 }}>{mktErr}</div>}
            {mktResult && mktResult.length === 0 && <div style={{ color: 'var(--theme-text-dim)', padding: 20, fontSize: 12 }}>No reports for this query.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(mktResult || []).map((r, i) => (
                <div key={i} style={{ border: '1px solid var(--theme-border)', background: 'var(--theme-surface)', padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-text)', fontSize: 12, fontWeight: 700 }}>{r.heading} ↗</a>
                    <span style={{ color: 'var(--theme-secondary)', fontSize: 10, whiteSpace: 'nowrap' }}>score {r.score ?? '—'}</span>
                  </div>
                  <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--theme-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>{r.category}</span><span>{r.published}</span><span>{r.report_code}</span>
                    {r.headline && <span style={{ color: 'var(--theme-primary)' }}>{r.headline.from} → {r.headline.to} by {r.headline.to_year} · {r.headline.cagr}% CAGR</span>}
                  </div>
                  {r.highlights && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--theme-text-dim)', lineHeight: 1.5 }}>{r.highlights}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'audit' && <DataAuditTab secret={secret} />}
      </div>
    </PageWrapper>
  )
}
