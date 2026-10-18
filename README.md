# LNM Brain v10.2.3

**A self-hosted, persistent Second Brain for AI agents, coding assistants, and chat tools.**

LNM Brain gives AI systems durable memory across sessions and platforms without forcing them to reread raw conversation history. It captures conversations and artifacts, compresses them into structured knowledge, extracts facts and graph relationships, indexes them across multiple retrieval systems, and exposes the result through REST + MCP.

This public template is derived from the worker behind the author's own Second Brain, with personal data, credentials, and private infrastructure identifiers removed.

**→ To install it, follow [INSTALL.md](INSTALL.md)** (or paste the one-prompt installer from it into Claude Code).

> **Current release:** v10.2.3  
> **Runtime:** Cloudflare Workers  
> **Primary storage:** your own GitHub repository  
> **Retrieval:** KV + D1 FTS5 + Vectorize + entity facts + triples + graph traversal  
> **Agent interface:** MCP + REST  
> **Data model:** raw observations + compressed wiki + entities + projects + graph + session state

---

## What Problem It Solves

AI assistants normally lose continuity in four ways:

1. **Session amnesia** — a new chat starts without the decisions and context from the previous one.
2. **Tool fragmentation** — ChatGPT, Claude, Codex, IDE agents, and other assistants do not automatically share memory.
3. **Context-window waste** — repeatedly feeding full transcripts is expensive, slow, and noisy.
4. **Weak correction** — append-only memory can preserve incorrect facts forever unless the system has explicit supersession and forgetting semantics.

LNM Brain addresses all four by maintaining an external, user-owned memory layer that agents query before acting and update after meaningful work.

---

## Architecture

```text
AI client / agent
      │
      ├──────── session start ────────▶ session_context()
      │
      ├──────── recall ───────────────▶ KV facts / triples
      │                                D1 FTS5
      │                                Vectorize
      │                                graph paths
      │                                RRF fusion + recency
      │
      └──────── capture ──────────────▶ /ingest
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
       GitHub raw record          compressed wiki           observation state
       immutable source           structured memory          KV session indexes
              │                          │                          │
              ├──────────────┬───────────┴───────────┬──────────────┤
              ▼              ▼                       ▼              ▼
          D1 FTS5       Vectorize vectors       entity facts      triples
       exact/keyword    title/content/summary   categorized       provenance-aware
              │              │                       │              │
              └──────────────┴──────── RRF / graph fusion ─────────┘
                                      │
                                      ▼
                              top-K memory context
```

### Memory layers

| Layer | Purpose |
|---|---|
| `raw/` | Immutable source observations and conversations |
| `wiki/` | Compressed, structured, Obsidian-compatible knowledge |
| `wiki/entities/` | Durable people/tool/company facts |
| `wiki/projects/` | First-class project memory with status and metadata |
| `wiki/profile/` | Synthesized self-model and writing/voice profile |
| `graph/` | Knowledge-graph representation and relationships |
| Cloudflare KV | Fast session state, observations, facts, triples, routing indexes |
| D1 FTS5 | Low-latency keyword retrieval |
| Vectorize | Semantic retrieval using multiple vectors per observation |

---

## What v10 Added Beyond the v9 Hybrid-Retrieval Design

### v10.0.x — Projects, provenance, clustering, graph intelligence

- First-class `project` memory type with `wiki/projects/{slug}.md`.
- Project metadata such as status, stack, repository URL, deployment URL, and project ID.
- Semantic cluster merging in addition to entity-overlap clustering.
- Entity centrality / "god-node" ranking for highly connected concepts.
- Triple provenance with derivation metadata and source observation IDs.
- Extraction timeout budgeting so dead or slow LLM tiers cannot stall the ingest pipeline indefinitely.

### v10.1.x — Graphify-style navigation + lower latency

- `get_top_entities` for centrality-ranked entity discovery.
- `find_entity_path` for shortest-path traversal through the entity/triple graph.
- Parallelized hot KV reads.
- Derivation-aware triple querying.

### v10.2.x — Durable self-model + correction

- Pinned identity, preference, instruction, and behavioral facts that do not silently disappear as indexes grow.
- Behavioral inference: learns durable patterns about how the user builds, decides, writes, communicates, and works.
- Writing-voice profile generated from the user's own captured writing.
- Softer recency weighting so older-but-important memories can resurface.
- `forget` MCP tool: soft-retracts a fact, triple, or observation without destroying audit history.
- Chunked-parallel observation reads for significantly lower wall-clock latency on hot paths.

---

## Retrieval Strategy

Use the cheapest useful memory source first and stop once sufficient context is found:

```text
session_context()
  ↓
get_entity_facts / query_triples
  ↓
keyword_search
  ↓
recall_brain
  ↓
query_second_brain / semantic_search
  ↓
ask_second_brain
```

### Hybrid recall

`recall_brain` combines multiple retrieval channels through reciprocal-rank fusion:

- semantic similarity from Vectorize;
- keyword relevance from D1 FTS5;
- entity facts;
- structured triples;
- recency weighting;
- provenance so the caller can understand where a memory came from.

This avoids depending on one retrieval mechanism and reduces the common "captured but unfindable" failure mode.

---

## Capture Pipeline

A normal ingest should create or update multiple representations of the same knowledge:

1. Store an immutable raw observation.
2. Create a compressed wiki representation.
3. Update session/recent indexes synchronously.
4. Index searchable text into D1 FTS5.
5. Create multiple semantic vectors (title, content, summary, entities).
6. Extract durable entity facts.
7. Extract subject-predicate-object triples with provenance.
8. Update graph and routing metadata.
9. Preserve important verdict/ranking blocks verbatim when required.
10. Run slower enrichment or consolidation work asynchronously where safe.

The goal is not merely to save text. The goal is to convert lived history into retrievable, structured memory.

---

## Session Continuity

Every connected agent should follow two rules.

### At session start

Call `session_context()` first. It returns a compact bootstrap containing the latest handoff, open threads, active topics, and recent decisions/verdicts.

### At session end

Persist both:

1. a concise conversation/observation capture; and
2. a rich `SESSION-HANDOFF` containing state, decisions, avoided paths, actions taken, important variables, next actions, blockers, and confidence flags.

A cold agent should be able to read the latest handoff and recover most of the working context in seconds.

---

## MCP

Deploying the worker exposes an MCP endpoint at `<worker-url>/mcp`. Every call must carry your
`API_KEY`: as an `X-API-Key` header (Claude Code, Claude app request headers), an
`Authorization: Bearer` header, or, when a client can't send headers, as `?key=<your-API-key>`
in the URL. A URL that contains the key is a password. Setup for each client is in
[INSTALL.md](INSTALL.md#step-9-connect-claude-code).

The v10.2.3 worker exposes 27 MCP tools. Important categories include:

- session/context retrieval;
- entity facts and structured triples;
- FTS5 keyword search;
- semantic and hybrid recall;
- graph/entity navigation;
- capture and full ingest;
- file/graph inspection;
- self-model refresh;
- health/lint operations;
- soft correction through `forget`.

Do not hard-code the tool count in downstream installers without validating it against the deployed worker's MCP manifest; the worker is the source of truth.

---

## Repository Layout

```text
raw/
  conversations/
  code/
  assets/
  web/

wiki/
  conversations/
  entities/
  projects/
  topics/
  synthesis/
  questions/
  sources/
  profile/
  _indexes/

graph/
scripts/
worker/
  src/
web/
AGENTS.md
CLAUDE.md
PLATFORM_INTEGRATION.md
KARPATHY_INTEGRATION.md
```

The public template intentionally does **not** ship another person's private raw conversations, wiki, graph, API keys, or account identifiers. A user's own knowledge base is generated after deployment.

---

## Cloudflare Components

A full deployment can use:

- **Workers** — API + MCP runtime;
- **KV** — fast state, facts, triples, session indexes, aliases;
- **D1** — FTS5 keyword retrieval and structured indexes;
- **Vectorize** — semantic memory search;
- **Workers AI** — optional inference/embedding fallback;
- **Cron Triggers** — compression, consolidation, maintenance, and index generation.

The worker is designed to degrade gracefully where possible—for example, falling back from D1-backed keyword retrieval when an optional binding is unavailable.

---

## Install

Follow **[INSTALL.md](INSTALL.md)**. It covers prerequisites, the private data repo, the
GitHub token, the Cloudflare resources, secrets, deploy, health checks, connecting Claude Code
and the Claude app (web, desktop, phone), the auto-memory hooks, and troubleshooting. It also
has a copy-paste prompt that lets Claude Code do the install for you.

**Cost:** Cloudflare Workers Paid ($5/month) is recommended. The Free plan can run a small
brain but hits its KV-write, Vectorize-storage and CPU limits as the brain grows; see
[INSTALL.md → Cost](INSTALL.md#cost-free-vs-paid).

After installing, adapt `AGENTS.md` / `CLAUDE.md` so your agents:

- retrieve context before substantive work;
- capture important work automatically;
- create rich session handoffs;
- use the cheapest retrieval path first;
- never expose secrets in committed files;
- use `forget`/supersession rather than destructive deletion for memory corrections.

---

## Maintenance

A durable Second Brain needs maintenance, not just ingestion.

Recommended recurring operations:

- health/lint checks;
- orphan and index repair;
- monthly navigation indexes;
- fact consolidation and contradiction handling;
- behavioral/self-model refresh;
- voice-profile refresh after enough new writing accumulates;
- graph/centrality recomputation;
- periodic retrieval-quality tests;
- backup through Git history;
- version bumps only when the deployed worker and docs agree.

Treat `worker/package.json`, the worker source header, `/health`, `AGENTS.md`, and release commits as the authoritative version chain. README prose may lag if it is not deliberately maintained.

---

## Security Model

- Auth fails closed: if the `API_KEY` secret is missing, a placeholder, or shorter than 16 characters, every memory route (including `/mcp`) answers `503` instead of opening up.
- The API key grants full read/write access to the memory. Treat it, and any connector URL containing `?key=`, as a password.
- Keep the user's memory/data repository private, and scope the GitHub token to that one repository (Contents: read and write).
- Keep `API_KEY`, `ADMIN_KEY`, GitHub tokens, model-provider keys, and Cloudflare credentials in secret stores only (`wrangler secret put`).
- Telegram capture is off unless configured, and only accepts the webhook secret and your own chat id.
- Never copy another user's API keys or account identifiers from an example deployment.
- Prefer soft retraction (`forget`) over hard deletion so corrections remain auditable.
- Separate the public architecture repository from private captured memory.
- Review public forks before pushing to ensure no raw conversations or generated personal profiles are included.

---

## Public Template vs Personal Instance

`lnm-brain-public` is the reusable architecture. A personal instance adds:

- the user's own private GitHub knowledge repository;
- their own Cloudflare Worker/KV/D1/Vectorize resources;
- their own API credentials;
- their own anchor/self entities;
- their own generated wiki, graph, facts, projects, behavioral model, and voice profile;
- platform-specific MCP configuration.

The architecture should be cloned; the identity and data should not.

---

## Documentation

- **`AGENTS.md`** — agent behavior, recall hierarchy, capture rules, session handoffs.
- **`CLAUDE.md`** — Claude-oriented integration instructions.
- **`PLATFORM_INTEGRATION.md`** — platform-specific connection guidance.
- **`KARPATHY_INTEGRATION.md`** — LLM-Wiki / memory-design background.
- **`worker/src/index.js`** — authoritative runtime behavior and version history.
- **`worker/src/self-model.js`** — pinned identity, behavioral inference, and voice-profile logic.

---

## Version

**Current architecture: v10.2.3**

Major line:

```text
v9      hybrid retrieval + synchronous retrievability
v10.0   projects + semantic clustering + centrality + triple provenance
v10.1   entity-path navigation + latency improvements
v10.2   durable self-model + behavioral inference + voice profile + correction
v10.2.2 forget tool + chunked-parallel observation reads
v10.2.3 fail-closed auth on every memory route + install guide
```

---

## License

MIT — see `LICENSE`.

Contributions that improve portability, self-hosting, retrieval quality, documentation, or agent integration are welcome.
