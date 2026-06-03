---
type: community
cohesion: 0.27
members: 11
---

# Trading Strategy Router

**Cohesion:** 0.27 - loosely connected
**Members:** 11 nodes

## Members
- [[Returns (signal_series, drift_adj_pct, label, detail).]] - rationale - backend/routers/strategy.py
- [[Series]] - code - backend/routers/strategy.py
- [[Strategy signal computation for backtester and Monte Carlo overlays. Each strate]] - rationale - backend/routers/strategy.py
- [[StrategyRequest_1]] - code - backend/routers/strategy.py
- [[_fetch_close()]] - code - backend/routers/strategy.py
- [[compute_signal()]] - code - backend/routers/strategy.py
- [[float_3]] - code - backend/routers/strategy.py
- [[get_strategy_signal()]] - code - backend/routers/strategy.py
- [[list_strategies()]] - code - backend/routers/strategy.py
- [[str_6]] - code - backend/routers/strategy.py
- [[strategy.py]] - code - backend/routers/strategy.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Trading_Strategy_Router
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Options & Portfolio Routers]]

## Top bridge nodes
- [[StrategyRequest_1]] - degree 3, connects to 1 community