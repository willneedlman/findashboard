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

// Clone a saved strategy under a fresh "<name> (copy)" name (numbered on
// repeat duplication so it never collides with saveCustomStrategy's
// upsert-by-name lookup), leaving the original untouched. Returns null if
// the source name isn't found.
export function duplicateCustomStrategy(name: string): CustomStrategyDef | null {
  const all = loadCustomStrategies()
  const source = all.find(s => s.name === name)
  if (!source) return null
  const existingNames = new Set(all.map(s => s.name))
  let copyName = `${name} (copy)`
  let n = 2
  while (existingNames.has(copyName)) copyName = `${name} (copy ${n++})`
  const clone: CustomStrategyDef = { ...JSON.parse(JSON.stringify(source)), name: copyName }
  all.push(clone)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  return clone
}
