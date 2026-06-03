---
type: community
cohesion: 0.12
members: 24
---

# Backend Cache & DCF Utils

**Cohesion:** 0.12 - loosely connected
**Members:** 24 nodes

## Members
- [[Centralized caching layer for all yfinance and external API calls. All routers i]] - rationale - backend/cache.py
- [[DCFRequest]] - code - backend/routers/dcf.py
- [[DataFrame]] - code - backend/cache.py
- [[ProbRequest]] - code - backend/routers/probability.py
- [[_implied_vol()]] - code - backend/routers/probability.py
- [[cache.py]] - code - backend/cache.py
- [[chain_distribution()]] - code - backend/routers/probability.py
- [[dcf.py]] - code - backend/routers/dcf.py
- [[dcf_value()]] - code - backend/routers/dcf.py
- [[fed_projections()]] - code - backend/routers/rates.py
- [[float_2]] - code - backend/routers/probability.py
- [[get_dcf_fundamentals()]] - code - app.py
- [[get_download()]] - code - backend/cache.py
- [[get_history()]] - code - backend/cache.py
- [[get_info()]] - code - backend/cache.py
- [[get_news()]] - code - backend/cache.py
- [[probability.py]] - code - backend/routers/probability.py
- [[probability_cone()]] - code - backend/routers/probability.py
- [[rates.py]] - code - backend/routers/rates.py
- [[risk_free_rate()]] - code - backend/routers/rates.py
- [[str]] - code - backend/cache.py
- [[str_2]] - code - backend/routers/dcf.py
- [[str_5]] - code - backend/routers/probability.py
- [[yield_curve()]] - code - backend/routers/rates.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Backend_Cache__DCF_Utils
SORT file.name ASC
```

## Connections to other communities
- 3 edges to [[_COMMUNITY_Options & Portfolio Routers]]
- 1 edge to [[_COMMUNITY_Twelve Data API Integration]]
- 1 edge to [[_COMMUNITY_Financial Utility Functions]]

## Top bridge nodes
- [[get_dcf_fundamentals()]] - degree 5, connects to 2 communities
- [[get_download()]] - degree 4, connects to 1 community
- [[DCFRequest]] - degree 3, connects to 1 community
- [[ProbRequest]] - degree 3, connects to 1 community