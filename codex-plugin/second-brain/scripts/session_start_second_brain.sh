#!/usr/bin/env bash
# SessionStart: load a compact Second Brain bootstrap (latest handoff, open threads, recent captures).
# Reads BRAIN_BASE_URL + BRAIN_API_KEY from ~/.config/lnm-brain/config (written by setup-global-hooks.sh).
set -uo pipefail

CONFIG="${LNM_BRAIN_CONFIG:-$HOME/.config/lnm-brain/config}"
[ -f "$CONFIG" ] && . "$CONFIG"
if [ -z "${BRAIN_API_KEY:-}" ] || [ -z "${BRAIN_BASE_URL:-}" ]; then
  printf '[second-brain] Not configured: run scripts/setup-global-hooks.sh from your lnm-brain-public clone.\n'
  exit 0
fi

SUMMARY=$(curl -sf --max-time 8 \
  -H "X-API-Key: $BRAIN_API_KEY" \
  "$BRAIN_BASE_URL/api/session_start_summary" 2>/dev/null || echo "")

SESSION_IDX=$(curl -sf --max-time 8 \
  -H "X-API-Key: $BRAIN_API_KEY" \
  "$BRAIN_BASE_URL/mcp" \
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
if files: print('Last session ('+str(d.get('last_session_date','?'))+'): '+', '.join(files))
if threads: print('Open threads: '+', '.join(str(t) for t in threads))
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
