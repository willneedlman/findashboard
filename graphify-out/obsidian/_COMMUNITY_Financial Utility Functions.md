---
type: community
cohesion: 0.33
members: 7
---

# Financial Utility Functions

**Cohesion:** 0.33 - loosely connected
**Members:** 7 nodes

## Members
- [[Format a $M value, auto-scaling to B or T.]] - rationale - app.py
- [[convert_df_to_csv()]] - code - app.py
- [[fmt_large()]] - code - app.py
- [[get_live_risk_free_rate()]] - code - app.py
- [[render_dcf()]] - code - app.py
- [[render_market()]] - code - app.py
- [[render_portfolio()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Financial_Utility_Functions
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_Twelve Data API Integration]]
- 3 edges to [[_COMMUNITY_Options & Volatility Utils]]
- 2 edges to [[_COMMUNITY_MSTR Bitcoin NAV]]
- 2 edges to [[_COMMUNITY_Monte Carlo Simulation]]
- 1 edge to [[_COMMUNITY_Backend Cache & DCF Utils]]

## Top bridge nodes
- [[render_dcf()]] - degree 6, connects to 3 communities
- [[render_portfolio()]] - degree 6, connects to 3 communities
- [[convert_df_to_csv()]] - degree 5, connects to 2 communities
- [[get_live_risk_free_rate()]] - degree 4, connects to 2 communities
- [[render_market()]] - degree 3, connects to 2 communities