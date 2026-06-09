---
description: "Incremental codebase knowledge graph builder. Usage: /graphify --update | /graphify query \"<question>\""
---

You are executing the `/graphify` command. Parse $ARGUMENTS to determine mode.

## Mode: `--update` (default when no args or `--update` passed)

Run an incremental graph update. Follow these steps exactly:

### Step 1 — Find changed files
```bash
python3 graphify_engine.py diff
```
Parse the JSON output. It has three keys: `changed` (list), `deleted` (list), `unchanged` (count).

If `changed` is empty and `deleted` is empty:
- Print: "graphify: graph is current — 0 files changed."
- Stop here.

### Step 2 — Auto-extract Python files (zero token cost)
For every entry in `changed` where `ext` is `.py`:
```bash
python3 graphify_engine.py extract_python "<path>" "<hash>"
```
This uses stdlib AST — no LLM needed. Do this for ALL `.py` files before moving on.

### Step 3 — Semantic extraction for frontend/config files
For every entry in `changed` where `needs_llm` is `true` and `ext` is NOT `.py`:
- Read the file using the Read tool
- Extract all semantic entities and relationships as JSON matching this schema:

```json
{
  "nodes": [
    {
      "id": "<snake_case_id>",
      "label": "<human readable name>",
      "file_type": "code",
      "source_file": "<rel_path>",
      "source_location": "<line number or null>"
    }
  ],
  "edges": [
    {
      "source": "<source_node_id>",
      "target": "<target_node_id>",
      "relation": "<imports|calls|uses|contains|renders|defines|extends>",
      "confidence": "EXTRACTED",
      "confidence_score": 1.0,
      "source_file": "<rel_path>",
      "weight": 1.0
    }
  ],
  "hyperedges": []
}
```

**Extraction rules:**
- One node per exported component/function/class/hook + one node for the file itself
- Node IDs: `<dir_path>_<filename_no_ext>_<entity_name>` — all lowercase, non-alphanumeric → `_`
- Edges: capture imports (→ `imports`), component usage (→ `renders`/`calls`), inheritance (→ `extends`)
- Skip trivial nodes (unnamed expressions, one-liner util re-exports with no unique identity)
- Include a hyperedge only when 3+ nodes form a named architectural group (e.g. "SPA routes", "Auth context providers")

After extracting, save it:
```bash
python3 graphify_engine.py save "<hash>" '<json_string>'
```

### Step 4 — Rebuild graph
```bash
python3 graphify_engine.py merge '<changed_array_json>'
```
Pass the full `changed` array from Step 1 as the argument (JSON-encoded string).

### Step 5 — Report
Print a one-line summary:
```
graphify: updated N files — graph now has X nodes, Y links across Z communities.
```
Read the first 10 lines of `graphify-out/GRAPH_REPORT.md` to fill in X, Y, Z.

---

## Mode: `query "<question>"`

Answer a structural question about the codebase using the knowledge graph.

### Step 1 — Search graph
```bash
python3 graphify_engine.py query "<question>"
```
Parse the JSON output: `matched_nodes` and `relevant_links`.

### Step 2 — Load context
For up to 5 of the most relevant matched nodes, read their Obsidian note:
```
graphify-out/obsidian/<node_label>.md
```

### Step 3 — Answer
Synthesize a direct answer using the graph nodes, links, and note content. Reference specific file paths and line numbers where available. Keep it under 200 words unless the question demands more depth.

---

## Mode: `stats`

```bash
python3 graphify_engine.py stats
```
Print the output directly to the user.
