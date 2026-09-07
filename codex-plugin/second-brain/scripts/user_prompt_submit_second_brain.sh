#!/usr/bin/env bash
# Hybrid hook: retrieve relevant Second Brain context when possible; otherwise request MCP recall.
set -uo pipefail

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.message // ""' 2>/dev/null || echo "")
[ ${#PROMPT} -lt 5 ] && exit 0

API_KEY="${BRAIN_API_KEY:-YOUR_API_KEY}"
BASE_URL="${BRAIN_BASE_URL:-https://your-worker-subdomain.workers.dev}"
QUERY=$(printf '%s' "$PROMPT" | head -c 300)

RESULT=$(curl -sf --max-time 8 -G \
  --data-urlencode "q=$QUERY" \
  -H "x-api-key: $API_KEY" \
  "$BASE_URL/query" 2>/dev/null || echo "")

if [ -n "$RESULT" ]; then
  printf '\n[second-brain] Relevant memory context:\n%s\n' \
    "$(printf '%s' "$RESULT" | head -c 4000)"
else
  TOPIC=$(printf '%s' "$PROMPT" | head -c 120)
  printf '\n[second-brain] Before relying on prior state, call query_second_brain with topic: "%s".\n' "$TOPIC"
fi
