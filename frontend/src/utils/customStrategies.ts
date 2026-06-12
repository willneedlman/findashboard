import type { CustomStrategyDef } from '../components/CustomStrategyModal'

const STORAGE_KEY = 'fdb_custom_strategies'

export function loadCustomStrategies(): CustomStrategyDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveCustomStrategy(def: CustomStrategyDef): void {
  const all = loadCustomStrategies()
  const idx = all.findIndex(s => s.name === def.name)
  if (idx >= 0) all[idx] = def
  else all.push(def)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function deleteCustomStrategy(name: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(
    loadCustomStrategies().filter(s => s.name !== name)
  ))
}
