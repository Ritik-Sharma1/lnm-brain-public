#!/usr/bin/env python3
"""
Generate hierarchical knowledge graph (v9.7 — Brain Compaction).

Shape: root → cluster-heads (7 domains) → topic clusters → observations.
Each observation connects to its CLUSTER HEAD and to peers via SHARED ENTITIES.
NO direct observation→root edges (root is a nav entry, not a semantic peer).
"""

import os
import re
import json
from pathlib import Path
from datetime import datetime
from collections import defaultdict

# ── Domain cluster-head definitions ─────────────────────────────────────────
DOMAIN_HEADS = [
    {"id": "cluster:code",     "label": "Code & Dev",      "keywords": ["worker","deploy","wrangler","cloudflare","github","code","fix","bug","api","function","script","tool","lnm","brain"]},
    {"id": "cluster:design",   "label": "Design",           "keywords": ["ui","ux","design","figma","css","layout","brand","visual","color","svg","banner"]},
    {"id": "cluster:work",     "label": "Work & Business",  "keywords": ["linkedin","ghostwriting","client","sales","marketing","leads","outreach","ExampleProject","ExampleProject","campaign","content"]},
    {"id": "cluster:personal", "label": "Personal",         "keywords": ["ritik","health","fa","ataxia","adhd","diet","exercise","supplement","personal","journal","daily"]},
    {"id": "cluster:research", "label": "Research",         "keywords": ["research","study","analysis","copyos","strategy","framework","model","economics","data","report"]},
    {"id": "cluster:health",   "label": "Health & Wellness","keywords": ["health","fa","ataxia","supplement","idebenone","magnesium","vitamin","diet","exercise","gut","spine"]},
    {"id": "cluster:finance",  "label": "Finance",          "keywords": ["income","revenue","pricing","payment","upi","money","finance","cost","profit","subscription"]},
]

ROOT_ID = "root:index"

NOISE_RE = re.compile(r"(?:^|[/\-])tool-(?:bash|edit|write|read|mcp|glob|grep|task)\b", re.I)


def is_tool_noise(filepath):
    name = Path(filepath).name
    return bool(NOISE_RE.search(name))


def extract_frontmatter(content):
    fm = {}
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        return fm
    i = 1
    while i < len(lines) and lines[i].strip() != "---":
        line = lines[i].strip()
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip(); val = val.strip()
            if val.startswith("[") and val.endswith("]"):
                val = [v.strip() for v in val[1:-1].split(",") if v.strip()]
            fm[key] = val
        i += 1
    return fm


def list_items(v):
    if not v:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str):
        return [v.strip()] if v.strip() else []
    return []


def classify_domain(filepath, tags, entities):
    """Score filepath+tags+entities against DOMAIN_HEADS keywords → best match."""
    text = (filepath + " " + " ".join(tags) + " " + " ".join(entities)).lower()
    best, best_score = "cluster:work", 0
    for dh in DOMAIN_HEADS:
        score = sum(1 for kw in dh["keywords"] if kw in text)
        if score > best_score:
            best, best_score = dh["id"], score
    return best


def node_id_from_path(filepath):
    return filepath.lstrip("./").replace("/", "--").replace(".md", "").lower()


def scan_markdown_files():
    files = []
    for root, dirs, fnames in os.walk("."):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "raw"}]
        for fname in fnames:
            if fname.endswith(".md"):
                files.append(os.path.join(root, fname))
    return files


def main():
    markdown_files = scan_markdown_files()
    print(f"Found {len(markdown_files)} markdown files (raw/ excluded from scan)")

    nodes = []
    edge_set = set()
    edges = []

    def add_edge(frm, to, etype, **kw):
        key = f"{frm}|{to}|{etype}"
        if key not in edge_set:
            edge_set.add(key)
            edges.append({"from": frm, "to": to, "type": etype, **kw})

    # ── Root node ────────────────────────────────────────────────────────────
    nodes.append({
        "id": ROOT_ID,
        "label": "Second Brain",
        "type": "root",
        "path": "index.md",
        "tags": [],
        "entities": [],
    })

    # ── Cluster-head nodes ──────────────────────────────────────────────────
    for dh in DOMAIN_HEADS:
        nodes.append({
            "id": dh["id"],
            "label": dh["label"],
            "type": "cluster-head",
            "path": "",
            "tags": [],
            "entities": [],
        })
        add_edge(dh["id"], ROOT_ID, "cluster-to-root")

    # ── Observation nodes ───────────────────────────────────────────────────
    entity_to_nodes = defaultdict(list)
    obs_count = 0

    for filepath in markdown_files:
        if is_tool_noise(filepath):
            continue

        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            continue

        fm = extract_frontmatter(content)
        tags = list_items(fm.get("tags"))
        entities = list_items(fm.get("entities"))

        nid = node_id_from_path(filepath)
        domain = classify_domain(filepath, tags, entities)

        nodes.append({
            "id": nid,
            "label": fm.get("title") or Path(filepath).stem.replace("-", " ").title(),
            "type": "observation",
            "path": filepath.lstrip("./"),
            "tags": tags,
            "entities": entities,
            "domain": domain,
        })

        # Edge: observation → cluster-head (NOT root — root is nav only).
        add_edge(nid, domain, "obs-to-cluster")
        obs_count += 1

        for ent in entities:
            if ent and len(ent) > 2:
                entity_to_nodes[ent].append(nid)

    # ── Shared-entity peer edges ─────────────────────────────────────────────
    peer_edges = 0
    for ent, nids in entity_to_nodes.items():
        if len(nids) < 2:
            continue
        sample = nids[:10]  # cap pairs per entity to avoid O(n²) explosion
        for i in range(len(sample)):
            for j in range(i + 1, len(sample)):
                add_edge(sample[i], sample[j], "shared-entity", entity=ent)
                peer_edges += 1

    graph = {
        "nodes": nodes,
        "edges": edges,
        "metadata": {
            "generated": datetime.now().isoformat(),
            "node_count": len(nodes),
            "edge_count": len(edges),
            "source": "generate_graph_v9.7",
            "shape": "root→cluster-head→observation",
            "obs_nodes": obs_count,
            "obs_to_cluster_edges": obs_count,
            "shared_entity_edges": peer_edges,
            "direct_obs_to_root_edges": 0,
        },
    }

    Path("graph").mkdir(exist_ok=True)
    with open("graph/graph.json", "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2)

    print(f"  root: 1")
    print(f"  cluster-heads: {len(DOMAIN_HEADS)}")
    print(f"  observation nodes: {obs_count}")
    print(f"  obs-to-cluster edges: {obs_count}")
    print(f"  shared-entity peer edges: {peer_edges}")
    print(f"  TOTAL edges: {len(edges)}")
    print(f"  direct obs→root edges: 0  (migrated {obs_count} old obs→index edges)")
    print(f"✓  graph/graph.json written")


if __name__ == "__main__":
    main()
