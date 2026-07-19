---
name: new-tool
description: Scaffold a new terminal tool in finance_dashboard the project's way — a React page wired into the app shell, hub taxonomy, and routing. Use when the user wants to add a new tool/page/feature to the terminal. Enforces the integrate-not-standalone rule; never produces a standalone script.
---

# New tool scaffolder

Add a new tool as a first-class page wired into the shared shell. Tools are NEVER standalone Streamlit/tkinter/HTML scripts — they are React pages in `frontend/src/pages` integrated into the nav, hub grid, and router.

Ask for (or infer from the request): the tool's **display name**, its **hub** (Research / Options / Macro / Charting / Trading / Valuation), its **route** (e.g. `/my-tool`), and a one-line **description**. Then wire all of the following.

## 1. The page — `frontend/src/pages/<Name>.tsx`
- Export a `*Content` component with the body, and a default export that wraps it: `export default function <Name>() { return <PageWrapper title="<Display Name>"><<Name>Content /></PageWrapper> }`. (Some tools omit the title and render their own in-panel header — match the closest sibling.)
- Use the shared building blocks, do not reinvent: `PageWrapper`/`PageHeader`, `SidebarLayout` (inputs rail + results) or the `mmCockpit` `KpiCell` strip for answer-first metrics, `LoadingState` / `EmptyState` / `ErrorState`, `TickerLogo`, and formatters from `lib/format`. For a ticker-driven tool use `TickerLaunch` for the empty state and auto-load the recent ticker (never a blank form; never fetch a name uninvited beyond the recent one).
- Register a Report Creator capture with `useReportCapture(getClip, { disabled, sourceTab })` from `hooks/useReportCapture` so the shell **Send to Report** button clips structured KPIs/tables/charts (helpers in `lib/reportCaptureRegistry`). The shell always offers a fallback stub for hub tools; rich registration is required when the tool has meaningful displays.
- Style with the dark terminal palette via `var(--theme-*)` tokens (see DESIGN.md) — never raw hex when a token exists. Route colors through the theme so custom themes hold.
- Follow the writing-style rules (spartan, active, second person, no emoji, no em dashes, no semicolons).

## 2. Route — `frontend/src/App.tsx`
- Add a lazy import: `const <Name> = lazyWithReload(() => import('./pages/<Name>'))`.
- Add `<Route path="<route>" element={<<Name> />} />` inside the terminal `Routes`.
- If the tool replaces or renames an old one, add a `<Navigate to="<route>" replace />` redirect from the old path (old routes always redirect, never 404).

## 3. Hub tile — `frontend/src/lib/hubs.ts`
- Add an entry to the chosen hub's `tools` array: `{ title, chip, desc, route, icon }`. Pick a `lucide-react` icon already imported at the top of hubs.ts (or add one to that import). Keep `desc` honest and short. The sidebar nav and command palette derive from HUBS automatically — no separate nav edit needed.

## 4. Backend (if the tool needs data)
- Add or extend a router under `backend/routers/`; register it in `backend/main.py` if new. Reuse the cache layer (`cache.py` `get_history`/`get_info`, the `@cached` decorator, `disk_get`/`disk_set`) and respect the free-tier/quota and prod-memory constraints (yfinance concurrency low, cache JSON strings not object trees). Unknown `/api/*` paths must 404, not fall through to the SPA.

## 5. Verify before done
- `cd frontend && npm run typecheck` must pass.
- Query `ui-ux-pro-max` before the frontend work and run `/impeccable` before calling it done (per project rules).
- Launch the app and screenshot the new route with Playwright — do not claim it works without a visual check.

## Reference
Recent examples to copy patterns from: `NAVTracker.tsx` (SidebarLayout + KpiCell strip), `SkewTool.tsx` / `IVTracker.tsx` (standalone Content + default export), `CorporateHub.tsx` (bordered-panel cockpit). Consult PRODUCT.md and DESIGN.md for register and tokens.
