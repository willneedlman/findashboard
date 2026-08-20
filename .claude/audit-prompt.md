Drive the terminal in Chrome and audit it — every hub, every tool — for
inconsistencies, gaps, and places the tools should work together but don't. Use
the site the way I do: type tickers, change ranges, toggle layers, open the
things that look interactive. I want findings I can act on, not a description of
what the app does.

## Getting in

Run it locally so nothing you click touches my production state:

    cd /Users/willneedlman/finance_dashboard/frontend && npm run dev   # localhost:5173
    venv/bin/uvicorn backend.main:app --port 8000

The frontend proxies /api to the backend on 8000. If you would rather see
production, it is https://finance-terminal.fly.dev — but then treat it as
read-only and obey the "do not touch" list below.

The app is a PWA with a service worker, so a plain refresh can serve a stale
shell. Hard-reload when a change you expect is not there. Theme and font live in
localStorage only, so they are per-browser and never synced — a visual
difference between machines is usually just that, not missing code.

## Do not touch

This is a live trading-adjacent terminal, and some surfaces write. Do not place,
modify, or cancel paper orders; do not delete report projects or alerts; do not
use the resolve/override controls in the Admin Hub's data-audit tab. Reading
those screens is in scope, mutating them is not. If judging a flow genuinely
needs a write, say so in the findings and leave it undone rather than guessing.

Also: do not trigger anything that raises a browser alert/confirm dialog — a
modal blocks every later command and the session goes dead.

## How to work

`frontend/src/lib/hubs.ts` (`HUBS`) is the tool registry and the definitive list
of hubs, tools, and routes. Go hub by hub, and keep a running findings file as
you go rather than holding it all in context.

For every tool: load it, let it settle, then actually use it. Enter a liquid
name (SPY, AAPL, NVDA), a thin one (a small-cap, a foreign listing), and
something that should fail (a garbage symbol) — the failure modes are where the
lies live. Read the console and the network log on each page; a tool that looks
fine while a request 500s in the background is a finding, and so is a page that
renders zeros for what is really a dead feed.

Screenshot anything visual you are calling out, and save screenshots to
~/Desktop/Screenshots/finance-dashboard-screenshots/.

When something looks wrong, confirm it in the source before writing it up.
Pages are `frontend/src/pages`, backend routes `backend/routers`. A finding with
a `file:line` and the actual response body is worth ten impressions.

## What I want you to look for

**1. Data inconsistency across tools.** The same quantity computed or labelled
differently in two places is the highest-value finding — open both tools on the
same ticker and compare. Trace each number to its source and say which one is
right. The shape of it: a P/E from a different vintage than the valuation page
uses, a change-% measured from a different reference close, IV from a different
expiry, a market cap diluted in one place and basic in another.

**2. Stale, dead, or lying UI.** Requests that 404/500 or return empty while the
page renders as if fine. Empty states that blame me for an upstream outage.
Spinners that never resolve. Numbers formatted to a precision the data does not
support. Anything presented as live that is actually cached, snapshotted, or
lagged, without saying so.

**3. Interface inconsistency.** Same concept, different treatment across tools:
KPI strips, answer-first verdict headers, config headers, empty states, table
density, date and number formatting, hardcoded colour instead of a `--theme-*`
token. Check a light theme too — hairlines and overlays have broken there before.
Note where a tool reinvents a shared component that already exists.

**4. Fluency and hand-offs.** Where do I hit a dead end and have to retype a
ticker, re-pick a date range, or copy a number by hand? The ticker link/drawer
(`frontend/src/lib/tickerLink.ts`, `TICKER_TOOLS`) and the options-to-paper-book
bridge are the hand-offs that already work — find the ones that are missing.
Which pairs of tools are two halves of one question I currently have to ask
twice? Also watch for state that should persist and doesn't, or persists when it
shouldn't.

**5. Overlap and consolidation.** Tools that are 80% the same surface and should
be fused, or one tool doing two unrelated jobs that should split. Describe the
merged surface concretely, not as a principle.

**6. New tools.** Only ones the existing data already supports — name the
endpoint or dataset each would run on. Anything needing a feed we do not have is
a wish, not a proposal; list those separately if they are compelling enough to
be worth paying for.

## Conventions to hold things against

`CLAUDE.md`, `PRODUCT.md`, and `DESIGN.md` at the repo root. In particular: no
emoji or decorative Unicode anywhere in the UI; spartan active copy, no em dashes
or semicolons; colour through `--theme-*` tokens; every tool is a React page
wired into the app shell, never a standalone.

## Deliverable

One markdown file, findings ordered by value to me, not by tool. For each:

- What is wrong or missing, in one sentence
- Evidence: the screenshot, the `file:line`, or the request and what it actually
  returned
- Why it matters to someone using the terminal
- The fix, specific enough to start on, with a rough size (an hour / a day / a week)

New-tool proposals in their own section at the end. Be blunt about severity — I
would rather see ten real problems than fifty observations. If a hub is clean,
say so in a line and move on. If a tool would not load at all, that is a finding,
not a reason to stop.
