import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultScope, mergeAlphaTapeClips, type ReportClip } from './reportCreator'
import {
  collectReportResearch,
  enhanceReportResearchPlan,
  inferResearchSymbols,
  parseResearchSymbols,
  planReportResearch,
  screenReportSymbols,
  runSavedScreen,
  readSavedScreens,
  SAVED_SCREENS_STORAGE_KEY,
} from './reportResearch'
import type { ActivePortfolioContext } from './pmImport'

const emptyPortfolio: ActivePortfolioContext = {
  id: '',
  name: 'No active portfolio',
  portfolioIds: [],
  isCombined: false,
  holdings: [],
  cashValue: 0,
  optionsCount: 0,
  futuresCount: 0,
  positionCount: 0,
  hasData: false,
}

const portfolio: ActivePortfolioContext = {
  ...emptyPortfolio,
  id: 'book-1',
  name: 'Core',
  portfolioIds: ['book-1'],
  holdings: [
    { ticker: 'AAPL', shares: 10, avgCost: 150 },
    { ticker: 'MSFT', shares: 5, avgCost: 300 },
  ],
  cashValue: 500,
  positionCount: 2,
  hasData: true,
}

describe('Report Creator AlphaTape research', () => {
  it('parses explicit symbols and ignores common uppercase prose', () => {
    expect(parseResearchSymbols('aapl, msft BRK.B')).toEqual(['AAPL', 'MSFT', 'BRK-B'])
    expect(inferResearchSymbols('Compare NVDA vs AAPL and include EPS')).toEqual(['NVDA', 'AAPL'])
  })

  it('uses the AI interpretation as an exact Stock Screener request', async () => {
    const requests: Array<{ url: string; body: any }> = []
    const selection = await screenReportSymbols(
      'Profitable technology companies growing revenue above 15%, sorted by the cheapest P/E',
      {
        get: async () => ({}),
        post: async (url, body) => {
          requests.push({ url, body })
          if (url === '/api/ai/screener-parse') {
            return {
              filters: [
                { field: 'revenueGrowth', operator: 'gt', value: 15, value2: null, param: null },
                { field: 'operatingMargin', operator: 'gt', value: 0, value2: null, param: null },
              ],
              sector: 'Technology',
              universe: 'sp500',
              exchange: null,
              region: 'North America',
              sort_by: 'peRatio',
              sort_dir: 'asc',
              sort_param: null,
              limit: 12,
              explanation: 'Find profitable, growing S&P 500 technology companies with the lowest P/E.',
            }
          }
          return {
            total: 14,
            results: [
              { ticker: 'ORCL' },
              { ticker: 'IBM' },
              { ticker: 'MSFT' },
              { ticker: 'AAPL' },
              { ticker: 'NVDA' },
              { ticker: 'AMD' },
              { ticker: 'ADBE' },
              { ticker: 'CRM' },
              { ticker: 'NOW' },
            ],
          }
        },
      },
    )
    expect(requests[0]).toEqual({
      url: '/api/ai/screener-parse',
      body: { query: 'Profitable technology companies growing revenue above 15%, sorted by the cheapest P/E' },
    })
    expect(requests[1].url).toBe('/api/screener/run')
    expect(requests[1].body).toMatchObject({
      sector: 'Technology',
      universe: 'sp500',
      region: 'North America',
      sort_by: 'peRatio',
      sort_dir: 'asc',
      limit: 8,
      filters: [
        { field: 'revenueGrowth', operator: 'gt', value: 15 },
        { field: 'operatingMargin', operator: 'gt', value: 0 },
      ],
    })
    expect(selection.symbols).toEqual(['ORCL', 'IBM', 'MSFT', 'AAPL', 'NVDA', 'AMD', 'ADBE', 'CRM'])
    expect(selection.total).toBe(14)
  })

  it('does not run a broad screen when the AI could not map the requested criteria', async () => {
    const urls: string[] = []
    await expect(screenReportSymbols('Companies with a high magic score', {
      get: async () => ({}),
      post: async url => {
        urls.push(url)
        return {
          valid: false,
          warning: '1 criterion could not be mapped to a supported screener field.',
          filters: [],
          sort_by: 'marketCap',
          sort_dir: 'desc',
          limit: 8,
        }
      },
    })).rejects.toThrow(/could not be mapped/i)
    expect(urls).toEqual(['/api/ai/screener-parse'])
  })

  it('keeps an explicitly named company ahead of its screened peers', async () => {
    const requests: Array<{ url: string; body: any }> = []
    const selection = await screenReportSymbols(
      'JPMorgan and other financial services companies and banks',
      {
        get: async () => ({}),
        post: async (url, body) => {
          requests.push({ url, body })
          if (url === '/api/ai/screener-parse') {
            return {
              valid: true,
              warning: null,
              filters: [],
              include_symbols: ['JPM'],
              sector: 'Financial Services',
              universe: null,
              exchange: null,
              region: null,
              sort_by: 'marketCap',
              sort_dir: 'desc',
              sort_param: null,
              limit: 4,
              explanation: 'JPMorgan and the largest Financial Services peers.',
            }
          }
          return {
            total: 20,
            results: [
              { ticker: 'BRK-B' },
              { ticker: 'V' },
              { ticker: 'MA' },
              { ticker: 'BAC' },
            ],
          }
        },
      },
    )

    expect(requests[1]).toEqual({
      url: '/api/screener/run',
      body: {
        filters: [],
        sector: 'Financial Services',
        universe: null,
        exchange: null,
        region: null,
        sort_by: 'marketCap',
        sort_dir: 'desc',
        sort_param: null,
        limit: 4,
      },
    })
    expect(selection.symbols).toEqual(['JPM', 'BRK-B', 'V', 'MA'])
    expect(selection.total).toBe(20)
  })

  it('builds a portfolio-risk plan around the active book', () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      goal: 'Assess risk and concentration in my portfolio',
    }
    const plan = planReportResearch(scope, portfolio)
    expect(plan.blockedReason).toBeUndefined()
    expect(plan.intent).toBe('portfolio')
    expect(plan.sources.map(source => source.id)).toEqual([
      'portfolio',
      'portfolio-risk',
      'factor-decomposition',
      'correlation',
      'company',
      'price-history',
      'news',
      'global-markets',
      'sector-rotation',
      'credit-spreads',
      'rate-engine',
      'macro-events',
      'earnings',
    ])
    expect(plan.symbols).toEqual(['AAPL', 'MSFT'])
  })

  it('keeps portfolio catalysts tied to actual holdings and adds event evidence when requested', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'JOBY, VST, OWL',
      goal: 'Assess inflation and rate risk in my portfolio',
    }, portfolio)

    expect(plan.sources.map(source => source.id)).toContain('macro-events')
    expect(plan.sources.map(source => source.id)).toContain('global-markets')
    expect(plan.sources.find(source => source.id === 'earnings')?.targets).toEqual(['AAPL', 'MSFT'])
  })

  it('builds allocation weights from current marks and flags unpriced positions', async () => {
    const book: ActivePortfolioContext = {
      ...portfolio,
      holdings: [
        { ticker: 'AAPL', shares: 2, avgCost: 100 },
        { ticker: 'NVDA', shares: 1, avgCost: 0 },
      ],
      cashValue: 0,
    }
    const source = {
      id: 'portfolio' as const,
      label: 'Active book',
      tool: 'Portfolio Manager',
      route: '/portfolio-manager',
      reason: 'Test current allocation',
      targets: [],
    }
    const result = await collectReportResearch(
      { ...planReportResearch({ ...defaultScope(), goal: 'Assess my portfolio' }, book), sources: [source] },
      { ...defaultScope(), goal: 'Assess my portfolio' },
      book,
      undefined,
      {
        get: async () => ({ AAPL: { current_price: 150 } }),
        post: async () => ({}),
      },
    )

    const allocation = result.clips.find(clip => clip.payload.kind === 'table')
    expect(allocation?.payload).toMatchObject({
      kind: 'table',
      columns: ['Ticker', 'Shares', 'Mark', 'Market value', 'Weight %', 'Sector classification', 'Valuation source'],
      rows: [
        ['AAPL', 2, '$150', '$300', 100, 'Unclassified', 'live quote'],
        ['NVDA', 1, 'Unpriced', 'Unpriced', null, 'Unclassified', 'unpriced'],
      ],
    })
    const warning = result.clips.find(clip => clip.payload.kind === 'text')
    expect(warning?.payload).toMatchObject({ kind: 'text' })
    if (warning?.payload.kind === 'text') expect(warning.payload.body).toContain('NVDA')
  })

  it('selects options and catalyst tools from the objective', () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'NVDA',
      goal: 'Explain the catalyst and options volatility around the NVDA move',
    }
    const plan = planReportResearch(scope, emptyPortfolio)
    expect(plan.sources.map(source => source.id)).toEqual([
      'company',
      'price-history',
      'options',
      'volatility-skew',
      'implied-probability',
      'mover',
      'news',
    ])
  })

  it('does not mistake instrument risk for portfolio intent', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      researchSymbols: 'NVDA',
      goal: 'Assess NVDA options risk and implied volatility',
    }, emptyPortfolio)
    expect(plan.intent).toBe('options')
    expect(plan.sources.map(source => source.id)).toContain('options')
  })

  it('uses the active book for a portfolio-review report even when the legacy context flag is off', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      reportType: 'portfolio-review',
      evidenceMode: 'alphatape',
      includePortfolio: false,
      goal: 'Assess risk and concentration in my portfolio',
    }, portfolio)
    expect(plan.blockedReason).toBeUndefined()
    expect(plan.symbols).toEqual(['AAPL', 'MSFT'])
    expect(plan.sources.map(source => source.id)).toEqual(expect.arrayContaining([
      'portfolio',
      'portfolio-risk',
      'factor-decomposition',
      'correlation',
    ]))
  })

  it('uses a comprehensive tool suite for a full portfolio objective', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      reportType: 'portfolio-review',
      evidenceMode: 'alphatape',
      includePortfolio: false,
      goal: 'Produce a full decision-grade analysis of my entire portfolio covering risk, downside, growth, valuation, catalysts, and macro conditions',
    }, portfolio)

    expect(plan.sources.map(source => source.id)).toEqual(expect.arrayContaining([
      'portfolio',
      'portfolio-risk',
      'factor-decomposition',
      'correlation',
      'company',
      'price-history',
      'news',
      'global-markets',
      'sector-rotation',
      'credit-spreads',
      'rate-engine',
      'macro-events',
      'sentiment',
      'peer-valuation',
      'dcf-valuation',
      'earnings',
    ]))
  })

  it('blocks incomplete automated research for books with derivatives', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      goal: 'Assess risk and concentration in my portfolio',
    }, { ...portfolio, optionsCount: 2, positionCount: 4 })
    expect(plan.blockedReason).toMatch(/options|option positions/i)
    expect(plan.blockedReason).toMatch(/equities and cash/i)
  })

  it('recognizes comparison language used by the report objective field', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      goal: 'Which is the better value between NVDA and AAPL?',
    }, emptyPortfolio)
    expect(plan.intent).toBe('comparison')
    expect(plan.sources.map(source => source.id)).toContain('market-compare')
    expect(plan.sources.map(source => source.id)).toContain('regression')
    expect(plan.sources.map(source => source.id)).toContain('peer-valuation')
  })

  it('anchors valuation research in peer and intrinsic-value visuals', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      researchSymbols: 'AAPL',
      goal: 'Estimate AAPL fair value using peers and intrinsic valuation',
    }, emptyPortfolio)
    expect(plan.intent).toBe('valuation')
    expect(plan.sources.map(source => source.id)).toEqual([
      'company',
      'price-history',
      'news',
      'earnings',
      'peer-valuation',
      'dcf-valuation',
    ])
  })

  it('keeps a screened peer set as context around one primary company subject', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      researchSymbols: 'JPM, HBAN, KEY, RF',
      goal: 'Create a JPMorgan equity research report',
    }, emptyPortfolio)

    expect(plan.intent).toBe('company')
    expect(plan.symbols).toEqual(['JPM', 'HBAN', 'KEY', 'RF'])
    expect(plan.sources.map(source => source.id)).toEqual([
      'company',
      'price-history',
      'peer-valuation',
      'news',
      'earnings',
    ])
    expect(plan.sources.every(source => source.targets.length === 0 || source.targets[0] === 'JPM')).toBe(true)
    expect(plan.sources.every(source => source.targets.length <= 1)).toBe(true)
  })

  it('lets AI add supported, non-duplicative visual tools to the baseline', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL MSFT',
      goal: 'Compare AAPL and MSFT risk',
    }
    const baseline = planReportResearch(scope, emptyPortfolio)
    expect(baseline.intent).toBe('comparison')
    const enhanced = await enhanceReportResearchPlan(baseline, scope, emptyPortfolio, {
      get: async () => ({}),
      post: async () => ({
        summary: 'Add dependence and rates context.',
        additions: [
          { id: 'correlation', reason: 'Show whether the two names diversify one another.' },
          { id: 'rate-engine', reason: 'Frame duration-sensitive valuation risk.' },
          { id: 'company', reason: 'Duplicate baseline source.' },
          { id: 'made-up-tool', reason: 'Unsupported.' },
        ],
      }),
    })
    expect(enhanced.aiEnhanced).toBe(true)
    expect(enhanced.aiSummary).toBe('Add dependence and rates context.')
    expect(enhanced.sources.filter(source => source.selectionOrigin === 'ai').map(source => source.id)).toEqual([
      'correlation',
      'rate-engine',
    ])
  })

  it('does not invent historical or forward windows when those horizons are disabled', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL MSFT',
      goal: 'Compare AAPL and MSFT risk',
      lookbackPreset: 'none' as const,
      lookforwardPreset: 'none' as const,
    }
    const baseline = planReportResearch(scope, emptyPortfolio)
    expect(baseline.sources.map(source => source.id)).toEqual(['company', 'news'])
    let plannerRequest: any
    const enhanced = await enhanceReportResearchPlan(baseline, scope, emptyPortfolio, {
      get: async () => ({}),
      post: async (_url, body) => {
        plannerRequest = body
        return {
          additions: [
            { id: 'price-history', reason: 'Needs an invented historical range.' },
            { id: 'earnings', reason: 'Needs an invented outlook range.' },
            { id: 'rate-engine', reason: 'Current rates are useful context.' },
          ],
        }
      },
    })
    expect(plannerRequest.timeframe).toBe('historical lookback disabled; forward outlook disabled')
    expect(plannerRequest.tools.map((tool: { id: string }) => tool.id)).not.toContain('price-history')
    expect(plannerRequest.tools.map((tool: { id: string }) => tool.id)).not.toContain('earnings')
    expect(enhanced.sources.map(source => source.id)).toEqual(['company', 'news', 'rate-engine'])
  })

  it('passes an unlimited outlook to the planner without inventing an end date', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL',
      goal: 'Assess AAPL over an open-ended horizon',
      lookforwardPreset: 'unlimited' as const,
    }
    const baseline = planReportResearch(scope, emptyPortfolio)
    let plannerRequest: any
    await enhanceReportResearchPlan(baseline, scope, emptyPortfolio, {
      get: async () => ({}),
      post: async (_url, body) => {
        plannerRequest = body
        return { additions: [] }
      },
    })

    expect(plannerRequest.timeframe).toContain('open-ended outlook with no fixed end date')
  })

  it('blocks company research until a subject is available', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      goal: 'Assess whether this company is attractively valued',
    }, emptyPortfolio)
    expect(plan.blockedReason).toMatch(/ticker/i)
    expect(plan.sources).toEqual([])
  })

  it('replaces prior AlphaTape clips without touching manual clips or notes', () => {
    const manual: ReportClip = {
      id: 'manual',
      sourceTab: 'DCF',
      capturedAt: '2026-01-01T00:00:00Z',
      dataType: 'text',
      payload: { kind: 'text', title: 'Manual', body: 'Keep me' },
      projectId: 'p1',
    }
    const prior: ReportClip = {
      id: 'research-1',
      sourceTab: 'Corporate Hub',
      capturedAt: '2026-01-01T00:00:00Z',
      dataType: 'kpi',
      payload: { kind: 'kpi', title: 'Old', cells: [] },
      projectId: 'p1',
      origin: 'alphatape',
      researchSourceId: 'company',
      researchKey: 'company:AAPL',
      userDescription: 'Keep this note',
    }
    const merged = mergeAlphaTapeClips([manual, prior], 'p1', [{
      sourceTab: 'Corporate Hub',
      dataType: 'kpi',
      payload: { kind: 'kpi', title: 'Fresh', cells: [] },
      origin: 'alphatape',
      researchSourceId: 'company',
      researchKey: 'company:AAPL',
    }], '2026-02-01T00:00:00Z')

    expect(merged.map(clip => clip.id)).toEqual(['manual', 'research-1'])
    expect(merged[1].userDescription).toBe('Keep this note')
    expect(merged[1].payload.title).toBe('Fresh')
    expect(merged[1].capturedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('retains prior evidence for sources that failed during refresh', () => {
    const old: ReportClip = {
      id: 'old-news',
      sourceTab: 'Mover Radar',
      capturedAt: '2026-01-01T00:00:00Z',
      dataType: 'table',
      payload: { kind: 'table', title: 'Prior news', columns: [], rows: [] },
      projectId: 'p1',
      origin: 'alphatape',
      researchSourceId: 'news',
      researchKey: 'news:AAPL',
    }
    const merged = mergeAlphaTapeClips(
      [old],
      'p1',
      [],
      '2026-02-01T00:00:00Z',
      { sourceIds: ['news'] },
    )
    expect(merged).toEqual([old])
  })

  it('retains every visual belonging to a failed ticker target', () => {
    const oldVisual: ReportClip = {
      id: 'old-options-visual',
      sourceTab: 'Options Desk',
      capturedAt: '2026-01-01T00:00:00Z',
      dataType: 'chart',
      payload: { kind: 'chart', chartType: 'bar', xKey: 'measure', data: [], series: [], title: 'Prior IV chart' },
      projectId: 'p1',
      origin: 'alphatape',
      researchSourceId: 'options',
      researchKey: 'options:AAPL:volatility-visual',
    }
    const merged = mergeAlphaTapeClips(
      [oldVisual],
      'p1',
      [],
      '2026-02-01T00:00:00Z',
      { researchKeys: ['options:AAPL'] },
    )
    expect(merged).toEqual([oldVisual])
  })

  it('preserves mixed manual and research ordering during refresh', () => {
    const clips: ReportClip[] = [
      {
        id: 'research-1', sourceTab: 'Corporate Hub', capturedAt: 'old', dataType: 'text',
        payload: { kind: 'text', title: 'Old company', body: '' }, projectId: 'p1',
        origin: 'alphatape', researchSourceId: 'company', researchKey: 'company:AAPL',
      },
      {
        id: 'manual', sourceTab: 'DCF', capturedAt: 'old', dataType: 'text',
        payload: { kind: 'text', title: 'Manual', body: '' }, projectId: 'p1',
      },
      {
        id: 'research-2', sourceTab: 'Market News', capturedAt: 'old', dataType: 'text',
        payload: { kind: 'text', title: 'Old news', body: '' }, projectId: 'p1',
        origin: 'alphatape', researchSourceId: 'news', researchKey: 'news:AAPL',
      },
    ]
    const merged = mergeAlphaTapeClips(clips, 'p1', [
      {
        sourceTab: 'Corporate Hub', dataType: 'text',
        payload: { kind: 'text', title: 'Fresh company', body: '' },
        origin: 'alphatape', researchSourceId: 'company', researchKey: 'company:AAPL',
      },
    ], 'fresh', { researchKeys: ['news:AAPL'] })
    expect(merged.map(clip => clip.id)).toEqual(['research-1', 'manual', 'research-2'])
    expect(merged[0].payload.title).toBe('Fresh company')
  })

  it('keeps successful evidence in plan order when one source fails', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL',
      goal: 'Assess AAPL options volatility',
    }
    const baseline = planReportResearch(scope, emptyPortfolio)
    const plan = {
      ...baseline,
      sources: baseline.sources.filter(source => ['company', 'price-history', 'options', 'news'].includes(source.id)),
    }
    const client = {
      get: async (url: string) => {
        if (url.startsWith('/api/corporate/hub')) return { current_price: 210, forward_pe: 28, beta: 1.1 }
        if (url.startsWith('/api/market/history')) throw new Error('history unavailable')
        if (url.startsWith('/api/options/snapshot')) return { spot: 210, atm_iv: 24, hv_30: 20, implied_move: 4.2 }
        if (url.startsWith('/api/market/news')) return { news: [{ title: 'Apple update', publisher: 'Wire', providerPublishTime: 1_700_000_000 }] }
        return {}
      },
      post: async () => ({}),
    }
    const result = await collectReportResearch(plan, scope, emptyPortfolio, undefined, client)

    expect(result.failed.map(failure => failure.sourceId)).toEqual(['price-history'])
    expect(result.clips.map(clip => clip.researchSourceId)).toEqual(['company', 'options', 'options', 'news'])
    expect(result.clips.filter(clip => clip.dataType === 'chart')).toHaveLength(1)
    expect(result.clips.every(clip => clip.origin === 'alphatape')).toBe(true)
  })

  it('collects decision-grade company, bank, analyst, segment, and estimate evidence', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'JPM',
      goal: 'Create a JPMorgan equity research report',
    }
    const baseline = planReportResearch(scope, emptyPortfolio)
    const plan = {
      ...baseline,
      sources: baseline.sources.filter(source => source.id === 'company'),
    }
    const result = await collectReportResearch(plan, scope, emptyPortfolio, undefined, {
      get: async url => {
        if (url.startsWith('/api/corporate/hub?')) {
          return { current_price: 350, forward_pe: 14.1, consensus: 'Moderate Buy' }
        }
        if (url.startsWith('/api/corporate/supply-chain')) {
          return {
            ticker: 'JPM',
            sector: 'Financial Services',
            industry: 'Banks - Diversified',
            roe: 17.8,
            rev_growth: 0.08,
            product_segments: { latest: [] },
            revenue_activity: {
              latest: [
                { name: 'Net Interest Income', value: 95_443_000_000, pct: 52.3, yoy_pct: 3.1 },
                { name: 'Trading', value: 27_212_000_000, pct: 14.9, yoy_pct: 9.8 },
              ],
              history: [
                { year: 2024, segments: [{ name: 'Net Interest Income', value: 92_583_000_000 }, { name: 'Trading', value: 24_787_000_000 }] },
                { year: 2025, segments: [{ name: 'Net Interest Income', value: 95_443_000_000 }, { name: 'Trading', value: 27_212_000_000 }] },
              ],
            },
            geo_segments: {
              latest: [
                { name: 'North America', value: 140_000_000_000, pct: 76.6 },
                { name: 'EMEA', value: 24_000_000_000, pct: 13.4 },
              ],
            },
          }
        }
        if (url.startsWith('/api/corporate/hub/analyst')) {
          return {
            target_mean: 372,
            target_low: 305,
            target_high: 420,
            implied_upside: 6.3,
            total_analysts: 20,
            distribution: { strongBuy: 3, buy: 9, hold: 8, sell: 0, strongSell: 0 },
          }
        }
        if (url.startsWith('/api/factset/financials')) {
          return {
            available: true,
            periods: [
              { label: 'FY2025', is_estimate: false },
              { label: 'FY2026', is_estimate: true },
            ],
            groups: [{
              rows: [
                { label: 'Revenue', unit: '$M', values: [182_447, 190_000] },
                { label: 'Net Income', unit: '$M', values: [58_000, 60_000] },
                { label: 'EPS (Diluted)', unit: '$', values: [23.2, 24.1] },
                { label: 'Return on Equity', unit: '%', values: [17.8, 18.1] },
              ],
            }],
          }
        }
        if (url === '/api/official/fdic') {
          return {
            banks: [{
              name: 'JPMorgan Chase Bank',
              assets: 4_000_000,
              deposits: 2_500_000,
              roa: 1.4,
              roe: 17.8,
              nim: 2.6,
              net_chargeoffs: 0.7,
            }],
          }
        }
        return {}
      },
      post: async () => ({}),
    })

    const titles = result.clips.map(clip => clip.payload.title)
    expect(titles).toEqual(expect.arrayContaining([
      'JPM company snapshot',
      'Product Segments · JPM',
      'JPM revenue activity history',
      'Geographic Segments · JPM',
      'Bank profitability and credit context · JPM',
      'Analyst view · JPM',
      'JPM financial trajectory · actual and consensus',
      'Financials and estimates · JPM',
    ]))
    expect(result.clips.filter(clip => clip.payload.kind === 'chart')).toHaveLength(2)
  })

  it('normalizes nested yfinance news and reports partial ticker failures', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL MSFT',
      goal: 'Review recent news for AAPL and MSFT',
    }
    const plan = {
      ...planReportResearch(scope, emptyPortfolio),
      sources: [{
        id: 'news' as const,
        label: 'Recent news',
        tool: 'Mover Radar',
        route: '/mover-radar',
        reason: 'Test',
        targets: ['AAPL', 'MSFT'],
      }],
    }
    const client = {
      get: async (url: string) => {
        if (url.includes('MSFT')) throw new Error('unavailable')
        return {
          news: [{
            content: {
              title: 'Apple launches a new product',
              provider: { displayName: 'Reuters' },
              pubDate: '2026-07-28T14:00:00Z',
            },
          }],
        }
      },
      post: async () => ({}),
    }
    const result = await collectReportResearch(plan, scope, emptyPortfolio, undefined, client)
    const clip = result.clips[0]
    expect(clip.payload.kind).toBe('table')
    if (clip.payload.kind === 'table') {
      expect(clip.payload.rows[0]).toEqual(['2026-07-28', 'Reuters', 'Apple launches a new product'])
    }
    expect(result.failed).toEqual([expect.objectContaining({
      sourceId: 'news',
      target: 'MSFT',
      researchKey: 'news:MSFT',
    })])
  })

  it('uses the selected custom historical window for source requests', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL',
      goal: 'Review AAPL price action',
      lookbackPreset: 'custom' as const,
      customStart: '2025-01-02',
      customEnd: '2025-03-14',
    }
    const plan = {
      ...planReportResearch(scope, emptyPortfolio),
      sources: [{
        id: 'price-history' as const,
        label: 'Price and drawdown',
        tool: 'Chart Studio',
        route: '/chart-studio',
        reason: 'Test',
        targets: ['AAPL'],
      }],
    }
    const urls: string[] = []
    await collectReportResearch(plan, scope, emptyPortfolio, undefined, {
      get: async url => {
        urls.push(url)
        return { price: [{ date: '2025-01-02', value: 100 }], metrics: {} }
      },
      post: async () => ({}),
    })
    expect(urls[0]).toContain('start=2025-01-02')
    expect(urls[0]).toContain('end=2025-03-14')
  })

  it('collects native visuals from valuation, charting, and options tools', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL MSFT',
      goal: 'Compare AAPL and MSFT using valuation, regression, and options evidence',
    }
    const sources = [
      { id: 'peer-valuation' as const, label: 'Peer valuation', tool: 'Peer Comparison', route: '/relative-valuation', reason: 'test', targets: ['AAPL'] },
      { id: 'dcf-valuation' as const, label: 'DCF valuation', tool: 'DCF Valuation', route: '/dcf', reason: 'test', targets: ['AAPL'] },
      { id: 'regression' as const, label: 'Regression', tool: 'Regression', route: '/regression', reason: 'test', targets: ['AAPL', 'MSFT'] },
      { id: 'volatility-skew' as const, label: 'Skew', tool: 'Volatility Skew', route: '/skew', reason: 'test', targets: ['AAPL'] },
      { id: 'dealer-gex' as const, label: 'GEX', tool: 'Dealer GEX', route: '/gex', reason: 'test', targets: ['AAPL'] },
      { id: 'implied-probability' as const, label: 'Probability', tool: 'Implied Probability', route: '/probability', reason: 'test', targets: ['AAPL'] },
    ]
    const result = await collectReportResearch(
      { ...planReportResearch(scope, emptyPortfolio), sources },
      scope,
      emptyPortfolio,
      undefined,
      {
        get: async url => {
          if (url.startsWith('/api/corporate/peer-valuation')) return {
            ticker: 'AAPL',
            sector: 'Technology',
            peers: [
              { ticker: 'AAPL', is_target: true, price: 200, target_mean_price: 230, pe: 28, ev_ebitda: 20, ps: 8, pfcf: 24, roe: 0.42, revenue_growth: 0.12 },
              { ticker: 'MSFT', price: 400, target_mean_price: 430, pe: 32, ev_ebitda: 22, ps: 10, pfcf: 30, roe: 0.36, revenue_growth: 0.15 },
            ],
          }
          if (url.startsWith('/api/dcf/fundamentals')) return {
            revenue: 400_000, shares: 15_000, op_margin: 31, rev_growth: 8,
            net_debt: -40_000, tax_rate: 16, capex_pct: 3, da_pct: 3, wc_pct: 0.5,
            beta: 1.1, de_ratio: 0.2, market_price: 200,
          }
          if (url.startsWith('/api/prob/skew')) return {
            ticker: 'AAPL', spot: 200, front_expiry: '2026-09-18', ts_slope: 2,
            term_structure: [
              { expiry: '2026-09-18', dte: 50, atm_iv: 24, rr_25: 3, bf_25: 1, smile: [{ moneyness: -10, iv: 30 }, { moneyness: 0, iv: 24 }] },
              { expiry: '2026-12-18', dte: 140, atm_iv: 26, rr_25: 2, bf_25: 1, smile: [] },
            ],
          }
          if (url.startsWith('/api/options/gex')) return {
            spot: 200, flip: 195, total_net_gex: 42, source: 'Tradier', delayed: false,
            max_positive_gex: { strike: 210, gex_m: 20 },
            max_negative_gex: { strike: 185, gex_m: -12 },
            data: [
              { strike: 190, net_gex: -4, call_gex: 2, put_gex: -6 },
              { strike: 200, net_gex: 8, call_gex: 10, put_gex: -2 },
            ],
          }
          if (url.startsWith('/api/options/snapshot')) return { expiry: '2026-09-18' }
          if (url.startsWith('/api/prob/chain-distribution')) return {
            expiry: '2026-09-18', modal_strike: 205, p10: 175, p50: 202, p90: 235,
            density: [{ strike: 190, density: 0.02 }, { strike: 210, density: 0.03 }],
            delta_curve: [{ strike: 190, delta: 0.7 }, { strike: 210, delta: 0.4 }],
          }
          return {}
        },
        post: async (url) => {
          if (url === '/api/ai/dcf-assumptions') return {
            rev_growth_1: 8, rev_growth_2: 6, rev_growth_3: 4,
            target_margin: 32, terminal_growth: 2.5, wacc: 9,
          }
          if (url === '/api/dcf/value') return {
            intrinsic_per_share: 225, enterprise_value: 3_000_000, pv_fcfs: 700_000, terminal_value: 2_300_000,
            fcfs: [{ year: 1, revenue: 430_000, fcf: 90_000, pv_fcf: 82_000 }],
            tornado: [{ label: 'WACC', lo: 190, hi: 260 }],
          }
          if (url === '/api/regression/analyze') return {
            r_squared: 0.7, adj_r_squared: 0.69, observations: 100, mse: 0.001,
            intercept: 0, intercept_p: 0.8, feature_names: ['MSFT'],
            coefficients: [0.8], p_values: [0.01], residuals: [0.01, -0.01],
            data: { dates: ['2026-01-01', '2026-01-02'], y: [0.02, -0.01], y_pred: [0.01, -0.005] },
          }
          if (url === '/api/prob/cone') return {
            S0: 200, sigma: 0.24,
            cone: [
              { date: '2026-07-29', upper: 200, median: 200, lower: 200 },
              { date: '2026-09-18', upper: 230, median: 203, lower: 176 },
            ],
          }
          return {}
        },
      },
    )
    expect(result.failed).toEqual([])
    for (const source of sources) {
      expect(result.clips.some(clip => clip.researchSourceId === source.id && clip.dataType === 'chart')).toBe(true)
    }
  })

  it('collects sector leadership as a labeled horizontal momentum ranking', async () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      goal: 'Review the macro regime and sector leadership',
    }
    const source = {
      id: 'sector-rotation' as const,
      label: 'Sector leadership',
      tool: 'Sector Rotation',
      route: '/sector-rotation',
      reason: 'Test',
      targets: [],
    }
    const result = await collectReportResearch(
      { ...planReportResearch(scope, emptyPortfolio), sources: [source] },
      scope,
      emptyPortfolio,
      undefined,
      {
        get: async () => ({
          as_of: '2026-07-29',
          sectors: [
            {
              ticker: 'XLV',
              name: 'Health Care',
              returns: { '1W': 4.91, '1M': 4.06, '3M': 15.07 },
              rel_strength: { '1M': 4.08 },
              momentum: -0.96,
            },
            {
              ticker: 'XLE',
              name: 'Energy',
              returns: { '1W': -2.75, '1M': 7.45, '3M': -2.79 },
              rel_strength: { '1M': 7.47 },
              momentum: 8.38,
            },
          ],
        }),
        post: async () => ({}),
      },
    )
    const visual = result.clips.find(clip => clip.dataType === 'chart')
    expect(visual?.payload).toMatchObject({
      kind: 'chart',
      title: 'Sector leadership · momentum ranking · 2026-07-29',
      chartType: 'bar',
      barOrientation: 'horizontal',
      xKey: 'sector',
      series: [{ key: 'momentum', label: 'Momentum score (pp)' }],
    })
    if (visual?.payload.kind === 'chart') {
      expect(visual.payload.data.map(row => row.sector)).toEqual([
        'Energy · XLE',
        'Health Care · XLV',
      ])
      expect(visual.payload.details).toContainEqual({
        key: 'vsSpyOneMonth',
        label: 'Vs SPY · 1M %',
      })
    }
  })

  it('ranks the full portfolio by current value and discloses top-20 coverage', async () => {
    const holdings = Array.from({ length: 21 }, (_, index) => ({
      ticker: `H${String(index + 1).padStart(2, '0')}`,
      shares: 1,
      avgCost: 1_000 - index,
    }))
    const largePortfolio: ActivePortfolioContext = {
      ...portfolio,
      holdings,
      positionCount: holdings.length,
      cashValue: 100,
    }
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      goal: 'Assess risk in my portfolio',
    }
    const source = {
      id: 'portfolio-risk' as const,
      label: 'Risk and performance',
      tool: 'Portfolio Compare',
      route: '/portfolio-compare',
      reason: 'Test',
      targets: [],
    }
    let compareRequest: any
    const result = await collectReportResearch(
      { ...planReportResearch(scope, largePortfolio), sources: [source] },
      scope,
      largePortfolio,
      undefined,
      {
        get: async () => Object.fromEntries(holdings.map((holding, index) => [
          holding.ticker,
          { current_price: index + 1 },
        ])),
        post: async (_url, body) => {
          compareRequest = body
          return {
            metrics: [{ cagr: 8, vol: 12, sharpe: 0.7, max_drawdown: -9, beta: 0.9, sortino: 1.1 }],
            series: [{ points: [{ date: '2026-01-02', value: 100 }] }],
            benchmark_points: [{ date: '2026-01-02', value: 100 }],
          }
        },
      },
    )
    expect(compareRequest.portfolios[0].tickers).toHaveLength(20)
    expect(compareRequest.portfolios[0].tickers[0]).toBe('H21')
    expect(compareRequest.portfolios[0].tickers).not.toContain('H01')
    const metrics = result.clips.find(clip => clip.payload.kind === 'kpi')
    expect(metrics?.payload.title).toContain('top 20 equity sleeve')
    if (metrics?.payload.kind === 'kpi') {
      expect(metrics.payload.cells).toContainEqual(expect.objectContaining({
        label: 'Book coverage',
        sub: '1 smaller position omitted',
      }))
    }
  })
})

describe('report subject imports', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('runs a saved screen without going through the AI parser', async () => {
    const requests: Array<{ url: string; body: any }> = []
    const selection = await runSavedScreen(
      {
        id: 's1', name: 'Deep Value', sortBy: 'peRatio', sortDir: 'asc',
        universes: ['sp500'],
        filters: [
          { field: 'peRatio', operator: 'lt', value: '15' },
          { field: 'pbRatio', operator: 'lt', value: 3 },
        ],
      },
      8,
      {
        get: async () => ({}),
        post: async (url, body) => {
          requests.push({ url, body })
          return { total: 42, results: [{ ticker: 'ibm' }, { ticker: 'F' }, { ticker: 'ibm' }] }
        },
      },
    )
    // The criteria are already structured — nothing to interpret.
    expect(requests.map(r => r.url)).toEqual(['/api/screener/run'])
    expect(requests[0].body.sort_by).toBe('peRatio')
    expect(requests[0].body.sort_dir).toBe('asc')
    expect(requests[0].body.universe).toBe('sp500')
    // String values from the saved-screen store are coerced to numbers.
    expect(requests[0].body.filters).toEqual([
      { field: 'peRatio', operator: 'lt', value: 15, value2: null, param: null },
      { field: 'pbRatio', operator: 'lt', value: 3, value2: null, param: null },
    ])
    expect(selection.symbols).toEqual(['IBM', 'F'])   // normalized and deduped
    expect(selection.total).toBe(42)
  })

  it('drops saved-screen filters the screener cannot run', async () => {
    const requests: any[] = []
    await runSavedScreen(
      {
        id: 's2', name: 'Mixed', sortBy: 'marketCap', sortDir: 'desc',
        filters: [
          { field: 'roe', operator: 'gt', value: '15' },
          { field: 'name', operator: 'contains', value: 'bank' },   // unsupported operator
          { field: 'peRatio', operator: 'lt', value: 'n/a' },       // unparseable value
        ],
      },
      8,
      { get: async () => ({}), post: async (_u, body) => { requests.push(body); return { total: 1, results: [] } } },
    )
    expect(requests[0].filters).toEqual([
      { field: 'roe', operator: 'gt', value: 15, value2: null, param: null },
    ])
  })

  it('returns nothing when there is no storage at all (print route, SSR)', () => {
    expect(readSavedScreens()).toEqual([])
  })

  it('reads the screener library and skips malformed entries', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
    localStorage.setItem(SAVED_SCREENS_STORAGE_KEY, JSON.stringify([
      { id: 'a', name: 'Quality', sortBy: 'roe', sortDir: 'asc', filters: [{ field: 'roe', operator: 'gt', value: '15' }] },
      { id: 'b' },                       // no name
      { name: 'No id' },                 // no id
      'nonsense',
    ]))
    const screens = readSavedScreens()
    expect(screens.map(s => s.id)).toEqual(['a'])
    expect(screens[0].sortDir).toBe('asc')
    expect(screens[0].filters).toHaveLength(1)

    localStorage.setItem(SAVED_SCREENS_STORAGE_KEY, 'not json')
    expect(readSavedScreens()).toEqual([])
    localStorage.removeItem(SAVED_SCREENS_STORAGE_KEY)
    expect(readSavedScreens()).toEqual([])
  })
})

describe('relationship tools get more than one subject', () => {
  it('never leaves a relationship tool with one target, whatever the intent', () => {
    // intent is 'portfolio' / 'company' here, not 'comparison', which is exactly
    // the case both planners used to truncate to a single name.
    for (const goal of [
      'Assess concentration and diversification in my portfolio',
      'Is NVDA still worth holding',
      'Explain what drove the move',
    ]) {
      const plan = planReportResearch({
        ...defaultScope(), evidenceMode: 'alphatape', researchSymbols: 'NVDA, MSFT, QCOM, MU', goal,
      }, emptyPortfolio)
      for (const s of plan.sources) {
        if (s.id === 'correlation' || s.id === 'regression' || s.id === 'market-compare') {
          expect(s.targets.length, `${s.id} for "${goal}"`).toBeGreaterThanOrEqual(2)
        }
      }
    }
  })

  it('gives an AI-added correlation every symbol, not the single-name slice', async () => {
    const baseline = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      researchSymbols: 'NVDA, MSFT, QCOM, MU',
      goal: 'Review the risk in my book',
    }, emptyPortfolio)

    const enhanced = await enhanceReportResearchPlan(baseline, {
      ...defaultScope(), researchSymbols: 'NVDA, MSFT, QCOM, MU', goal: 'Review the risk in my book',
    }, emptyPortfolio, {
      get: async () => ({}),
      post: async () => ({
        summary: 'Add dependence evidence.',
        additions: [{ id: 'correlation', reason: 'Show whether the holdings diversify.' }],
      }),
    })

    const correlation = enhanced.sources.find(s => s.id === 'correlation')
    expect(correlation).toBeDefined()
    expect(correlation!.targets).toEqual(['NVDA', 'MSFT', 'QCOM', 'MU'])
  })

  it('single-subject tools still get just the subject', async () => {
    const baseline = planReportResearch({
      ...defaultScope(), evidenceMode: 'alphatape', researchSymbols: 'NVDA, MSFT', goal: 'Is NVDA a buy',
    }, emptyPortfolio)
    const enhanced = await enhanceReportResearchPlan(baseline, {
      ...defaultScope(), researchSymbols: 'NVDA, MSFT', goal: 'Is NVDA a buy',
    }, emptyPortfolio, {
      get: async () => ({}),
      post: async () => ({
        summary: 'Add valuation.',
        additions: [{ id: 'dcf-valuation', reason: 'Fundamental anchor.' }],
      }),
    })
    expect(enhanced.sources.find(s => s.id === 'dcf-valuation')!.targets).toEqual(['NVDA'])
  })
})
