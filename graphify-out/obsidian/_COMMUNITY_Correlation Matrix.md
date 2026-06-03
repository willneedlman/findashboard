---
type: community
cohesion: 0.29
members: 8
---

# Correlation Matrix

**Cohesion:** 0.29 - loosely connected
**Members:** 8 nodes

## Members
- [[CorrRequest]] - code - backend/routers/correlation.py
- [[CorrelationMatrix.tsx]] - code - frontend/src/pages/CorrelationMatrix.tsx
- [[INPUT_2]] - code - frontend/src/pages/CorrelationMatrix.tsx
- [[LABEL_2]] - code - frontend/src/pages/CorrelationMatrix.tsx
- [[cellBg()]] - code - frontend/src/pages/CorrelationMatrix.tsx
- [[cellText()]] - code - frontend/src/pages/CorrelationMatrix.tsx
- [[correlation.py]] - code - backend/routers/correlation.py
- [[fetchCorrelation()]] - code - frontend/src/hooks/useApi.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Correlation_Matrix
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_API Data Hooks]]
- 1 edge to [[_COMMUNITY_Options & Portfolio Routers]]
- 1 edge to [[_COMMUNITY_App Layout & Navigation]]
- 1 edge to [[_COMMUNITY_Page Wrapper Component]]

## Top bridge nodes
- [[CorrelationMatrix.tsx]] - degree 10, connects to 3 communities
- [[CorrRequest]] - degree 3, connects to 1 community
- [[fetchCorrelation()]] - degree 2, connects to 1 community