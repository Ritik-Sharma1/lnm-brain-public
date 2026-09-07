#!/usr/bin/env bash
# Run ONCE from the Lnm-Brain repo root on any machine (Mac, Linux, cloud VM).
# Merges second brain + caveman ultra hooks into the global ~/.claude/settings.json
# so all three behaviors fire in EVERY Claude Code project, not just this repo.
#
# Usage:  bash scripts/setup-global-hooks.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"
SCRIPTS="$REPO_DIR/codex-plugin/second-brain/scripts"
SETTINGS="$HOME/.claude/settings.json"

# Verify scripts exist
for f in session_start_second_brain.sh user_prompt_submit_second_brain.sh stop_second_brain_capture.sh; do
  if [ ! -f "$SCRIPTS/$f" ]; then
    echo "ERROR: missing $SCRIPTS/$f — run from the repo root." >&2
    exit 1
  fi
done

# Create global settings file if it doesn't exist
mkdir -p "$HOME/.claude"
if [ ! -f "$SETTINGS" ]; then
  echo '{"hooks":{}}' > "$SETTINGS"
fi

# Check jq is available
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq not found. Install it: brew install jq" >&2
  exit 1
fi

SS_CMD="bash $SCRIPTS/session_start_second_brain.sh"
UPS_CMD="bash $SCRIPTS/user_prompt_submit_second_brain.sh"
STOP_CMD="bash $SCRIPTS/stop_second_brain_capture.sh"

# Merge hooks — adds ours only if not already present, preserves all existing hooks
UPDATED=$(jq \
  --arg ss  "$SS_CMD" \
  --arg ups "$UPS_CMD" \
  --arg stp "$STOP_CMD" '
  def add_hook(event; cmd):
    .hooks[event] = (
      (.hooks[event] // []) +
      [{"hooks": [{"type": "command", "command": cmd}]}]
      | unique_by(.hooks[0].command)
    );
  add_hook("SessionStart"; $ss)
  | add_hook("UserPromptSubmit"; $ups)
  | add_hook("Stop"; $stp)
' "$SETTINGS")

# Write atomically
printf '%s\n' "$UPDATED" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Done. Updated: $SETTINGS"
echo ""
echo "All three behaviors now active in EVERY Claude Code project:"
echo "  SessionStart    → second brain reminder + caveman ultra ruleset"
echo "  UserPromptSubmit → second brain query + caveman ultra per-turn"
echo "  Stop            → auto-capture to second brain"
echo ""
echo "Restart Claude Code to apply."
