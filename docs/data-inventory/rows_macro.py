from build_inv import row, prov
R = 'backend/routers/rates.py'

row('yield_curve','feed_field','Rate Engine','US Treasury yield curve',
    'Constant-maturity Treasury yields across the curve, plus history.',
    '-', 'US Treasury / FRED', prov('/api/rates/yield-curve', f'{R}:231'),
    'daily, cached',
    'The base rate structure everything else prices off. Shape matters more than level: an inverted curve has preceded every US recession since 1970.',
    'Constant-maturity par yields, not zero-coupon or forward rates, so they are not directly usable for discounting a cash flow at a specific date.')

row('curve_spreads','derived_metric','Rate Engine','Curve spreads',
    'Differences between curve points, notably 10y minus 2y and 10y minus 3m.',
    'yield(long) - yield(short) per pair, with a 6-month trend',
    'FRED', prov('/api/rates/curve-spreads', f'{R}:900'),
    'daily',
    'Negative is inversion. The 10y-2y is the headline; the 10y-3m is the one most cited in the academic recession literature. Both feed the cycle composite.',
    'Inversion leads recessions by 6 to 18 months, a lag long and variable enough that the signal is close to useless for timing.')

row('fed_path','model','Rate Engine','Implied FOMC path',
    'Market-implied probability of a hike, hold or cut at each scheduled meeting.',
    'CME Fed funds futures (ZQ), unblended for meeting-month timing; falls back to the FRED Treasury curve where a contract has no data',
    'CME futures, FRED', prov('/api/rates/fed-projections', f'{R}:664'),
    'daily',
    'What the market expects, not what the Fed has said. Meetings priced off the curve fallback are flagged in gold so the reader knows which are futures-implied and which are inferred.',
    'Futures imply a distribution of the average effective rate over the month, not a clean per-meeting probability; the unblending is an approximation. The curve fallback is materially weaker.')

row('sep_dots','feed_field','Rate Engine','SEP dot plot',
    'The FOMC Summary of Economic Projections median, central tendency and range.',
    '-', 'FRED / Federal Reserve publications', prov('/api/rates/sep-dots', f'{R}:832'),
    'quarterly, on SEP publication',
    'The Fed own projection against the market path is the interesting comparison; a wide gap usually resolves toward the market.',
    'Median, central tendency and range only. Individual participant dots are NOT plotted because they are not published as attributable data, and inventing them would be fabrication.')

row('credit_spreads','feed_field','Credit Spreads','IG and HY option-adjusted spreads',
    'Corporate credit spreads over Treasuries by rating bucket, plus VIX alongside.',
    '-', 'FRED (ICE BofA OAS series)', prov('/api/rates/credit-spreads', f'{R}:1426'),
    'daily',
    'The cleanest single read on financial stress. HY past roughly 6 points is genuine funding stress; CCC is the most recession-sensitive bucket and widens first.',
    'Daily and index-level, so it lags an intraday risk event by a session. Option-adjusted, so it embeds a model of embedded optionality.')

row('macro_economy','feed_field','Macro Monitor','Unemployment, payrolls, CPI, core CPI, PCE',
    'The headline US labour and inflation series with a 24-month trend.',
    'payroll change is month-over-month difference of the level series; inflation gauges are year-over-year',
    'FRED', prov('/api/rates/economy', f'{R}:1571'),
    'monthly on release, disk-cached 15m',
    'The four numbers that move the rates market. Inflation gauges are plotted against the 2% target on one axis so CPI, core and PCE can be compared directly.',
    'FRED publishes no consensus, so there is no expected figure here and none is invented. Revisions are silent: a prior month can change without notice.')

row('cycle_composite','model','Macro Monitor','Cycle position',
    'Where the business cycle stands, from five indicators each scored against a published rule.',
    'each component scored -1 to +1 by linear interpolation between a "good" and "bad" level; composite is the mean of whichever components resolved. Components: 10y-2y spread, initial claims vs their 12-month low, the Sahm gap (3-month unemployment average minus its prior 12-month minimum), 3-month average payroll growth, and the HY spread',
    'FRED', prov('/api/rates/cycle', 'backend/cycle.py:145 cycle()'),
    'cached 1h, persisted',
    'Deliberately NOT a recession probability. Every component prints its level, its reading and the threshold it is judged against, so a reader who disagrees with one can see exactly which to discount. Currently Expansion at +0.46 with payrolls the single weak leg.',
    'A hand-set scoring rule, not a fitted model, and no probability is claimed from it. Thresholds (Sahm 0.50pp, claims 15% above trough, HY 6 points) are documented rules of thumb, not estimated parameters. A dead feed narrows the base rather than scoring neutral, which would make the panel less decisive the more broken it got.')

row('macro_calendar','feed_field','Economic Calendar','Release schedule',
    'Scheduled US and international economic releases with importance and category.',
    '-', 'FRED release schedule, Investing.com calendar scrape',
    prov('/api/rates/macro-calendar', f'{R}:1210'),
    'daily',
    'The forward diary. Drives the macro_event_within_days alert, which can watch marquee movers, Fed/Treasury only, or everything high-importance.',
    'Consensus is NOT in FRED. Expected figures come from an Investing.com scrape covering a subset of releases only, which is why an economic surprise index over the full calendar is not a free synthesis of data already held.')

row('macro_release_reaction','derived_metric','Economic Calendar','Release-day cross-asset reaction',
    'How the S&P, the dollar and the 10-year moved on the day of each release.',
    'same-day return of ^GSPC, DX-Y.NYB and ^TNX on the release date, from the shared price cache',
    'FRED release dates + yfinance', prov('/api/macro-events', 'backend/routers/macro_events.py:583 macro_events()'),
    'daily',
    'Attaches a market consequence to a print, which is more useful than the print alone. Repeated large reactions mark which releases actually matter this cycle.',
    'Whole-day returns, so it attributes everything that happened that day to the release. A release at 08:30 shares its day with the rest of the session.')

row('cot_positioning','feed_field','Trader Positioning','CFTC commitments of traders',
    'Net positioning by trader category across commodities, rates, FX and equity-index futures.',
    '-', 'CFTC published COT reports', prov('/api/official/cot'),
    'weekly (Friday, as of Tuesday)',
    'Extreme net positioning is a contrarian marker at the tails. Read the percentile against history rather than the raw contract count.',
    'Published Friday for Tuesday, so it is always at least three days stale and often more. Covers futures positioning only: no term structure, no roll yield, and no commodity curve, which would need a futures vendor.')

row('housing_market','model','Housing Market','Prices, mortgage rates, affordability, supply',
    'A housing cycle board: price index, 30-year rate, NAR-style affordability, supply and construction.',
    'HAI = median family income / income required to qualify for a mortgage on the median home x 100, at the current 30-year rate; 100 means the median family exactly qualifies',
    'FRED, Census, NAR-style construction in-house',
    prov('/api/housing/market', 'backend/housing_market.py:147 affordability_index()'),
    'monthly on release',
    'HAI at 100 is the balance point; below it the median family cannot afford the median home. It is the cleanest way to see rate moves transmitting into housing demand.',
    'HAI is NAR-style, reconstructed here rather than taken from NAR, so it will not match their published figure exactly. Some series in this tool run on a deterministic three-year mock cycle rather than live data.')

row('fx_matrix','derived_metric','FX Matrix','Cross-rate matrix and volatility',
    'Every pair among the tracked currencies, with 1-week realised volatility.',
    'cross rates derived from USD pairs; vol = stdev of weekly returns',
    'yfinance FX', prov('/api/fx/matrix'),
    'intraday, cached',
    'The grid view for spotting which leg of a move is doing the work. The diagonal is blank by construction.',
    'Crosses are derived from USD legs, so a synthetic cross carries both legs bid-ask, not the real quoted cross spread.')

row('bond_analytics','model','Bond Analytics','Price, yield, duration, convexity',
    'Fixed-income analytics for a bond given coupon, maturity and price or yield.',
    'standard discounted cash flow: YTM solved by bisection; Macaulay and modified duration; convexity from the second derivative of price with respect to yield',
    'in-house bond math (frontend/src/lib/bondMath.ts and backend/routers/bond.py)',
    prov('/api/bond/analytics'),
    'on request, pure function',
    'Modified duration is the first-order price move per 100bp; convexity is the correction that matters for large moves and for comparing bonds of similar duration.',
    'Assumes fixed coupons, no embedded options and no credit migration. A callable or a floater priced here is wrong.')

row('bond_lookup','feed_field','Bond Lookup','CUSIP resolution and marks',
    'Identify a bond from its CUSIP and attach an issuer, terms and where possible a price.',
    '-', 'OpenFIGI for identifiers, SEC EDGAR for issuers, SSGA and Alpha Vantage for ETF-derived marks',
    prov('/api/bond/cusip/{p}', 'backend/routers/bond.py'),
    'on request, cached',
    'Turns an unreadable identifier into an issuer and a set of terms, which is the first step in any bond workflow.',
    'Per-CUSIP TRACE prices need a paid FINRA entitlement and return 403, so the scaffold in bond_prices.py is dormant and marks fall back to widened SPDR ETF-derived levels. A CUSIP with no ETF exposure has no price at all.')
