#!/usr/bin/env python3
"""
graphify_engine.py — Codebase knowledge graph engine for /graphify slash command.

Commands:
  diff                      Print JSON of changed/new/deleted files vs stat-index.json
  save <hash> <json>        Write semantic analysis JSON to cache/semantic/<hash>.json
  merge <changed_json>      Rebuild graph.json, GRAPH_REPORT.md, obsidian/ from all caches
  query <question>          Search graph nodes/edges matching the question
  stats                     Print summary stats about the current graph
"""

import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
OUT = ROOT / "graphify-out"
STAT_INDEX_PATH = OUT / "cache" / "stat-index.json"
GRAPH_JSON_PATH = OUT / "graph.json"
REPORT_MD_PATH = OUT / "GRAPH_REPORT.md"
SEMANTIC_CACHE_DIR = OUT / "cache" / "semantic"
COST_JSON_PATH = OUT / "cost.json"
OBSIDIAN_DIR = OUT / "obsidian"
MANIFEST_PATH = OUT / "manifest.json"

SEMANTIC_EXTS = frozenset({".py", ".tsx", ".ts", ".js", ".jsx"})
ALL_TRACK_EXTS = SEMANTIC_EXTS | frozenset({
    ".json", ".md", ".yml", ".yaml", ".txt", ".sh", ".html", ".svg", ".png"
})
EXCLUDE_DIRS = frozenset({
    "node_modules", "venv", ".venv", "__pycache__", ".git", "graphify-out",
    ".mypy_cache", ".pytest_cache", "htmlcov", ".eggs", "build", "dist",
    "coverage", ".tox", "worktrees", "design-mockups",
})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_stat_index() -> dict:
    if STAT_INDEX_PATH.exists():
        return json.loads(STAT_INDEX_PATH.read_text())
    return {}


def load_graph() -> dict:
    if GRAPH_JSON_PATH.exists():
        return json.loads(GRAPH_JSON_PATH.read_text())
    return {"directed": True, "multigraph": False, "graph": {}, "nodes": [], "links": [], "hyperedges": []}


HIDDEN_ALLOW = frozenset({".devcontainer", ".github", ".vscode"})


def scan_files():
    """Yield all tracked file Paths under ROOT, respecting EXCLUDE_DIRS and .gitignore."""
    gitignored = _load_gitignored_dirs()

    for root, dirs, files in os.walk(ROOT):
        root_path = Path(root)
        rel_root = root_path.relative_to(ROOT)

        dirs[:] = [
            d for d in sorted(dirs)
            if " " not in d                          # skip dirs with spaces (e.g. "gcloud auth login")
            and d not in EXCLUDE_DIRS
            and (not d.startswith(".") or d in HIDDEN_ALLOW)
            and str(rel_root / d) not in gitignored
        ]
        for fname in files:
            p = root_path / fname
            if p.suffix.lower() in ALL_TRACK_EXTS:
                yield p


def _load_gitignored_dirs() -> set:
    """Return a set of relative dir paths that git considers ignored."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--others", "--ignored", "--exclude-standard",
             "--directory", "-z"],
            cwd=ROOT, capture_output=True, text=True, timeout=10
        )
        return {p.rstrip("/") for p in result.stdout.split("\0") if p}
    except Exception:
        return set()


def node_id(rel_path: str, entity: str) -> str:
    """Derive a stable node ID from a relative file path and entity name."""
    base = re.sub(r"[^a-z0-9]+", "_", rel_path.lower().replace("\\", "/"))
    base = base.strip("_")
    ent = re.sub(r"[^a-z0-9]+", "_", entity.lower()).strip("_")
    if base.endswith(ent):
        return base
    return f"{base}_{ent}" if ent else base


# ---------------------------------------------------------------------------
# AST-based extraction for Python files (zero token cost)
# ---------------------------------------------------------------------------

def extract_python_ast(path: Path, rel_path: str) -> dict:
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        return {"nodes": [], "edges": [], "hyperedges": []}

    nodes = []
    edges = []

    file_nid = node_id(rel_path, Path(rel_path).stem)

    # Top-level definitions
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nid = node_id(rel_path, node.name)
            nodes.append({
                "id": nid,
                "label": f"{Path(rel_path).stem}.{node.name}",
                "file_type": "code",
                "source_file": rel_path,
                "source_location": str(node.lineno),
            })
            edges.append({
                "source": file_nid,
                "target": nid,
                "relation": "contains",
                "confidence": "EXTRACTED",
                "confidence_score": 1.0,
                "source_file": rel_path,
                "weight": 1.0,
            })
        elif isinstance(node, ast.ClassDef):
            nid = node_id(rel_path, node.name)
            nodes.append({
                "id": nid,
                "label": node.name,
                "file_type": "code",
                "source_file": rel_path,
                "source_location": str(node.lineno),
            })
            edges.append({
                "source": file_nid,
                "target": nid,
                "relation": "contains",
                "confidence": "EXTRACTED",
                "confidence_score": 1.0,
                "source_file": rel_path,
                "weight": 1.0,
            })
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module
                target_nid = re.sub(r"[^a-z0-9]+", "_", mod.lower()).strip("_")
                edges.append({
                    "source": file_nid,
                    "target": target_nid,
                    "relation": "imports",
                    "confidence": "EXTRACTED",
                    "confidence_score": 1.0,
                    "source_file": rel_path,
                    "weight": 1.0,
                })

    # Add file-level node
    nodes.insert(0, {
        "id": file_nid,
        "label": Path(rel_path).name,
        "file_type": "code",
        "source_file": rel_path,
        "source_location": "L1",
    })

    return {"nodes": nodes, "edges": edges, "hyperedges": []}


# ---------------------------------------------------------------------------
# Community detection (union-find connected components)
# ---------------------------------------------------------------------------

def detect_communities(node_ids: list, links: list) -> dict:
    parent = {nid: nid for nid in node_ids}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    def union(x, y):
        px, py = find(x), find(y)
        if px != py and px in parent:
            parent[px] = py

    for link in links:
        src, tgt = link.get("source"), link.get("target")
        if src in parent and tgt in parent:
            union(src, tgt)

    components = defaultdict(list)
    for nid in node_ids:
        components[find(nid)].append(nid)

    sorted_comps = sorted(components.values(), key=len, reverse=True)
    return {nid: i for i, comp in enumerate(sorted_comps) for nid in comp}


# ---------------------------------------------------------------------------
# Community label inference from node source files
# ---------------------------------------------------------------------------

def infer_community_labels(nodes: list, community_map: dict) -> dict:
    """Return {community_id: label_string} based on most common path segment."""
    buckets = defaultdict(list)
    for n in nodes:
        cid = community_map.get(n["id"])
        if cid is not None:
            src = n.get("source_file", "")
            buckets[cid].append(src)

    labels = {}
    for cid, paths in buckets.items():
        segs = []
        for p in paths:
            parts = Path(p).parts
            segs.extend(parts[:-1])  # skip filename
        if segs:
            from collections import Counter
            most_common = Counter(segs).most_common(1)[0][0]
            labels[cid] = most_common.replace("_", " ").replace("-", " ").title()
        else:
            labels[cid] = f"Group {cid}"
    return labels


# ---------------------------------------------------------------------------
# Graph rebuild from all semantic caches
# ---------------------------------------------------------------------------

def rebuild_graph(changed_files: list) -> dict:
    stat_index = load_stat_index()

    # Update stat-index for all changed/new files
    for f in changed_files:
        p = Path(f["path"])
        if p.exists():
            stat = p.stat()
            stat_index[f["path"]] = {
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "hash": f["hash"],
            }

    # Remove deleted files
    deleted = {f["path"] for f in changed_files if not Path(f["path"]).exists()}
    for dp in deleted:
        stat_index.pop(dp, None)

    # Collect nodes/links from all semantic caches
    all_nodes = {}
    all_links = []
    all_hyperedges = []

    for abs_path, info in stat_index.items():
        h = info["hash"]
        cache_file = SEMANTIC_CACHE_DIR / f"{h}.json"
        if cache_file.exists():
            try:
                data = json.loads(cache_file.read_text())
            except Exception:
                continue
            for n in data.get("nodes", []):
                if n.get("id"):
                    all_nodes[n["id"]] = n
            all_links.extend(data.get("edges", []))
            all_hyperedges.extend(data.get("hyperedges", []))

    node_ids = list(all_nodes.keys())
    community_map = detect_communities(node_ids, all_links)
    community_labels = infer_community_labels(list(all_nodes.values()), community_map)

    for nid, n in all_nodes.items():
        n["community"] = community_map.get(nid, 0)
        n["norm_label"] = n.get("label", "")

    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, stderr=subprocess.DEVNULL
        ).decode().strip()
    except Exception:
        commit = ""

    graph = {
        "directed": True,
        "multigraph": False,
        "graph": {"hyperedges": all_hyperedges},
        "nodes": list(all_nodes.values()),
        "links": all_links,
        "hyperedges": all_hyperedges,
        "built_at_commit": commit,
    }

    GRAPH_JSON_PATH.write_text(json.dumps(graph))
    STAT_INDEX_PATH.write_text(json.dumps(stat_index, indent=2))

    generate_report(graph, community_labels)
    generate_obsidian(graph, community_labels)

    return graph


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report(graph: dict, community_labels: dict):
    nodes = graph["nodes"]
    links = graph["links"]
    n_communities = len(set(n.get("community", 0) for n in nodes))

    buckets = defaultdict(list)
    for n in nodes:
        buckets[n.get("community", 0)].append(n)

    sorted_comps = sorted(buckets.items(), key=lambda x: len(x[1]), reverse=True)
    shown = [c for c in sorted_comps if len(c[1]) >= 3]
    thin = [c for c in sorted_comps if len(c[1]) < 3]

    lines = [
        f"# Graph Report - .  ({__import__('datetime').date.today()})",
        "",
        "## Summary",
        f"- {len(nodes)} nodes · {len(links)} edges · {n_communities} communities "
        f"({len(shown)} shown, {len(thin)} thin omitted)",
        "",
        "## Community Hubs (Navigation)",
    ]

    for cid, comp_nodes in shown:
        label = community_labels.get(cid, f"Group {cid}")
        slug = label.replace(" ", "_")
        lines.append(f"- [[_COMMUNITY_{slug}|{label}]]")

    REPORT_MD_PATH.write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Obsidian note generation
# ---------------------------------------------------------------------------

def generate_obsidian(graph: dict, community_labels: dict):
    OBSIDIAN_DIR.mkdir(parents=True, exist_ok=True)

    community_by_id = {}
    for n in graph["nodes"]:
        cid = n.get("community", 0)
        community_by_id[n["id"]] = community_labels.get(cid, f"Group {cid}")

    # Build adjacency for outgoing links
    adjacency = defaultdict(list)
    for link in graph["links"]:
        adjacency[link["source"]].append(link)

    for n in graph["nodes"]:
        label = n.get("label", n["id"])
        safe_label = re.sub(r'[<>:"/\\|?*]', "_", label)
        note_path = OBSIDIAN_DIR / f"{safe_label}.md"

        community_label = community_by_id.get(n["id"], "Unknown")
        slug = community_label.replace(" ", "_")

        connections = adjacency.get(n["id"], [])
        conn_lines = []
        for link in connections[:20]:
            tgt = link.get("target", "")
            rel = link.get("relation", "")
            conf = link.get("confidence", "")
            conn_lines.append(f"- [[{tgt}]] - `{rel}` [{conf}]")

        body = [
            "---",
            f'source_file: "{n.get("source_file", "")}"',
            f'type: "code"',
            f'community: "{community_label}"',
            f'location: "{n.get("source_location", "")}"',
            "tags:",
            "  - graphify/code",
            "  - graphify/EXTRACTED",
            f"  - community/{slug}",
            "---",
            "",
            f"# {label}",
            "",
        ]
        if conn_lines:
            body += ["## Connections"] + conn_lines + [""]
        body.append(f"#graphify/code #graphify/EXTRACTED #community/{slug}")

        note_path.write_text("\n".join(body))


# ---------------------------------------------------------------------------
# Query: search graph for relevant nodes
# ---------------------------------------------------------------------------

def cmd_query(question: str):
    graph = load_graph()
    q = question.lower()
    tokens = re.findall(r"\w+", q)

    scored = []
    for n in graph["nodes"]:
        score = 0
        label = n.get("label", "").lower()
        src = n.get("source_file", "").lower()
        for tok in tokens:
            if tok in label:
                score += 3
            if tok in src:
                score += 1
        if score > 0:
            scored.append((score, n))

    scored.sort(key=lambda x: x[0], reverse=True)
    top_nodes = [n for _, n in scored[:15]]
    top_ids = {n["id"] for n in top_nodes}

    relevant_links = [
        lk for lk in graph["links"]
        if lk.get("source") in top_ids or lk.get("target") in top_ids
    ]

    result = {
        "question": question,
        "matched_nodes": top_nodes,
        "relevant_links": relevant_links[:30],
    }
    print(json.dumps(result, indent=2))


# ---------------------------------------------------------------------------
# Diff: find changed/new/deleted files
# ---------------------------------------------------------------------------

def cmd_diff():
    stat_index = load_stat_index()
    current_paths: set[str] = set()
    changed = []

    for path in scan_files():
        abs_str = str(path)
        current_paths.add(abs_str)
        h = file_hash(path)
        rel = str(path.relative_to(ROOT))

        old_hash = stat_index.get(abs_str, {}).get("hash")
        if old_hash != h:
            changed.append({
                "path": abs_str,
                "rel_path": rel,
                "hash": h,
                "ext": path.suffix,
                "is_new": abs_str not in stat_index,
                "needs_llm": path.suffix in SEMANTIC_EXTS,
            })

    deleted = [p for p in stat_index if p not in current_paths]
    previously_changed = sum(1 for f in changed if not f["is_new"])
    unchanged = len(stat_index) - previously_changed - len(deleted)

    print(json.dumps({
        "changed": changed,
        "deleted": deleted,
        "unchanged": max(0, unchanged),
    }))


# ---------------------------------------------------------------------------
# Save: write a semantic analysis to cache
# ---------------------------------------------------------------------------

def cmd_save(hash_val: str, json_data: str):
    SEMANTIC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(json_data)
    except json.JSONDecodeError as e:
        print(f"ERROR: invalid JSON — {e}", file=sys.stderr)
        sys.exit(1)

    cache_file = SEMANTIC_CACHE_DIR / f"{hash_val}.json"
    cache_file.write_text(json.dumps(data))
    nodes = len(data.get("nodes", []))
    edges = len(data.get("edges", []))
    print(f"Saved {nodes} nodes, {edges} edges → cache/semantic/{hash_val[:16]}…")


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def cmd_stats():
    graph = load_graph()
    n_nodes = len(graph["nodes"])
    n_links = len(graph["links"])
    n_comm = len(set(n.get("community", 0) for n in graph["nodes"]))
    commit = graph.get("built_at_commit", "unknown")[:12]
    print(f"Nodes: {n_nodes}  Links: {n_links}  Communities: {n_comm}  Commit: {commit}")

    # Stat index
    stat_index = load_stat_index()
    print(f"Tracked files: {len(stat_index)}")

    # Cache coverage
    cached = sum(
        1 for info in stat_index.values()
        if (SEMANTIC_CACHE_DIR / f"{info['hash']}.json").exists()
    )
    print(f"Files with semantic cache: {cached}/{len(stat_index)}")


# ---------------------------------------------------------------------------
# Merge: rebuild graph from all caches
# ---------------------------------------------------------------------------

def cmd_merge(changed_json: str):
    try:
        changed_files = json.loads(changed_json)
    except json.JSONDecodeError:
        changed_files = []

    graph = rebuild_graph(changed_files)
    n_nodes = len(graph["nodes"])
    n_links = len(graph["links"])
    print(f"Graph rebuilt: {n_nodes} nodes, {n_links} links → graphify-out/graph.json")


# ---------------------------------------------------------------------------
# Auto-extract Python files locally (no LLM cost)
# ---------------------------------------------------------------------------

def cmd_extract_python(abs_path: str, hash_val: str):
    """Extract nodes/edges from a Python file using AST (no LLM)."""
    p = Path(abs_path)
    rel = str(p.relative_to(ROOT))
    data = extract_python_ast(p, rel)
    SEMANTIC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = SEMANTIC_CACHE_DIR / f"{hash_val}.json"
    cache_file.write_text(json.dumps(data))
    nodes = len(data.get("nodes", []))
    edges = len(data.get("edges", []))
    print(f"AST-extracted {nodes} nodes, {edges} edges → cache/semantic/{hash_val[:16]}…")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0]

    if cmd == "diff":
        cmd_diff()
    elif cmd == "save" and len(args) >= 3:
        cmd_save(args[1], " ".join(args[2:]))
    elif cmd == "merge":
        cmd_merge(args[1] if len(args) > 1 else "[]")
    elif cmd == "query" and len(args) >= 2:
        cmd_query(" ".join(args[1:]))
    elif cmd == "stats":
        cmd_stats()
    elif cmd == "extract_python" and len(args) >= 3:
        cmd_extract_python(args[1], args[2])
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(__doc__)
        sys.exit(1)
