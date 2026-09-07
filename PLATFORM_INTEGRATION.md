# Platform Integration Guide — Lnm-Brain Second Brain v9.9.0

MCP URL: `https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY`
REST Base: `https://your-worker-subdomain.workers.dev`
API Key: `YOUR_API_KEY`
Tools: **23** | Worker v9.9.0 | Cloudflare Workers + GitHub (your-username/your-repo) + Vectorize (lnm-brain-m3, 1024-dim BGE-M3) + KV + D1 FTS5

---

## SESSION-HANDOFF — Rich Template (ALL surfaces)

Every substantive session ends with TWO captures:
1. `capture_to_second_brain(type="conversation", ...)` — the exchange
2. SESSION-HANDOFF note — **RICH 10-section template:**

```
content:
  Surface: <surface>
  Time: <IST>
  Topic: <topic>

  ## State
  <1-2 sent — where things stand>

  ## Decisions Made
  - <decision> → reason: <why>

  ## Avoided Paths
  - NOT <X> → reason: <why rejected>

  ## Actions Taken
  - <concrete done/built/confirmed>

  ## Key Insights
  - <non-obvious learning a cold AI wouldn't know>

  ## Key Data & Variables
  - <numbers, IDs, versions, URLs, thresholds>

  ## Next Actions (priority order)
  1. <first specific action>
  2. <second>

  ## Open Questions / Blockers
  - <unresolved items>

  ## Confidence Flags
  - Confirmed ✅: <verified working>
  - Assumed ⚠️: <believed but untested>

  ## Trail
  <last 3 handoff slugs>

top-level params: topic=, state=, next_action=, trail=[]
entities=["SESSION-HANDOFF","Brain Owner","<surface>"]
tags=["session-handoff","<surface>","continuity"]
surface="<surface>"
```

**Goal:** cold AI reads handoff → 80% context in 30 seconds. Include decisions WITH reasoning, avoided paths, confidence flags. Not just "where we stopped" — what we know.

---

## 1. Claude Code

**Status: ✅ MCP wired via `~/.claude/.mcp.json` + instructions in `~/.claude/CLAUDE.md`**

`~/.claude/CLAUDE.md` holds full instructions (23 tools, rich handoff template, token economy, surface rules).
`~/.claude/docs/second-brain.md` holds full capture templates.

No manual setup needed for Claude Code sessions. Already reads v9.9.0 instructions.

**When working on OTHER projects (not Lnm-Brain repo),** add to their CLAUDE.md:
```markdown
## Second Brain
MCP connected: https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY
Session start: session_context() FIRST. End: capture exchange + rich SESSION-HANDOFF (surface="claude-code").
Full instructions: ~/.claude/CLAUDE.md
```

---

## 2. Claude Cowork

**Status: ✅ Paste block below into Cowork → Workspace Settings → General Instructions**

```
SECOND BRAIN MCP — v9.9.0, 23 tools, connector URL: https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY

This workspace is wired to Brain Owner's personal Second Brain. Treat it as persistent memory.

EVERY new conversation:
1. Call session_context() FIRST (single KV read, <3 KB)
2. If insufficient: get_latest_handoff() → get_home_feed() → get_routing_index(surface="cowork")
3. Display 3-line summary: (a) last surface, (b) last topic, (c) next action
4. Proceed

EVERY substantive exchange ends with TWO captures (surface="cowork"):
1. capture_to_second_brain(type="conversation", title="YYYY-MM-DD-HH-MM-slug", content=<exchange + decisions + files>, entities=["Claude Cowork","<topic>","cowork"], tags=["cowork","auto-captured"], surface="cowork")
2. SESSION-HANDOFF rich template (type="note", title="SESSION-HANDOFF — <topic> — cowork"):
   content sections: State / Decisions Made (+reasoning) / Avoided Paths (+reasoning) /
   Actions Taken / Key Insights / Key Data & Variables / Next Actions (ordered) /
   Open Questions / Confidence Flags (✅confirmed/⚠️assumed) / Trail
   Params: topic=, state=, next_action=, trail=[]
   entities=["SESSION-HANDOFF","Brain Owner","cowork"], tags=["session-handoff","cowork","continuity"], surface="cowork"
   GOAL: cold Claude reads handoff → 80% context in 30 seconds.

RECALL HIERARCHY (cheapest first):
session_context → get_entity_facts/query_triples (KV, free) → keyword_search (D1 FTS5) → recall_brain (RRF hybrid) → query_second_brain(fast=true) → query_second_brain(fast=false) → ask_second_brain

GUARDRAILS:
- query_second_brain default fast=true. Set fast=false only if fast returned nothing.
- Surface MANDATORY on every capture. Use "cowork".
- Destructive actions: ASK FIRST.
- ALWAYS pass wiki_body on capture (worker stores verbatim, skips weak external LLM).

TONE: drop pleasantries. Open with answer. Match Brain Owner's energy. Separate facts | plausible | speculative.
WEB: firecrawl_* MCP only. Built-in web_search/web_fetch prohibited.
NUMEROLOGY: avoid visible numbers (version labels, headlines) whose digit-sum is 4 or 8.
```

---

## 3. Claude (claude.ai web + mobile)

**Status: ✅ MCP Custom Connector + User Preferences**

Connector URL (add in Settings → Connectors):
`https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY`
Expected: **23 tools**.

**User Preferences paste block (Settings → Personalization):**
```
SECOND BRAIN — 23 tools, worker v9.9.0, Cloudflare + GitHub + Vectorize (lnm-brain-m3, 1024-dim BGE-M3) + KV + D1 FTS5.
MCP: https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY

EVERY message: query BEFORE, capture AFTER. Start: session_context() FIRST.
Recall: recall_brain() → miss → query_second_brain(fast=false).
Known entity: get_entity_facts + query_triples (KV, instant).

23 TOOLS — KV (instant): session_context, get_latest_handoff, get_home_feed, get_routing_index, get_entity_facts, query_triples, list_recent, get_handoffs, get_session_index, get_observation, read_second_brain_file | FTS5: keyword_search, recall_brain | Semantic/LLM: query_second_brain, semantic_search, ask_second_brain, get_second_brain_graph | Writes: capture_to_second_brain, ingest_to_second_brain, write_second_brain_file, lint_second_brain | Self-model: get_about_me, refresh_about_me

SESSION END — capture exchange + RICH SESSION-HANDOFF (surface="claude-ai-web"):
10 sections: State / Decisions Made (+reasoning) / Avoided Paths / Actions Taken /
Key Insights / Key Data & Variables / Next Actions (ordered) / Open Questions /
Confidence Flags (✅confirmed/⚠️assumed) / Trail.
Goal: cold Claude reads handoff → 80% context in 30s.
ALWAYS pass wiki_body (stored verbatim, skips weak external model).

WEB: firecrawl_* MCP only. Built-in web_search/web_fetch prohibited.
MECE: every strategic question decomposed MECE — name the avoided branch.
NUMEROLOGY: no visible number with digit-sum 4 or 8 (versions/counts/KPIs).
```

---

## 4. Hermes

**Status: ✅ MCP wired + SOUL.md at `~/.hermes/SOUL.md`**

SOUL.md holds full operating doctrine including Second Brain Memory Contract, rich SESSION-HANDOFF template (10 sections), v9.9.0 schema, token discipline, sovereignty rules.

SESSION-HANDOFF from Hermes: use `surface="hermes"` in both tags and entities.

Hermes /ui dashboard: `https://your-worker-subdomain.workers.dev/ui`

---

## 5. Google AntiGravity

**Status: ⚙️ REST + instructions via AntiGravity config**

**AntiGravity system instructions (paste in config):**
```
SECOND BRAIN — Brain Owner's persistent memory. Worker v9.9.0, 23 MCP tools.
MCP: https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY

SESSION START: call session_context() FIRST. Returns latest handoff + open threads + active topics.
If topic unclear: recall_brain("<topic>") → query_second_brain("<topic>") if miss.
Known entity: get_entity_facts + query_triples (KV, instant, no LLM).

SESSION END — capture RICH SESSION-HANDOFF (surface="google-antigravity"):
10 sections in content: State / Decisions Made (+reasoning) / Avoided Paths (+reasoning) /
Actions Taken / Key Insights / Key Data & Variables / Next Actions (ordered) /
Open Questions / Confidence Flags / Trail.
Pass: topic=, state=, next_action=, trail=[]
entities=["SESSION-HANDOFF","Brain Owner","google-antigravity"]
tags=["session-handoff","google-antigravity","continuity"]
ALWAYS pass wiki_body (stored verbatim).
Goal: cold AI reads handoff → 80% context in 30s.

WEB: firecrawl_* only. NUMEROLOGY: no visible digit-sum-4 or digit-sum-8.
```

---

## 6. ChatGPT

**Status: ⚙️ REST only — no MCP support**

**ChatGPT Custom Instructions:**
```
Second Brain at https://your-worker-subdomain.workers.dev (v9.9.0)
Key: YOUR_API_KEY
Session start: GET /session-start?key=KEY → shows last handoff + open threads.
Recall: GET /recall?q=TOPIC&limit=5&key=KEY (hybrid RRF search).
Capture: POST /capture {title, content, type, tags, entities, surface="chatgpt-go", wiki_body}
Session end: POST /capture with SESSION-HANDOFF (10-section rich template, surface="chatgpt-go").
```

---

## 7. OpenCode / Codex / AGENTS.md readers

**Status: ✅ AGENTS.md in repo root**

AGENTS.md in `your-username/your-repo` root — auto-read by OpenCode, Codex, and any agent that reads AGENTS.md. Updated to v9.9.0 + rich handoff template.

---

## Reconnect Checklist (after worker deploy)

1. claude.ai web: Settings → Connectors → Second Brain → Disconnect → Add same URL → expect **23 tools** → hard-reload (Cmd+Shift+R)
2. Cowork: Workspace Settings → Integrations → same URL → reconnect → paste General Instructions block
3. Claude Code: no action — reads live worker each session
4. Hermes: `hermes mcp list` to verify second-brain shows 23 tools
5. Claude mobile: Settings → Connected apps → reconnect same URL

---

## Quick Test

```bash
KEY="YOUR_API_KEY"

# Health + version
curl -s "https://your-worker-subdomain.workers.dev/health?key=$KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('version:', d['version'], '| kv:', d['kv_status'])"
# Expect: version: 9.9.0

# Tool count
curl -s -X POST "https://your-worker-subdomain.workers.dev/mcp?key=$KEY" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('tools:', len(d['result']['tools']))"
# Expect: tools: 23

# Capture timing (should be <10s now)
time curl -s -X POST "https://your-worker-subdomain.workers.dev/capture?key=$KEY" \
  -H "content-type: application/json" \
  -d '{"title":"test-capture","content":"timing test","type":"note","surface":"claude-code","entities":["SESSION-HANDOFF","claude-code"],"tags":["session-handoff","claude-code"],"wiki_body":"test"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('latency:', d['retrieval_latency_ms'], 'ms')"
```


## Backlinks
[[index]]
