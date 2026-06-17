import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import { useTheme } from '../contexts/ThemeContext'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.07))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive, #22c55e)',
  neg:     'var(--theme-negative, #ef4444)',
}

const CONDITIONS = [
  { value: 'price_above',         label: 'Price above $' },
  { value: 'price_below',         label: 'Price below $' },
  { value: 'pct_change_1d_above', label: '1-Day % change above %' },
  { value: 'pct_change_1d_below', label: '1-Day % change below %' },
]

interface Alert {
  id:            string
  ticker:        string
  condition:     string
  threshold:     number
  active:        number
  cooldown_until: number
  created_at:    number
}

function conditionLabel(cond: string, threshold: number): string {
  switch (cond) {
    case 'price_above':          return `Price > $${threshold}`
    case 'price_below':          return `Price < $${threshold}`
    case 'pct_change_1d_above':  return `1D% > ${threshold}%`
    case 'pct_change_1d_below':  return `1D% < ${threshold}%`
    default:                      return `${cond} ${threshold}`
  }
}

const inp: React.CSSProperties = {
  background: T.surface, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: T.text, fontFamily: T.mono, fontSize: 11,
  padding: '6px 10px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

const btn = (variant: 'gold' | 'muted' | 'danger'): React.CSSProperties => ({
  padding: '6px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', fontFamily: T.label, cursor: 'pointer', border: '1px solid',
  borderColor: variant === 'gold' ? T.gold : variant === 'danger' ? T.neg : T.border,
  background: variant === 'gold' ? T.gold : 'transparent',
  color: variant === 'gold' ? '#0a1220' : variant === 'danger' ? T.neg : T.muted,
})

const NOTIF_KEY = 'ft-notif-asked'

export default function Alerts() {
  const { user } = useTheme()
  const qc = useQueryClient()

  const [ticker,    setTicker]    = useState('')
  const [condition, setCondition] = useState('price_above')
  const [threshold, setThreshold] = useState('')
  const [notifState, setNotifState] = useState<NotificationPermission | 'unsupported'>('default')

  // Check notification permission on mount
  useEffect(() => {
    if (!('Notification' in window)) {
      setNotifState('unsupported')
    } else {
      setNotifState(Notification.permission)
    }
  }, [])

  const requestNotif = async () => {
    if (!('Notification' in window)) return
    const perm = await Notification.requestPermission()
    setNotifState(perm)
    localStorage.setItem(NOTIF_KEY, perm)
  }

  const { data, isLoading } = useQuery<{ alerts: Alert[] }>({
    queryKey:  ['alerts', user?.id],
    queryFn:   () => axios.get(`/api/alerts/${user!.id}`).then(r => r.data),
    enabled:   !!user,
    staleTime: 10_000,
  })

  const createMut = useMutation({
    mutationFn: (body: object) => axios.post('/api/alerts', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts', user?.id] })
      setTicker(''); setThreshold('')
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/alerts/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts', user?.id] }),
  })

  const rearmMut = useMutation({
    mutationFn: (id: string) => axios.post(`/api/alerts/${id}/rearm`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts', user?.id] }),
  })

  const submit = () => {
    const sym = ticker.trim().toUpperCase()
    const val = parseFloat(threshold)
    if (!sym || isNaN(val) || !user) return
    createMut.mutate({ user_id: user.id, ticker: sym, condition, threshold: val })
  }

  const alerts = data?.alerts ?? []
  const now = Math.floor(Date.now() / 1000)

  const lbl: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
    color: T.muted, fontFamily: T.label, marginBottom: 6, display: 'block',
  }

  return (
    <PageWrapper title="Price Alerts">
      <div style={{ maxWidth: 820, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.gold, letterSpacing: '0.08em', margin: 0 }}>
            PRICE ALERTS
          </h1>
          <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, marginTop: 6 }}>
            Alerts evaluate every 60 seconds. Triggered alerts silence for 1 hour (rearm manually).
          </p>
        </div>

        {/* Notification permission banner */}
        {notifState === 'default' && (
          <div style={{
            background: 'color-mix(in srgb, var(--theme-primary) 8%, transparent)', border: `1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)`,
            padding: '10px 14px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <span style={{ fontSize: 11, color: T.text, fontFamily: T.label }}>
              Enable browser notifications to receive alerts even when you're on another tab.
            </span>
            <button onClick={requestNotif} style={btn('gold')}>Enable</button>
          </div>
        )}
        {notifState === 'denied' && (
          <div style={{ background: 'color-mix(in srgb, var(--theme-negative) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 25%, transparent)', padding: '8px 14px', marginBottom: 20, fontSize: 10, color: 'var(--theme-negative)', fontFamily: T.mono }}>
            Browser notifications blocked.
          </div>
        )}

        {/* Not logged in */}
        {!user && (
          <div style={{ padding: 40, textAlign: 'center', color: T.muted, fontSize: 12, fontFamily: T.mono, border: `1px solid ${T.border}` }}>
            Log in to create and manage price alerts.
          </div>
        )}

        {user && (
          <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24, alignItems: 'start' }}>

            {/* Create form */}
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, fontFamily: T.label, marginBottom: 14 }}>
                New Alert
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={lbl}>Ticker</label>
                  <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
                    placeholder="AAPL" style={inp}
                    onKeyDown={e => e.key === 'Enter' && submit()} />
                </div>

                <div>
                  <label style={lbl}>Condition</label>
                  <select value={condition} onChange={e => setCondition(e.target.value)}
                    style={{ ...inp, appearance: 'none' }}>
                    {CONDITIONS.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={lbl}>
                    {condition.includes('pct') ? 'Threshold (%)' : 'Threshold ($)'}
                  </label>
                  <input value={threshold} onChange={e => setThreshold(e.target.value)}
                    type="number" step="any" placeholder="0.00" style={inp}
                    onKeyDown={e => e.key === 'Enter' && submit()} />
                </div>

                <button onClick={submit} disabled={createMut.isPending || !ticker || !threshold}
                  style={{ ...btn('gold'), opacity: createMut.isPending ? 0.5 : 1, padding: '8px 0' }}>
                  {createMut.isPending ? 'Creating…' : '+ Add Alert'}
                </button>
              </div>
            </div>

            {/* Alert list */}
            <div>
              {isLoading && (
                <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono, padding: 20, textAlign: 'center' }}>Loading…</div>
              )}

              {!isLoading && alerts.length === 0 && (
                <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono, padding: 40, textAlign: 'center', border: `1px solid ${T.border}` }}>
                  No alerts yet. Create one to get started.
                </div>
              )}

              {alerts.map(alert => {
                const inCooldown = alert.cooldown_until > now
                const cooldownMin = inCooldown ? Math.ceil((alert.cooldown_until - now) / 60) : 0
                return (
                  <div key={alert.id} style={{
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderLeft: `3px solid ${inCooldown ? T.muted : T.gold}`,
                    padding: '12px 14px', marginBottom: 8,
                    display: 'flex', alignItems: 'center', gap: 12,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: inCooldown ? T.muted : T.gold, letterSpacing: '0.08em' }}>
                          {alert.ticker}
                        </span>
                        {inCooldown && (
                          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, fontFamily: T.mono, background: 'var(--theme-hover, rgba(255,255,255,0.04))', padding: '1px 5px' }}>
                            COOLDOWN {cooldownMin}m
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono }}>
                        {conditionLabel(alert.condition, alert.threshold)}
                      </div>
                      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 3 }}>
                        Created {new Date(alert.created_at * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {inCooldown && (
                        <button onClick={() => rearmMut.mutate(alert.id)} style={btn('muted')}>
                          Rearm
                        </button>
                      )}
                      <button onClick={() => deleteMut.mutate(alert.id)} style={btn('danger')}>
                        ×
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
