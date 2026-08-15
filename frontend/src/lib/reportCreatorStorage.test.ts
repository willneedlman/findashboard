import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, getProject, replaceAlphaTapeClips, reportStorageUsage } from './reportCreator'
import type { ClipDraft } from './reportCreator'

// A minimal store rather than jsdom: the module under test only needs
// getItem/setItem, and the repo has no DOM environment installed.
class MemoryStorage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}
const memory = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } },
  configurable: true,
})
Object.defineProperty(globalThis, 'Event', { value: class { constructor(public type: string) {} }, configurable: true })

const draft = (key: string): ClipDraft => ({
  sourceTab: 'Peer Comparison',
  dataType: 'table',
  payload: { kind: 'table', title: `Table ${key}`, columns: ['a'], rows: [['1']] },
  researchSourceId: 'peer-valuation',
  researchKey: key,
})

/**
 * A write that fails silently is indistinguishable from one that never
 * happened: every read goes back to localStorage, so the UI keeps showing the
 * old state with no error. In the wizard that presented as research completing,
 * every source reporting collected, and the button never advancing past
 * "Run AlphaTape research" no matter how many times it was clicked.
 */
describe('report store persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    memory.clear()
  })

  it('reports success when the write lands', () => {
    const project = createProject('Test')
    const result = replaceAlphaTapeClips(project.id, [draft('peer-valuation:NVDA')])
    expect(result.persisted).toBe(true)
    expect(result.added).toBe(1)
    expect(getProject(project.id)?.clips).toHaveLength(1)
  })

  it('reports failure rather than swallowing a full quota', () => {
    const project = createProject('Test')
    const quota = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e }
    vi.spyOn(memory, 'setItem').mockImplementation(quota)

    const result = replaceAlphaTapeClips(project.id, [draft('peer-valuation:NVDA')])

    expect(result.persisted).toBe(false)
  })

  it('leaves the stored clips untouched when the save fails', () => {
    const project = createProject('Test')
    replaceAlphaTapeClips(project.id, [draft('peer-valuation:NVDA')])
    const quota = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e }
    vi.spyOn(memory, 'setItem').mockImplementation(quota)

    const result = replaceAlphaTapeClips(project.id, [draft('peer-valuation:AMD'), draft('peer-valuation:AVGO')])

    expect(result.persisted).toBe(false)
    // The read goes back to storage, so the caller must not believe the merge.
    expect(getProject(project.id)?.clips).toHaveLength(1)
  })

  it('describes what is taking the space, so the message can name a cause', () => {
    createProject('One')
    createProject('Two')
    const usage = reportStorageUsage()
    expect(usage.projects).toBe(2)
    expect(usage.snapshots).toBe(0)
    expect(usage.chars).toBeGreaterThan(0)
  })
})
