# LNM Brain — Agent Configuration v10.2.2

This file is a reusable agent contract for an independently deployed LNM Brain. Replace all deployment placeholders with the user's own private infrastructure.

Worker version: **10.2.2**  
MCP tools: **27 registered runtime tools**  
MCP URL: `https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY`

## Session start

Call `session_context()` first. It returns a compact bootstrap containing the latest handoff, open threads, active topics, and recent important decisions.

If MCP is unavailable, use the deployment's authenticated `/session-start` REST endpoint as a fallback.

## Recall hierarchy

Use the cheapest useful retrieval path and stop when enough context is available:

```text
session_context()
  → get_entity_facts / query_triples
  → keyword_search
  → recall_brain
  → query_second_brain / semantic_search
  → ask_second_brain
```

## All 27 MCP tools

The deployed worker's `tools/list` response is the source of truth.

1. `query_second_brain`
2. `get_entity_facts`
3. `ask_second_brain`
4. `semantic_search`
5. `capture_to_second_brain`
6. `ingest_to_second_brain`
7. `get_latest_handoff`
8. `list_recent`
9. `get_handoffs`
10. `get_home_feed`
11. `lint_second_brain`
12. `read_second_brain_file`
13. `get_second_brain_graph`
14. `write_second_brain_file`
15. `query_triples`
16. `get_top_entities`
17. `find_entity_path`
18. `get_session_index`
19. `get_observation`
20. `get_about_me`
21. `get_self`
22. `refresh_about_me`
23. `get_routing_index`
24. `keyword_search`
25. `recall_brain`
26. `session_context`
27. `forget`

## Capture policy

Capture durable information, not tool noise. Good captures include decisions, project-state changes, architecture, research findings, preferences, instructions, important troubleshooting results, blockers, and next actions.

Skip greetings, acknowledgements, repetitive shell/tool output, duplicate captures, and ephemeral details with no future value.

For a substantive session, persist:

1. a concise conversation/observation capture; and
2. a rich `SESSION-HANDOFF`.

Suggested handoff structure:

```text
Surface: <surface>
Time: <time>
Topic: <topic>

## State
<where things stand>

## Decisions Made
- <decision> → <reason>

## Avoided Paths
- <rejected option> → <reason>

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
- Assumed: <not yet verified>

## Trail
<recent related handoffs>
```

The goal is for a cold agent to recover most working context within seconds.

## Self-model

The owner identity is **deployment-specific**. Do not hard-code a person's name, projects, medical information, location, writing preferences, or other personal profile data into the reusable public source.

A personal deployment should initialize an owner entity such as `Brain Owner`, then learn the actual user's identity/preferences from that user's private memory store.

Pinned categories such as identity, preference, instruction, and behavioral memory should survive normal index caps and recency decay.

## Correction

Use `forget` for stale or incorrect memory. It performs soft retraction/supersession rather than destroying audit history.

## Security

- Never commit real API keys, GitHub tokens, Cloudflare IDs, model-provider credentials, or personal captured memory to a public template.
- Use the user's own private GitHub data repository.
- Store credentials with Cloudflare secrets or the relevant secret manager.
- Treat `YOUR_API_KEY`, `your-username/your-repo`, and `your-worker-subdomain` as placeholders only.

## Repo and worker placeholders

```text
GitHub data repo: your-username/your-private-brain-repo
Worker: https://your-worker-subdomain.workers.dev
MCP: https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY
Version: 10.2.2
```

## Maintenance

Run periodic lint/orphan repair, compression, consolidation, monthly index generation, graph refresh, self-model refresh, and retrieval-quality checks. A successful ingest that cannot immediately be found through the expected retrieval paths should be treated as a failure.
