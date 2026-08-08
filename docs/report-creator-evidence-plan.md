# Report Creator: evidence selection rebuild

Why reports kept citing the same handful of numbers, and what was built to fix it.

Written against `docs/data-inventory/surfaced.csv` (274 verified values across 59
tools), `backend/reporting/tool_registry.py`, `backend/routers/ai.py` and
`frontend/src/lib/reportResearch.ts`.

> **Status: built.** Sections 1 and 2 are the diagnosis and the principle.
> Section 3 describes the design as implemented. Section 4 records what shipped
> and what was deliberately left, with measured before/after numbers.

---

## 1. Diagnosis

Four measured causes. None of them is "the model is bad at picking".

### 1.1 Half the data is unreachable

| | |
|---|---|
| App tools with surfaced data | **59** |
| Tools the report catalog can pull | **23** |
| Distinct values in the inventory | **274** |
| Values the report cannot reach | **133** |

37 tools have no report path at all, including several that answer questions
reports are constantly asked: Market Breadth, Seasonality, Trader Positioning,
Credit Stress, Macro Monitor and its cycle composite, Short Interest, 13F
changes, Estimate Revisions, Master Valuation, Multiples, Reverse DCF, SOTP,
Monte Carlo, Portfolio Backtester, Portfolio Compare, Portfolio Allocator, ETF
Analyzer, Stock Screener, Pairs Trader, Chokepoint Exposure, Trade Flows,
Supply Chain Map, Housing, FX Matrix, Bond Analytics.

No amount of prompting fixes this. The model cannot select what is not in the
catalog.

### 1.2 Intent is a single label from a first-match regex

`detectIntent()` (`reportResearch.ts:337`) tests seven patterns in order and
returns the first hit. Consequences:

- *"Compare NVDA and AMD on valuation"* matches `comparison` and never reaches
  the valuation branch, so `dcf-valuation` and `peer-valuation` are not in the
  baseline.
- Anything unmatched falls through to `company`, the catch-all.
- A real objective is usually several questions at once. One label cannot
  represent "is it cheap, is the trend intact, and what is the macro risk".

### 1.3 The baselines overlap almost completely

`CRITICAL_SOURCES` gives each intent 2–4 sources. `company` appears in five of
seven intents; `price-history` is the default second. So most reports start from
the same two clips regardless of what was asked, and the additions phase is
decorating an identical base.

### 1.4 The model is asked to pick from a flat menu of names

`_REPORT_RESEARCH_PLANNER_SYSTEM` hands the model 23 ids with a one-line
description each and asks for up to 8 additions. It is never told what a tool
*produces*, what question a given number answers, or what it cannot support.

A free-tier Llama given a flat list of names and no output semantics will
reliably choose the ones whose names most resemble the objective's words. That
is exactly the observed behaviour: familiar, repetitive, safe.

**There is also no feedback loop.** Nothing records which pulled clips the
finished prose actually cited, so nothing pushes the next report to reach
further.

---

## 2. Design principle

> The scaffolding selects. The model makes small, closed-set choices inside a
> shortlist it can actually reason about.

This is the pattern already proven in this repo by `backend/algo_runtime/`:
INTENT → SPEC → GROUND → GENERATE → VALIDATE → REPAIR, with deterministic
validation levels and a bounded repair loop. The report planner should adopt the
same shape rather than inventing a new one.

Three rules for every model call in this pipeline:

1. **Never show it more than ~12 options.** Retrieval narrows first.
2. **Show it semantics, not names.** Each option carries its `interpretation`
   and `limits` from the inventory, so the choice is about fit.
3. **One decision per call**, forced JSON, validated, with a repair prompt that
   names the specific failure. Several cheap calls beat one ambitious call.

---

## 3. The build

### Phase 0 — Make the inventory the machine-readable source of truth

**New:** `backend/reporting/metric_catalog.py` + `backend/data/metric_catalog.json`,
generated from `surfaced.csv` by a script alongside the existing
`docs/data-inventory/build_inv.py`.

Per metric, carried over from the inventory plus four new machine fields:

| Field | From | Purpose |
|---|---|---|
| `id`, `name`, `formula`, `interpretation`, `limits` | inventory | what the model reads |
| `tool`, `endpoint`, `provenance` | inventory | how to fetch it |
| `requires` | derived from `targetMode` | `symbols` / `portfolio` / `none` |
| `question_tags` | **new, hand-assigned** | closed vocabulary, below |
| `output_shape` | **new** | `scalar` / `series` / `table` / `distribution` / `matrix` / `categorical` |
| `evidence_class` | **new** | closed set, below |
| `cost` | **new** | `cheap` / `normal` / `slow` — S&P breadth is 85s cold |

The `limits` column earns its keep twice here: it steers selection, and it feeds
the existing verification pass so the report cannot claim something the metric
cannot support.

**Effort:** the three new fields are ~274 hand assignments, mechanical, done once
in the row modules that already exist. Everything else is a projection.

### Phase 1 — Replace intent detection with question decomposition

**Change:** `detectIntent()` retires. New call, `POST /api/ai/report-questions`.

The model decomposes objective + thesis into **3–6 analytical questions**, each
tagged from a **closed vocabulary**:

```
valuation_level      trend_direction     relative_performance
risk_downside        volatility_regime   positioning_flow
catalyst_event       quality_fundamental capital_structure
macro_regime         rates_credit        liquidity_breadth
concentration        correlation_struct  seasonality_timing
supply_chain_real    scenario_forward
```

Output is small, closed, and easy for a weak model:

```json
{"questions": [
  {"q": "Is the multiple justified by the growth rate?",
   "tags": ["valuation_level", "quality_fundamental"], "priority": 1}
]}
```

Deterministic fallback: keep the current regexes as a floor so a failed call
still produces a usable tag set. This is a strict upgrade, never a regression.

### Phase 2 — Deterministic retrieval, model ranks the shortlist

For each question, **deterministically** retrieve candidates:

```
candidates = catalog
  .filter(tag overlap with the question)
  .filter(requires satisfiable: symbols present / portfolio loaded)
  .filter(cost allowed by the report's time budget)
  .rank(tag specificity, then evidence_class scarcity in the plan so far)
  .take(10)
```

Only then does the model see anything, and it sees ten options with their
interpretation text, asked to pick the 2–3 that best answer *this one question*.

That is the whole fix for repetitiveness. The model never sees the full 274 and
never competes familiar names against each other; it compares ten things that
all plausibly answer the question in front of it.

### Phase 3 — Coverage and diversity floors, enforced in code

Deterministic, post-selection, not a prompt instruction:

**Evidence-class floor.** Classify every metric into one of:
`level`, `trend`, `risk`, `relative`, `positioning`, `catalyst`, `context`.
A report of a given template must hit its required classes. An equity thesis
report with zero `risk` and zero `positioning` evidence is rejected and the
shortlist is re-run for the missing class.

**Shape budget.** Cap by `output_shape` so a report cannot be five line charts:
at most 3 `series`, at least 1 non-`series` visual when the length permits.

**Novelty pressure.** Persist the metric ids used by the last N reports of the
same template. Down-rank recently used ids at the retrieval step. Not a ban —
a tiebreak. This directly attacks "the data it uses is very similar".

**Redundancy check.** Two metrics with the same `evidence_class` *and* the same
`tool` are near-duplicates; keep the higher-ranked one and free the slot.

### Phase 4 — Visual selection as its own typed decision

Today the model implicitly decides visuals by picking chart-producing tools.
Split it:

```
output_shape  →  allowed visual types (deterministic)
  series      →  line, area, indexed-line
  distribution→  histogram, density, cone
  matrix      →  heatmap
  categorical →  bar, stacked bar
  scalar      →  KPI cell, range bar
  table       →  table (never a chart)
```

The model chooses only when more than one is valid, and only from that list.
A scalar can never become a line chart by accident.

### Phase 5 — Validation and bounded repair

Mirror `algo_runtime/validate.py`. Levels, cheapest first:

| Level | Check |
|---|---|
| L0 | JSON schema |
| L1 | Every metric id exists in the catalog |
| L2 | `requires` satisfiable for each selection |
| L3 | Evidence-class floor met for the template |
| L4 | Shape budget respected, no near-duplicates |
| L5 | Every outline section maps to at least one selected metric |
| L6 | No claim in the outline contradicts a selected metric's `limits` |

Failures produce a repair prompt naming the specific failure and the specific
slot to fill. Two repair attempts, then fall back to the deterministic baseline.
L6 is the one that stops a report asserting sweep/block flow the data cannot
support, or reading a price-weighted index's cap share as influence.

### Phase 6 — Close the loop

**Instrument:** after generation, diff clips *pulled* against clips *cited* in
the prose. Persist per report.

**Surface:** "pulled but never cited" is the waste metric, and the single best
signal for tuning retrieval. Show it in the Report Creator UI as a build note.

**Feed back:** citation rate per metric becomes a ranking input. Metrics that
consistently get pulled and ignored fall down the shortlist; metrics that get
cited rise.

---

## 4. What shipped

| # | Step | Where |
|---|---|---|
| 1 | Metric catalog generated from the inventory | `backend/scripts/build_report_catalog.py` → `backend/data/report_metric_catalog.json` |
| 2 | Registry expanded 23 → 40 tools, each with tags, class, shapes, cost, yields, limits | `backend/reporting/tool_registry.py` |
| 3 | Question decomposition over a 17-tag closed vocabulary | `_REPORT_QUESTION_SYSTEM`, `normalize_questions()` |
| 4 | Deterministic retrieval and shortlist ranking | `evidence_plan.shortlist()` |
| 5 | Coverage floor, shape budget, novelty, redundancy | `evidence_plan.enforce()` |
| 6 | Visual-type mapping by output shape | `VISUAL_BY_SHAPE`, `allowed_visuals()` |
| 7 | Validation levels L0–L4 plus one bounded repair | `validate_selection()`, `repair_instruction()` |
| 8 | Citation instrumentation | `_evidence_utilisation()`, surfaced on `pipeline.evidenceUtilisation` |

### Measured effect on reach

|  | before | after |
|---|---|---|
| Report tools | 23 | **40** |
| Inventory values reachable | 143 of 274 (52%) | **178 of 274 (65%)** |
| Values unreachable | 131 | **96** |

The 17 new tools, all wired against verified response shapes: `asset-profile`,
`dividends`, `debt-maturity`, `seasonality`, `options-unusual`,
`insider-activity`, `institutional-ownership`, `cot-positioning`, `breadth`,
`sector-rrg`, `pairs`, `fx-matrix`, `macro-cycle`, `credit-stress`, `housing`,
`ipo-calendar`, `chokepoint-exposure`.

### Deliberately not wired

Each of these needs a preceding fetch to build a POST body — a full assumption
schedule, a holdings list, a weight vector — which makes each one its own small
project rather than a fetcher:

Master Valuation, SOTP, DDM, Reverse DCF, Monte Carlo, Portfolio Backtester,
Portfolio Allocator, Stock Screener (already reachable by a separate path via
`screenReportSymbols`), ETF Analyzer, Bond Analytics, Trade Flows, Supply Chain
Map, NAV Tracker, Energy Flows, Options Strategy.

Not evidence, and never will be: Market Hours, Report Creator, Trade Journal,
Paper Trading, Market Maker leaderboard, Price Alerts, Algo Builder.

That accounts for the remaining 96 values.

### Not done

- **L5 and L6.** Both need the drafted outline, not just the selection, so they
  belong in the generation call rather than the planner. `limits_for()` already
  supplies the caveat text they will check against, and it ships to the client on
  `evidenceLimits`.

## 5. What this does not do

- It does not make a free-tier Llama a better analyst. It narrows every decision
  until the model is choosing between options that are all defensible.
- It does not add a data source. Everything selectable already existed and was
  already verified in the inventory.
- It does not touch the writing prompts, the outline stage, or the export path.
  This work is entirely about *what evidence gets pulled and why*.
