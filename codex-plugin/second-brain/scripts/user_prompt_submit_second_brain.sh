#!/usr/bin/env bash
# UserPromptSubmit: inject relevant Second Brain memories for the prompt (hybrid recall).
# Reads BRAIN_BASE_URL + BRAIN_API_KEY from ~/.config/lnm-brain/config.
set -uo pipefail

CONFIG="${LNM_BRAIN_CONFIG:-$HOME/.config/lnm-brain/config}"
[ -f "$CONFIG" ] && . "$CONFIG"
[ -n "${BRAIN_API_KEY:-}" ] && [ -n "${BRAIN_BASE_URL:-}" ] || exit 0

INPUT=$(cat)
# Claude Code sends the text as .prompt; other hosts use .message.
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // .message // ""' 2>/dev/null || echo "")
[ ${#PROMPT} -lt 5 ] && exit 0

QUERY=$(printf '%s' "$PROMPT" | head -c 300)
MAX_CHARS="${LNM_RECALL_CHARS:-2000}"

RESULT=$(curl -sf --max-time 6 -G \
  --data-urlencode "q=$QUERY" \
  --data-urlencode "limit=5" \
  -H "X-API-Key: $BRAIN_API_KEY" \
  "$BRAIN_BASE_URL/recall" 2>/dev/null || echo "")

if [ -n "$RESULT" ]; then
  printf '\n[second-brain] Relevant memory context:\n%s\n' \
    "$(printf '%s' "$RESULT" | head -c "$MAX_CHARS")"
else
  TOPIC=$(printf '%s' "$PROMPT" | head -c 120)
  printf '\n[second-brain] Before relying on prior state, call recall_brain with topic: "%s".\n' "$TOPIC"
fi
