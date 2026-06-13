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
const POLL_MS   = 30_000   // polling interval when tab hidden
const BACKOFF   = [1000, 2000, 4000, 8000, 16000, 30000]

export function useAlertSocket(userId: string | null, onAlert: Handler) {
  const wsRef       = useRef<WebSocket | null>(null)
  const retryRef    = useRef(0)
  const retryTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimer   = useRef<ReturnType<typeof setInterval> | null>(null)
  const onAlertRef  = useRef<Handler>(onAlert)
  onAlertRef.current = onAlert

  const token = localStorage.getItem('ft-session-token') ?? ''

  const clearTimers = () => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    if (pollTimer.current)  { clearInterval(pollTimer.current); pollTimer.current = null }
  }

  const disconnect = useCallback(() => {
    clearTimers()
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    if (!userId || pollTimer.current) return
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/alerts/${userId}/pending`)
        const data = await res.json()
        for (const row of data.triggered ?? []) {
          onAlertRef.current({
            type:          'alert_triggered',
            alert_id:      row.id,
            ticker:        row.ticker,
            condition:     row.condition,
            threshold:     row.threshold,
            current_price: 0,
            pct_1d:        0,
            triggered_at:  row.cooldown_until - 3600,
            cooldown_until: row.cooldown_until,
          })
        }
      } catch { /* network error, ignore */ }
    }, POLL_MS)
  }, [userId])

  const stopPolling = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
  }, [])

  const connect = useCallback(() => {
    if (!userId || !token) return
    disconnect()

    const url = `${WS_BASE}/api/alerts/ws/${userId}?token=${token}`
    const ws  = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      retryRef.current = 0
      stopPolling()
      // Keep-alive ping every 25s
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        else clearInterval(ping)
      }, 25_000)
    }

    ws.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as AlertPayload
        if (payload.type === 'alert_triggered') onAlertRef.current(payload)
      } catch { /* ignore pong */ }
    }

    ws.onclose = (e) => {
      wsRef.current = null
      if (e.code === 4001) return   // auth failure — don't retry
      if (document.hidden) {
        startPolling()
        return
      }
      const delay = BACKOFF[Math.min(retryRef.current, BACKOFF.length - 1)]
      retryRef.current++
      retryTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = () => { ws.close() }
  }, [userId, token, disconnect, startPolling, stopPolling])

  // Visibility change: WS when visible, poll when hidden
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        disconnect()
        startPolling()
      } else {
        stopPolling()
        connect()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [connect, disconnect, startPolling, stopPolling])

  // Connect/disconnect based on userId
  useEffect(() => {
    if (userId && token) {
      connect()
    } else {
      disconnect()
    }
    return disconnect
  }, [userId, token, connect, disconnect])
}
