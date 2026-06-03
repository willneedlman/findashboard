---
type: community
cohesion: 1.00
members: 2
---

# API Rate Limiting

**Cohesion:** 1.00 - tightly connected
**Members:** 2 nodes

## Members
- [[Simple token-bucket guard for Twelve Data free tier (8 callsmin).]] - rationale - app.py
- [[twelve_rate_guard()]] - code - app.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/API_Rate_Limiting
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Twelve Data API Integration]]

## Top bridge nodes
- [[twelve_rate_guard()]] - degree 2, connects to 1 community