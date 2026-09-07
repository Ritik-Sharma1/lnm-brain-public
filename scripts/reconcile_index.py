#!/usr/bin/env python3
"""Drain index reconciler until 0 orphans.

Usage:
    python3 scripts/reconcile_index.py              # live worker
    python3 scripts/reconcile_index.py --dry-run    # preview only
"""
import json, os, sys, urllib.request, time

KEY = os.environ.get("BRAIN_KEY", "YOUR_API_KEY")
BASE = "https://your-worker-subdomain.workers.dev"
DRY = "--dry-run" in sys.argv

url = f"{BASE}/reconcile-index?key={KEY}"
cursor, total_backlinks, total_hubs, pass_num = 0, 0, 0, 1

print(f"Reconciler drain {'(DRY RUN) ' if DRY else ''}starting...")

while True:
    body = json.dumps({"cursor": cursor, "batch": 40, "dry_run": DRY}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=90))
    except Exception as e:
        print(f"  ERROR at cursor={cursor}: {e}")
        time.sleep(5)
        continue

    added   = r.get("backlinks_added", 0)
    hubs    = r.get("hubs_written", 0)
    rem     = r.get("remaining", 0)
    nxt     = r.get("cursor")
    scanned = r.get("scanned", "?")
    idx_upd = r.get("index_updated", False)

    total_backlinks += added
    total_hubs      += hubs

    print(f"  pass={pass_num} cursor={cursor}/{scanned} hubs_written={hubs} "
          f"backlinks+={added} remaining={rem} index_updated={idx_upd}")

    if nxt is None and rem == 0:
        break

    cursor   = nxt if nxt is not None else 0
    pass_num += 1
    time.sleep(0.5)  # polite rate

print(f"\nDONE. total_backlinks_added={total_backlinks} total_hubs_written={total_hubs}")
if DRY:
    print("(dry-run — no writes performed)")
