#!/usr/bin/env python3
"""Capture a conversation snippet or note into Lnm-Brain via GitHub API."""

import json
import sys
import subprocess
from datetime import datetime
from pathlib import PurePosixPath

REPO = "your-username/your-repo"
BRANCH = "main"


def gh_api(method, path, data=None):
    cmd = ["gh", "api", f"/repos/{REPO}/contents/{path}",
           "-X", method, "-f", f"ref={BRANCH}"]
    if data:
        cmd.extend(["-f", f"message=auto: capture via lnm-brain",
                    "-f", f"content={data}"])
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result


def capture(args):
    data = json.load(sys.stdin) if not sys.stdin.isatty() else None
    if not data:
        print("Usage: echo '{...}' | python3 capture.py")
        sys.exit(1)

    cap_type = data.get("type", "note")
    title = data.get("title", f"untitled-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    content = data.get("content", "")
    tags = data.get("tags", [])
    entities = data.get("entities", [])
    source_url = data.get("source_url", "")

    import base64
    encoded = base64.b64encode(content.encode()).decode()

    if cap_type == "conversation":
        path = f"raw/conversations/{datetime.now().strftime('%Y-%m-%d')}-{title}.md"
    elif cap_type == "code":
        path = f"raw/code/{title}"
    elif cap_type == "web":
        path = f"raw/web/{title}.md"
    else:
        path = f"raw/conversations/{datetime.now().strftime('%Y-%m-%d')}-{title}.md"

    frontmatter = "---\n"
    frontmatter += f"type: {cap_type}\n"
    frontmatter += f"created: {datetime.now().strftime('%Y-%m-%d')}\n"
    frontmatter += f"tags: [{', '.join(tags)}]\n"
    if entities:
        frontmatter += f"entities: [{', '.join(entities)}]\n"
    if source_url:
        frontmatter += f"source_url: {source_url}\n"
    frontmatter += "---\n\n"

    full_content = frontmatter + content
    encoded = base64.b64encode(full_content.encode()).decode()

    result = gh_api("PUT", path, encoded)
    if result.returncode == 0:
        print(f"Captured to {path}")
    else:
        print(f"Error: {result.stderr}")
        sys.exit(1)


if __name__ == "__main__":
    capture(sys.argv)
