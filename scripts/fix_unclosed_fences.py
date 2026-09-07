#!/usr/bin/env python3
"""Guarantee every conversation file's [[index]] backlink is OUTSIDE any code fence.

Root cause of the disconnected graph rim: the worker's wiki-regex-fallback
compressor emitted an UNCLOSED ```fence in the Summary. Everything after it --
including `## Backlinks [[index]]` -- was swallowed inside the open code block,
so Obsidian parsed [[index]] as literal text, formed no edge, and the file
became a permanent rim orphan despite the backlink being physically present.

Bulletproof fix (idempotent):
  1. If the file's ``` fence count is ODD, append a closing ``` so all fences
     are balanced and nothing dangles open.
  2. Ensure a `## Backlinks` block with [[index]] exists at EOF, OUTSIDE all
     fences. If the file already ends with a fenced/again-trapped backlink, the
     appended one is the live, parseable edge.

Run from repo root:  python3 scripts/fix_unclosed_fences.py
"""
import glob, os, re, sys

DIRS = ["wiki/conversations", "raw/conversations", "wiki/entities",
        "wiki/topics", "wiki/projects", "handoffs"]
FENCE = "```"

def month_of(path):
    m = re.search(r"(\d{4}-\d{2})", os.path.basename(path))
    return m.group(1) if m else None

def fix_file(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    fences = raw.count(FENCE)   # substring count — catches mid-line ``` too
    changed = False
    text = raw

    # 1. close a dangling fence
    if fences % 2 != 0:
        if not text.endswith("\n"):
            text += "\n"
        text += "\n" + FENCE + "\n"
        changed = True

    # 2. ensure a parseable [[index]] backlink OUTSIDE any fence at EOF.
    #    Re-check: does an [[index]] appear AFTER the final fence close?
    last_fence_pos = text.rfind(FENCE)
    tail = text[last_fence_pos + 3:] if last_fence_pos != -1 else text
    if "[[index]]" not in tail:
        mo = month_of(path)
        block = "\n\n## Backlinks\n[[index]]" + (f" · [[{mo}]]" if mo else "") + "\n"
        if not text.endswith("\n"):
            text += "\n"
        text += block
        changed = True

    if changed:
        open(path, "w", encoding="utf-8").write(text)
    return changed

def main():
    fixed = []
    for d in DIRS:
        for path in glob.glob(os.path.join(d, "*.md")):
            try:
                if fix_file(path):
                    fixed.append(path)
            except Exception as e:
                print(f"ERR {path}: {e}", file=sys.stderr)
    print(f"Fixed {len(fixed)} files.")

    # verify
    bad = 0
    for d in DIRS:
        for path in glob.glob(os.path.join(d, "*.md")):
            t = open(path, errors="ignore").read()
            if t.count(FENCE) % 2:
                bad += 1
                print("  STILL UNCLOSED:", path)
    print(f"Remaining unclosed: {bad}")

if __name__ == "__main__":
    main()
