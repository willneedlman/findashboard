---
type: community
cohesion: 0.22
members: 10
---

# Options & Volatility Utils

**Cohesion:** 0.22 - loosely connected
**Members:** 10 nodes

## Members
- [[Fetches live options chain via yfinance. Returns nearest expiry chain.]] - rationale - app.py
- [[bs_greeks()_1]] - code - math_engine.py
- [[bs_price()_1]] - code - math_engine.py
- [[get_options_chain()]] - code - app.py
- [[get_yf_implied_vol()]] - code - app.py
- [[get_yf_market_data()]] - code - app.py
- [[render_chain()]] - code - app.py
- [[render_options()]] - code - app.py
- [[render_prob()]] - code - app.py
- [[render_strategy_builder()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Options__Volatility_Utils
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_Twelve Data API Integration]]
- 3 edges to [[_COMMUNITY_Financial Utility Functions]]
- 2 edges to [[_COMMUNITY_Options & Portfolio Routers]]
- 2 edges to [[_COMMUNITY_Bond Pricing Engine]]
- 1 edge to [[_COMMUNITY_Monte Carlo Simulation]]

## Top bridge nodes
- [[get_yf_market_data()]] - degree 7, connects to 3 communities
- [[bs_price()_1]] - degree 5, connects to 3 communities
- [[bs_greeks()_1]] - degree 4, connects to 3 communities
- [[render_prob()]] - degree 4, connects to 2 communities
- [[render_strategy_builder()]] - degree 4, connects to 1 community