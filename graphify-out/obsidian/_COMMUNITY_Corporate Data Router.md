---
type: community
members: 9
---

# Corporate Data Router

**Members:** 9 nodes

## Members
- [[Fast scan endpoint — only fetches price history and news. No tkr.info calls.]] - rationale - backend/routers/corporate.py
- [[Insider transactions for a ticker — up to 10 most recent rows.]] - rationale - backend/routers/corporate.py
- [[Slow supplemental endpoint — fetches short interest from tkr.info. Called lazily]] - rationale - backend/routers/corporate.py
- [[_extract_news()]] - code - backend/routers/corporate.py
- [[corporate.py]] - code - backend/routers/corporate.py
- [[corporate_hub()]] - code - backend/routers/corporate.py
- [[corporate_hub_insider()]] - code - backend/routers/corporate.py
- [[corporate_hub_short()]] - code - backend/routers/corporate.py
- [[str_1]] - code - backend/routers/corporate.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Corporate_Data_Router
SORT file.name ASC
```
