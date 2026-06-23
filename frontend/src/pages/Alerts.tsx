import { T } from '../lib/theme'
import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerInput from '../components/TickerInput'
import useIsMobile from '../hooks/useIsMobile'
import { useTheme } from '../contexts/ThemeContext'

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
interface Quote { current_price: number; pct_change_1d: number | null }

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
  background: T.bg, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: T.text, fontFamily: T.mono, fontSize: 11,
  padding: '7px 10px', outline: 'none', width: '100%', boxSizing: 'border-box',
}
const lbl: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
  color: T.muted, fontFamily: T.label, marginBottom: 6, display: 'block',
}
const goldBtn: React.CSSProperties = {
  background: T.gold, color: '#0a1220', border: 'none', fontFamily: T.label,
  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  cursor: 'pointer', padding: '6px 14px',
}
const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label,
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer', padding: '5px 9px',
}

const NOTIF_KEY = 'ft-notif-asked'

export default function Alerts() {
  const { user } = useTheme()
  const isMobile = useIsMobile()
  const qc = useQueryClient()

  const [ticker,    setTicker]    = useState('')
  const [condition, setCondition] = useState('price_above')
  const [threshold, setThreshold] = useState('')
  const [filter,    setFilter]    = useState<'all' | 'armed' | 'cooldown'>('all')
  const [notifState, setNotifState] = useState<NotificationPermission | 'unsupported'>('default')

  useEffect(() => {
    if (!('Notification' in window)) setNotifState('unsupported')
    else setNotifState(Notification.permission)
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts', user?.id] }); setTicker(''); setThreshold('') },
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

  // Live quote per watched ticker — surfaces the metric each alert tracks.
  const tickers = useMemo(() => [...new Set(alerts.map(a => a.ticker))], [alerts])
  const { data: quotes } = useQuery<Record<string, Quote>>({
    queryKey: ['alert-quotes', tickers.join(',')],
    queryFn: async () => {
      const entries = await Promise.all(tickers.map(t =>
        axios.get(`/api/market/quote/${t}`).then(r => [t, r.data as Quote] as const).catch(() => [t, null] as const)))
      return Object.fromEntries(entries.filter(([, v]) => v)) as Record<string, Quote>
    },
    enabled: tickers.length > 0,
    staleTime: 30_000,
  })

  const isCooldown = (a: Alert) => a.cooldown_until > now
  const armedCount    = alerts.filter(a => !isCooldown(a)).length
  const cooldownCount = alerts.length - armedCount
  const todayStr = new Date().toDateString()
  const firedToday = alerts.filter(a => a.cooldown_until > 0 && new Date(a.cooldown_until * 1000).toDateString() === todayStr).length
  const notifsOn = notifState === 'granted'

  const shown = alerts.filter(a => filter === 'all' ? true : filter === 'armed' ? !isCooldown(a) : isCooldown(a))

  // ── Summary strip cell ──────────────────────────────────────────────────────
  const SummaryCell = ({ label, value, color, sub, primary }: { label: string; value: string; color?: string; sub?: React.ReactNode; primary?: boolean }) => (
    <div style={{ flex: primary ? 1.4 : 1, minWidth: 0, padding: '14px 18px', borderLeft: primary ? 'none' : `1px solid ${T.border}` }}>
      <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: primary ? 28 : 20, fontWeight: 700, color: color ?? T.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: T.mono, fontSize: 10, color: T.pos, marginTop: 6 }}>{sub}</div>}
    </div>
  )

  const filterChip = (key: 'all' | 'armed' | 'cooldown', label: string) => (
    <button key={key} onClick={() => setFilter(key)} style={{
      fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
      padding: '3px 9px', cursor: 'pointer', border: 'none',
      color: filter === key ? T.gold : T.muted,
      background: filter === key ? T.goldTint(14) : 'transparent',
    }}>{label}</button>
  )

  return (
    <PageWrapper>
      <PageHeader title="Price Alerts" actions={
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, letterSpacing: '0.04em' }}>
          Server-side monitor · checks every 1-5m
        </span>
      } />

      {/* Notification banner */}
      {notifState === 'default' && (
        <div style={{ background: T.goldTint(8), border: `1px solid ${T.goldTint(30)}`, padding: '11px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: T.text, fontFamily: T.label }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: T.gold, flexShrink: 0 }} />
            Enable browser notifications to receive alerts even when you're on another tab.
          </span>
          <button onClick={requestNotif} style={goldBtn}>Enable</button>
        </div>
      )}
      {notifState === 'denied' && (
        <div style={{ background: T.negTint(7), border: `1px solid ${T.negTint(25)}`, padding: '10px 16px', marginBottom: 20, fontSize: 10, color: T.neg, fontFamily: T.mono }}>
          Browser notifications are blocked — enable them in your browser settings to receive alerts.
        </div>
      )}

      {!user ? (
        <div className="ft-panel" style={{ padding: 48, textAlign: 'center', color: T.muted, fontSize: 12, fontFamily: T.mono }}>
          Log in to create and manage price alerts.
        </div>
      ) : (
        <>
          {/* Summary strip */}
          <div className="ft-panel" style={{ display: 'flex', marginBottom: 20, flexWrap: 'wrap' }}>
            <SummaryCell primary label="Active Alerts" value={`${alerts.length}`} color={T.gold}
              sub={<>{armedCount} armed · {cooldownCount} in cooldown</>} />
            <SummaryCell label="Armed"        value={`${armedCount}`}    color={T.pos} />
            <SummaryCell label="Cooldown"     value={`${cooldownCount}`} color={cooldownCount ? T.warn : T.text} />
            <SummaryCell label="Fired Today"  value={`${firedToday}`} />
            <SummaryCell label="Notifications" value={notifsOn ? 'On' : 'Off'} color={notifsOn ? T.gold : T.muted} />
          </div>

          {/* Body */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 280px) 1fr', gap: 20, alignItems: 'start' }}>
            {/* New Alert */}
            <div className="ft-panel">
              <div className="ft-panel-header">New Alert</div>
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lbl}>Ticker</label>
                  <TickerInput value={ticker} onChange={setTicker} placeholder="Ticker or company" style={inp} onEnter={submit} />
                </div>
                <div>
                  <label style={lbl}>Condition</label>
                  <select value={condition} onChange={e => setCondition(e.target.value)} style={{ ...inp, appearance: 'none', cursor: 'pointer' }}>
                    {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>{condition.includes('pct') ? 'Threshold (%)' : 'Threshold ($)'}</label>
                  <input value={threshold} onChange={e => setThreshold(e.target.value)} type="number" step="any" placeholder="0.00" style={inp}
                    onKeyDown={e => e.key === 'Enter' && submit()} />
                </div>
                <button onClick={submit} disabled={createMut.isPending || !ticker || !threshold}
                  style={{ ...goldBtn, padding: '9px 0', opacity: (createMut.isPending || !ticker || !threshold) ? 0.5 : 1, cursor: (createMut.isPending || !ticker || !threshold) ? 'default' : 'pointer' }}>
                  {createMut.isPending ? 'Creating…' : '+ Add Alert'}
                </button>
                <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>
                  Alerts are checked server-side every 1-5 minutes. After firing, an alert enters a short cooldown before it can trigger again; rearm it manually or wait for the cooldown to clear.
                </div>
              </div>
            </div>

            {/* Alert list */}
            <div className="ft-panel">
              <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Your Alerts · {alerts.length}</span>
                <span style={{ display: 'flex', gap: 2 }}>
                  {filterChip('all', 'All')}{filterChip('armed', 'Armed')}{filterChip('cooldown', 'Cooldown')}
                </span>
              </div>

              {isLoading ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>Loading…</div>
              ) : alerts.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>No alerts yet. Create one to get started.</div>
              ) : shown.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>No {filter} alerts.</div>
              ) : shown.map((alert, i) => {
                const cd = isCooldown(alert)
                const cooldownMin = cd ? Math.ceil((alert.cooldown_until - now) / 60) : 0
                const q = quotes?.[alert.ticker]
                const isPct = alert.condition.includes('pct')
                const readLabel = isPct ? '1D Change' : 'Last'
                let readValue = '—', readColor = T.text
                if (q) {
                  if (isPct && q.pct_change_1d != null) {
                    readValue = `${q.pct_change_1d >= 0 ? '+' : ''}${q.pct_change_1d.toFixed(2)}%`
                    readColor = q.pct_change_1d >= 0 ? T.pos : T.neg
                  } else if (!isPct) {
                    readValue = `$${q.current_price.toFixed(2)}`
                    readColor = q.pct_change_1d == null ? T.text : q.pct_change_1d >= 0 ? T.pos : T.neg
                  }
                }
                return (
                  <div key={alert.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: i < shown.length - 1 ? `1px solid var(--theme-hover, rgba(255,255,255,0.05))` : 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {/* Status dot */}
                    <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                      background: cd ? T.warn : T.pos,
                      boxShadow: cd ? 'none' : '0 0 8px rgba(34,197,94,0.6)' }} />

                    {/* Body */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: cd ? T.warn : T.gold, letterSpacing: '0.08em' }}>{alert.ticker}</span>
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>{conditionLabel(alert.condition, alert.threshold)}</span>
                        {cd && (
                          <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: T.warn, background: 'color-mix(in srgb, var(--theme-warn, #e8c04a) 14%, transparent)', border: `1px solid color-mix(in srgb, var(--theme-warn, #e8c04a) 35%, transparent)`, padding: '1px 5px' }}>
                            COOLDOWN {cooldownMin}m
                          </span>
                        )}
                      </div>
                      <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
                        {cd
                          ? `Cooldown ends ${new Date(alert.cooldown_until * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          : 'Armed'} · created {new Date(alert.created_at * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </div>
                    </div>

                    {/* Value readout */}
                    <div style={{ flexShrink: 0, textAlign: 'right' }}>
                      <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>{readLabel}</div>
                      <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: readColor }}>{readValue}</div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {cd && (
                        <button onClick={() => rearmMut.mutate(alert.id)} style={ghostBtn}
                          onMouseEnter={e => (e.currentTarget.style.color = T.gold)}
                          onMouseLeave={e => (e.currentTarget.style.color = T.muted)}>Rearm</button>
                      )}
                      <button onClick={() => deleteMut.mutate(alert.id)} aria-label="Delete alert"
                        style={{ ...ghostBtn, padding: '5px 9px', fontSize: 12, lineHeight: 1 }}
                        onMouseEnter={e => { e.currentTarget.style.color = T.neg; e.currentTarget.style.borderColor = T.negTint(45) }}
                        onMouseLeave={e => { e.currentTarget.style.color = T.muted; e.currentTarget.style.borderColor = T.border }}>×</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </PageWrapper>
  )
}
