---
type: community
cohesion: 0.09
members: 25
---

# Corporate Hub & Router

**Cohesion:** 0.09 - loosely connected
**Members:** 25 nodes

## Members
- [[CONSENSUS_STYLE]] - code - frontend/src/pages/CorporateHub.tsx
- [[CorporateHub.tsx]] - code - frontend/src/pages/CorporateHub.tsx
- [[Fast scan endpoint — only fetches price history and news. No tkr.info calls.]] - rationale - backend/routers/corporate.py
- [[INPUT_1]] - code - frontend/src/pages/CorporateHub.tsx
- [[Insider transactions for a ticker — up to 10 most recent rows.]] - rationale - backend/routers/corporate.py
- [[InsiderPanel()]] - code - frontend/src/pages/CorporateHub.tsx
- [[InsiderTx]] - code - frontend/src/pages/CorporateHub.tsx
- [[LABEL_1]] - code - frontend/src/pages/CorporateHub.tsx
- [[LABEL_S]] - code - frontend/src/pages/CorporateHub.tsx
- [[ShortRow]] - code - frontend/src/pages/CorporateHub.tsx
- [[Slow supplemental endpoint — fetches short interest from tkr.info. Called lazily]] - rationale - backend/routers/corporate.py
- [[TD]] - code - frontend/src/pages/CorporateHub.tsx
- [[TD_S]] - code - frontend/src/pages/CorporateHub.tsx
- [[TH]] - code - frontend/src/pages/CorporateHub.tsx
- [[TH_S]] - code - frontend/src/pages/CorporateHub.tsx
- [[TickerLogo()]] - code - frontend/src/pages/CorporateHub.tsx
- [[TickerRow]] - code - frontend/src/pages/CorporateHub.tsx
- [[_extract_news()]] - code - backend/routers/corporate.py
- [[corporate.py]] - code - backend/routers/corporate.py
- [[corporate_hub_insider()]] - code - backend/routers/corporate.py
- [[corporate_hub_short()]] - code - backend/routers/corporate.py
- [[fetchInsiderTicker()]] - code - frontend/src/pages/CorporateHub.tsx
- [[fetchShortTicker()]] - code - frontend/src/pages/CorporateHub.tsx
- [[fetchTicker()]] - code - frontend/src/pages/CorporateHub.tsx
- [[str_1]] - code - backend/routers/corporate.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Corporate_Hub__Router
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_App Layout & Navigation]]
- 1 edge to [[_COMMUNITY_Page Wrapper Component]]

## Top bridge nodes
- [[CorporateHub.tsx]] - degree 22, connects to 2 communities