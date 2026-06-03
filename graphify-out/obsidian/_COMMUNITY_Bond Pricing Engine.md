---
type: community
cohesion: 0.18
members: 15
---

# Bond Pricing Engine

**Cohesion:** 0.18 - loosely connected
**Members:** 15 nodes

## Members
- [[BondAnalytics.tsx]] - code - frontend/src/pages/BondAnalytics.tsx
- [[ChartPanel()]] - code - frontend/src/pages/BondAnalytics.tsx
- [[INPUT]] - code - frontend/src/pages/BondAnalytics.tsx
- [[LABEL]] - code - frontend/src/pages/BondAnalytics.tsx
- [[MetricCard()]] - code - frontend/src/pages/BondAnalytics.tsx
- [[TICK]] - code - frontend/src/pages/BondAnalytics.tsx
- [[TOOLTIP_STYLE]] - code - frontend/src/pages/BondAnalytics.tsx
- [[bond.py]] - code - backend/routers/bond.py
- [[bond_price()_1]] - code - math_engine.py
- [[duration_convexity()_1]] - code - math_engine.py
- [[fetchBondAnalytics()]] - code - frontend/src/hooks/useApi.ts
- [[float]] - code - backend/routers/bond.py
- [[math_engine.py_1]] - code - math_engine.py
- [[render_bond()]] - code - app.py
- [[solve_ytm()]] - code - backend/routers/bond.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Bond_Pricing_Engine
SORT file.name ASC
```

## Connections to other communities
- 3 edges to [[_COMMUNITY_Twelve Data API Integration]]
- 3 edges to [[_COMMUNITY_Options & Portfolio Routers]]
- 2 edges to [[_COMMUNITY_API Data Hooks]]
- 2 edges to [[_COMMUNITY_Options & Volatility Utils]]
- 1 edge to [[_COMMUNITY_FMP API Client]]
- 1 edge to [[_COMMUNITY_App Layout & Navigation]]
- 1 edge to [[_COMMUNITY_Page Wrapper Component]]

## Top bridge nodes
- [[BondAnalytics.tsx]] - degree 13, connects to 4 communities
- [[math_engine.py_1]] - degree 7, connects to 3 communities
- [[bond.py]] - degree 6, connects to 1 community
- [[duration_convexity()_1]] - degree 5, connects to 1 community
- [[solve_ytm()]] - degree 5, connects to 1 community