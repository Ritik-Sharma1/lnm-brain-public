#!/usr/bin/env bash
# Installs the LNM Brain auto-memory hooks for Claude Code in EVERY project:
#   SessionStart     → loads your latest handoff + recent captures
#   UserPromptSubmit → injects memories relevant to each prompt
#   Stop/SessionEnd  → saves a digest of the session (throttled, runs in background)
#
# It writes your worker URL + API key to ~/.config/lnm-brain/config (chmod 600),
# copies the hook scripts to ~/.config/lnm-brain/hooks/, checks the key against your
# worker, backs up ~/.claude/settings.json, then merges the hooks into it.
#
# Usage (from the repo root):
#   bash scripts/setup-global-hooks.sh
# Non-interactive:
#   BRAIN_BASE_URL=https://<worker>.<subdomain>.workers.dev BRAIN_API_KEY=<key> bash scripts/setup-global-hooks.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"
SRC_HOOKS="$REPO_DIR/codex-plugin/second-brain/scripts"
CONFIG_DIR="$HOME/.config/lnm-brain"
CONFIG="$CONFIG_DIR/config"
HOOK_DIR="$CONFIG_DIR/hooks"
SETTINGS="$HOME/.claude/settings.json"

for bin in jq curl python3; do
  command -v "$bin" >/dev/null || { echo "ERROR: $bin not found. macOS: brew install $bin" >&2; exit 1; }
done
for f in session_start_second_brain.sh user_prompt_submit_second_brain.sh stop_second_brain_capture.sh; do
  [ -f "$SRC_HOOKS/$f" ] || { echo "ERROR: missing $SRC_HOOKS/$f — run from your lnm-brain-public clone." >&2; exit 1; }
done

# 1. Config: worker URL + API key, readable only by you.
URL="${BRAIN_BASE_URL:-}"
KEY="${BRAIN_API_KEY:-}"
if [ -z "$URL$KEY" ] && [ -f "$CONFIG" ]; then
  echo "Using existing $CONFIG"
else
  [ -n "$URL" ] || read -rp "Worker URL (https://<worker>.<subdomain>.workers.dev): " URL
  [ -n "$KEY" ] || { read -rsp "API key (input hidden): " KEY; echo; }
  URL="${URL%%\?*}"; URL="${URL%/}"; URL="${URL%/mcp}"
  mkdir -p "$CONFIG_DIR"; chmod 700 "$CONFIG_DIR"
  (umask 077; printf 'BRAIN_BASE_URL=%q\nBRAIN_API_KEY=%q\n' "$URL" "$KEY" > "$CONFIG")
  echo "Saved $CONFIG (chmod 600)"
fi
. "$CONFIG"

# 2. Check the key before touching Claude Code settings.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "X-API-Key: $BRAIN_API_KEY" "$BRAIN_BASE_URL/api/home-feed" || true)
if [ "$CODE" != "200" ]; then
  echo "ERROR: $BRAIN_BASE_URL answered HTTP $CODE with this key (expected 200)." >&2
  echo "  401 = wrong key · 503 = API_KEY secret not set on the worker · 000 = wrong URL / offline" >&2
  exit 1
fi
echo "Worker reachable, key accepted."

# 3. Copy hooks out of the repo so moving or deleting the clone doesn't break them.
mkdir -p "$HOOK_DIR"
install -m 755 "$SRC_HOOKS/session_start_second_brain.sh" "$SRC_HOOKS/user_prompt_submit_second_brain.sh" \
  "$SRC_HOOKS/stop_second_brain_capture.sh" "$HOOK_DIR/"

# 4. Merge into ~/.claude/settings.json (backup first; existing hooks are kept).
mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
UPDATED=$(jq \
  --arg ss  "bash \"$HOOK_DIR/session_start_second_brain.sh\"" \
  --arg ups "bash \"$HOOK_DIR/user_prompt_submit_second_brain.sh\"" \
  --arg stp "bash \"$HOOK_DIR/stop_second_brain_capture.sh\"" '
  def add_hook(event; cmd):
    .hooks[event] = (
      ((.hooks[event] // []) + [{"hooks": [{"type": "command", "command": cmd}]}])
      | unique_by(.hooks[0].command)
    );
  .hooks = (.hooks // {})
  | add_hook("SessionStart"; $ss)
  | add_hook("UserPromptSubmit"; $ups)
  | add_hook("Stop"; $stp)
  | add_hook("SessionEnd"; $stp)
' "$SETTINGS")
printf '%s\n' "$UPDATED" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Done. Hooks added to $SETTINGS (backup saved next to it)."
echo "Restart Claude Code. Capture errors, if any, are logged to ~/.cache/lnm-brain/capture.log"
echo "To remove: delete the four lnm-brain entries under \"hooks\" in $SETTINGS."
