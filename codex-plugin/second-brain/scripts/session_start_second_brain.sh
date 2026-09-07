#!/usr/bin/env bash
# SessionStart: load compact Second Brain context. Public template contains no personal style overrides.
set -uo pipefail

API_KEY="${BRAIN_API_KEY:-YOUR_API_KEY}"
BASE_URL="${BRAIN_BASE_URL:-https://your-worker-subdomain.workers.dev}"

SUMMARY=$(curl -sf --max-time 8 \
  -H "x-api-key: $API_KEY" \
  "$BASE_URL/api/session_start_summary" 2>/dev/null || echo "")

SESSION_IDX=$(curl -sf --max-time 8 \
  -H "x-api-key: $API_KEY" \
  "$BASE_URL/mcp" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_session_index","arguments":{"limit":5}}}' \
  2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  entries=json.loads(d.get('result',{}).get('content',[{}])[0].get('text','{}'))
  items=entries.get('entries',[])
  if items:
    print('Recent captures: '+', '.join(e.get('title','?') for e in items[:5]))
except Exception:
  pass
" 2>/dev/null || echo "")

printf '%s\n' '[second-brain] Second Brain memory layer active. Use session_context/query tools before meaningful work involving prior state. Persist durable outcomes without capturing trivial tool noise.'

if [ -n "$SUMMARY" ]; then
  LAST_FILES=$(printf '%s' "$SUMMARY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
files=d.get('last_session_files',[])[:5]
threads=d.get('open_threads',[])[:3]
decisions=d.get('recent_decisions',[])[:3]
if files: print('Last session ('+d.get('last_session_date','?')+'): '+', '.join(files))
if threads: print('Open threads: '+', '.join(threads))
if decisions: print('Recent decisions: '+', '.join(x.get('title','?') for x in decisions))
" 2>/dev/null || echo "")
  if [ -n "$LAST_FILES" ]; then
    printf '\n[second-brain] CONTEXT LOADED:\n%s\n' "$LAST_FILES"
  fi
fi

if [ -n "$SESSION_IDX" ]; then
  printf '[second-brain] %s\n' "$SESSION_IDX"
fi

if [ -z "$SUMMARY" ] && [ -z "$SESSION_IDX" ]; then
  printf '[second-brain] FIRST ACTION: call session_context; if unavailable, query_second_brain for recent sessions before relying on prior project state.\n'
fi
