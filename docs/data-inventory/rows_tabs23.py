import json, pathlib
from build_inv import write, OUT
SC = pathlib.Path('/private/tmp/claude-501/-Users-willneedlman-finance-dashboard/da8aaddc-9cd3-4ba5-a5f6-9f332088522e/scratchpad')
ORPH = json.loads((SC/'orphans.json').read_text())

C2 = ['endpoint','method','provenance','what_it_produces','why_it_matters','verdict']
def o(ep, produces, matters, verdict):
    e = ORPH.get(ep, {})
    return {'endpoint': ep, 'method': e.get('method',''),
            'provenance': f"{e.get('file','')}:{e.get('line','')} {e.get('fn','')}()",
            'what_it_produces': produces, 'why_it_matters': matters, 'verdict': verdict}

TAB2 = [
 o('/api/strategy/code/history',
   'Full revision history for a Python strategy, from the SQLite revision DAG in backend/algo_runtime/store.py.',
   'The whole version-control layer for generated strategies is built and reachable by HTTP but nothing calls it. StrategyCodePanel only calls /compile and /generate, so a user can generate code and lose the previous version with no way back.',
   'BUILD THE UI. The backend is done; this is a panel, not a feature.'),
 o('/api/strategy/code/commit', 'Commits a code revision against a strategy.', 'Same DAG. Nothing writes to it, so the history endpoint above has nothing to read even if it were wired.', 'BUILD THE UI'),
 o('/api/strategy/code/revert', 'Reverts a strategy to an earlier revision.', 'The payoff of the whole revision feature and it is unreachable.', 'BUILD THE UI'),
 o('/api/strategy/code/revision', 'Fetches one revision by id.', 'Supporting read for a diff view that does not exist.', 'BUILD THE UI'),
 o('/api/strategy/code/strategies', 'Lists strategies that have code revisions.', 'The index the history panel would open on.', 'BUILD THE UI'),
 o('/api/etf/holdings',
   'Full or top-25 constituents for a single ETF, with the SSGA / Alpha Vantage / stockanalysis fallback chain.',
   'ETF Analyzer calls /etf/xray, /etf/quotes and /etf/supported but never this. The single-fund holdings view has no surface, so the fallback chain is only exercised through the multi-fund x-ray.',
   'EITHER surface a single-fund view OR delete. Currently dead weight that still costs an Alpha Vantage call budget when reached.'),
 o('/api/iv/surface',
   'A full implied-volatility surface across strikes and expiries.',
   'Volatility Scanner plots skew and term structure from /prob/skew instead. A surface endpoint exists and nothing renders it.',
   'HIGH VALUE. A surface view is the main thing the Options hub lacks that does not need a new vendor.'),
 o('/api/iv/strikes', 'Per-strike IV detail for one expiry.', 'Supporting read for the same unbuilt surface view.', 'BUILD WITH THE SURFACE'),
 o('/api/regression/rolling',
   'Rolling-window regression coefficients over time.',
   'The Regression tool shows a static fit. Rolling beta is computed and surfaced elsewhere (Import/Monte Carlo regression views) but this general endpoint is unused.',
   'CHECK FOR DUPLICATION before building; the rolling-beta chart may already cover it.'),
 o('/api/regression/quick', 'A one-call OLS fit for arbitrary series.', 'Superseded by the client-side quickRegression in regressionShared.tsx, which does the same job without a round trip.', 'DELETE. The client version is the live one.'),
 o('/api/market/macro-dashboard',
   'A composed macro summary payload.',
   'Predates the Macro Monitor and the new cycle composite, both of which assemble their own data.',
   'DELETE or fold into /rates/cycle.'),
 o('/api/housing/affordability', 'Standalone NAR-style HAI.', 'Housing Market renders HAI from the composite /housing/market payload, so this narrower endpoint is redundant.', 'DELETE'),
 o('/api/housing/region/{p}', 'Regional housing detail.', 'No regional view exists in the UI; the tool is national-only.', 'BUILD OR DELETE. Regional housing is a real gap if the data is genuine rather than the mock cycle.'),
 o('/api/corporate/profile', 'A narrower company profile than /corporate/hub.', 'Superseded by /hub, which Company Profile actually calls.', 'DELETE'),
 o('/api/corporate/public-company-evidence', 'Evidence linking a private supply-chain node to a listed company.', 'Built for the Veridion pipeline; Supply Chain Map does not surface it.', 'SURFACE IN THE SUPPLY CHAIN MAP or delete.'),
 o('/api/logistics/customer-links', 'Disclosed customer relationships between companies.', 'LogisticsMap draws supplier nodes but the customer-link layer is not requested.', 'SURFACE. The map already has the legend text for it.'),
 o('/api/maritime/energy-nowcast', 'The AIS-derived energy transit nowcast as its own payload.', 'Energy Flows reads the nowcast through other routes; this direct one is unused. Moot while AISSTREAM_API_KEY is unset (see dormant.csv).', 'BLOCKED ON THE KEY'),
 o('/api/maritime/port-performance/{p}/history', 'Per-port historical performance series.', 'Freight Map shows current port calls; the history view was never built.', 'BUILD. Cheap, and the chokepoint history panel proves the pattern works.'),
 o('/api/filings/transcripts/{p}', 'Earnings call transcript text.', 'No transcript reader exists anywhere in the UI.', 'BUILD OR DELETE. A transcript reader is a real feature; a dead endpoint is not.'),
 o('/api/screener/percentile', 'Percentile rank of a metric across the screener universe.', 'Would let a screen filter on "top decile ROIC" rather than an absolute threshold. Nothing calls it.', 'SURFACE. Percentile filters are the main thing the screener lacks.'),
 o('/api/paper/strategies/builtin', 'Catalogue of built-in paper strategies.', 'Paper Trading lists user strategies only.', 'SURFACE OR DELETE'),
 o('/api/paper/strategies/builtin/{p}/load', 'Loads a built-in strategy into the paper account.', 'Same.', 'SURFACE OR DELETE'),
 o('/api/official/census-trade', 'US Census trade statistics.', 'Trade Flows uses Comtrade only. Census would give a faster-updating US-only view.', 'SURFACE. Comtrade lags a year; Census is monthly.'),
 o('/api/official/census-status', 'Health check for the Census feed.', 'Supporting read.', 'KEEP AS A HEALTH CHECK'),
 o('/api/ai/screener-fallback', 'LLM-assisted screen construction when the deterministic parser fails.', 'The screener does not offer a natural-language entry point.', 'BUILD OR DELETE'),
 o('/api/lob/replay', 'Limit-order-book replay.', 'No LOB surface exists; the Market Maker simulator generates its own synthetic flow.', 'DELETE unless the LOB tool is still planned.'),
 o('/api/data-audit/runs', 'History of data-reconciliation runs.', 'Admin Hub shows the current audit tab but not the run history.', 'MINOR. Admin-only.'),
 o('/api/data-audit/entity/{p}/{p}/{p}', 'Per-entity audit detail.', 'Same.', 'MINOR. Admin-only.'),
 o('/api/alerts/{p}/pending', 'Alerts that fired while the client was disconnected.', 'The client uses the websocket path; a reconnecting client never drains the pending queue over HTTP.', 'CHECK. A user offline when an alert fires may never see it.'),
 o('/api/users/appdata/{p}', 'Server-side per-user application data.', 'Every user preference (theme, portfolios, journal, saved screens) lives in localStorage instead. This endpoint is the road not taken.', 'STRATEGIC. Wiring this is what would make books and settings follow a user across browsers.'),
 o('/api/users/sync', 'Pushes local app data to the server.', 'The write half of the same unused sync.', 'STRATEGIC, pairs with the above'),
]

C3 = ['path','source','evidence','status','consequence']
TAB3 = [
 {'path': 'Tradier account and order API', 'source': 'Tradier',
  'evidence': 'backend/routers/trading.py:13-138 defines 7 endpoints (account, positions, orders, equity/option/multileg order, cancel). Grep of frontend/src for "trading/account" and siblings returns nothing.',
  'status': 'LIVE BACKEND, ZERO CALLERS',
  'consequence': 'Real-money order routing is reachable by HTTP but unreachable from the UI. paper_engine.py replaced it. Either delete the router or gate it explicitly; an unused order endpoint is a liability, not a feature.'},
 {'path': 'Reddit sentiment sources', 'source': 'Reddit public JSON',
  'evidence': 'backend/sentiment/config.py:143-157 declares 8 subreddit SourceSpecs. Production /api/sentiment/snapshot returns 19 sources of which ONE is Reddit, sitting at avg_score 50.0, avg_direction 0.0, avg_conf 0.1 (the neutral default).',
  'status': 'CONFIGURED, RETURNS NOTHING',
  'consequence': 'Reddit blocks datacenter IPs. Any mention-velocity or social-momentum feature built on this would be measuring an empty feed. Needs a residential proxy or the official API with credentials.'},
 {'path': 'FINRA TRACE per-CUSIP bond prices', 'source': 'FINRA FIP',
  'evidence': 'backend/bond_prices.py:355-368. Catalog names verified against the live API; reading corporateAndAgencyTradeHistory needs a dataset entitlement beyond authentication. FINRA_API_CLIENT_ID / _SECRET unset.',
  'status': 'DORMANT SCAFFOLD, PAID ENTITLEMENT REQUIRED',
  'consequence': 'Bond Lookup falls back to widened SPDR ETF-derived marks. A CUSIP with no ETF exposure gets no price at all. Costs nothing while unconfigured, by design.'},
 {'path': 'FactSet', 'source': 'FactSet',
  'evidence': 'FACTSET_USERNAME and FACTSET_API_KEY both unset. backend/routers/factset.py exists.',
  'status': 'NO CREDENTIALS',
  'consequence': 'Company Profile falls back to yfinance/FMP for overview fields. No user-visible error; the data is simply thinner.'},
 {'path': 'Alpaca IEX market data', 'source': 'Alpaca',
  'evidence': 'ALPACA_API_KEY unset. backend/alpaca.py is env-gated with a yfinance fallback.',
  'status': 'NO CREDENTIALS',
  'consequence': 'Loses the preferred real-time and deep-intraday equity source. Everything falls back to yfinance, which is delayed and rate-limits under load. This is the single cheapest data upgrade available.'},
 {'path': 'aisstream live vessel positions', 'source': 'aisstream.io',
  'evidence': 'AISSTREAM_API_KEY unset. Server log on boot: "maritime: AISSTREAM_API_KEY not set - vessel stream disabled".',
  'status': 'NO CREDENTIALS',
  'consequence': 'The 96-hour transit log stays empty, so the chokepoint disruption score loses its live nowcast and falls back to PortWatch, which lags 3 to 4 days. The nowcast exists specifically to close that gap, so this key is the difference between a live and a stale map.'},
 {'path': 'LSEG ownership and insider exports', 'source': 'LSEG bulk export',
  'evidence': 'The corporate DB has no populated lseg_* tables. Code at backend/routers/corporate.py:505 and :1140 treats LSEG as present-if-found and falls through to yfinance otherwise.',
  'status': 'PARTIAL / MOSTLY EMPTY',
  'consequence': 'Insider transactions and institutional holders come from yfinance for effectively every ticker. The passive/active ownership split, which only LSEG has, is absent. The fallback is silent and correct, so nothing looks broken.'},
 {'path': 'Alpha Vantage ETF_PROFILE for non-US funds', 'source': 'Alpha Vantage',
  'evidence': 'Key is SET and works: QQQ returns 105 holdings. INDY, EWJ and INDA return 0 holdings and empty sectors.',
  'status': 'LIVE BUT US-EQUITY ONLY',
  'consequence': 'International ETFs fall back to a top-25 list flagged partial, or to nothing. This is also why index constituents had to be scraped from Wikipedia rather than taken from a tracking ETF.'},
 {'path': 'SerpAPI finance', 'source': 'SerpAPI',
  'evidence': 'SERPAPI_KEY unset; backend/serpapi_finance.py imported by routers/market.py.',
  'status': 'NO CREDENTIALS',
  'consequence': 'A quote/news enrichment path that never runs. No user-visible effect since every caller has a fallback.'},
 {'path': 'OpenFIGI', 'source': 'OpenFIGI',
  'evidence': 'OPENFIGI_API_KEY unset. OpenFIGI serves unauthenticated requests at a lower rate limit.',
  'status': 'UNAUTHENTICATED',
  'consequence': 'CUSIP resolution still works but is rate-limited, so a bulk lookup will throttle. The key is free.'},
]

n2 = write(TAB2, OUT/'computed_not_surfaced.csv', C2)
n3 = write(TAB3, OUT/'dormant.csv', C3)
print('computed_not_surfaced.csv:', n2)
print('dormant.csv:', n3)
