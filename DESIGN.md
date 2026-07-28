# Design

Visual system for Alphatape Terminal. Tokens are CSS custom properties set at
runtime by `ThemeContext` (`frontend/src/contexts/ThemeContext.tsx`); the values
below are the shipped defaults (`DEFAULT_THEME`). Most components read them via
`var(--theme-*, <fallback>)`, so always reference the variable, not a raw hex.

## Theme

Dark terminal. Deep navy surfaces, a single gold accent, blue for data. The mood is
a research desk after hours: dense, focused, quiet. Dark is intrinsic to the product,
not a toggle. Theme is user-customizable (accent, background, fonts) but every tool
must work against the defaults below.

## Color

| Role | Token | Default | Notes |
|---|---|---|---|
| Accent / primary | `--theme-primary` | `#c9a84c` | Gold. Used sparingly: active nav, key figures, primary CTAs, headings. A scalpel, not a fill. |
| Secondary text | `--theme-secondary` | `#8099b0` | Muted blue-gray for labels and sub-text. Some legacy fallbacks read `#5e768f` / `#99907e`, now converging on the token value. |
| Tertiary / data | `--theme-tertiary` | `#60a5fa` | Blue. Primary chart/data series, info accents. |
| App background | `--theme-bg` | `#101c2e` | See the bg-vs-surface rule below. |
| Surface | `--theme-surface` | `#0d1826` | Cards, panels, sidebars. |
| Body text | `--theme-text` | `#d7e3fc` | Near-white blue. Primary reading color. |
| Border | `--theme-border` | `rgba(255,255,255,0.06–0.09)` | Hairline separators. |
| Positive | `--theme-positive` | green | Gains, significance, "move together". |
| Negative | `--theme-negative` | red (errors `#f85149`) | Losses, errors, "move opposite". |
| Chart neutral | (chartNeutral) | `#4a7fa5` | Muted series / gridline accents. |

**Critical rule: background is LIGHTER than surface.** `--theme-bg` (`#101c2e`) is
lighter than `--theme-surface` (`#0d1826`). Content/reading areas must use
`--theme-bg`. Using `--theme-surface` for a full content panel creates a dark-blue
sunken overlay. This specifically bites `SidebarLayout`'s content div, which must use
`var(--theme-bg)`.

**Color strategy: restrained.** Tinted-navy neutrals carry the surface; the gold
accent stays under roughly 10% of any view. Divergent data (correlation, P&L) uses
red and green with the value printed, never color alone (best-effort colorblind
safety).

**Contrast:** keep body text on `--theme-bg` / `--theme-surface` readable, avoid
gray-on-gray. Chart tooltips set explicit light text (`--theme-text`) so they never
render gray-on-gray against their own background.

## Typography

Three families, each with a job. All are loaded in `frontend/index.html`.

- **Display (`Cinzel`, serif):** the `ALPHATAPE` wordmark and hero h1 only. Tracked,
  uppercase, gold. Do not use for body or UI.
- **Data (`Hanken Grotesk`, `--theme-mono`):** numbers, tabular data, tickers, model
  outputs, and most tool chrome. It is proportional, with tabular figures applied so
  dense columns remain aligned. SF Mono remains selectable in Settings.
- **UI sans (`Sora`, `--theme-sans`):** nav labels, section labels, prose,
  buttons.

The brand mark is a gold, stroked A+T monogram: a geometric A with an inscribed T.

Mono and sans are user-swappable (`MONO_FONTS` / sans presets in `ThemeContext`);
design against the defaults. Labels and eyebrows are small, uppercase, letter-spaced
(`fontSize 9–10`, `letter-spacing 0.14–0.2em`, `font-weight 700`). No all-caps body.

## Layout

- **App shell** (`components/Layout.tsx`): collapsible left sidebar (220px, 56px
  collapsed) with grouped `NAV_SECTIONS`, plus a Workspaces block (Home / My
  Dashboard / Portfolio Manager). Main content is `max-w-7xl` centered, except the
  custom dashboard which is full-width.
- **Home** (`pages/Home.tsx`): bento grid of tool tiles (`BENTO_CARDS`), gold
  top-border on each tile, tag plus title plus body plus an "OPEN" affordance.
- **Tool pages** commonly use `SidebarLayout` (a left inputs rail plus results area).
  See the Stock Valuation tabs and `valuationShared.tsx` for the shared token set
  (INPUT, LABEL, SECTION, PRIMARY_BTN, GHOST_BTN, PANEL, METRIC_GRID, and more).
  Reuse these before inventing new ones.
- Spacing is dense but rhythmic. Panels are separated by hairline borders, not heavy
  shadows.

## Components

Reuse these (in `frontend/src/components` and `pages/valuationShared.tsx`):
`MetricCard`, `PageHeader`, `PageWrapper`, `EmptyState`, `SidebarLayout`,
`ChartPanel`, `HelpTip`, plus the valuation token set. Cards carry a hairline border.
Some banners/callouts use a colored `border-left` accent stripe, an established
in-app convention for status banners (pre-profit warning, terminal-dominated
warning). Charts are `recharts`, themed to the palette, with value-bearing tooltips.

## Dashboard widgets

The custom dashboard (`pages/CustomDashboard.tsx`) composes draggable widgets via
`WidgetFrame` + `WidgetRenderer`; the **Trading Portal** preset is the reference
layout (ticker-tape strip, watchlist rail, chart + order ticket + positions cockpit,
full-width positions ledger). Every widget is a sharp-cornered navy panel; visual
consistency comes from one shared chrome:

- **Panel:** `--theme-surface` (`#0d1826`) fill, 1px hairline border, no radius, no
  shadow. Panels separate by borders, never elevation.
- **Grid density:** desktop widgets use a 52px grid row with an 8px gutter.
  Auto-arrange preserves natural widget dimensions and stacks short supporting
  panels beside taller primary workspaces instead of stretching rows uniformly.
- **Header strip:** a recessed bar (`rgba(0,0,0,0.16)`, bottom hairline
  `rgba(255,255,255,0.05)`) with the title in gold (`--theme-primary`), Sora,
  `9px`, weight `700`, uppercase, `letter-spacing 0.16em`. Inline controls (timeframe,
  overlays, ticker box) sit on the same strip, right-aligned. `WidgetFrame` renders
  this strip for every widget.
- **Numbers:** the data face (`--theme-mono`, Hanken Grotesk) with `font-variant-numeric: tabular-nums`. Gains green,
  losses red, the value always printed alongside color.
- **Tickers:** a transparent-PNG logo (`assets.parqet.com/logos/symbol/<SYM>?format=png`,
  the shared `TickerLogo` component) next to the symbol in watchlists, positions
  ledgers, and order tickets.
- **Watchlist row:** logo (22px) + symbol (Sora, 12px, weight 600,
  `#dce3ed`) over a truncated company name (9px, `--theme-secondary`) on the left;
  right-aligned price (mono, 12px) over day-change % (10px, green/red).
  Rows separate by a faint `rgba(255,255,255,0.04)` hairline, no columns.
- **Index tape:** a thin full-width strip of `SYM price ±chg%` segments (mono,
  11px, tabular-nums; symbol muted, value green/red). Scrolls as a seamless
  marquee, pauses on hover, and freezes under `prefers-reduced-motion`. Tickers are
  configurable or loaded from a Portfolio Manager book.
- **Trading tone:** buy/up green `#22C55E`, sell/down red `#EF4444`, labels in
  `--theme-secondary`.

Presets (`buildPreset` in `hooks/useDashboard.ts`): Everything, Trading Portal,
Research, Screening, Market Overview. Research-specific widgets: Analyst Consensus
(rating distribution + targets), Valuation (multiples vs the broad market), Insider
Activity (ownership split + transaction log).

## Motion

`framer-motion`. Entrance reveals (tile grids, panels) use a small `y` offset plus
`staggerChildren`, ease-out, no bounce or elastic. **All entrance motion is gated on
`useReducedMotion`:** when reduced, render the final state directly (never gate
content visibility on an animation that will not fire). Keep motion subtle. This is a
work tool, not a showcase.

## Copy (voice rules, enforced)

Spartan, active, second person ("you"). Every word earns its place.

- **No emoji or decorative Unicode** (no ⬢⊕✦⟳⚡⏱📈). Plain text, arrows (→ ↑ ↓), and
  ASCII punctuation only.
- **No em dashes** and **no semicolons** in UI copy. Use periods, commas, colons,
  parentheses.
- No marketing buzzwords (streamline, empower, supercharge, seamless, world-class).
  Name what the tool literally does.
- Button labels are verb plus object ("Run Correlation", "Load segments").

## Code conventions

- Styling is inline styles keyed to `var(--theme-*)` tokens with hex fallbacks.
  Tailwind utility classes are used selectively. No CSS modules.
- No comments unless the WHY is non-obvious. Delete unused code, no backwards-compat
  shims.
- New tools are React pages in `frontend/src/pages`, wired into `App.tsx` routes,
  `Layout.tsx` nav, and a `Home.tsx` tile, never standalone scripts.
