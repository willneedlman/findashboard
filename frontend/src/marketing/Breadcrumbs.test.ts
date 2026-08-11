import { describe, expect, it } from 'vitest'
import { breadcrumbSchema } from './Breadcrumbs'

describe('breadcrumbSchema', () => {
  it('emits a positioned BreadcrumbList crawlers can read', () => {
    const parsed = JSON.parse(breadcrumbSchema([
      { label: 'Alphatape', to: '/' },
      { label: 'Options' },
    ]))
    expect(parsed['@type']).toBe('BreadcrumbList')
    expect(parsed.itemListElement).toHaveLength(2)
    expect(parsed.itemListElement[0]).toMatchObject({ position: 1, name: 'Alphatape', item: 'https://alphatape.app/' })
  })

  it('leaves the current page without a link', () => {
    // A self-referential final crumb is the one shape Google flags; the last
    // item carries a name only.
    const parsed = JSON.parse(breadcrumbSchema([
      { label: 'Alphatape', to: '/' },
      { label: 'Macro' },
    ]))
    expect(parsed.itemListElement[1].item).toBeUndefined()
    expect(parsed.itemListElement[1].name).toBe('Macro')
  })

  it('resolves relative paths against the canonical origin', () => {
    const parsed = JSON.parse(breadcrumbSchema([
      { label: 'Alphatape', to: '/' },
      { label: 'Research', to: '/product/research' },
      { label: 'Screener' },
    ]))
    expect(parsed.itemListElement[1].item).toBe('https://alphatape.app/product/research')
    expect(parsed.itemListElement.map((i: {position: number}) => i.position)).toEqual([1, 2, 3])
  })
})
