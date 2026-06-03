---
type: community
cohesion: 0.22
members: 9
---

# Monte Carlo Simulation

**Cohesion:** 0.22 - loosely connected
**Members:** 9 nodes

## Members
- [[Overlay median paths and show a side-by-side metrics table for strategy vs base]] - rationale - app.py
- [[Renders strategy picker, plain description, and adjustable parameters.     Retur]] - rationale - app.py
- [[Returns (drift_adj_pct, signal_series, label, detail).     params — dict of user]] - rationale - app.py
- [[_mc_comparison()]] - code - app.py
- [[_mc_draw_paths()]] - code - app.py
- [[_mc_risk_metrics()]] - code - app.py
- [[_strategy_selector()]] - code - app.py
- [[compute_strategy_data()]] - code - app.py
- [[render_monte_carlo()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Monte_Carlo_Simulation
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_Twelve Data API Integration]]
- 2 edges to [[_COMMUNITY_Financial Utility Functions]]
- 1 edge to [[_COMMUNITY_Options & Volatility Utils]]
- 1 edge to [[_COMMUNITY_Strategy Selector Component]]

## Top bridge nodes
- [[_strategy_selector()]] - degree 5, connects to 3 communities
- [[render_monte_carlo()]] - degree 7, connects to 2 communities
- [[compute_strategy_data()]] - degree 4, connects to 2 communities
- [[_mc_comparison()]] - degree 3, connects to 1 community
- [[_mc_draw_paths()]] - degree 2, connects to 1 community