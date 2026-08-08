import { T } from '../lib/theme'
import { useState, useEffect, useCallback } from 'react'
import type { AlertPayload } from '../hooks/useAlertSocket'

const STORAGE_KEY = 'ft-alert-toasts'
const MAX_TOASTS  = 5
const DISMISS_MS  = 8000


function conditionLabel(condition: string, threshold: number): string {
  switch (condition) {
    case 'price_above':          return `> $${threshold}`
    case 'price_below':          return `< $${threshold}`
    case 'pct_change_1d_above':  return `1D% > ${threshold}%`
    case 'pct_change_1d_below':  return `1D% < ${threshold}%`
    case 'strategy_entry':        return 'Entry signal fired'
    case 'strategy_exit':         return 'Exit signal fired'
    case 'macro_event_within_days': return `Macro events within ${threshold}d`
    default:                      return `${condition} ${threshold}`
  }
}

interface Toast extends AlertPayload {
  key: string
}

function loadPersisted(): Toast[] {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}
function savePersisted(toasts: Toast[]) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toasts)) } catch { /* quota */ }
}

interface Props { alerts: AlertPayload[] }

export default function AlertToastQueue({ alerts }: Props) {
  const [toasts, setToasts] = useState<Toast[]>(loadPersisted)

  // Add incoming alerts
  useEffect(() => {
    if (!alerts.length) return
    setToasts(prev => {
      const next = [
        ...alerts.map(a => ({ ...a, key: `${a.alert_id}-${a.triggered_at}` })),
        ...prev,
      ].slice(0, MAX_TOASTS)
      savePersisted(next)
      return next
    })
  }, [alerts])

  const dismiss = useCallback((key: string) => {
    setToasts(prev => {
      const next = prev.filter(t => t.key !== key)
      savePersisted(next)
      return next
    })
  }, [])

  // Auto-dismiss
  useEffect(() => {
    if (!toasts.length) return
    const timer = setTimeout(() => {
      setToasts(prev => {
        const next = prev.slice(0, -1)
        savePersisted(next)
        return next
      })
    }, DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toasts])

  if (!toasts.length) return null

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div key={t.key} style={{
          pointerEvents: 'auto',
          background: 'var(--theme-surface)',
          border: `1px solid ${T.gold}`,
          borderLeft: `3px solid ${T.gold}`,
          padding: '10px 12px',
          minWidth: 240, maxWidth: 320,
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          animation: 'ft-toast-in 0.2s ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: T.gold, fontFamily: T.mono }}>
                  ALERT TRIGGERED
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text, #d7e3fc)', fontFamily: T.mono, letterSpacing: '0.06em' }}>
                {t.ticker}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: T.mono, marginTop: 2 }}>
                {conditionLabel(t.condition, t.threshold)}
                {t.fired_tickers?.length
                  ? ` → ${t.fired_tickers.join(', ')}`
                  : t.current_price > 0 && ` → $${t.current_price.toFixed(2)}`}
              </div>
            </div>
            <button
              onClick={() => dismiss(t.key)}
              style={{ background: 'none', border: 'none', color: 'var(--theme-secondary, #8099b0)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
            >×</button>
          </div>
        </div>
      ))}
      <style>{`
        @keyframes ft-toast-in {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
