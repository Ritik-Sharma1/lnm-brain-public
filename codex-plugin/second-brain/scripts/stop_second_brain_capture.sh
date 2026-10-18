#!/usr/bin/env bash
# Stop / SessionEnd hook: saves a digest of the current Claude Code session to your LNM Brain.
# Stop fires after EVERY reply, so captures are throttled to one per LNM_CAPTURE_EVERY
# (default 6) new user messages; SessionEnd always saves whatever is new. The upload runs
# in the background so Claude Code never waits on it. Failures go to
# ~/.cache/lnm-brain/capture.log. Reads BRAIN_BASE_URL + BRAIN_API_KEY from
# ~/.config/lnm-brain/config (written by scripts/setup-global-hooks.sh).
set -uo pipefail

CONFIG="${LNM_BRAIN_CONFIG:-$HOME/.config/lnm-brain/config}"
[ -f "$CONFIG" ] && . "$CONFIG"
[ -n "${BRAIN_API_KEY:-}" ] && [ -n "${BRAIN_BASE_URL:-}" ] || exit 0
export BRAIN_API_KEY BRAIN_BASE_URL

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/lnm-brain"
mkdir -p "$STATE_DIR"
INPUT=$(cat)

nohup python3 - "$INPUT" "$STATE_DIR" >>"$STATE_DIR/capture.log" 2>&1 <<'PYEOF' &
import sys, json, os, re, datetime, urllib.request, urllib.error, pathlib

inp = json.loads(sys.argv[1] or "{}")
state_dir = pathlib.Path(sys.argv[2])
if inp.get("stop_hook_active"):
    sys.exit(0)
path = inp.get("transcript_path") or ""
if not os.path.isfile(path):
    sys.exit(0)
event = inp.get("hook_event_name") or "Stop"
sid = re.sub(r"[^A-Za-z0-9_-]", "", str(inp.get("session_id") or "unknown"))[:64]

SKIP_PREFIXES = ("<command-", "<local-command-", "<system-reminder>", "Caveat:")
turns = []
for line in open(path, encoding="utf-8", errors="replace"):
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("isSidechain") or d.get("isMeta"):
        continue
    m = d.get("message") if isinstance(d.get("message"), dict) else d
    role = m.get("role") or d.get("type")
    if role not in ("user", "assistant"):
        continue
    c = m.get("content", "")
    if isinstance(c, list):
        text = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    else:
        text = c if isinstance(c, str) else ""
    text = text.strip()
    if len(text) < 3 or text.startswith(SKIP_PREFIXES):
        continue
    turns.append((role, text))

exchanges = []
for role, text in turns:
    if role == "user":
        exchanges.append([text, ""])
    elif exchanges:
        exchanges[-1][1] = text
if not exchanges:
    sys.exit(0)

state = state_dir / f"{sid}.count"
try:
    last = int(state.read_text())
except Exception:
    last = 0
every = int(os.environ.get("LNM_CAPTURE_EVERY", "6"))
new = len(exchanges) - last
if new <= 0 or (event != "SessionEnd" and new < every):
    sys.exit(0)

picked = [exchanges[0]]
middle = exchanges[1:-1]
if middle:
    step = max(1, len(middle) // 5)
    picked += middle[::step][:5]
if len(exchanges) > 1:
    picked.append(exchanges[-1])
content = "\n\n---\n\n".join(f"Q: {u[:400]}\nA: {a[:800]}" for u, a in picked)

first_user = exchanges[0][0]
slug = re.sub(r"[^a-z0-9-]+", "-", first_user[:60].lower()).strip("-") or "session"
now = datetime.datetime.now(datetime.timezone.utc)
title = f"{now:%Y-%m-%d-%H%M}-{slug}"
entities = []
for word in re.findall(r"\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b", content):
    if word not in entities:
        entities.append(word)

payload = json.dumps({
    "title": title,
    "content": content[:12000],
    "type": "conversation",
    "surface": "claude-code",
    "tags": ["auto-captured", "claude-code", event.lower()],
    "entities": entities[:10] + ["claude-code"],
}).encode()

base = os.environ["BRAIN_BASE_URL"].rstrip("/")
for endpoint, timeout in (("/ingest", 60), ("/capture", 30)):
    req = urllib.request.Request(base + endpoint, data=payload, method="POST",
        headers={"X-API-Key": os.environ["BRAIN_API_KEY"], "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
        state.write_text(str(len(exchanges)))
        sys.exit(0)
    except urllib.error.HTTPError as e:
        print(f"{now:%Y-%m-%dT%H:%M}Z {endpoint} HTTP {e.code}: {e.read()[:200]!r}")
    except Exception as e:
        print(f"{now:%Y-%m-%dT%H:%M}Z {endpoint} failed: {e}")
PYEOF
exit 0
