---
type: community
cohesion: 0.22
members: 9
---

# Market Data Charts

**Cohesion:** 0.22 - loosely connected
**Members:** 9 nodes

## Members
- [[ChartPanel()_4]] - code - frontend/src/pages/MarketData.tsx
- [[MarketData.tsx]] - code - frontend/src/pages/MarketData.tsx
- [[TICK_STYLE]] - code - frontend/src/pages/MarketData.tsx
- [[TOOLTIP_STYLE_4]] - code - frontend/src/pages/MarketData.tsx
- [[TVChart()]] - code - frontend/src/components/charts/TVChart.tsx
- [[TVChart.tsx]] - code - frontend/src/components/charts/TVChart.tsx
- [[TVChartProps]] - code - frontend/src/components/charts/TVChart.tsx
- [[TerminalMetric()]] - code - frontend/src/pages/MarketData.tsx
- [[fetchMarketHistory()]] - code - frontend/src/hooks/useApi.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Market_Data_Charts
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_API Data Hooks]]
- 1 edge to [[_COMMUNITY_App Layout & Navigation]]
- 1 edge to [[_COMMUNITY_Page Wrapper Component]]

## Top bridge nodes
- [[MarketData.tsx]] - degree 9, connects to 3 communities
- [[fetchMarketHistory()]] - degree 2, connects to 1 community