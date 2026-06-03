---
type: community
cohesion: 0.09
members: 24
---

# Twelve Data API Integration

**Cohesion:** 0.09 - loosely connected
**Members:** 24 nodes

## Members
- [[app.py]] - code - app.py
- [[get_twelve_batch_yield_curve()]] - code - app.py
- [[get_twelve_implied_vol()]] - code - app.py
- [[get_twelve_market_data()]] - code - app.py
- [[get_twelve_shares_outstanding()]] - code - app.py
- [[get_twelve_time_series()]] - code - app.py
- [[go_bond()]] - code - app.py
- [[go_chain()]] - code - app.py
- [[go_corr()]] - code - app.py
- [[go_dcf()]] - code - app.py
- [[go_earn()]] - code - app.py
- [[go_fed()]] - code - app.py
- [[go_gex()]] - code - app.py
- [[go_home()]] - code - app.py
- [[go_market()]] - code - app.py
- [[go_monte()]] - code - app.py
- [[go_nav()]] - code - app.py
- [[go_options()]] - code - app.py
- [[go_port()]] - code - app.py
- [[go_prob()]] - code - app.py
- [[go_strategy()]] - code - app.py
- [[render_fed()]] - code - app.py
- [[render_home()]] - code - app.py
- [[safe_tab()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Twelve_Data_API_Integration
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_Options & Volatility Utils]]
- 6 edges to [[_COMMUNITY_Monte Carlo Simulation]]
- 6 edges to [[_COMMUNITY_Financial Utility Functions]]
- 5 edges to [[_COMMUNITY_Corporate Fundamentals]]
- 5 edges to [[_COMMUNITY_MSTR Bitcoin NAV]]
- 3 edges to [[_COMMUNITY_Bond Pricing Engine]]
- 2 edges to [[_COMMUNITY_GEX Data Rendering]]
- 1 edge to [[_COMMUNITY_Backend Cache & DCF Utils]]
- 1 edge to [[_COMMUNITY_API Rate Limiting]]

## Top bridge nodes
- [[app.py]] - degree 61, connects to 9 communities