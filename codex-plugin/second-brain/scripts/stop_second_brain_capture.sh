#!/usr/bin/env bash
# Stop hook — full session summary capture, three-path strategy:
#   1. /ingest API (full pipeline: wiki + observations + KV + vectors)
#   2. /capture API fallback (same pipeline)
#   3. GitHub API commit (raw file — triggers nightly recompress workflow)
#   4. MCP instruction (last resort)
set -uo pipefail

INPUT=$(cat)

ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
[ "$ACTIVE" = "true" ] && exit 0

TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && {
  printf '[second-brain] MANDATORY: call ingest_to_second_brain NOW with key decisions, code, and insights. type=conversation.\n'
  exit 0
}

API_KEY="YOUR_API_KEY"
BASE_URL="https://your-worker-subdomain.workers.dev"
GH_REPO="your-username/your-repo"
GH_BRANCH="main"

python3 - "$TRANSCRIPT" "$API_KEY" "$BASE_URL" "$GH_REPO" "$GH_BRANCH" <<'PYEOF'
import sys, json, re, datetime, urllib.request, base64, os

path, api_key, base_url, gh_repo, gh_branch = sys.argv[1:6]

try:
    lines = open(path).readlines()
except Exception:
    sys.exit(2)

msgs = []
for line in lines:
    try:
        msgs.append(json.loads(line))
    except Exception:
        pass

# Extract ALL user + assistant messages for a rich session summary
user_msgs = []
assistant_msgs = []
for msg in msgs:
    role = msg.get("role", "")
    c = msg.get("content", "")
    text = ""
    if isinstance(c, list):
        text = " ".join(
            b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"
        )
    elif isinstance(c, str):
        text = c
    text = text.strip()
    if not text or len(text) < 3:
        continue
    if role == "user":
        user_msgs.append(text)
    elif role == "assistant":
        assistant_msgs.append(text)

if not user_msgs and not assistant_msgs:
    sys.exit(2)

first_user = user_msgs[0] if user_msgs else ""
last_user  = user_msgs[-1] if user_msgs else ""
last_asst  = assistant_msgs[-1] if assistant_msgs else ""

# Build full session summary: first exchange + middle digest + last exchange
pairs = list(zip(user_msgs, assistant_msgs))
key_exchanges = []
# First exchange (topic/context)
if pairs:
    u, a = pairs[0]
    key_exchanges.append(f"Q: {u[:400]}\nA: {a[:700]}")
# Middle exchanges (up to 5, sampled)
if len(pairs) > 2:
    mid = pairs[1:-1]
    step = max(1, len(mid) // 5)
    for u, a in mid[::step][:5]:
        key_exchanges.append(f"Q: {u[:300]}\nA: {a[:500]}")
# Last exchange
if len(pairs) > 1:
    u, a = pairs[-1]
    key_exchanges.append(f"Q: {u[:400]}\nA: {a[:800]}")

session_content = "\n\n---\n\n".join(key_exchanges)

# Derive title from first user message
raw_slug = re.sub(r"[^a-z0-9-]+", "-", first_user[:60].lower()).strip("-") or "session"
ts    = datetime.datetime.utcnow().strftime("%Y-%m-%d-%H%M")
title = f"{ts}-{raw_slug}"

# Extract entity hints
entities = []
for word in re.findall(r'\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b', session_content):
    if word not in entities:
        entities.append(word)
entities = entities[:10]

tags = ["auto-captured", "stop-hook"]

payload_dict = {
    "title": title,
    "content": session_content[:12000],
    "type": "conversation",
    "tags": tags,
    "entities": entities,
}
payload = json.dumps(payload_dict).encode()

# ── Path 1: /ingest API (full pipeline) ──────────────────────────────────────
req = urllib.request.Request(
    f"{base_url}/ingest", data=payload,
    headers={"x-api-key": api_key, "Content-Type": "application/json"}, method="POST",
)
try:
    urllib.request.urlopen(req, timeout=15)
    print(f"[second-brain] Ingested via API: {title}")
    sys.exit(0)
except Exception:
    pass

# ── Path 1b: /capture fallback (same pipeline) ───────────────────────────────
req2 = urllib.request.Request(
    f"{base_url}/capture", data=payload,
    headers={"x-api-key": api_key, "Content-Type": "application/json"}, method="POST",
)
try:
    urllib.request.urlopen(req2, timeout=12)
    print(f"[second-brain] Captured via API: {title}")
    sys.exit(0)
except Exception:
    pass

# ── Path 2: GitHub API commit (raw file + nightly recompress picks it up) ────
gh_token = os.environ.get("GITHUB_TOKEN", "")
if not gh_token:
    try:
        import subprocess
        result = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5)
        gh_token = result.stdout.strip()
    except Exception:
        pass

if gh_token:
    file_path = f"raw/conversations/{ts}-{raw_slug}.md"
    front = (
        f"---\ntype: conversation\ncreated: {datetime.datetime.utcnow().strftime('%Y-%m-%d')}\n"
        f"tags: [auto-captured, stop-hook, needs-compression]\n"
        f"entities: [{', '.join(entities)}]\n---\n\n"
    )
    file_content = base64.b64encode((front + session_content[:10000]).encode()).decode()
    gh_payload = json.dumps({
        "message": f"capture: {title}",
        "content": file_content,
        "branch": gh_branch,
    }).encode()
    gh_req = urllib.request.Request(
        f"https://api.github.com/repos/{gh_repo}/contents/{file_path}",
        data=gh_payload,
        headers={
            "Authorization": f"token {gh_token}",
            "Content-Type": "application/json",
            "User-Agent": "lnm-brain-stop-hook",
        },
        method="PUT",
    )
    try:
        urllib.request.urlopen(gh_req, timeout=12)
        print(f"[second-brain] Captured via GitHub (raw): {title}")
        sys.exit(0)
    except Exception:
        pass

# ── Path 3: MCP fallback ──────────────────────────────────────────────────────
sys.exit(3)
PYEOF

STATUS=$?
if [ $STATUS -eq 3 ]; then
  printf '[second-brain] MANDATORY: call ingest_to_second_brain NOW — summary of this session: key decisions, code written, problems solved, entities discussed. type=conversation.\n'
fi
