#!/usr/bin/env python3
"""
U2 — Memory-type backfill.

Hits a new admin endpoint POST /api/classify-memory-type that runs the
classifier on a single obs by id, writes memory_type to obs:meta.

Usage:
    python3 backfill_memory_type.py --limit 200 --dry-run
    python3 backfill_memory_type.py --limit 200 --apply
    python3 backfill_memory_type.py --since 2026-05-01 --apply

The endpoint must be wired in v7.9.2 deploy (see admin_endpoints.js).
"""
from __future__ import annotations
import argparse, json, sys, urllib.request, urllib.error
from pathlib import Path

BRAIN_BASE = "https://your-worker-subdomain.workers.dev"
LIST_ENDPOINT = f"{BRAIN_BASE}/api/list-recent"
CLASSIFY_ENDPOINT = f"{BRAIN_BASE}/api/classify-memory-type"


def post_json(url, payload, timeout=45):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                  headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--since", type=str, default=None, help="YYYY-MM-DD")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip obs that already have memory_type set")
    args = ap.parse_args()

    url = f"{LIST_ENDPOINT}?limit={args.limit}"
    if args.since:
        url += f"&since={args.since}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        print(f"list-recent failed: {e}", file=sys.stderr)
        return 1

    items = data.get("results") or data.get("items") or []
    print(f"Loaded {len(items)} observations")

    if args.only_missing:
        items = [o for o in items if not o.get("memory_type")]
        print(f"  filtered to {len(items)} without memory_type")

    results = []
    for o in items:
        if not args.apply:
            results.append({"id": o["id"], "title": o.get("title", ""), "memory_type": "(dry-run)"})
            continue
        try:
            res = post_json(CLASSIFY_ENDPOINT, {"id": o["id"]})
            results.append({"id": o["id"], "title": o.get("title", ""),
                            "memory_type": res.get("memory_type"),
                            "confidence": res.get("confidence")})
            print(f"  {o['id'][:40]:<40} -> {res.get('memory_type')} ({res.get('confidence'):.2f})")
        except Exception as e:
            print(f"  fail {o['id']}: {e}", file=sys.stderr)
            results.append({"id": o["id"], "error": str(e)})

    by_type = {}
    for r in results:
        t = r.get("memory_type", "?")
        by_type[t] = by_type.get(t, 0) + 1
    print("\nDistribution:")
    for k, v in sorted(by_type.items(), key=lambda x: -x[1]):
        print(f"  {k:<14} {v}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
