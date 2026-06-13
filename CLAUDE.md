# Finance Dashboard — Claude Project Instructions

## 0. Addressing the User

The user's name is **Will**. Address him by name (Will) in every response.

## 1. Graphify — Codebase Knowledge Graph

**At the start of every session**, run `/graphify --update`. No exceptions — this keeps the structural map current and reduces token usage on codebase questions.

- **When to query**: use `/graphify query "<question>"` instead of reading raw files for structural questions ("what calls X?", "trace data flow through Y")
- **Graph location**: `graphify-out/graph.json` — always present after the first run
- **Do not run a full rebuild** unless the graph is missing; `--update` handles incremental changes

## 2. UI/UX Design System (`./ui-ux-pro-max-skill`)

**Design context:** `PRODUCT.md` (register, users, purpose, anti-references, principles) and `DESIGN.md` (color tokens, typography, layout, components, copy voice) at the repo root are the source of truth for this product's identity and visual system. Read them before any design work. The `/impeccable` skill loads them automatically. Keep them current when tokens or conventions change.

Before making any frontend change, query the design system search engine:

```bash
python3 ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/search.py "<query>" --domain <domain>
```

Domains: `style`, `color`, `typography`, `chart`, `ux`, `landing`, `product`
Stacks: `react`, `nextjs`, `shadcn`, `html-tailwind` (default)

**Apply its rules as follows:**
- **Styles**: 67 UI styles (glassmorphism, brutalism, neumorphism, dark mode, bento grid…) — choose the closest match to the existing terminal aesthetic
- **Color palettes**: 161 palettes — always prefer those aligned with the dark terminal scheme (`#101c2e` base, `#c9a84c` gold, `#d7e3fc` text)
- **Typography**: 57 font pairings — project uses JetBrains Mono; check pairings before adding any new typeface
- **UX guidelines**: 99 rules covering accessibility, spacing, interaction states, animation
- **Design review**: before reporting any frontend task complete, run `search.py "review" --domain ux` and verify the output passes its pre-delivery checklist

**Fallback** (if directory is missing): proceed with existing conventions and note it to the user.

**Source of truth**: `ui-ux-pro-max-skill/src/ui-ux-pro-max/` — edit data/scripts/templates only here; `cli/assets/` is a bundled copy for npm publishing.

## 3. Obsidian Vault Integration

**Reading vault files:**
- Use `Read` to open `.md` files directly by absolute path
- Use `Bash` + `grep`/`find` to search across the vault: `find <vault_path> -name "*.md" | xargs grep -l "<keyword>"`

**Writing / logging to the vault:**
- Only write when explicitly instructed — always confirm the target file path first
- To force Obsidian's graph indexer to pick up a new link: append `[[NewNote]]` to an existing index/MOC file using the `Edit` tool, then save. Obsidian detects filesystem changes automatically — no app restart needed.
- To create a new vault note: use `Write` with a `.md` file at the vault path. Add YAML frontmatter (`tags:`, `date:`, `project:`) so it appears correctly in graph view.
- To establish backlinks between notes: add `[[NoteTitle]]` inline references in the body — Obsidian resolves these without requiring the file to exist yet.

**Session start — always run these steps:**
1. Read `"/Users/willneedlman/Documents/Obsidian Vault/000 Index.md"` to load vault context
2. Run the following to find recently modified notes:
   ```bash
   find "/Users/willneedlman/Documents/Obsidian Vault" -newer "/Users/willneedlman/Documents/Obsidian Vault/.obsidian/workspace.json" -name "*.md"
   ```
3. For each new/modified note found, pass its content to `/graphify` so it is indexed in the knowledge graph alongside the codebase. This keeps vault research and code structure in a single queryable map.

**Vault path**: `OBSIDIAN_VAULT_PATH=/Users/willneedlman/Documents/Obsidian Vault`

## 4. Project Conventions

- Backend: FastAPI + Python, located in `backend/`
- Frontend: React + TypeScript + Vite, located in `frontend/src/`
- Styling: Inline styles with the dark terminal palette; Tailwind used selectively
- Data: yfinance + FMP API for market data; cache layer in `backend/cache.py`
- No comments unless the WHY is non-obvious
- No backwards-compat shims; delete unused code outright

## 5. Skill Auto-Invocation Rules

These are mandatory — invoke the listed skill/tool proactively without waiting to be asked:

| When | Required action |
|---|---|
| Any frontend component/page/style change | Query `ui-ux-pro-max` before writing; invoke `/impeccable` before marking the task done |
| UI verification (does it look right?) | Use playwright MCP: `browser_navigate` → `browser_screenshot` — do not claim success without a visual check |
| Codebase structure question ("what calls X", "trace Y") | `/graphify query "<question>"` — never crawl raw files for structural info |
| After editing any `.py` file | graphify auto-extracts via PostToolUse hook; no manual step needed |
| Before any `git commit` | `/caveman-commit` for the commit message |
| Before `git push` / opening a PR | `/code-review` to audit the diff |
| Design decision (color, spacing, font, layout) | `python3 ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/search.py "<topic>" --domain <domain>` |

**Hook coverage** (what fires automatically without any action needed):
- `SessionStart` → graphify diff check
- `UserPromptSubmit` → intent router (injects skill hints into context)
- `PreToolUse Edit|Write` → ui-ux guard on frontend files
- `PostToolUse Edit|Write` → graphify AST auto-extract on `.py` files
