---
type: community
cohesion: 0.67
members: 3
---

# GEX Data Rendering

**Cohesion:** 0.67 - moderately connected
**Members:** 3 nodes

## Members
- [[Returns (spot, df_gex) where df_gex has columns       strike, expiry, call_oi,]] - rationale - app.py
- [[get_gex_data()]] - code - app.py
- [[render_gex()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/GEX_Data_Rendering
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Twelve Data API Integration]]

## Top bridge nodes
- [[get_gex_data()]] - degree 3, connects to 1 community
- [[render_gex()]] - degree 2, connects to 1 community