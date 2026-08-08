# Data inventory

Three CSVs describing every data field and derived computation the terminal
surfaces, what is computed but never shown, and what is plumbed but dead.

| File | Rows | What it is |
|---|---|---|
| `surfaced.csv` | 274 | Values a user can reach in the UI, with provenance, formula, interpretation and limits |
| `computed_not_surfaced.csv` | 31 | Backend endpoints with no frontend caller |
| `dormant.csv` | 10 | Ingestion paths that return nothing in production, and why |

## How it was built

Not by hand and not from memory. `build_inv.py` plus the `rows_*.py` modules
regenerate all three files; provenance is looked up from a route index rather
than typed, so a moved endpoint cannot leave a stale line behind.

The mechanical layer was derived first and is exact:

- `hubs.ts` -> 59 tools -> `App.tsx` routes -> page files
- each page's transitive local imports -> the endpoints it calls (both the
  literal `/api/...` form and the `baseURL: '/api'` instance in `hooks/useApi.ts`)
- `main.py` router prefixes + `@router` decorators -> 268 endpoints at file:line
- 201 frontend-referenced endpoints, 196 auto-resolved, 5 hand-resolved from
  template literals

`computed_not_surfaced.csv` is the set difference: backend endpoints matched
against a full-text sweep of `frontend/src`, so a shared widget or the custom
dashboard cannot make an endpoint look dead.

## Grain

One row per distinct surfaced value. "Beta vs S&P 500" and "30-day volatility"
are two rows though one endpoint returns both. A 40-name constituent table is
one row, not 40.

This is deliberately not one row per rendered label: a sweep of the pages finds
~1,400 label strings, most of which are buttons, axis titles, form fields and
duplicates. The 274 rows here are the values that carry an interpretation.

Sharpe, Sortino, Calmar, volatility, max drawdown and beta are six rows, not
one, because each answers a different question and carries a different caveat.
A handful of rows still name two or three figures where they are genuinely one
reading: mean/high/low price target is a range, not three numbers.

## Rules applied

- A row ships only with both a producing `file:line` and a consuming page.
- `interpretation` says how to read the number and what to do differently
  because of it. A row that restates its own name was rejected.
- `limits` is specific and quantitative. Every caveat in a code comment is
  carried up into it.

## Regenerating

```
python3 docs/data-inventory/build_inv.py   # writes nothing on its own
python3 -c "import rows_charting, rows_options, ..."  # see the modules
```

The endpoint and tool indexes are rebuilt from the repo, so the files should be
regenerated after any routing change rather than edited in place.
