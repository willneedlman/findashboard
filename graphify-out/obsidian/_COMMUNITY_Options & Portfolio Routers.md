---
type: community
cohesion: 0.12
members: 25
---

# Options & Portfolio Routers

**Cohesion:** 0.12 - loosely connected
**Members:** 25 nodes

## Members
- [[BacktestRequest]] - code - backend/routers/portfolio.py
- [[BaseModel]] - code
- [[BondRequest]] - code - backend/routers/bond.py
- [[MonteCarloRequest]] - code - backend/routers/portfolio.py
- [[NavRequest]] - code - backend/routers/nav.py
- [[PriceRequest]] - code - backend/routers/options.py
- [[Scrapes MSTR BTC holdings from SEC EDGAR 8-K filings (static HTML, always access]] - rationale - backend/routers/nav.py
- [[StrategyLeg]] - code - backend/routers/options.py
- [[StrategyRequest]] - code - backend/routers/options.py
- [[_get_mstr_btc()]] - code - backend/routers/nav.py
- [[_get_risk_free_rate()]] - code - backend/routers/portfolio.py
- [[backtest()]] - code - backend/routers/portfolio.py
- [[dealer_gex()]] - code - backend/routers/options.py
- [[float_1]] - code - backend/routers/portfolio.py
- [[greek_surface()]] - code - backend/routers/options.py
- [[monte_carlo()]] - code - backend/routers/portfolio.py
- [[nav.py]] - code - backend/routers/nav.py
- [[nav_proxy()]] - code - backend/routers/nav.py
- [[options.py]] - code - backend/routers/options.py
- [[options_chain()]] - code - backend/routers/options.py
- [[payoff()]] - code - backend/routers/options.py
- [[portfolio.py]] - code - backend/routers/portfolio.py
- [[priceOption()]] - code - frontend/src/hooks/useApi.ts
- [[str_4]] - code - backend/routers/options.py
- [[strategyPayoff()]] - code - frontend/src/hooks/useApi.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Options__Portfolio_Routers
SORT file.name ASC
```

## Connections to other communities
- 3 edges to [[_COMMUNITY_Backend Cache & DCF Utils]]
- 3 edges to [[_COMMUNITY_Bond Pricing Engine]]
- 2 edges to [[_COMMUNITY_Options & Volatility Utils]]
- 2 edges to [[_COMMUNITY_API Data Hooks]]
- 1 edge to [[_COMMUNITY_Correlation Matrix]]
- 1 edge to [[_COMMUNITY_Trading Strategy Router]]
- 1 edge to [[_COMMUNITY_Options Pricer & Greeks]]

## Top bridge nodes
- [[BaseModel]] - degree 11, connects to 3 communities
- [[options.py]] - degree 12, connects to 2 communities
- [[priceOption()]] - degree 4, connects to 2 communities
- [[backtest()]] - degree 4, connects to 1 community
- [[strategyPayoff()]] - degree 3, connects to 1 community