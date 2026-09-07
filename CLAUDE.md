# LNM Brain — Claude / Agent Memory Configuration v10.2.2

This is a reusable integration template. It must point to the current user's own private LNM Brain deployment; it must never contain another person's captured memory, credentials, or profile data.

## Before substantive work

1. Call `session_context()` at session start.
2. For work involving existing projects, preferences, prior decisions, or history, retrieve relevant Second Brain context before answering or acting.
3. Prefer the cheapest useful retrieval path:

```text
session_context
→ get_entity_facts / query_triples
→ keyword_search
→ recall_brain
→ query_second_brain / semantic_search
→ ask_second_brain
```

Stop once enough evidence is available.

## Capture rules

Persist durable outcomes such as:

- decisions and reasons;
- project-state changes;
- important code/architecture conclusions;
- research findings;
- preferences and instructions;
- troubleshooting outcomes worth remembering;
- blockers and next actions.

Skip pure greetings, acknowledgements, duplicate captures, and low-value tool noise.

Use `ingest_to_second_brain` for the full pipeline. Use `capture_to_second_brain` as a lighter fallback where appropriate.

## SESSION-HANDOFF

After a substantive session, write a compact handoff with:

```text
Surface: <surface>
Time: <time>
Topic: <topic>

## State
<where things stand>

## Decisions Made
- <decision> → <reason>

## Avoided Paths
- <rejected path> → <reason>

## Actions Taken
- <completed work>

## Key Insights
- <durable learning>

## Key Data & Variables
- <versions, IDs, URLs, thresholds>

## Next Actions
1. <next action>

## Open Questions / Blockers
- <blocker>

## Confidence Flags
- Confirmed: <verified>
- Assumed: <not verified>

## Trail
<recent related handoffs>
```

The handoff should let a cold agent recover most of the working state quickly without loading raw history.

## Runtime MCP interface

The v10.2.2 reference worker registers **27 MCP tools**. The worker's `tools/list` response is authoritative:

`query_second_brain`, `get_entity_facts`, `ask_second_brain`, `semantic_search`, `capture_to_second_brain`, `ingest_to_second_brain`, `get_latest_handoff`, `list_recent`, `get_handoffs`, `get_home_feed`, `lint_second_brain`, `read_second_brain_file`, `get_second_brain_graph`, `write_second_brain_file`, `query_triples`, `get_top_entities`, `find_entity_path`, `get_session_index`, `get_observation`, `get_about_me`, `get_self`, `refresh_about_me`, `get_routing_index`, `keyword_search`, `recall_brain`, `session_context`, `forget`.

## Owner/self-model rules

The public source uses a generic owner concept. A private deployment should learn the real user from that user's own captures.

Never hard-code into a public template:

- a person's real name;
- medical or health details;
- address/location details;
- private projects or clients;
- personal writing/style rules;
- account identifiers;
- API keys or tokens.

Identity, preference, instruction, and behavioral facts may be pinned in the private deployment so important long-lived memory is not evicted by recent noise.

## Correction

Use `forget` to retract stale or incorrect facts, triples, or observations through soft supersession. Preserve audit history rather than silently destroying it.

## MCP connector placeholder

```text
https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY
```

## REST fallback placeholders

Base URL: `https://your-worker-subdomain.workers.dev`  
Auth header: `x-api-key: YOUR_API_KEY`

Common endpoints include `/ingest`, `/capture`, `/ask`, `/query`, `/search`, `/recall`, `/keyword-search`, `/session-start`, `/graph`, `/file`, `/write`, `/lint`, and `/health`.

## Security

- Use a private GitHub repository for the user's actual knowledge base.
- Store secrets in Cloudflare/host secret storage, never in committed files.
- Create independent KV, D1, Vectorize, Worker, and API credentials for each user.
- Do not copy credentials or captured knowledge from an example deployment.

## Version discipline

Target reference version: **10.2.2**. Keep `worker/package.json`, worker source header, `/health`, README, and agent docs aligned. Do not infer a newer version from stale prose.
