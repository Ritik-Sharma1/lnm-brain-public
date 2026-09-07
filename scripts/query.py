#!/usr/bin/env python3
"""Query the Lnm-Brain wiki via GitHub API."""

import json
import sys
import subprocess

REPO = "your-username/your-repo"
BRANCH = "main"


def gh_get(path):
    cmd = ["gh", "api", f"/repos/{REPO}/contents/{path}?ref={BRANCH}",
           "-H", "Accept: application/vnd.github.v3.raw"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout


def search(query):
    index = gh_get("index.md")
    if not index:
        print("Could not read index.md")
        return

    query_lower = query.lower()
    lines = index.split("\n")
    matches = []
    for line in lines:
        if line.startswith("|") and query_lower in line.lower():
            matches.append(line)

    if matches:
        print(f"Found {len(matches)} matches for '{query}':\n")
        for m in matches:
            print(m)
    else:
        print(f"No matches for '{query}'")


def read_page(path):
    content = gh_get(path)
    print(content)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 query.py <search query>")
        print("       python3 query.py --read wiki/topics/some-topic.md")
        sys.exit(1)

    if sys.argv[1] == "--read" and len(sys.argv) > 2:
        read_page(sys.argv[2])
    else:
        search(" ".join(sys.argv[1:]))
