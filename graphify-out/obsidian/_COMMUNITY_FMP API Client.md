---
type: community
cohesion: 0.15
members: 21
---

# FMP API Client

**Cohesion:** 0.15 - loosely connected
**Members:** 21 nodes

## Members
- [[Annual income statements (latest first). limit=2 enables YoY growth calc.]] - rationale - backend/fmp.py
- [[Fetches profile + income(2yr) + balance + cashflow in parallel (~200ms).     Ret]] - rationale - backend/fmp.py
- [[Financial Modeling Prep (FMP) client — stable API.  Replaces slow yfinance .info]] - rationale - backend/fmp.py
- [[Latest annual balance sheet totalDebt, cashAndCashEquivalents, netDebt, totalSt]] - rationale - backend/fmp.py
- [[Latest annual cash flow capitalExpenditure (negative), depreciationAndAmortizat]] - rationale - backend/fmp.py
- [[Price, marketCap, beta, changePercentage, companyName, sector.]] - rationale - backend/fmp.py
- [[Real-time quote price, changePercentage, marketCap, volume.     Cached for 2 mi]] - rationale - backend/fmp.py
- [[TTLCache]] - code - backend/fmp.py
- [[_cached()]] - code - backend/fmp.py
- [[_get()]] - code - backend/fmp.py
- [[available()]] - code - backend/fmp.py
- [[bool]] - code - backend/fmp.py
- [[fmp.py]] - code - backend/fmp.py
- [[get_balance()]] - code - backend/fmp.py
- [[get_cashflow()]] - code - backend/fmp.py
- [[get_dcf_fundamentals()_1]] - code - backend/fmp.py
- [[get_income()]] - code - backend/fmp.py
- [[get_profile()]] - code - backend/fmp.py
- [[get_quote()]] - code - backend/fmp.py
- [[int]] - code - backend/routers/bond.py
- [[str_7]] - code - backend/fmp.py

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/FMP_API_Client
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Bond Pricing Engine]]

## Top bridge nodes
- [[int]] - degree 2, connects to 1 community