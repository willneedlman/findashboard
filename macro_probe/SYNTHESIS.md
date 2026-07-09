# Macro Consensus Source Recon — Findings

Empirical probe of 7 sources for **median consensus/survey estimates** on high-impact
macro events. Tested live with our keys where possible (`macro_probe/probe_apis.py`);
enterprise feeds documented + normalized in `probe_institutional.py`.

## Result Table

| # | Source | Consensus type | Where the field lives | Access | Cost / barrier | Live probe result | Production fit |
|---|--------|----------------|------------------------|--------|----------------|-------------------|----------------|
| 1 | **Finnhub** `/calendar/economic` | Explicit survey (`estimate`) | `economicCalendar[].estimate` | REST JSON | Paid (calendar gated) | **403** on our key | Good if paid; clean JSON |
| 2 | **FMP** economic calendar | Explicit survey (`estimate`) | `[].estimate` | REST JSON | Paid (~$20–30/mo Starter) | **429** on our free key | **Best paid option** — cheap, stable, matches existing FMP use |
| 3 | **Trading Economics** `/calendar` | Both: pooled survey **`Forecast`** + own model `TEForecast` | `[].Forecast` (survey) | REST JSON | Paid (guest tier killed) | **410** guest discontinued | Good but pricey; only one giving survey+model split |
| 4 | **FocusEconomics** | Panel **mean/median + min/max + panelists** | `consensus.mean` | Enterprise feed / data files | Enterprise contract ($$$) | No public API (schema mocked) | Gold standard, overkill for a terminal |
| 5 | **Consensus Economics** | Survey **mean/high/low + std** | `survey.mean` | Subscription feed / Excel | Enterprise subscription ($$$) | No public API (schema mocked) | Gold standard, overkill |
| 6 | **Forex Factory** JSON feed | Curated **`forecast`** (consensus) | `[].forecast` | Public JSON (`nfs.faireconomy.media/ff_calendar_thisweek.json`) | **Free, no key** | **200 ✓** (ISM Services PMI `forecast:54.2`); **429 on rapid repeat** | Viable free — rate-limited, poll hourly + cache; no `actual` on forward feed; ToS gray area |
| 7 | **Investing.com** | **`Forecast`** column | `td.fore` in `getCalendarFilteredData` HTML | AJAX POST → HTML rows | **Free, no key** | **200 ✓** 42 rows, **actual+forecast+previous** incl. ISM | Richest free data, but ToS prohibits scraping + Cloudflare/format fragility |

## Key empirical findings

- **All three "developer-friendly" APIs are paywalled for the calendar** on our current keys (Finnhub 403, FMP 429, TE guest 410). Their consensus fields are real (`estimate` / `Forecast`) — you just need a paid key.
- **Trading Economics is the only source that separates** pooled **`Forecast`** (survey consensus) from **`TEForecast`** (their in-house econometric model). Read `Forecast` for true consensus.
- **Forex Factory's public JSON is the best free consensus feed**: `{title, country, date, impact, forecast, previous}`. `forecast` is FF's curated consensus. Free, no key — but it rate-limits (429 on repeated hits), so cache and poll ~hourly. Forward events have no `actual` yet (fills in post-release).
- **Investing.com returns the most complete free row** (`actual` + `forecast` + `previous`, and covers ISM/ADP which FRED lacks) via a server-side POST that still works today — but it violates their ToS, sits behind Cloudflare, and the HTML shape can change without notice.
- **FocusEconomics / Consensus Economics** are the institutional gold standard (true surveyed mean/high/low with per-panelist detail) but are enterprise contracts with no self-serve API — disproportionate for a retail-scale terminal.

## Recommended production path

**Hybrid: FRED (authoritative actuals + schedule) + a consensus overlay.**

1. **Keep FRED** as the spine — free, authoritative `actual`/`previous` + the official release calendar (already wired into `/api/macro-events`).
2. **Consensus overlay, in priority order:**
   - **Primary (recommended): FMP paid Starter tier (~$20–30/mo).** Clean REST JSON `estimate`, stable schema, and it reuses the `FMP_API_KEY` integration you already have. Lowest engineering + operational risk for a production pipeline. Drops straight into the existing `expected` field, matched to FRED rows by event + date.
   - **Free fallback / no-budget mode: Forex Factory JSON feed**, cached 1–6h, merged onto FRED rows by (country, event-name fuzzy match, date). Gives consensus with zero cost and zero key, at the price of a rate-limit-aware poller and looser event matching.
3. **Avoid** Investing.com scraping in production (ToS + Cloudflare + fragility) and the enterprise panels (cost) unless you specifically need surveyed dispersion (min/max/std) — in which case Trading Economics paid is the mid-tier step up.

**One-line recommendation:** ship **FRED + Forex Factory (free, hourly-cached) now**, and upgrade the consensus layer to **FMP paid** the moment a budget exists — both target the same `expected` field, so the swap is a config flag, not a rewrite.
