import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTheme } from './ThemeContext'

export interface PortfolioHolding {
  ticker:    string
  weight:    number
  strategy?: string
}

interface PortfolioCtx {
  holdings:       PortfolioHolding[]
  tickers:        string[]
  setHoldings:    (h: PortfolioHolding[]) => void
  clearPortfolio: () => void
}

const ANON_KEY = 'ft-portfolio'

function storageKey(userId: string | null) {
  return userId ? `ft-portfolio-${userId}` : ANON_KEY
}
function loadFromStorage(key: string): PortfolioHolding[] {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') } catch { return [] }
}
function saveToStorage(key: string, h: PortfolioHolding[]) {
  try { localStorage.setItem(key, JSON.stringify(h)) } catch { /* quota */ }
}

async function fetchFromServer(userId: string): Promise<PortfolioHolding[]> {
  try {
    const res = await fetch(`/api/users/portfolio/${userId}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.holdings ?? []
  } catch { return [] }
}

async function pushToServer(userId: string, holdings: PortfolioHolding[]) {
  try {
    await fetch('/api/users/portfolio', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, holdings }),
    })
  } catch { /* network error — ignore, localStorage is source of truth */ }
}

const Ctx = createContext<PortfolioCtx>({
  holdings: [], tickers: [], setHoldings: () => {}, clearPortfolio: () => {},
})

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { user } = useTheme()
  const userId = user?.id ?? null

  const [holdings, setHoldingsState] = useState<PortfolioHolding[]>(() =>
    loadFromStorage(storageKey(userId))
  )

  // Debounce server sync — don't hammer the API on every keystroke
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncToServer = useCallback((uid: string, h: PortfolioHolding[]) => {
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => pushToServer(uid, h), 1500)
  }, [])

  // When user logs in/out — reload portfolio from the correct source
  useEffect(() => {
    const key = storageKey(userId)
    const local = loadFromStorage(key)

    if (userId) {
      // Show local immediately, then overwrite with server if server has data
      if (local.length > 0) setHoldingsState(local)
      fetchFromServer(userId).then(server => {
        if (server.length > 0) {
          setHoldingsState(server)
          saveToStorage(key, server)
        } else if (local.length > 0) {
          // Push local holdings up to server so they're persisted
          pushToServer(userId, local)
        }
      })
    } else {
      setHoldingsState(local)
    }
  }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps

  const setHoldings = useCallback((h: PortfolioHolding[]) => {
    setHoldingsState(h)
    const key = storageKey(userId)
    saveToStorage(key, h)
    if (userId) syncToServer(userId, h)
  }, [userId, syncToServer])

  const clearPortfolio = useCallback(() => {
    setHoldingsState([])
    const key = storageKey(userId)
    localStorage.removeItem(key)
    if (userId) pushToServer(userId, [])
  }, [userId])

  const tickers = holdings.map(h => h.ticker)

  return (
    <Ctx.Provider value={{ holdings, tickers, setHoldings, clearPortfolio }}>
      {children}
    </Ctx.Provider>
  )
}

export function usePortfolio() { return useContext(Ctx) }
