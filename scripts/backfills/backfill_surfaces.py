#!/usr/bin/env python3
"""
U1a — Surface backfill.

Walks Worker's /api/list-recent endpoint, infers surface from heuristics on
existing obs, and POSTs a relabel to /api/relabel-surface (a new admin endpoint
shipped with v7.9.2 — see u1-foundation/admin_endpoints.js).

Heuristics:
  - tags or entities contains "claude-code"        -> claude-code
  - tags or entities contains "cowork"             -> cowork
  - title starts with "2026-..-..-..-tool-Bash-"  -> claude-code
  - title contains "X-twitter" or "x-post"        -> claude-ai-web
  - title contains "chatgpt-history"              -> chatgpt-go
  - source_url has chat.openai.com / chatgpt.com  -> chatgpt-go
  - source_url has gemini.google.com              -> gemini
  - source_url has claude.ai                      -> claude-ai-web
  - else                                          -> other (leave alone)

Dry-run first. Apply only after sample inspection.

Usage:
    python3 backfill_surfaces.py --limit 200 --dry-run
    python3 backfill_surfaces.py --limit 200 --apply

Output: prints a table of (id, old, inferred, confidence) and a JSON summary.
"""
from __future__ import annotations
import argparse, json, sys, urllib.request, urllib.error
from typing import Optional

BRAIN_BASE = "https://your-worker-subdomain.workers.dev"
LIST_ENDPOINT = f"{BRAIN_BASE}/api/list-recent"
RELABEL_ENDPOINT = f"{BRAIN_BASE}/api/relabel-surface"

VALID = {"claude-ai-web", "claude-code", "cowork", "gemini", "chatgpt-go", "claude-mobile", "other"}


def infer_surface(obs: dict) -> tuple[Optional[str], float, str]:
    """Return (inferred_surface, confidence_0_1, reason)."""
    tags = [t.lower() for t in (obs.get("tags") or [])]
    ents = [e.lower() for e in (obs.get("entities") or [])]
    title = (obs.get("title") or "").lower()
    url = (obs.get("source_url") or "").lower()

    if "claude-code" in tags or "claude-code" in ents:
        return "claude-code", 0.95, "tags/entities include claude-code"
    if "cowork" in tags or "cowork" in ents:
        return "cowork", 0.95, "tags/entities include cowork"
    if "claude-ai-web" in tags or "claude-ai-web" in ents:
        return "claude-ai-web", 0.95, "tags/entities include claude-ai-web"

    # title patterns
    if "-tool-bash-" in title or "-tool-mcp__" in title or title.startswith("session-handoff"):
        return "claude-code", 0.9, "title is tool/session marker"
    if "x-twitter" in title or "x-post" in title or "tweet" in title:
        return "claude-ai-web", 0.7, "title mentions x/twitter draft"
    if "chatgpt-history" in title or "chatgpt" in title:
        return "chatgpt-go", 0.85, "title mentions chatgpt"
    if "gemini" in title:
        return "gemini", 0.7, "title mentions gemini"

    # source_url
    if "chat.openai.com" in url or "chatgpt.com" in url:
        return "chatgpt-go", 0.9, "source_url chatgpt"
    if "gemini.google.com" in url:
        return "gemini", 0.9, "source_url gemini"
    if "claude.ai" in url:
        return "claude-ai-web", 0.9, "source_url claude.ai"

    return None, 0.0, "no signal"


def post_json(url: str, payload: dict, timeout: int = 30) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                  headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--apply", action="store_true", help="actually relabel (default dry-run)")
    ap.add_argument("--min-confidence", type=float, default=0.7)
    args = ap.parse_args()

    url = f"{LIST_ENDPOINT}?limit={args.limit}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        print(f"list-recent failed: {e}", file=sys.stderr)
        return 1

    items = data.get("results") or data.get("items") or []
    print(f"Loaded {len(items)} observations")

    proposals = []
    for o in items:
        old = (o.get("surface") or "other").lower()
        if old != "other":
            continue  # already labelled, skip
        new, conf, reason = infer_surface(o)
        if not new or conf < args.min_confidence:
            continue
        proposals.append({"id": o["id"], "old": old, "new": new, "confidence": conf, "reason": reason, "title": o.get("title", "")})

    print(f"\nFound {len(proposals)} relabel candidates (>= confidence {args.min_confidence})\n")
    print(f"{'id':<40} {'old':<10} {'new':<14} {'conf':>5}  reason")
    for p in proposals[:30]:
        print(f"{p['id'][:40]:<40} {p['old']:<10} {p['new']:<14} {p['confidence']:>5.2f}  {p['reason']}")
    if len(proposals) > 30:
        print(f"... ({len(proposals) - 30} more)")

    if not args.apply:
        print("\nDry-run. Re-run with --apply to write.")
        return 0

    print(f"\nApplying {len(proposals)} relabels...")
    ok, fail = 0, 0
    for p in proposals:
        try:
            post_json(RELABEL_ENDPOINT, {"id": p["id"], "surface": p["new"]})
            ok += 1
        except Exception as e:
            print(f"  fail {p['id']}: {e}", file=sys.stderr)
            fail += 1
    print(f"Done. ok={ok}, fail={fail}")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
