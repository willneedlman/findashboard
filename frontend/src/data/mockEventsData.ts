// Seed data for the Macro Event Release Hub (Macro hub tool). A realistic set of
// recent and upcoming economic + central-bank releases so the feed is fully
// functional before it is ever wired to the live FRED/FMP calendar. Reactions
// are the immediate cross-asset move in the minutes after each print. Yields are
// quoted in basis points, everything else in percent, because that is how each
// asset actually trades.

export type Region = 'US' | 'EU' | 'ASIA'
export type Impact = 'High' | 'Medium' | 'Low'
export type EventStatus = 'released' | 'upcoming'
export type ReactionUnit = '%' | 'bp'

export interface MarketReaction {
  asset: string          // 'S&P 500', 'DXY', 'US 10Y', 'EUR/USD', 'Bund 10Y', ...
  change: number         // signed move; up is green, down is red
  unit: ReactionUnit
}

export interface MacroEvent {
  id: string
  name: string
  country: string        // full display name
  countryCode: string    // short code shown in the region chip
  region: Region
  category: 'Inflation' | 'Central Bank' | 'Labor' | 'Growth' | 'Sentiment'
  datetime: string       // ISO with offset, drives sort + released/upcoming split
  displayTime: string    // preformatted label so the stated release time never drifts by viewer timezone
  impact: Impact
  status: EventStatus
  actual: string | null  // null until released
  expected: string | null // consensus, when the data tier provides it (FRED does not)
  previous: string
  summary: string        // brief AI-style read, spartan voice
  sourceName: string
  sourceUrl: string
  reactions: MarketReaction[]
}

export const REGIONS: { key: Region; label: string }[] = [
  { key: 'US', label: 'United States' },
  { key: 'EU', label: 'Europe' },
  { key: 'ASIA', label: 'Asia' },
]

export const IMPACTS: Impact[] = ['High', 'Medium', 'Low']

export const REGION_LABEL: Record<Region, string> = {
  US: 'United States',
  EU: 'Europe',
  ASIA: 'Asia',
}

export const MOCK_EVENTS: MacroEvent[] = [
  // ── Upcoming ────────────────────────────────────────────────────────────────
  {
    id: 'us-cpi-jun',
    name: 'CPI Inflation (June)',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Inflation',
    datetime: '2026-07-15T08:30:00-04:00', displayTime: 'Jul 15, 2026 · 08:30 ET',
    impact: 'High', status: 'upcoming',
    actual: null, expected: '2.5% y/y', previous: '2.4% y/y',
    summary: 'The June print is the last major inflation read before the July FOMC. A core figure above 2.9% would stall the easing case and lift the front end. Watch shelter and core services, which drive the sticky part of the basket.',
    sourceName: 'BLS', sourceUrl: 'https://www.bls.gov/cpi/',
    reactions: [],
  },
  {
    id: 'cn-gdp-q2',
    name: 'GDP Growth (Q2)',
    country: 'China', countryCode: 'CN', region: 'ASIA', category: 'Growth',
    datetime: '2026-07-15T10:00:00+08:00', displayTime: 'Jul 15, 2026 · 10:00 CST',
    impact: 'High', status: 'upcoming',
    actual: null, expected: '4.8% y/y', previous: '5.2% y/y',
    summary: 'Second-quarter output tests whether the property drag is easing or spreading. A miss below 4.6% would revive stimulus bets and pressure industrial commodities. Retail sales and fixed-asset investment land alongside it.',
    sourceName: 'China NBS', sourceUrl: 'https://www.stats.gov.cn/english/',
    reactions: [],
  },
  {
    id: 'uk-cpi-jun',
    name: 'CPI Inflation (June)',
    country: 'United Kingdom', countryCode: 'UK', region: 'EU', category: 'Inflation',
    datetime: '2026-07-16T07:00:00+01:00', displayTime: 'Jul 16, 2026 · 07:00 BST',
    impact: 'Medium', status: 'upcoming',
    actual: null, expected: '3.2% y/y', previous: '3.4% y/y',
    summary: 'Services inflation remains the Bank of England sticking point. A cooler core would open room for an August cut and weigh on sterling. The market prices roughly one more cut into year end.',
    sourceName: 'UK ONS', sourceUrl: 'https://www.ons.gov.uk/economy/inflationandpriceindices',
    reactions: [],
  },
  {
    id: 'eu-pmi-jul',
    name: 'Flash Composite PMI (July)',
    country: 'Eurozone', countryCode: 'EU', region: 'EU', category: 'Sentiment',
    datetime: '2026-07-23T10:00:00+02:00', displayTime: 'Jul 23, 2026 · 10:00 CET',
    impact: 'Medium', status: 'upcoming',
    actual: null, expected: '50.9', previous: '50.6',
    summary: 'The composite sits just above the expansion line. A slip back under 50 would harden the case for the ECB to keep cutting. Manufacturing stays the weak leg while services hold up.',
    sourceName: 'S&P Global', sourceUrl: 'https://www.pmi.spglobal.com/',
    reactions: [],
  },
  {
    id: 'ecb-jul',
    name: 'ECB Deposit Rate Decision',
    country: 'Eurozone', countryCode: 'EU', region: 'EU', category: 'Central Bank',
    datetime: '2026-07-24T14:15:00+02:00', displayTime: 'Jul 24, 2026 · 14:15 CET',
    impact: 'High', status: 'upcoming',
    actual: null, expected: 'Hold 2.00%', previous: '2.00%',
    summary: 'The market expects a hold after June cut to 2.00%. The read is all in the statement and Lagarde tone on whether the cutting cycle is done. A hawkish pause would lift the euro and Bund yields.',
    sourceName: 'ECB', sourceUrl: 'https://www.ecb.europa.eu/press/govcdec/html/index.en.html',
    reactions: [],
  },
  {
    id: 'fomc-jul',
    name: 'FOMC Rate Decision',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Central Bank',
    datetime: '2026-07-29T14:00:00-04:00', displayTime: 'Jul 29, 2026 · 14:00 ET',
    impact: 'High', status: 'upcoming',
    actual: null, expected: 'Hold 4.25-4.50%', previous: '4.25-4.50%',
    summary: 'No move is priced, so the reaction rides on the statement and the Powell press conference. Any softening of the data-dependent language would pull forward the first cut. The dot plot does not update at this meeting.',
    sourceName: 'Federal Reserve', sourceUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    reactions: [],
  },

  // ── Released ────────────────────────────────────────────────────────────────
  {
    id: 'us-nfp-jun',
    name: 'Non-Farm Payrolls (June)',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Labor',
    datetime: '2026-07-03T08:30:00-04:00', displayTime: 'Jul 3, 2026 · 08:30 ET',
    impact: 'High', status: 'released',
    actual: '+147K', expected: '+110K', previous: '+144K',
    summary: 'Payrolls beat at 147K and the jobless rate held at 4.1%. The strength pushes back July cut odds and lifts front-end yields. Wage growth at 3.9% stayed firm enough to keep the Fed patient.',
    sourceName: 'BLS', sourceUrl: 'https://www.bls.gov/news.release/empsit.nr0.htm',
    reactions: [
      { asset: 'S&P 500', change: 0.15, unit: '%' },
      { asset: 'DXY', change: 0.34, unit: '%' },
      { asset: 'US 10Y', change: 6, unit: 'bp' },
    ],
  },
  {
    id: 'us-ism-jun',
    name: 'ISM Manufacturing PMI (June)',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Growth',
    datetime: '2026-07-01T10:00:00-04:00', displayTime: 'Jul 1, 2026 · 10:00 ET',
    impact: 'Medium', status: 'released',
    actual: '49.0', expected: '48.8', previous: '48.5',
    summary: 'Factory activity ticked up but stayed in contraction for a fourth month. New orders improved while prices paid eased, a mild relief on the goods side of inflation. Not enough to change the rate path.',
    sourceName: 'ISM', sourceUrl: 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/',
    reactions: [
      { asset: 'S&P 500', change: 0.10, unit: '%' },
      { asset: 'DXY', change: 0.12, unit: '%' },
      { asset: 'US 10Y', change: 2, unit: 'bp' },
    ],
  },
  {
    id: 'us-pce-may',
    name: 'Core PCE Price Index (May)',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Inflation',
    datetime: '2026-06-27T08:30:00-04:00', displayTime: 'Jun 27, 2026 · 08:30 ET',
    impact: 'High', status: 'released',
    actual: '2.7% y/y', expected: '2.7% y/y', previous: '2.6% y/y',
    summary: 'The Fed preferred gauge landed in line at 2.7%. In-line but sticky keeps a September cut as the base case, not July. Real spending was soft, a small offset that helped equities and bonds.',
    sourceName: 'BEA', sourceUrl: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index',
    reactions: [
      { asset: 'S&P 500', change: 0.30, unit: '%' },
      { asset: 'DXY', change: -0.10, unit: '%' },
      { asset: 'US 10Y', change: -1, unit: 'bp' },
    ],
  },
  {
    id: 'us-gdp-q1',
    name: 'GDP Growth (Q1, Final)',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Growth',
    datetime: '2026-06-26T08:30:00-04:00', displayTime: 'Jun 26, 2026 · 08:30 ET',
    impact: 'Medium', status: 'released',
    actual: '-0.5% q/q', expected: '-0.2% q/q', previous: '-0.2% q/q',
    summary: 'The final revision cut first-quarter output to -0.5% annualized, worse than the prior read. Weaker consumer spending drove the markdown and revived soft-landing worries. Yields fell as cut odds firmed.',
    sourceName: 'BEA', sourceUrl: 'https://www.bea.gov/data/gdp/gross-domestic-product',
    reactions: [
      { asset: 'S&P 500', change: -0.40, unit: '%' },
      { asset: 'DXY', change: -0.25, unit: '%' },
      { asset: 'US 10Y', change: -4, unit: 'bp' },
    ],
  },
  {
    id: 'boj-jun',
    name: 'BoJ Policy Rate Decision',
    country: 'Japan', countryCode: 'JP', region: 'ASIA', category: 'Central Bank',
    datetime: '2026-06-20T12:00:00+09:00', displayTime: 'Jun 20, 2026 · 12:00 JST',
    impact: 'High', status: 'released',
    actual: 'Hold 0.50%', expected: 'Hold 0.50%', previous: '0.50%',
    summary: 'The Bank of Japan held at 0.50% but flagged that the next hike stays on the table. The hawkish hold sent the yen higher and pressured exporters. JGB yields rose as the market pulled forward the tightening path.',
    sourceName: 'Bank of Japan', sourceUrl: 'https://www.boj.or.jp/en/mopo/mpmdeci/index.htm',
    reactions: [
      { asset: 'Nikkei 225', change: -0.80, unit: '%' },
      { asset: 'USD/JPY', change: -0.65, unit: '%' },
      { asset: 'JGB 10Y', change: 3, unit: 'bp' },
    ],
  },
  {
    id: 'fomc-jun',
    name: 'FOMC Rate Decision + SEP',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Central Bank',
    datetime: '2026-06-18T14:00:00-04:00', displayTime: 'Jun 18, 2026 · 14:00 ET',
    impact: 'High', status: 'released',
    actual: 'Hold 4.25-4.50%', expected: 'Hold 4.25-4.50%', previous: '4.25-4.50%',
    summary: 'The Fed held and the updated dot plot penciled in fewer cuts than the market wanted. Powell leaned on data dependence and gave no green light on timing. Equities slipped and the dollar firmed on the hawkish shift.',
    sourceName: 'Federal Reserve', sourceUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    reactions: [
      { asset: 'S&P 500', change: -0.55, unit: '%' },
      { asset: 'DXY', change: 0.45, unit: '%' },
      { asset: 'US 10Y', change: 8, unit: 'bp' },
    ],
  },
  {
    id: 'ecb-jun',
    name: 'ECB Deposit Rate Decision',
    country: 'Eurozone', countryCode: 'EU', region: 'EU', category: 'Central Bank',
    datetime: '2026-06-12T14:15:00+02:00', displayTime: 'Jun 12, 2026 · 14:15 CET',
    impact: 'High', status: 'released',
    actual: 'Cut to 2.00%', expected: 'Cut to 2.00%', previous: '2.25%',
    summary: 'The ECB cut 25bp to 2.00% as expected and softened its guidance only slightly. Lagarde kept optionality, so the euro firmed on the lack of a dovish tilt. Bund yields eased as the cut was fully delivered.',
    sourceName: 'ECB', sourceUrl: 'https://www.ecb.europa.eu/press/govcdec/html/index.en.html',
    reactions: [
      { asset: 'EuroStoxx 50', change: 0.35, unit: '%' },
      { asset: 'EUR/USD', change: -0.20, unit: '%' },
      { asset: 'Bund 10Y', change: -3, unit: 'bp' },
    ],
  },
  {
    id: 'us-cpi-may',
    name: 'CPI Inflation (May)',
    country: 'United States', countryCode: 'US', region: 'US', category: 'Inflation',
    datetime: '2026-06-11T08:30:00-04:00', displayTime: 'Jun 11, 2026 · 08:30 ET',
    impact: 'High', status: 'released',
    actual: '2.4% y/y', expected: '2.5% y/y', previous: '2.5% y/y',
    summary: 'Headline cooled to 2.4% and core eased to 2.8%, both a touch below the call. The soft print revived rate-cut hope and drove a broad risk rally. Yields dropped and the dollar sold off across the board.',
    sourceName: 'BLS', sourceUrl: 'https://www.bls.gov/news.release/cpi.nr0.htm',
    reactions: [
      { asset: 'S&P 500', change: 0.65, unit: '%' },
      { asset: 'DXY', change: -0.35, unit: '%' },
      { asset: 'US 10Y', change: -5, unit: 'bp' },
    ],
  },
]
