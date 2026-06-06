import { useState, useCallback } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'

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

const RED = '#ef4444'
const RED_DIM = 'rgba(239,68,68,0.12)'
const RED_BORDER = 'rgba(239,68,68,0.25)'

const inp: React.CSSProperties = {
  background: '#0a0505', border: `1px solid ${RED_BORDER}`,
  color: '#fca5a5', fontFamily: 'var(--theme-mono)', fontSize: 11,
  padding: '5px 9px', outline: 'none', flex: 1,
}

const btn = (active = true): React.CSSProperties => ({
  background: active ? RED : 'rgba(255,255,255,0.04)',
  border: `1px solid ${active ? RED : RED_BORDER}`,
  color: active ? '#fff' : '#6b7280',
  fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.08em', textTransform: 'uppercase',
  padding: '5px 14px', cursor: active ? 'pointer' : 'default',
  transition: 'opacity 0.15s',
})

const card: React.CSSProperties = {
  background: RED_DIM, border: `1px solid ${RED_BORDER}`,
  padding: '14px 16px', marginBottom: 12,
}

interface HealthData {
  python: string
  users_db: string
  cache_entries: number
  cache_size_kb: number
  api_keys: Record<string, boolean>
}

interface UserStats {
  total_users: number
  new_last_7d: number
  new_last_30d: number
  users: { id: string; username: string; display_name: string; created_at: string; last_login_at: string | null; login_count: number }[]
}

type Tab = 'health' | 'users' | 'cache' | 'endpoints' | 'lob'

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

export default function AdminTester() {
  const [secret, setSecret] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [authErr, setAuthErr] = useState('')
  const [tab, setTab] = useState<Tab>('health')

  const [health, setHealth] = useState<HealthData | null>(null)
  const [stats, setStats] = useState<UserStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)

  // Endpoint tester
  const [epUrl, setEpUrl] = useState('')
  const [epMethod, setEpMethod] = useState('GET')
  const [epResult, setEpResult] = useState('')
  const [epLoading, setEpLoading] = useState(false)

  // LOB replay
  const [lobCsv, setLobCsv] = useState('')
  const [lobInterval, setLobInterval] = useState(50)
  const [lobTopN, setLobTopN] = useState(5)
  const [lobResult, setLobResult] = useState<LOBResult | null>(null)
  const [lobLoading, setLobLoading] = useState(false)
  const [lobErr, setLobErr] = useState('')
  const [lobSnap, setLobSnap] = useState(0)

  const hdrs = { 'x-admin-secret': secret }

  const unlock = useCallback(async () => {
    setAuthErr('')
    try {
      await axios.get('/api/users/admin/health', { headers: hdrs })
      setUnlocked(true)
    } catch {
      setAuthErr('Invalid secret — access denied')
    }
  }, [secret])

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
    color: 'rgba(239,68,68,0.55)', marginBottom: 6, fontFamily: 'var(--theme-mono)',
  })

  if (!unlocked) {
    return (
      <PageWrapper>
        <div style={{ maxWidth: 420, margin: '60px auto', padding: 32, background: RED_DIM, border: `1px solid ${RED_BORDER}` }}>
          <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: RED, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 20 }}>
            ⚠ Admin Access Required
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && unlock()}
              placeholder="ADMIN_SECRET"
              style={inp}
              autoComplete="off"
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
          <button onClick={() => setUnlocked(false)} style={{ ...btn(), marginLeft: 'auto', background: 'none', border: `1px solid ${RED_BORDER}`, color: '#6b7280', fontSize: 9 }}>
            Lock
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${RED_BORDER}`, marginBottom: 20 }}>
          {(['health', 'users', 'cache', 'endpoints', 'lob'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', borderBottom: tab === t ? `2px solid ${RED}` : '2px solid transparent',
              color: tab === t ? RED : '#6b7280', fontFamily: 'var(--theme-mono)', fontSize: 10,
              fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '8px 16px', cursor: 'pointer',
            }}>
              {t}
            </button>
          ))}
        </div>

        {/* ── Health tab ── */}
        {tab === 'health' && (
          <div>
            <button onClick={loadHealth} disabled={loading} style={{ ...btn(), marginBottom: 16 }}>
              {loading ? '…' : 'Run Health Check'}
            </button>
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
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: '#6b7280' }}>{k}</span>
                        <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: '#fca5a5', margin: '2px 0 0' }}>{v}</p>
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
                        background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.15)',
                        border: `1px solid ${ok ? 'rgba(34,197,94,0.3)' : RED_BORDER}`,
                        color: ok ? '#86efac' : '#fca5a5',
                      }}>
                        {key} {ok ? '✓' : '✗'}
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
            {stats && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
                  {[
                    ['Total Users', stats.total_users],
                    ['New (7d)', stats.new_last_7d],
                    ['New (30d)', stats.new_last_30d],
                  ].map(([k, v]) => (
                    <div key={String(k)} style={card}>
                      <p style={label(String(k))}>{k}</p>
                      <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 22, color: RED, margin: 0 }}>{v}</p>
                    </div>
                  ))}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${RED_BORDER}` }}>
                        {['Username', 'Display Name', 'Created', 'Last Login', 'Logins'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: 'rgba(239,68,68,0.6)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stats.users.map(u => (
                        <tr key={u.id} style={{ borderBottom: `1px solid rgba(239,68,68,0.07)` }}>
                          <td style={{ padding: '6px 8px', color: '#fca5a5' }}>@{u.username}</td>
                          <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{u.display_name}</td>
                          <td style={{ padding: '6px 8px', color: '#6b7280' }}>{u.created_at?.slice(0, 10)}</td>
                          <td style={{ padding: '6px 8px', color: '#6b7280' }}>{u.last_login_at?.slice(0, 10) ?? '—'}</td>
                          <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{u.login_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Cache tab ── */}
        {tab === 'cache' && (
          <div>
            {msg && (
              <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: msgErr ? RED : '#86efac', marginBottom: 12 }}>{msg}</p>
            )}
            <div style={card}>
              <p style={label('Cache Control')}>Cache Control</p>
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: '#6b7280', marginBottom: 14 }}>
                Evicts all expired entries from the in-memory cache. Use after restarting the backend or rotating API keys.
              </p>
              <button onClick={evictCache} style={btn()}>Evict Expired Cache</button>
            </div>
            <div style={card}>
              <p style={label('Info')}>How caching works</p>
              <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: '#6b7280', lineHeight: 1.7 }}>
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
                    background: 'rgba(239,68,68,0.07)', border: `1px solid ${RED_BORDER}`,
                    color: '#fca5a5', cursor: 'pointer',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {epResult && (
              <pre style={{
                background: '#0a0505', border: `1px solid ${RED_BORDER}`,
                color: '#fca5a5', fontFamily: 'var(--theme-mono)', fontSize: 10,
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
            <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
              Paste CSV with columns: <code style={{ fontFamily: 'var(--theme-mono)', color: '#fca5a5', fontSize: 10 }}>timestamp, side, price, size, order_id</code>
            </p>

            {/* Load options */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                onClick={() => setLobCsv(SAMPLE_CSV)}
                style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '4px 10px', background: 'rgba(239,68,68,0.1)', border: `1px solid ${RED_BORDER}`, color: '#fca5a5', cursor: 'pointer' }}
              >
                Load Sample Data
              </button>
              <label style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '4px 10px', background: 'rgba(239,68,68,0.07)', border: `1px solid ${RED_BORDER}`, color: '#fca5a5', cursor: 'pointer' }}>
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
                  style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, padding: '4px 10px', background: 'transparent', border: `1px solid ${RED_BORDER}`, color: '#6b7280', cursor: 'pointer' }}>
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
                color: '#fca5a5', fontFamily: 'var(--theme-mono)', fontSize: 10,
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
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: '#fca5a5' }}>
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
                        <span style={{ color: '#6b7280' }}>
                          Mid: <span style={{ color: '#fca5a5' }}>{snap.mid?.toFixed(4) ?? 'N/A'}</span>
                        </span>
                        <span style={{ color: '#6b7280' }}>
                          Imbalance: <span style={{ color: snap.imbalance != null && snap.imbalance > 0 ? '#86efac' : '#fca5a5' }}>
                            {snap.imbalance != null ? (snap.imbalance >= 0 ? '+' : '') + snap.imbalance.toFixed(3) : 'N/A'}
                          </span>
                        </span>
                      </div>
                      {/* Asks (reversed so best ask is closest to mid) */}
                      {[...snap.asks].reverse().map(([price, size]) => (
                        <div key={price} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span style={{ color: '#fca5a5', width: 80, textAlign: 'right' }}>{price.toFixed(4)}</span>
                          <div style={{ flex: 1, background: 'rgba(239,68,68,0.08)', height: 12, position: 'relative' }}>
                            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(size / maxSize) * 100}%`, background: 'rgba(239,68,68,0.4)' }} />
                          </div>
                          <span style={{ color: '#6b7280', width: 60 }}>{size.toFixed(0)}</span>
                        </div>
                      ))}
                      <div style={{ borderTop: `1px solid ${RED_BORDER}`, margin: '6px 0' }} />
                      {snap.bids.map(([price, size]) => (
                        <div key={price} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span style={{ color: '#86efac', width: 80, textAlign: 'right' }}>{price.toFixed(4)}</span>
                          <div style={{ flex: 1, background: 'rgba(34,197,94,0.08)', height: 12, position: 'relative' }}>
                            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(size / maxSize) * 100}%`, background: 'rgba(34,197,94,0.35)' }} />
                          </div>
                          <span style={{ color: '#6b7280', width: 60 }}>{size.toFixed(0)}</span>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
