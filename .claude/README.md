# Claude Code setup — finance_dashboard

How this repo is wired for Claude Code: what runs automatically, what you can invoke, and what needs credentials. Two scopes matter:

- **Project-scoped** — checked into this repo, travels with a clone, shared by anyone working here.
- **User-scoped** — installed on this machine for all of Will's projects; a fresh clone by someone else would **not** get these.

Most changes below activate on a fresh session or after `/reload-plugins`.

---

## Project-scoped (in the repo)

### Hooks — `.claude/settings.json`
| Event | Command | What it does |
|---|---|---|
| `Stop` | `.claude/hooks/frontend_typecheck.py` | After a turn that changed `frontend/src/**/*.ts(x)`, runs `tsc --noEmit` and surfaces any type errors. Advisory (never blocks); no-ops on backend/config-only turns. |

Note: the graphify, ui-ux guard, and skill-router hooks referenced in `CLAUDE.md` live in the **user-global** `~/.claude/settings.json`, not here — they work on Will's machine but do not travel with the repo. Only the typecheck hook above is project-scoped.

### Skills — `.claude/skills/`
| Skill | Invoke | Notes |
|---|---|---|
| `/deploy` | user-only | Fly.io ship ritual: rebuild `frontend/dist` → caveman-commit → `cd` repo root → `flyctl deploy` → curl-verify prod. Does not auto-fire. |
| `/new-tool` | user or model | Scaffolds a new terminal tool the project's way (page + `App.tsx` route + `hubs.ts` tile + redirect). Enforces integrate-not-standalone. |
| `/impeccable` | user or model | Frontend design/critique/polish system (tracked project skill). |
| `cavecrew` | model | Delegation guide for the caveman subagents. |

Design skills (`brandkit`, `design-taste-*`, `emil-design-eng`, etc.) are vendored copies and gitignored — not project skills.

### Subagents — `.claude/agents/`
| Agent | Purpose |
|---|---|
| `frontend-test-writer` | Writes Vitest tests for the deterministic pure helpers in `frontend/src/lib` (the biggest coverage gap: ~100 components, few tests). Pure functions only; no components or network. Spawn via the Agent tool. |

### MCP servers — `.mcp.json`
| Server | Transport | Auth |
|---|---|---|
| `context7` | HTTP | keyless (rate-limited; add `CONTEXT7_API_KEY` header for more) — live library-doc lookup |
| `github` | HTTP | OAuth on first use — issues/PRs/Actions in-session (no local `gh` needed) |

Both are remote and secret-free, so `.mcp.json` is safe to commit.

---

## User-scoped (this machine, all projects)

### Installed plugins
Added from the `claude-plugins-official` marketplace via `claude plugin install <name>@claude-plugins-official`:

**Code intelligence & quality**
- `pyright-lsp` — Python type intelligence across the FastAPI backend (backend counterpart to the frontend tsc hook; no mypy/pyright existed before)
- `typescript-lsp` — TS code intelligence for the frontend
- `serena` — semantic symbol-level navigation + refactor over the whole repo (complements graphify's structure map)
- `semgrep` — inline SAST as code is written (auth, API keys, SQL, external fetching); local rules run offline

**Data & authoring**
- `duckdb-skills` — query the SQLite dbs (`analytics.db`, `leaderboard.db`, `alerts.db`) in-session
- `skill-creator` — author / refine / measure project skills

**Observability (need account tokens before they do anything)**
- `logfire` — Pydantic Logfire; auto-instruments FastAPI + httpx. Wire-up: `logfire.configure()` + `logfire.instrument_fastapi(app)` in `backend/main.py`, token from `.env`. Would have pinpointed the 1GB OOM.
- `langfuse` — LLM tracing for the Groq→Cerebras calls (AI brief, sentiment). Needs Langfuse public/secret keys.

Pre-existing user plugins: `frontend-design`, `caveman`, `claude-code-setup`.

### Global hooks (in `~/.claude/settings.json`, not this repo)
`SessionStart`/`Stop` graphify sync, `PostToolUse` graphify AST extract, `PreToolUse` ui-ux guard, `UserPromptSubmit` skill router. These fire in every project.

---

## Activation checklist
1. `/reload-plugins` (or start a fresh session) — loads the LSPs, serena's MCP, and the new skills/agent.
2. Approve `context7` + `github` when Claude Code prompts; authenticate GitHub via OAuth on first use.
3. For `logfire` / `langfuse`, add credentials to `.env` and wire the backend before expecting data.
