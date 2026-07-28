// Saved-strategy library for the Options Strategy Builder. Persists user-built
// leg structures in localStorage (per-browser, the same idiom as the watchlist
// pe_wl key) so a strategy can be saved, reloaded, and removed inside the tool.
// A window event keeps every mounted surface live and cross-tab.

import { useEffect, useState } from 'react'
import type { Leg } from './shared'

const KEY = 'ft_saved_option_strategies_v1'
const EVT = 'ft:saved-option-strategies'
const CAP = 100

export interface SavedStrategy {
  id: string
  name: string
  legs: Leg[]
  spotOverrides: Record<string, number>
  savedAt: string   // ISO
}

const uid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function emit() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT)) }

export function getSavedStrategies(): SavedStrategy[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const d = JSON.parse(raw)
    if (!Array.isArray(d)) return []
    return d.filter((s: unknown): s is SavedStrategy => {
      const x = s as Partial<SavedStrategy>
      return !!x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.legs)
    })
  } catch { return [] }
}

function write(list: SavedStrategy[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* quota — drop silently */ }
  emit()
}

export function saveStrategy(name: string, legs: Leg[], spotOverrides: Record<string, number>): SavedStrategy {
  const item: SavedStrategy = {
    id: uid(),
    name: name.trim() || 'Untitled strategy',
    legs: clone(legs),
    spotOverrides: clone(spotOverrides || {}),
    savedAt: new Date().toISOString(),
  }
  write([item, ...getSavedStrategies()].slice(0, CAP))
  return item
}

export function renameSavedStrategy(id: string, name: string) {
  write(getSavedStrategies().map(s => (s.id === id ? { ...s, name: name.trim() || s.name } : s)))
}

export function deleteSavedStrategy(id: string) {
  write(getSavedStrategies().filter(s => s.id !== id))
}

// Reactive list for the tool. Re-reads on same-tab writes and cross-tab storage.
export function useSavedStrategies(): SavedStrategy[] {
  const [list, setList] = useState<SavedStrategy[]>(getSavedStrategies)
  useEffect(() => {
    const read = () => setList(getSavedStrategies())
    window.addEventListener(EVT, read)
    window.addEventListener('storage', read)
    return () => { window.removeEventListener(EVT, read); window.removeEventListener('storage', read) }
  }, [])
  return list
}

export const savedStrategyTicker = (s: SavedStrategy): string =>
  [...new Set(s.legs.map(l => l.ticker))].join('/') || '—'
