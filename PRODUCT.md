# Product

## Register

product

## Users

Sophisticated individual investors and active traders (the project owner first, and
users with a similar bar). They arrive in focused research/analysis sessions at a
desk: valuing a stock, modeling options or a portfolio, scanning macro and flow,
tracking live positions. They want real data and methodology, not a simplified
consumer wrapper, and they don't need hand-holding.

## Product Purpose

Alphatape Terminal is an institutional-style market analytics terminal that
consolidates data, valuation, derivatives, portfolio, and trading tools into one
dark, dense workspace. Each tool is a first-class page wired into a shared shell
(sidebar nav plus Home tile grid). Success is fast, trustworthy analysis: the user
can move from question to answer without leaving the terminal, and trusts the numbers
because the tools are honest about their assumptions and limits.

## Brand Personality

Sharp, modern, approachable. Serious analytics that stays legible and never
intimidating. Voice is spartan and active, second person ("you"), no hype, no
filler. (See the writing-style rules in the design system: no emoji, no em dashes,
no semicolons, plain text and arrows only.)

## Anti-references

This should NOT look or feel like any of:
- **Generic SaaS dashboard.** Rounded pastel cards, gradient hero metric, mascot
  illustrations, the default "AI made this" look.
- **Crypto / hype aesthetic.** Neon glows, animated gradients, emoji, gamified
  confetti, rocket-and-moon energy.
- **Consumer fintech (Robinhood-style).** Oversimplified, gamified, hides the real
  data behind cheerful UI.
- **Cluttered legacy terminal.** Genuinely unreadable density: tiny gray-on-gray
  text, no hierarchy, 1990s-Bloomberg punishment. Dense, but never punishing.

## Design Principles

- **Signal over hand-holding.** Trust the user. Show real data, real models, and the
  methodology behind them, not simplified proxies.
- **Dense but readable.** High information density is the point, but hierarchy,
  spacing, and contrast must hold. Density is not an excuse for clutter.
- **Honest outputs.** Surface uncertainty rather than hiding it. When a model is
  fragile (for example a terminal-value-dominated DCF), say so. Never present a shaky
  number as fact.
- **One system, many tools.** Every tool draws from the same token set and shared
  components so the terminal reads as a single product, not a folder of scripts.
- **Quiet styling.** Let the data and charts carry the page. The gold accent is a
  scalpel, not a paintbrush.

## Accessibility & Inclusion

Best-effort, no formal WCAG target committed. Practical bar: keep body text readable
against its surface, respect `prefers-reduced-motion` (the app already gates entrance
animations on it), and prefer numeric value labels on charts/heatmaps so meaning is
never carried by color alone.
