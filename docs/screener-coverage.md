# Screener coverage contract

The screener is a fast, cache-backed view over bundled constituent seeds. It is not a global security master. `backend/data/screener_coverage.json` is the runtime contract displayed in the UI and returned by `/api/screener/fields`.

| Scope | Bundled names | Target | Status | Gap / cause |
| --- | ---: | ---: | --- | --- |
| S&P 500 | 503 | 500 | Seeded, not currently validated | Share classes account for counts over 500; a dated primary-source roster refresh is still required. |
| S&P 400 | 400 | 400 | Seeded, not currently validated | Exact count is not proof of current membership. |
| Nasdaq-100 | 101 | 100 | Seeded, not currently validated | Share classes account for counts over 100; a dated primary-source roster refresh is still required. |
| DAX 40 | 40 | 40 | Count-complete, not currently validated | Exact count is not proof of current membership. |
| FTSE 100 | 52 | 100 | Partial | 48 current constituents are absent. Stale `AHT.L` and `CRH.L` were removed after their LSE exits; `BDEV.L` was updated to `BTRW.L`. |
| Nikkei 225 | 64 | 225 | Partial | 161 current constituents are absent; the bundled financial cohort is complete but the full index is not. |
| Asia-Pacific | 64 | n/a | Partial | Only the partial Japan subset is bundled. Australia, China, Hong Kong, India, Korea, Singapore, Taiwan, and other Asia-Pacific markets have no constituent source. |

## Behavioural safeguards

- “Bundled universes” and the region selector are explicitly marked curated/partial rather than global or comprehensive.
- Every bundled international ticker receives deterministic country, region, and exchange metadata before the quote provider is queried. A missing provider profile therefore cannot silently remove it from a country, region, or exchange filter.
- International quote/fundamental snapshots remain disk-cached (six-hour fresh, seven-day last-good fallback). The UI does not make bulk per-request market-data calls.
- Tests enforce index counts, representative tickers across the eleven GICS-style sectors, international country/region/exchange mappings, and honest coverage states. The validation script fails CI if a seed no longer conforms to the declared contract.

## Required source refreshes

An exact, current constituent roster is required before changing any status to `validated_complete`. For historical screens, retain effective membership dates rather than replacing the current seed.

## WRDS request (only if licensed)

Do not export more US CRSP daily or CRSP S&P membership data: this repository already has those US files, and they cannot fill non-US rosters.

For a genuinely broad global screener, export the following only if the WRDS subscription exposes the corresponding licensed tables:

1. **Compustat Global Security Daily / Global Security master** — active and inactive listings, CSV (UTF-8, one header row): `gvkey`, `iid`, `tic`, `isin`, `sedol`, `cusip`, `conm`, `exchg`, `loc`, `fic`, `curcd`, `sic`, `gsector`, `gind`, `gsubind`, `datadate`, `prccd`, `cshoc`, `trfd`, and active/start/end-date fields. Export a current snapshot plus daily history from **2024-07-01 through export date**. This supplies global identifiers, local listings, country/exchange, classification, market-cap inputs, and price history.
2. **Licensed index constituent history** (WRDS-hosted Refinitiv/LSEG Index Constituents if entitled; otherwise the primary index providers) — CSV with `index_id`, `index_name`, `effective_start`, `effective_end`, `isin`, `sedol`, local `ticker`, `company_name`, `exchange`, `country`, and `gsector`/`gind`/`gsubind` (or ICB). Export current constituents for S&P 500, S&P MidCap 400, Nasdaq-100, DAX 40, FTSE 100, Nikkei 225, and the chosen Asia-Pacific benchmark; add **2024-07-01 through export date** membership history only if point-in-time screens are required.
3. **Broad Asia-Pacific benchmark membership** — a licensed current file for the selected benchmark (for example MSCI AC Asia Pacific, FTSE Asia Pacific, or S&P Asia Pacific BMI), using the exact same constituent fields above. Plain CRSP is US coverage and cannot provide this.

The index membership export is required even when Global Security Daily is available: a security master identifies securities, but does not establish index membership. A current snapshot is enough for the live screener; historical effective dates are unnecessary unless the product adds as-of-date screening.
