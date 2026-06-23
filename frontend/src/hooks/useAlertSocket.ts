import { useEffect, useRef, useCallback } from 'react'

export interface AlertPayload {
  type:          'alert_triggered'
  alert_id:      string
  ticker:        string
  condition:     string
  threshold:     number
  current_price: number
  pct_1d:        number
  triggered_at:  number
  cooldown_until: number
}

type Handler = (alert: AlertPayload) => void

// Match the page protocol: wss:// on HTTPS, ws:// on plain HTTP. A hardcoded
// ws:// is blocked as mixed content when the app is served over HTTPS.
const WS_BASE   = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
const POLL_MS   = 20_000   // /pending catch-up cadence (runs alongside the ws)
const BACKOFF   = [1000, 2000, 4000, 8000, 16000, 30000]

export function useAlertSocket(userId: string | null, onAlert: Handler) {
  const wsRef       = useRef<WebSocket | null>(null)
  const retryRef    = useRef(0)
  const retryTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimer   = useRef<ReturnType<typeof setInterval> | null>(null)
  const onAlertRef  = useRef<Handler>(onAlert)
  onAlertRef.current = onAlert
  const seenRef     = useRef<Set<string>>(new Set())

  const token = localStorage.getItem('ft-session-token') ?? ''

  // Single delivery point for both transports. The ws gives instant delivery;
  // the poll is a reliable catch-up for any broadcast missed during a reconnect.
  // Dedupe by (alert id, fire time) so the two never double-fire.
  const dispatch = useCallback((p: AlertPayload) => {
    const key = `${p.alert_id}:${p.cooldown_until}`
    if (seenRef.current.has(key)) return
    seenRef.current.add(key)
    if (seenRef.current.size > 200) seenRef.current = new Set([...seenRef.current].slice(-100))
    onAlertRef.current(p)
  }, [])

  const poll = useCallback(async () => {
    if (!userId) return
    try {
      const res = await fetch(`/api/alerts/${userId}/pending`)
      const data = await res.json()
      for (const row of data.triggered ?? []) {
        dispatch({
          type:           'alert_triggered',
          alert_id:       row.id,
          ticker:         row.ticker,
          condition:      row.condition,
          threshold:      row.threshold,
          current_price:  0,
          pct_1d:         0,
          triggered_at:   row.cooldown_until - 3600,
          cooldown_until: row.cooldown_until,
        })
      }
    } catch { /* network error, ignore */ }
  }, [userId, dispatch])

  const connect = useCallback(() => {
    if (!userId || !token) return
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close() }

    const ws = new WebSocket(`${WS_BASE}/api/alerts/ws/${userId}?token=${token}`)
    wsRef.current = ws

    ws.onopen = () => {
      retryRef.current = 0
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        else clearInterval(ping)
      }, 25_000)
    }
    ws.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as AlertPayload
        if (payload.type === 'alert_triggered') dispatch(payload)
      } catch { /* ignore pong */ }
    }
    ws.onclose = (e) => {
      wsRef.current = null
      if (e.code === 4001) return   // auth failure — don't retry
      const delay = BACKOFF[Math.min(retryRef.current, BACKOFF.length - 1)]
      retryRef.current++
      retryTimer.current = setTimeout(connect, delay)
    }
    ws.onerror = () => { ws.close() }
  }, [userId, token, dispatch])

  // Run the ws and the catch-up poll together for the whole session.
  useEffect(() => {
    if (!userId || !token) return
    connect()
    poll()
    pollTimer.current = setInterval(poll, POLL_MS)
    return () => {
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null }
      if (retryTimer.current) clearTimeout(retryTimer.current)
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [userId, token, connect, poll])
}
