---
type: community
cohesion: 0.29
members: 7
---

# MSTR Bitcoin NAV

**Cohesion:** 0.29 - loosely connected
**Members:** 7 nodes

## Members
- [[Scrapes live BTC holdings from Strategy (MicroStrategy) investor relations page.]] - rationale - app.py
- [[Unified dispatcher tries Twelve Data first, falls back to yfinance.     Handles]] - rationale - app.py
- [[get_mstr_bitcoin_holdings()]] - code - app.py
- [[get_price_series()]] - code - app.py
- [[get_yf_backtest_series()]] - code - app.py
- [[render_correlation()]] - code - app.py
- [[render_nav()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/MSTR_Bitcoin_NAV
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_Twelve Data API Integration]]
- 2 edges to [[_COMMUNITY_Financial Utility Functions]]

## Top bridge nodes
- [[get_yf_backtest_series()]] - degree 4, connects to 2 communities
- [[render_correlation()]] - degree 3, connects to 2 communities
- [[get_price_series()]] - degree 4, connects to 1 community
- [[get_mstr_bitcoin_holdings()]] - degree 3, connects to 1 community
- [[render_nav()]] - degree 3, connects to 1 community