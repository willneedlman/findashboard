---
type: community
cohesion: 0.20
members: 10
---

# Fed Rates & Yield Curve

**Cohesion:** 0.20 - loosely connected
**Members:** 10 nodes

## Members
- [[ChartPanel()_2]] - code - frontend/src/pages/FedRates.tsx
- [[FED_WEIGHTS]] - code - frontend/src/pages/FedRates.tsx
- [[FedRates()]] - code - frontend/src/pages/FedRates.tsx
- [[FedRates.tsx]] - code - frontend/src/pages/FedRates.tsx
- [[MetricCard()_2]] - code - frontend/src/pages/FedRates.tsx
- [[TICK_2]] - code - frontend/src/pages/FedRates.tsx
- [[TOOLTIP_STYLE_2]] - code - frontend/src/pages/FedRates.tsx
- [[YC_WEIGHTS]] - code - frontend/src/pages/FedRates.tsx
- [[fetchFedProjections()]] - code - frontend/src/hooks/useApi.ts
- [[fetchYieldCurve()]] - code - frontend/src/hooks/useApi.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Fed_Rates__Yield_Curve
SORT file.name ASC
```

## Connections to other communities
- 3 edges to [[_COMMUNITY_API Data Hooks]]
- 1 edge to [[_COMMUNITY_App Layout & Navigation]]
- 1 edge to [[_COMMUNITY_Page Wrapper Component]]

## Top bridge nodes
- [[FedRates.tsx]] - degree 12, connects to 3 communities
- [[fetchFedProjections()]] - degree 2, connects to 1 community
- [[fetchYieldCurve()]] - degree 2, connects to 1 community