import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultScope, mergeAlphaTapeClips, summarizeClipForAI, type ReportClip } from './reportCreator'
import {
  collectReportResearch,
  buildReportDataBank,
  enhanceReportResearchPlan,
  inferResearchSymbols,
  parseResearchSymbols,
  planReportResearch,
  screenReportSymbols,
  runSavedScreen,
  readSavedScreens,
  REPORT_RESEARCH_TOOL_CATALOG,
  SAVED_SCREENS_STORAGE_KEY,
} from './reportResearch'
import type { ActivePortfolioContext } from './pmImport'
import portfolioReviewFixture from '../fixtures/portfolioReview16.json'
import { chartClip } from './reportCaptureRegistry'

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

const portfolioReview16Symbols = portfolioReviewFixture.symbols

const portfolioReview16: ActivePortfolioContext = {
  ...emptyPortfolio,
  id: 'portfolio-review-16',
  name: 'Portfolio Review Regression',
  portfolioIds: ['portfolio-review-16'],
  holdings: portfolioReview16Symbols.map((ticker, index) => ({
    ticker,
    shares: 1,
    avgCost: 160 - index,
  })),
  positionCount: 16,
  hasData: true,
}

const reportToolManifest = { tools: REPORT_RESEARCH_TOOL_CATALOG }

describe('Report Creator AlphaTape research', () => {
  it('stores chart units as metadata and never guesses from display labels', () => {
    const neutral = chartClip('Test', 'Return chart', 'bar', 'bucket', [
      { bucket: 'A', value: 10 },
      { bucket: 'B', value: 20 },
    ], [{ key: 'value', label: 'Return %' }])
    const explicit = chartClip('Test', 'Return chart', 'bar', 'bucket', [
      { bucket: 'A', value: 10 },
      { bucket: 'B', value: 20 },
    ], [{ key: 'value', label: 'Return %', unit: 'percent' }])

    expect(neutral.payload.kind).toBe('chart')
    expect(explicit.payload.kind).toBe('chart')
    if (neutral.payload.kind === 'chart' && explicit.payload.kind === 'chart') {
      expect(neutral.payload.series[0].unit).toBe('number')
      expect(explicit.payload.series[0].unit).toBe('percent')
    }
  })

  it('keeps every row in the exact 16-position portfolio summary sent to the writer', () => {
    const allocation: ReportClip = {
      id: 'allocation-16',
      sourceTab: 'Portfolio Manager',
      capturedAt: '2026-08-06T12:00:00Z',
      dataType: 'table',
      projectId: 'portfolio-review-project',
      evidenceDomain: 'portfolio',
      payload: {
        kind: 'table',
        title: 'Portfolio Review Regression · current allocation',
        columns: ['Ticker', 'Weight %'],
        rows: portfolioReview16Symbols.map((ticker, index) => [ticker, 10 - index * 0.4]),
      },
    }

    const summary = summarizeClipForAI(allocation)

    for (const symbol of portfolioReview16Symbols) expect(summary).toContain(symbol)
    expect(summary).not.toContain('more rows')
    expect(summary).not.toContain('[truncated]')
  })

  it('covers all 16 portfolio positions and separates book analytics from issuer coverage', () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      reportType: 'portfolio-review' as const,
      length: 'long' as const,
      lookbackPreset: portfolioReviewFixture.lookbackPreset as 'last90',
      lookforwardPreset: portfolioReviewFixture.lookforwardPreset as 'next365',
      goal: 'Create a comprehensive review of the complete portfolio with valuation, risk, and catalysts.',
    }
    const plan = planReportResearch(scope, portfolioReview16)

    expect(plan.symbols).toEqual(portfolioReview16Symbols)
    expect(plan.sources.some(source => source.id === 'portfolio-risk')).toBe(true)
    expect(plan.sources.some(source => source.id === 'earnings')).toBe(true)
    expect(plan.sources.find(source => source.id === 'portfolio')).toMatchObject({ domain: 'portfolio', targets: [] })
    expect(plan.sources.find(source => source.id === 'portfolio-risk')).toMatchObject({ domain: 'portfolio', targets: [] })
    // Correlation is capped at what its endpoint accepts. Sending all sixteen
    // returned a 400 and the book lost its correlation evidence entirely, so the
    // cap is the difference between partial evidence and none.
    const correlation = plan.sources.find(source => source.id === 'correlation')
    expect(correlation).toMatchObject({
      domain: 'portfolio',
      targets: portfolioReview16Symbols.slice(0, 12),
    })
    // And it says so, rather than reporting full coverage of a truncated basket.
    expect(correlation?.reason).toContain('largest 12 of 16')
    for (const sourceId of ['company', 'price-history', 'news', 'earnings', 'peer-valuation', 'dcf-valuation']) {
      expect(plan.sources.find(source => source.id === sourceId)).toMatchObject({
        domain: 'issuer',
        targets: portfolioReview16Symbols,
      })
    }
  })

  it('reports exact target coverage and blocks only when critical portfolio evidence is incomplete', () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      reportType: 'portfolio-review' as const,
      goal: 'Create a comprehensive review of the complete portfolio.',
    }
    const fullPlan = planReportResearch(scope, portfolioReview16)
    const wanted = new Set(['portfolio', 'portfolio-risk', 'correlation', 'factor-decomposition', 'company'])
    const plan = {
      ...fullPlan,
      sources: fullPlan.sources.filter(source => wanted.has(source.id)),
      requiredSourceIds: fullPlan.sources.filter(source => wanted.has(source.id)).map(source => source.id),
    }
    const drafts = plan.sources.flatMap(source => {
      const targets = source.targets.length ? source.targets : ['portfolio-review-16']
      return targets.map(target => ({
        sourceTab: source.tool,
        dataType: 'text' as const,
        payload: { kind: 'text' as const, title: `${source.label} · ${target}`, body: 'Regression evidence.' },
        origin: 'alphatape' as const,
        researchSourceId: source.id,
        researchKey: `${source.id}:${target}`,
        evidenceDomain: source.domain,
      }))
    })
    const clips = mergeAlphaTapeClips([], 'portfolio-review-project', drafts)
    const completeResult = {
      clips: drafts,
      completed: plan.sources.map(source => ({ sourceId: source.id, label: source.label, clipCount: 1 })),
      failed: [],
      finishedAt: '2026-08-06T12:00:00Z',
    }
    const complete = buildReportDataBank(plan, completeResult, clips)
    expect(complete.phase).toBe('ready')
    expect(new Set(complete.criticalSourceIds)).toEqual(new Set(['portfolio', 'portfolio-risk', 'correlation', 'factor-decomposition']))
    expect(complete.coverage.targetCoveragePct).toBe(100)

    const issuerGapResult = {
      ...completeResult,
      failed: [{
        sourceId: 'company' as const,
        label: 'Company snapshot',
        message: 'Issuer fundamentals unavailable.',
        target: 'TSLL',
        researchKey: 'company:TSLL',
      }],
    }
    const issuerGap = buildReportDataBank(plan, issuerGapResult, clips)
    expect(issuerGap.phase).toBe('ready')
    expect(issuerGap.runs.find(run => run.sourceId === 'company')).toMatchObject({
      status: 'partial',
      requestedTargetCount: 16,
      coveredTargetCount: 15,
      coveragePct: 93.8,
    })
    expect(issuerGap.unresolvedGaps).toEqual([expect.stringContaining('TSLL')])

    // Correlation runs on the twelve its endpoint accepts, not all sixteen, so
    // its coverage is measured against twelve. Use a symbol it actually holds.
    const correlationTarget = portfolioReview16Symbols[0]
    const criticalGapResult = {
      ...completeResult,
      failed: [{
        sourceId: 'correlation' as const,
        label: 'Correlation structure',
        message: 'One holding lacked matched history.',
        target: correlationTarget,
        researchKey: `correlation:${correlationTarget}`,
      }],
    }
    const criticalGap = buildReportDataBank(plan, criticalGapResult, clips)
    expect(criticalGap.phase).toBe('blocked')
    expect(criticalGap.runs.find(run => run.sourceId === 'correlation')).toMatchObject({
      requestedTargetCount: 12,
      coveredTargetCount: 11,
      coveragePct: 91.7,
    })
  })

  it('parses explicit symbols and ignores common uppercase prose', () => {
    expect(parseResearchSymbols('aapl, msft BRK.B')).toEqual(['AAPL', 'MSFT', 'BRK-B'])
    expect(inferResearchSymbols('Compare NVDA vs AAPL and include EPS')).toEqual(['NVDA', 'AAPL'])
  })

  it('serializes successful and failed tool runs into a terminal DataBank', () => {
    const scope = {
      ...defaultScope(),
      evidenceMode: 'alphatape' as const,
      researchSymbols: 'AAPL',
      goal: 'Assess AAPL',
    }
    const plan = planReportResearch(scope, emptyPortfolio)
    plan.sources = plan.sources.filter(source => source.id === 'company' || source.id === 'news')
    plan.requiredSourceIds = ['company', 'news']
    plan.objectivePlan = {
      thesis: 'Test whether AAPL fundamentals support the current price.',
      requiredDataPoints: ['Latest fundamentals'],
      requiredChecks: ['Relative valuation'],
    }
    const draft = {
      sourceTab: 'Corporate Hub',
      dataType: 'text' as const,
      payload: { kind: 'text' as const, title: 'AAPL snapshot', body: 'Price and fundamentals.' },
      origin: 'alphatape' as const,
      researchSourceId: 'company' as const,
      researchKey: 'company:AAPL',
    }
    const clips = mergeAlphaTapeClips([], 'project-1', [draft])
    const result = {
      clips: [draft],
      completed: [{ sourceId: 'company' as const, label: 'Company snapshot', clipCount: 1 }],
      failed: [{ sourceId: 'news' as const, label: 'Recent news', message: 'No usable data returned.' }],
      finishedAt: '2026-08-05T12:00:00Z',
    }

    const dataBank = buildReportDataBank(plan, result, clips)

    expect(dataBank.phase).toBe('ready')
    expect(dataBank.runs).toEqual([
      expect.objectContaining({ sourceId: 'company', status: 'complete', clipIds: [clips[0].id] }),
      expect.objectContaining({ sourceId: 'news', status: 'failed', clipIds: [], coveragePct: 0 }),
    ])
    expect(dataBank.coverage.targetCoveragePct).toBe(50)
    expect(dataBank.unresolvedGaps).toEqual([expect.stringContaining('No usable data returned')])
    expect(dataBank.objectivePlan.thesis).toContain('AAPL fundamentals')
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
      domain: 'portfolio' as const,
      critical: true,
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

  it('captures option contracts and states the sleeve-level analytics boundary', async () => {
    const book: ActivePortfolioContext = {
      ...portfolio,
      optionsCount: 1,
      positionCount: 3,
      optionPositions: [{
        id: 'opt-1', underlying: 'NVDA', name: 'Long Call',
        legs: [{ type: 'call', side: 'long', strike: 200, expiry: '2026-09-18', contracts: 2, avgPremium: 12 }],
      }],
    }
    const source = {
      id: 'portfolio' as const,
      label: 'Active book',
      tool: 'Portfolio Manager',
      route: '/portfolio-manager',
      reason: 'Capture the complete position inventory',
      targets: [],
      domain: 'portfolio' as const,
      critical: true,
    }
    const result = await collectReportResearch(
      { ...planReportResearch({ ...defaultScope(), goal: 'Assess my entire portfolio' }, book), sources: [source] },
      { ...defaultScope(), goal: 'Assess my entire portfolio' },
      book,
      undefined,
      {
        get: async url => url.includes('/api/alerts/quotes')
          ? { AAPL: { current_price: 180 }, MSFT: { current_price: 420 } }
          : { sector: 'Technology' },
        post: async url => url.includes('/api/options/marks')
          ? { marks: [{ mark: 10.5, delta: 0.45, source: 'chain' }] }
          : {},
      },
    )

    const optionInventory = result.clips.find(clip => /current option positions/i.test(clip.payload.title ?? ''))
    expect(optionInventory?.payload).toMatchObject({
      kind: 'table',
      rows: [['NVDA', 'Long Call', 'long', 'call', 2, '$200', '2026-09-18', '$12', '$10.5', '$2,100', '90.0', 'chain']],
    })
    const allocation = result.clips.find(clip => /current allocation/i.test(clip.payload.title ?? ''))
    if (allocation?.payload.kind === 'table') {
      expect(allocation.payload.rows).toContainEqual(expect.arrayContaining(['OPTIONS', null, null, '$2,100']))
    }
    const coverage = result.clips.find(clip => /option analytics coverage/i.test(clip.payload.title ?? ''))
    expect(coverage?.payload).toMatchObject({ kind: 'text' })
    if (coverage?.payload.kind === 'text') {
      expect(coverage.payload.body).toMatch(/equity-and-cash sleeve metrics/i)
      expect(coverage.payload.body).toMatch(/historical return.*sleeve metrics/i)
    }
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

  it('excludes zero-share comparison names from portfolio research', () => {
    const singlePosition = {
      ...portfolio,
      holdings: [
        { ticker: 'SNDK', shares: 100, avgCost: 50 },
        { ticker: 'NVDA', shares: 0, avgCost: 150 },
        { ticker: 'ORCL', shares: 0, avgCost: 200 },
      ],
    }
    const plan = planReportResearch({
      ...defaultScope(),
      reportType: 'portfolio-review',
      goal: 'Produce a full analysis of my entire portfolio',
    }, singlePosition)

    expect(plan.symbols).toEqual(['SNDK'])
    expect(plan.sources.some(source => source.id === 'correlation')).toBe(false)
    expect(plan.sources.find(source => source.id === 'company')?.targets).toEqual(['SNDK'])
  })

  it('researches option underlyings without treating sleeve metrics as whole-book analytics', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      goal: 'Produce a comprehensive analysis of my entire portfolio',
    }, {
      ...portfolio,
      optionsCount: 1,
      positionCount: 3,
      optionPositions: [{
        id: 'opt-1', underlying: 'NVDA', name: 'Long Call',
        legs: [{ type: 'call', side: 'long', strike: 200, expiry: '2026-09-18', contracts: 2, avgPremium: 12 }],
      }],
    })

    expect(plan.blockedReason).toBeUndefined()
    expect(plan.symbols).toContain('NVDA')
    for (const sourceId of ['options', 'volatility-skew', 'implied-probability', 'dealer-gex']) {
      expect(plan.sources.find(source => source.id === sourceId)?.targets).toEqual(['NVDA'])
    }
    expect(plan.sources.find(source => source.id === 'correlation')?.targets).toEqual(['AAPL', 'MSFT'])
  })

  it('still blocks futures until contract exposure is modeled', () => {
    const plan = planReportResearch({
      ...defaultScope(),
      evidenceMode: 'alphatape',
      goal: 'Assess risk and concentration in my portfolio',
    }, { ...portfolio, futuresCount: 1, positionCount: 3 })
    expect(plan.blockedReason).toMatch(/futures position/i)
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
      get: async () => reportToolManifest,
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
      get: async () => reportToolManifest,
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
    expect(plannerRequest.tools).toBeUndefined()
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
      get: async () => reportToolManifest,
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

  it('keeps delayed global-market observations as usable evidence', async () => {
    const scope = { ...defaultScope(), evidenceMode: 'alphatape' as const, goal: 'Review the market regime' }
    const source = {
      id: 'global-markets' as const,
      label: 'Global market board',
      tool: 'Global Markets',
      route: '/global-markets',
      reason: 'Test delayed feeds',
      targets: [],
      domain: 'macro' as const,
      critical: false,
    }
    const result = await collectReportResearch(
      { ...planReportResearch(scope, emptyPortfolio), sources: [source] },
      scope,
      emptyPortfolio,
      undefined,
      {
        get: async () => ({
          as_of: '2026-08-05T15:30:00Z',
          sections: [{ name: 'Equities', rows: [{ label: 'S&P 500', price: 6420, change_pct: 0.6, status: 'delayed' }] }],
        }),
        post: async () => ({}),
      },
    )

    expect(result.failed).toEqual([])
    expect(result.clips[0]?.payload).toMatchObject({
      kind: 'table',
      rows: [['Equities', 'S&P 500', 6420, 0.6, 'delayed']],
    })
  })

  it('limits per-ticker request fan-out', async () => {
    const scope = { ...defaultScope(), evidenceMode: 'alphatape' as const, goal: 'Review portfolio news' }
    const targets = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL']
    const source = {
      id: 'news' as const,
      label: 'Recent news',
      tool: 'Mover Radar',
      route: '/mover-radar',
      reason: 'Test concurrency',
      targets,
      domain: 'issuer' as const,
      critical: false,
    }
    let active = 0
    let peak = 0
    await collectReportResearch(
      { ...planReportResearch(scope, emptyPortfolio), sources: [source] },
      scope,
      emptyPortfolio,
      undefined,
      {
        get: async url => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active -= 1
          const ticker = new URL(`https://local${url}`).searchParams.get('ticker')
          return { news: [{ content: { title: `${ticker} update`, provider: { displayName: 'Wire' }, pubDate: '2026-08-05T12:00:00Z' } }] }
        },
        post: async () => ({}),
      },
    )

    expect(peak).toBeLessThanOrEqual(2)
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
        domain: 'issuer' as const,
        critical: false,
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
        domain: 'issuer' as const,
        critical: false,
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
      { id: 'peer-valuation' as const, label: 'Peer valuation', tool: 'Peer Comparison', route: '/relative-valuation', reason: 'test', targets: ['AAPL'], domain: 'issuer' as const, critical: false },
      { id: 'dcf-valuation' as const, label: 'DCF valuation', tool: 'DCF Valuation', route: '/dcf', reason: 'test', targets: ['AAPL'], domain: 'issuer' as const, critical: false },
      { id: 'regression' as const, label: 'Regression', tool: 'Regression', route: '/regression', reason: 'test', targets: ['AAPL', 'MSFT'], domain: 'benchmark' as const, critical: false },
      { id: 'volatility-skew' as const, label: 'Skew', tool: 'Volatility Skew', route: '/skew', reason: 'test', targets: ['AAPL'], domain: 'issuer' as const, critical: false },
      { id: 'dealer-gex' as const, label: 'GEX', tool: 'Dealer GEX', route: '/gex', reason: 'test', targets: ['AAPL'], domain: 'issuer' as const, critical: false },
      { id: 'implied-probability' as const, label: 'Probability', tool: 'Implied Probability', route: '/probability', reason: 'test', targets: ['AAPL'], domain: 'issuer' as const, critical: false },
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
      domain: 'benchmark' as const,
      critical: false,
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
      expect(visual.payload.details).toContainEqual(expect.objectContaining({
        key: 'vsSpyOneMonth',
        label: 'Vs SPY · 1M %',
      }))
    }
  })

  it('keeps every eligible position in portfolio-wide risk analytics', async () => {
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
      domain: 'portfolio' as const,
      critical: true,
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
    expect(compareRequest.portfolios[0].tickers).toHaveLength(21)
    expect(compareRequest.portfolios[0].tickers[0]).toBe('H21')
    expect(compareRequest.portfolios[0].tickers).toContain('H01')
    const metrics = result.clips.find(clip => clip.payload.kind === 'kpi')
    expect(metrics?.payload.title).not.toContain('top 20 equity sleeve')
    if (metrics?.payload.kind === 'kpi') {
      expect(metrics.payload.cells).toContainEqual(expect.objectContaining({
        label: 'Book coverage',
        sub: 'All eligible positions',
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
      get: async () => reportToolManifest,
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
      get: async () => reportToolManifest,
      post: async () => ({
        summary: 'Add valuation.',
        additions: [{ id: 'dcf-valuation', reason: 'Fundamental anchor.' }],
      }),
    })
    expect(enhanced.sources.find(s => s.id === 'dcf-valuation')!.targets).toEqual(['NVDA'])
  })
})

describe('tools reached by the evidence-selection rebuild', () => {
  const scope = { ...defaultScope(), goal: 'Assess AAPL' }
  const src = (id: any, targets: string[] = ['AAPL']) => ({
    id, label: id, tool: id, route: `/${id}`, reason: 'test',
    targets, domain: 'issuer' as const, critical: false,
  })
  const run = (source: any, get: (url: string) => any) => collectReportResearch(
    { objective: 'x', intent: 'company', symbols: ['AAPL'], sources: [source] },
    scope, emptyPortfolio, undefined,
    { get: async (url: string) => get(url), post: async () => ({}) },
  )

  it('reports the seasonal record with the sample size behind every figure', async () => {
    // A hit rate quoted without its n is the misreading this tool invites, so
    // the observation count has to survive into the clip, not just the chart.
    const result = await run(src('seasonality'), () => ({
      available: true, ticker: 'AAPL', years_covered: 20, sessions: 5048, first_date: '2006-07-14',
      months: [{ label: 'Jan', n: 20, mean_pct: -1.68, median_pct: -0.81, hit_rate_pct: 45, best_pct: 12.7, worst_pct: -31.7 }],
      best_month: { label: 'Jul', n: 20, mean_pct: 6.69, hit_rate_pct: 90 },
      worst_month: { label: 'Jan', n: 20, mean_pct: -1.68, hit_rate_pct: 45 },
      current_month: { label: 'Aug', n: 21, mean_pct: 4.43, hit_rate_pct: 66.7 },
    }))
    const kpi = result.clips.find(clip => clip.payload.kind === 'kpi')
    expect(kpi).toBeTruthy()
    if (kpi?.payload.kind === 'kpi') {
      const current = kpi.payload.cells.find(cell => cell.label.includes('Aug'))
      expect(current?.sub).toContain('n=21')
    }
    const table = result.clips.find(clip => clip.payload.kind === 'table')
    if (table?.payload.kind === 'table') {
      expect(table.payload.columns).toContain('Observations')
    }
  })

  it('keeps the 10b5-1 split visible beside insider buy and sell totals', async () => {
    // A scheduled sale carries no signal. Totals without the split get over-read.
    const result = await run(src('insider-activity'), () => ({
      transactions: [
        { date: '2026-07-01', insider: 'A Person', title: 'CFO', side: 'sell', shares: 100, value: 20000, is_10b51: true },
        { date: '2026-06-01', insider: 'B Person', title: 'CEO', side: 'buy', shares: 50, value: 9000, is_10b51: false },
      ],
      held_pct_insiders: 0.0165,
    }))
    const kpi = result.clips.find(clip => clip.payload.kind === 'kpi')
    if (kpi?.payload.kind === 'kpi') {
      expect(kpi.payload.cells.find(cell => cell.label.includes('10b5-1'))?.value).toBe('1 of 2')
    }
  })

  it('states plainly when a pair is not cointegrated', async () => {
    // Without stationarity the z-score has no mean to revert to, so a bare
    // z-score of 1.48 would read as a live signal when it is nothing of the sort.
    const result = await run(src('pairs', ['AAPL', 'MSFT']), () => ({
      hedge_ratio: -0.3513, correlation: 0.111, hedge_method: 'ols', signal: 'flat',
      adf: { stat: -1.267, crit_5: -2.86, stationary: false },
      zscore: { current: 1.48, entry: 2, exit: 0.5, window: 60 },
      half_life_days: 42.4, backtest: { sharpe: 0.54, trades: 4, win_rate: 50 },
    }))
    const kpi = result.clips.find(clip => clip.payload.kind === 'kpi')
    if (kpi?.payload.kind === 'kpi') {
      expect(kpi.payload.cells.find(cell => cell.label === 'Cointegrated')?.value).toBe('No')
      expect(kpi.payload.cells.find(cell => cell.label === 'Spread z-score')?.sub)
        .toBe('Not mean-reverting on this window')
    }
  })

  it('carries the breadth participation history as its own visual', async () => {
    const result = await run({ ...src('breadth', []), domain: 'benchmark' as const }, () => ({
      available: true, index: '^GSPC', as_of: '2026-08-07',
      coverage: { listed: 501, priced: 501 },
      today: { advancing: 322, declining: 177, ad_ratio: 1.82, new_highs: 21, new_lows: 1 },
      participation: { pct_above_50: 66.4, pct_above_200: 73.8, pct_above_50_change: 1.8, pct_above_200_change: 2.2 },
      divergence: { state: 'aligned', sessions: 21, index_change_pct: 2.41 },
      history: Array.from({ length: 10 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`, ad_line: 100 + i, pct_above_50: 60 + i, pct_above_200: 70 + i,
      })),
    }))
    const charts = result.clips.filter(clip => clip.payload.kind === 'chart')
    expect(charts.length).toBe(2)
    expect(result.clips.some(clip => clip.payload.kind === 'kpi')).toBe(true)
  })

  it('records a thin source as a gap instead of failing the report', async () => {
    // Every new fetcher returns [] rather than throwing when the source has
    // nothing, so one empty answer degrades that pull, not the whole run.
    const result = await run(src('debt-maturity'), () => ({ buckets: [] }))
    expect(result.clips).toEqual([])
    expect(result.failed).toEqual([{
      sourceId: 'debt-maturity',
      label: 'debt-maturity',
      target: 'AAPL',
      researchKey: 'debt-maturity:AAPL',
      message: 'No usable data returned for AAPL.',
    }])
  })
})

describe('modelled tools', () => {
  const scope = { ...defaultScope(), goal: 'Value AAPL' }
  const src = (id: any, targets: string[] = ['AAPL'], domain: any = 'issuer') => ({
    id, label: id, tool: id, route: `/${id}`, reason: 'test',
    targets, domain, critical: false,
  })
  const run = (source: any, client: any, book = emptyPortfolio) => collectReportResearch(
    { objective: 'x', intent: 'company', symbols: ['AAPL'], sources: [source] },
    scope, book, undefined, client,
  )

  const FUNDAMENTALS = {
    ticker: 'AAPL', revenue: 416161, shares: 15004.7, net_debt: 54744,
    market_price: 313.33, beta: 1.07, source: 'computed CAPM',
    schedule: [1, 2, 3, 4, 5].map(year => ({
      year, growth: 6, margin: 32, tax_rate: 15.6, da_pct: 2.8, capex_pct: 3.1,
      change_nwc_pct: 0, sbc_pct: 0, cash_adjustment_pct: 0, fcf_conversion_pct: 100,
      net_interest_pct: 0, dilution_pct: 0, payout_pct: 0,
    })),
    current_multiples: { ev_revenue: 11.4, ev_ebitda: 26.2 },
    business_segments: [{ name: 'Products', revenue_share: 75, price_to_sales_multiple: 8 }],
    business_segments_source: 'SEC', business_segments_fiscal_year: 2025,
    dividend_per_share: 1.08, dividend_yield: 0.34,
  }

  it('seeds the valuation request from fundamentals and reports the method spread', async () => {
    // The composite alone hides a DCF and a multiples value 80% apart, so the
    // spread has to reach the clip beside it.
    let posted: any = null
    const result = await run(src('master-valuation'), {
      get: async () => FUNDAMENTALS,
      post: async (_url: string, body: any) => {
        posted = body
        return {
          ticker: 'AAPL', market_price: 313.33,
          methods: { dcf: 143.66, multiples: 263.0, ddm: null, sotp: 144.05 },
          composite: { value_per_share: 185.43, range_low: 143.66, range_high: 263.0 },
          reverse: { implied_revenue_cagr: 15.08, implied_terminal_margin: 74.08, implied_wacc: 6.09, implied_exit_multiple: 35.4, implied_exit_year: 3 },
        }
      },
    })

    expect(posted.schedule).toHaveLength(5)
    expect(posted.multiple_targets.map((t: any) => t.metric)).toEqual(['ev_revenue', 'ev_ebitda'])
    expect(posted.weights).toEqual({ dcf: 65, multiples: 35, ddm: 0, sotp: 0 })
    expect(posted.schedule[0].payout_pct).toBeGreaterThan(0)   // pays a dividend

    const kpi = result.clips.find(clip => clip.payload.kind === 'kpi')
    if (kpi?.payload.kind === 'kpi') {
      expect(kpi.payload.cells.find(cell => cell.label === 'Method spread')?.value)
        .toBe('$143.66 to $263.00')
    }
    const table = result.clips.find(clip => clip.payload.kind === 'table')
    if (table?.payload.kind === 'table') {
      // DDM returned null, so it is absent rather than rendered as a dash.
      expect(table.payload.rows.map(row => row[0])).toEqual([
        'Discounted cash flow', 'Exit multiples', 'Sum of the parts',
      ])
    }
    expect(result.clips.some(clip => clip.payload.title?.includes('already assumes'))).toBe(true)
  })

  it('refuses to value a company whose fundamentals cannot support the model', async () => {
    // A valuation built on a two-year forecast is worse than no valuation.
    const result = await run(src('master-valuation'), {
      get: async () => ({ ...FUNDAMENTALS, schedule: FUNDAMENTALS.schedule.slice(0, 2) }),
      post: async () => { throw new Error('analyze must not be called') },
    })
    expect(result.clips).toEqual([])
    // And the report says which fundamental was missing, rather than implying
    // the source was down.
    expect(result.failed[0].message).toContain('three annual periods')
  })

  it('weights the simulator by live market value, not cost basis', async () => {
    // A book that has moved is misweighted by cost, which would misstate the tail.
    const book: ActivePortfolioContext = {
      ...portfolio,
      holdings: [{ ticker: 'AAPL', shares: 10, avgCost: 100 }, { ticker: 'MSFT', shares: 10, avgCost: 100 }],
    }
    let posted: any = null
    await run(src('monte-carlo', [], 'portfolio'), {
      get: async () => ({ AAPL: { current_price: 300 }, MSFT: { current_price: 100 } }),
      post: async (_url: string, body: any) => {
        posted = body
        return { percentiles: { p5: 0.87, p25: 1.1, p50: 1.26, p75: 1.43, p95: 1.76 }, var_95: 12.58, cvar_95: 19.13, core_metrics: {}, mu: 0.24, sigma: 0.21 }
      },
    }, book)

    expect(posted.tickers).toEqual(['AAPL', 'MSFT'])
    expect(posted.weights).toEqual([0.75, 0.25])   // by value, not the 50/50 cost split
  })

  it('labels the optimiser gap as in-sample so it does not read as free money', async () => {
    const book: ActivePortfolioContext = {
      ...portfolio,
      holdings: [{ ticker: 'AAPL', shares: 10, avgCost: 100 }, { ticker: 'MSFT', shares: 10, avgCost: 100 }],
    }
    const result = await run(src('portfolio-optimizer', [], 'portfolio'), {
      get: async () => ({ AAPL: { current_price: 300 }, MSFT: { current_price: 100 } }),
      post: async () => ({
        tickers: ['AAPL', 'MSFT'], dropped: [], days: 896,
        span: { start: '2023-01-04', end: '2026-07-31' },
        portfolios: {
          current: { return: 20, vol: 22, sharpe: 0.9 },
          max_sharpe: { return: 24, vol: 20, sharpe: 1.2 },
          min_variance: { return: 12, vol: 14, sharpe: 0.6 },
          risk_parity: { return: 18, vol: 19, sharpe: 0.8 },
          equal_weight: { return: 19, vol: 21, sharpe: 0.85 },
        },
        frontier: Array.from({ length: 12 }, (_, i) => ({ vol: 14 + i, return: 12 + i })),
      }),
    }, book)

    const kpi = result.clips.find(clip => clip.payload.kind === 'kpi')
    if (kpi?.payload.kind === 'kpi') {
      const gap = kpi.payload.cells.find(cell => cell.label === 'Sharpe gap')
      expect(gap?.value).toBe('0.30')
      expect(gap?.sub).toContain('In-sample')
    }
    expect(result.clips.some(clip => clip.payload.kind === 'chart')).toBe(true)
  })

  const stubStorage = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  }

  it('runs no backtest when the user has saved no strategy', async () => {
    stubStorage()
    const result = await run(src('portfolio-backtest', [], 'portfolio'), {
      get: async () => ({}),
      post: async () => { throw new Error('backtest must not be called without a strategy') },
    })
    expect(result.clips).toEqual([])
  })

  it('replays the saved strategy and says it measures the rule, not the holdings', async () => {
    stubStorage()
    localStorage.setItem('fdb_algo_universe_monte_carlo_handoff', JSON.stringify({
      version: 1, createdAt: '2026-08-01', start: '2023-01-01', end: '2026-08-01',
      timeframe: '1d', tradeSizePct: 10, leverage: 1, effectiveAnnualRate: 0,
      strategy: { name: 'RSI Mean Reversion', buy: [{ x: 1 }], sell: [{ y: 2 }], risk: { stopLossPct: 5 } },
      positions: [{ ticker: 'AAPL', side: 'long' }, { ticker: 'MSFT', side: 'long' }],
    }))
    let posted: any = null
    const result = await run(src('portfolio-backtest', [], 'portfolio'), {
      get: async () => ({}),
      post: async (_url: string, body: any) => {
        posted = body
        return { metrics: { total_return: 34.2, cagr: 9.8, sharpe: 0.71, max_drawdown: -18.4, trades: 42, win_rate: 55, exposure_pct: 61 }, equity_curve: [] }
      },
    })

    expect(posted.positions).toHaveLength(2)
    expect(posted.positions[0].rules).toEqual({ buy: [{ x: 1 }], sell: [{ y: 2 }] })
    expect(posted.positions[0].stop_loss).toBe(5)
    const kpi = result.clips.find(clip => clip.payload.kind === 'kpi')
    if (kpi?.payload.kind === 'kpi') {
      expect(kpi.payload.cells.find(cell => cell.label === 'Measures')?.value)
        .toBe('The rule set, not the holdings')
    }
    localStorage.removeItem('fdb_algo_universe_monte_carlo_handoff')
  })
})

describe('per-ticker sources report real coverage', () => {
  const scope = { ...defaultScope(), goal: 'Assess AAPL' }

  /** Every per-ticker source must emit one clip keyed with the bare ticker.
   *
   * collectReportResearch marks a target missing unless some clip has
   * researchKey `${sourceId}:${target}` exactly. A source whose clips all use a
   * suffixed key returns full data and is still reported as a total failure —
   * which is what "No usable data returned for X" meant on a tool that worked. */
  const payloads: Record<string, any> = {
    '/api/market/seasonality': {
      available: true, ticker: 'AAPL', years_covered: 20, sessions: 5048, first_date: '2006-07-14',
      months: [{ label: 'Jan', n: 20, mean_pct: 1, median_pct: 1, hit_rate_pct: 50, best_pct: 2, worst_pct: -2 }],
      best_month: { label: 'Jul', n: 20, mean_pct: 6 }, worst_month: { label: 'Jan', n: 20, mean_pct: -1 },
      current_month: { label: 'Aug', n: 21, mean_pct: 4 },
    },
    '/api/corporate/debt-maturity': { buckets: [{ label: '2027', amount: 1e9 }], total: 1e9, fiscal_year: 2025 },
    '/api/corporate/hub/insider': { transactions: [{ date: '2026-07-01', insider: 'A', title: 'CFO', side: 'buy', shares: 1, value: 100 }] },
    '/api/corporate/institutional': { pct_institutions: 0.66, holders: [{ holder: 'X', shares: 1, value: 1, pct_out: 0.01, date: '2026-03-31' }], changes: {} },
    '/api/options/unusual': { count: 1, rows: [{ ticker: 'AAPL', type: 'call', strike: 300, expiry: '2026-09-18', volume: 900, openInterest: 100, volOiRatio: 9, iv: 0.4, premium: 5 }], params: {} },
    '/api/market/asset-profile': { ticker: 'AAPL', stats: { last: 313, returns: {}, range_52w: {}, vs_benchmark: {} } },
  }

  const cases: [string, string][] = [
    ['seasonality', '/api/market/seasonality'],
    ['debt-maturity', '/api/corporate/debt-maturity'],
    ['insider-activity', '/api/corporate/hub/insider'],
    ['institutional-ownership', '/api/corporate/institutional'],
    ['options-unusual', '/api/options/unusual'],
    ['asset-profile', '/api/market/asset-profile'],
  ]

  it.each(cases)('%s records no phantom gap when it returns data', async (id, endpoint) => {
    const source = {
      id: id as any, label: id, tool: id, route: `/${id}`, reason: 'test',
      targets: ['AAPL'], domain: 'issuer' as const, critical: false,
    }
    const result = await collectReportResearch(
      { objective: 'x', intent: 'company', symbols: ['AAPL'], sources: [source] },
      scope, emptyPortfolio, undefined,
      { get: async () => payloads[endpoint], post: async () => ({}) },
    )

    expect(result.clips.length).toBeGreaterThan(0)
    expect(result.failed).toEqual([])
    expect(result.clips.some(clip => clip.researchKey === `${id}:AAPL`)).toBe(true)
    // The route link keeps the symbol, so "open tool" lands on the right page.
    expect(result.clips[0].sourceRoute).toContain('AAPL')
  })

  it('master valuation keys its primary clip on the bare ticker', async () => {
    const source = {
      id: 'master-valuation' as any, label: 'mv', tool: 'mv', route: '/master-valuation',
      reason: 'test', targets: ['AAPL'], domain: 'issuer' as const, critical: false,
    }
    const result = await collectReportResearch(
      { objective: 'x', intent: 'company', symbols: ['AAPL'], sources: [source] },
      scope, emptyPortfolio, undefined,
      {
        get: async () => ({
          ticker: 'AAPL', revenue: 1000, shares: 100, net_debt: 0, market_price: 50,
          schedule: [1, 2, 3].map(year => ({ year, growth: 5, margin: 20 })),
          current_multiples: {}, business_segments: [], dividend_per_share: null,
        }),
        post: async () => ({
          ticker: 'AAPL', market_price: 50,
          methods: { dcf: 60, multiples: null, ddm: null, sotp: null },
          composite: { value_per_share: 60, range_low: 60, range_high: 60 },
          reverse: {},
        }),
      },
    )
    expect(result.failed).toEqual([])
    expect(result.clips.some(clip => clip.researchKey === 'master-valuation:AAPL')).toBe(true)
  })
})

describe('failure messages name the real cause', () => {
  const scope = { ...defaultScope(), goal: 'Assess AAPL' }
  const httpError = (status: number, detail?: string) =>
    Object.assign(new Error('Request failed'), { response: { status, data: detail ? { detail } : undefined } })

  it('surfaces what a 4xx source actually rejected', async () => {
    // "Research source did not complete" hid a hard twelve-ticker cap, so a book
    // with thirteen holdings lost its correlation evidence with no way to tell why.
    const source = {
      id: 'correlation' as const, label: 'Correlation structure', tool: 'Correlation',
      route: '/correlation', reason: 'test', targets: ['AAPL', 'MSFT'],
      domain: 'portfolio' as const, critical: false,
    }
    const result = await collectReportResearch(
      { objective: 'x', intent: 'portfolio', symbols: ['AAPL', 'MSFT'], sources: [source] },
      scope, emptyPortfolio, undefined,
      { get: async () => ({}), post: async () => { throw httpError(400, 'Maximum 12 tickers') } },
    )
    expect(result.failed[0].message).toContain('Maximum 12 tickers')
  })

  it('distinguishes a throttled ticker from one with genuinely no data', async () => {
    const source = {
      id: 'news' as const, label: 'Recent news', tool: 'Mover Radar', route: '/mover-radar',
      reason: 'test', targets: ['ORCL', 'MSFT'], domain: 'issuer' as const, critical: false,
    }
    const result = await collectReportResearch(
      { objective: 'x', intent: 'company', symbols: ['ORCL', 'MSFT'], sources: [source] },
      scope, emptyPortfolio, undefined,
      {
        get: async (url: string) => {
          if (url.includes('ORCL')) throw httpError(429)
          return { news: [] }          // answered, but had nothing
        },
        post: async () => ({}),
      },
    )
    const byTarget = Object.fromEntries(result.failed.map(f => [f.target, f.message]))
    expect(byTarget.ORCL).toContain('rate limit')
    expect(byTarget.MSFT).toBe('No usable data returned for MSFT.')
  })

  it('caps a relationship tool at what its endpoint accepts', () => {
    const book: ActivePortfolioContext = {
      ...portfolio,
      holdings: Array.from({ length: 15 }, (_, i) => ({ ticker: `T${i}`, shares: 15 - i, avgCost: 100 })),
      positionCount: 15,
    }
    const plan = planReportResearch(
      { ...defaultScope(), includePortfolio: true, goal: 'Review my portfolio diversification' },
      book,
    )
    const correlation = plan.sources.find(source => source.id === 'correlation')
    expect(correlation?.targets).toHaveLength(12)
    expect(correlation?.reason).toContain('largest 12 of 15')
  })
})
