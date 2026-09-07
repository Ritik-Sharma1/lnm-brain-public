#!/usr/bin/env python3
"""
update_graph.py — Lnm-Brain Knowledge Graph Generator v3.1

Scales to unlimited files via inverted-index edge detection (O(n), not O(n²)).

Scope: wiki/entities, wiki/topics, wiki/projects, wiki/sessions
     + root hub files (index.md, README.md, AGENTS.md, overview.md etc.)
      raw/* and wiki/conversations/* excluded — too many, low signal.
      They exist in D1 FTS5 + KV for search. Graph = knowledge structure only.

Every in-scope node gets an "index-member" edge to index.md (hub).
So every node in Obsidian graph view connects to the index center.

Edge types:
  - wikilink     : explicit [[link]] in content
  - shared-entity: two files share an entity (via inverted index)
  - shared-tag   : two files share a non-generic tag (via inverted index)
  - index-member : every node → index.md hub
"""

import json, re, datetime, sys
from pathlib import Path
from collections import defaultdict, Counter

# ── Config ───────────────────────────────────────────────────────────────────

# Only these dirs are included in graph. Everything else = excluded.
INCLUDE_DIRS = {"wiki/entities", "wiki/topics", "wiki/projects", "wiki/sessions"}

# Root-level files to include as hub nodes (relative to repo root)
HUB_FILES = {
    "index.md", "README.md", "AGENTS.md", "overview.md",
    "PLATFORM_INTEGRATION.md", "KARPATHY_INTEGRATION.md",
}

# index.md is the master hub — every node gets an edge to it
INDEX_HUB = "index.md"

# Tags too generic to create edges
SKIP_TAGS = {
    "note", "conversation", "code", "web", "setup", "update", "document",
    "raw", "auto-captured", "claude-code", "claude-ai-web", "cowork",
    "antigravity", "continuity", "session-handoff", "message-end",
    "supersedes-prior", "infrastructure", "mcp-update", "onboarding",
}

# Max edges per node for shared-entity/shared-tag (prevents hub explosion)
MAX_EDGES_PER_NODE = 200

# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_frontmatter(content):
    fm = {}
    if not content.startswith("---"):
        return fm
    end = content.find("---", 3)
    if end == -1:
        return fm
    for line in content[3:end].strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            k, v = k.strip(), v.strip()
            if v.startswith("[") and v.endswith("]"):
                fm[k] = [i.strip().strip('"\'') for i in v[1:-1].split(",") if i.strip()]
            else:
                fm[k] = v
    return fm

def node_type(filepath):
    p = str(filepath)
    if filepath.name == "index.md" and filepath.parent == Path("."): return "hub"
    if "wiki/entities" in p: return "entity"
    if "wiki/topics"   in p: return "topic"
    if "wiki/projects" in p: return "project"
    if "wiki/sessions" in p: return "session"
    return "hub"

def clean_label(filepath, fm_title=""):
    if fm_title:
        return fm_title
    label = filepath.stem.replace("-", " ").title()
    label = re.sub(r"^\d{4} \d{2} \d{2} ", "", label)
    return label

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def in_scope(filepath):
    p = str(filepath).lstrip("./")
    # Root hub files
    if filepath.parent == Path(".") and filepath.name in HUB_FILES:
        return True
    return any(p.startswith(d) for d in INCLUDE_DIRS)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    root = Path(".")

    # Collect only in-scope files
    all_files = sorted([
        f for f in root.rglob("*.md")
        if ".git" not in str(f) and in_scope(f)
    ])

    total_md = sum(1 for f in root.rglob("*.md") if ".git" not in str(f))
    print(f"Total .md files in repo: {total_md}")
    print(f"In-scope for graph:      {len(all_files)} (wiki/entities + wiki/topics + wiki/projects + wiki/sessions)")

    nodes = []
    node_meta = {}   # nid -> {tags, entities, wikilinks, stem}
    stem_to_ids = defaultdict(list)  # stem -> [nid, ...]

    # ── Pass 1: Build nodes + inverted indexes ────────────────────────────────
    entity_index = defaultdict(list)  # entity -> [nid, ...]
    tag_index    = defaultdict(list)  # tag    -> [nid, ...]

    for f in all_files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        fm       = parse_frontmatter(content)
        nid      = str(f).lstrip("./")
        label    = clean_label(f, fm.get("title", ""))
        ntype    = node_type(f)
        tags     = [slugify(t) for t in fm.get("tags",     [])]
        entities = [slugify(e) for e in fm.get("entities", [])]
        wikilinks = re.findall(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', content)

        nodes.append({
            "id": nid, "label": label, "type": ntype, "path": nid,
            "tags": tags, "entities": entities,
            "created": fm.get("created", ""),
            "connections": len(wikilinks) + len(entities),
        })
        node_meta[nid] = {
            "tags": tags, "entities": entities,
            "wikilinks": wikilinks, "stem": f.stem,
        }
        stem_to_ids[f.stem].append(nid)

        for e in entities:
            entity_index[e].append(nid)
        for t in tags:
            if t not in SKIP_TAGS:
                tag_index[t].append(nid)

    all_node_ids = set(n["id"] for n in nodes)

    # ── Pass 2: Edges via inverted index (O(n), not O(n²)) ───────────────────
    edge_set = set()
    edges    = []
    edge_count_per_node = defaultdict(int)

    def add_edge(src, tgt, etype):
        if src == tgt:
            return
        if src not in all_node_ids or tgt not in all_node_ids:
            return
        if edge_count_per_node[src] >= MAX_EDGES_PER_NODE:
            return
        if edge_count_per_node[tgt] >= MAX_EDGES_PER_NODE:
            return
        key = (min(src, tgt), max(src, tgt), etype)
        if key in edge_set:
            return
        edge_set.add(key)
        edges.append({"from": src, "to": tgt, "type": etype})
        edge_count_per_node[src] += 1
        edge_count_per_node[tgt] += 1

    for nid, meta in node_meta.items():

        # 1. [[wikilinks]]
        for link in meta["wikilinks"]:
            link_stem = Path(link.strip()).stem
            for target in stem_to_ids.get(link_stem, []):
                add_edge(nid, target, "wikilink")

        # 2. Shared entities — O(n) via inverted index
        for e in meta["entities"]:
            for other in entity_index.get(e, []):
                add_edge(nid, other, "shared-entity")

        # 3. Shared tags — O(n) via inverted index
        for t in meta["tags"]:
            if t in SKIP_TAGS:
                continue
            for other in tag_index.get(t, []):
                add_edge(nid, other, "shared-tag")

    # ── Pass 3: Index-member edges — every node → index.md ───────────────────
    # Ensures every node is connected to the hub in Obsidian graph view.
    # Bypasses MAX_EDGES_PER_NODE cap (index hub is allowed unlimited edges).
    if INDEX_HUB in all_node_ids:
        for nid in all_node_ids:
            if nid == INDEX_HUB:
                continue
            key = (min(nid, INDEX_HUB), max(nid, INDEX_HUB), "index-member")
            if key not in edge_set:
                edge_set.add(key)
                edges.append({"from": nid, "to": INDEX_HUB, "type": "index-member"})
    else:
        print("WARNING: index.md not found in graph — no index-member edges added")

    # ── Write ─────────────────────────────────────────────────────────────────
    graph = {
        "nodes": nodes,
        "edges": edges,
        "meta": {
            "generated":    datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "node_count":   len(nodes),
            "edge_count":   len(edges),
            "total_md_files": total_md,
            "version":      "3.1",
            "scope":        "wiki/entities + wiki/topics + wiki/projects + wiki/sessions + root hubs",
            "excluded":     "raw/* + wiki/conversations/* (use D1 FTS5 for search)",
            "note":         "O(n) inverted-index + index-member edges — every node connected to index hub",
        }
    }
    Path("graph").mkdir(exist_ok=True)
    Path("graph/graph.json").write_text(
        json.dumps(graph, indent=2, ensure_ascii=False)
    )

    nt = Counter(n["type"] for n in nodes)
    et = Counter(e["type"] for e in edges)
    print(f"✓ graph.json v3.1: {len(nodes)} nodes, {len(edges)} edges")
    for t, c in nt.most_common(): print(f"  nodes/{t}: {c}")
    for t, c in et.most_common(): print(f"  edges/{t}: {c}")
    print(f"  (excluded {total_md - len(all_files)} raw/conversation files from graph)")

if __name__ == "__main__":
    main()
