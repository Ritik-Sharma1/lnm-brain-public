#!/usr/bin/env python3
"""Lint the Lnm-Brain wiki — bidirectional orphan check, mirrors worker v9.3 logic.

Checks:
  - orphan-no-index-entry : file name not found in index.md or any hub in wiki/_indexes/
  - uncompressed          : raw/conversations file has no wiki/conversations counterpart

Run: python3 scripts/lint.py
Exits non-zero if any issues found.
"""

import collections, json, subprocess, sys

REPO   = "your-username/your-repo"
BRANCH = "main"

RECONCILE_DIRS = [
    "wiki/conversations", "wiki/entities", "wiki/topics", "wiki/projects",
    "wiki/skills", "wiki/rules", "wiki/code", "handoffs", "raw/conversations",
]


def gh_get_raw(path):
    cmd = ["gh", "api", f"/repos/{REPO}/contents/{path}?ref={BRANCH}",
           "-H", "Accept: application/vnd.github.v3.raw"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def gh_tree():
    cmd = ["gh", "api", f"/repos/{REPO}/git/trees/{BRANCH}?recursive=1"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("ERROR: could not fetch git tree", r.stderr[:200], file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout).get("tree", [])


def list_all(tree, prefix):
    """All .md blob paths under prefix."""
    pre = prefix.rstrip("/") + "/"
    return [t["path"] for t in tree if t["type"] == "blob" and t["path"].startswith(pre) and t["path"].endswith(".md")]


def lint():
    print("=== Lnm-Brain Lint v9.3 ===\n")
    tree = gh_tree()

    # Build index corpus: index.md + all hub files
    index_raw = gh_get_raw("index.md")
    hub_paths = list_all(tree, "wiki/_indexes")
    corpus_parts = [index_raw]
    for hp in hub_paths:
        corpus_parts.append(gh_get_raw(hp))
    corpus = "\n".join(corpus_parts)

    issues = collections.Counter()
    issue_list = []

    # Check all in-scope dirs
    total_scanned = 0
    for d in RECONCILE_DIRS:
        files = list_all(tree, d)
        total_scanned += len(files)
        for fp in files:
            name_noext = fp.split("/")[-1].replace(".md", "")
            if name_noext not in corpus:
                issues["orphan-no-index-entry"] += 1
                issue_list.append({"type": "orphan-no-index-entry", "file": fp})

    # Uncompressed check
    raw_names  = set(fp.split("/")[-1] for fp in list_all(tree, "raw/conversations"))
    wiki_names = set(fp.split("/")[-1] for fp in list_all(tree, "wiki/conversations"))
    for n in raw_names:
        if n not in wiki_names:
            issues["uncompressed"] += 1
            issue_list.append({"type": "uncompressed", "file": f"raw/conversations/{n}"})

    print(f"Total scanned : {total_scanned}")
    print(f"Hub files     : {len(hub_paths)}")
    print(f"Issues found  : {sum(issues.values())}")
    print()
    for t, c in issues.most_common():
        print(f"  {t}: {c}")

    if issue_list[:20]:
        print("\nFirst up to 20:")
        for i in issue_list[:20]:
            print(f"  [{i['type']}] {i['file']}")

    if not issues:
        print("\nWiki is healthy. Zero orphans.")
    else:
        print(f"\nRun: python3 scripts/reconcile_index.py  to fix all orphans.")

    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(lint())
