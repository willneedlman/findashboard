---
type: community
cohesion: 0.40
members: 5
---

# Corporate Fundamentals

**Cohesion:** 0.40 - moderately connected
**Members:** 5 nodes

## Members
- [[get_cached_history()]] - code - app.py
- [[get_cached_ticker()]] - code - app.py
- [[get_insider_transactions()]] - code - app.py
- [[get_short_interest()]] - code - app.py
- [[render_earnings()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Corporate_Fundamentals
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_Twelve Data API Integration]]

## Top bridge nodes
- [[render_earnings()]] - degree 5, connects to 1 community
- [[get_cached_history()]] - degree 2, connects to 1 community
- [[get_cached_ticker()]] - degree 2, connects to 1 community
- [[get_insider_transactions()]] - degree 2, connects to 1 community
- [[get_short_interest()]] - degree 2, connects to 1 community