import { describe, expect, it } from 'vitest'
import type { ReportClip } from './reportCreator'
import { selectReportAppendixData } from './reportPresentation'

function clip(id: string, kind: 'chart' | 'table' | 'kpi' | 'text'): ReportClip {
  const payload = kind === 'chart'
    ? { kind, chartType: 'line' as const, xKey: 'x', data: [], series: [] }
    : kind === 'table'
      ? { kind, columns: ['Ticker'], rows: [['AAPL']] }
      : kind === 'kpi'
        ? { kind, cells: [{ label: 'Price', value: '$100' }] }
        : { kind, body: 'Supporting note' }
  return {
    id,
    sourceTab: 'Test',
    capturedAt: '2026-07-29T00:00:00.000Z',
    dataType: kind,
    payload,
    projectId: 'project',
  }
}

describe('selectReportAppendixData', () => {
  it('omits every chart, including explicitly appended unused visuals', () => {
    const clips = [clip('chart', 'chart'), clip('table', 'table')]
    expect(selectReportAppendixData(['chart', 'table'], clips).map(item => item.id))
      .toEqual(['table'])
  })

  it('deduplicates and ranks selected supporting data', () => {
    const clips = [clip('table', 'table'), clip('kpi', 'kpi'), clip('text', 'text')]
    expect(selectReportAppendixData(['table', 'text', 'kpi', 'table'], clips).map(item => item.id))
      .toEqual(['kpi', 'table', 'text'])
  })

  it('omits structurally empty tables that only contain orphaned numeric values', () => {
    const emptyActivity = clip('empty', 'table')
    emptyActivity.payload = {
      kind: 'table',
      columns: ['Date', 'Type', 'Counterparty', 'Value'],
      rows: [
        ['—', '—', '—', 3000],
        ['—', '—', '—', 1600],
        ['—', '—', '—', 625],
      ],
    }
    const holders = clip('holders', 'table')
    holders.payload = {
      kind: 'table',
      columns: ['Holder', 'Shares', '% Out'],
      rows: [['BlackRock', 4_065_810, 9.46]],
    }

    expect(selectReportAppendixData(['empty', 'holders'], [emptyActivity, holders]).map(item => item.id))
      .toEqual(['holders'])
  })
})
