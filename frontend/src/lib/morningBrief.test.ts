import { describe, expect, it, beforeEach } from 'vitest'
import { hasSeenMorningBriefToday, localDayKey, markMorningBriefSeenToday } from './morningBrief'

const store = new Map<string, string>()
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
  key: () => null,
  get length() { return store.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })

describe('morningBrief day gate', () => {
  beforeEach(() => {
    store.clear()
  })

  it('localDayKey is YYYY-MM-DD', () => {
    expect(localDayKey(new Date('2026-07-19T15:00:00'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('marks and detects seen for today', () => {
    expect(hasSeenMorningBriefToday()).toBe(false)
    markMorningBriefSeenToday()
    expect(hasSeenMorningBriefToday()).toBe(true)
  })
})
