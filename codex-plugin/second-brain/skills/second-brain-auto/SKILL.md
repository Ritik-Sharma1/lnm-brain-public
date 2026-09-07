---
name: second-brain-auto
description: Default Second Brain memory layer for Codex. Use on every meaningful task unless the user explicitly asks not to use Second Brain. Query before planning, coding, researching, writing, debugging, or answering; ingest after meaningful outcomes.
metadata:
  priority: 1
  pathPatterns: []
  bashPatterns: []
  promptSignals:
    phrases:
      - "build"
      - "fix"
      - "debug"
      - "implement"
      - "write"
      - "research"
      - "analyze"
      - "plan"
      - "review"
      - "summarize"
      - "explain"
      - "refactor"
      - "investigate"
      - "design"
      - "document"
      - "create"
---

# Second Brain Auto Layer

Use this skill as the default memory layer for meaningful Codex work when the `second-brain` MCP tools are available.

This plugin is intentionally isolated. It does not change the repository root's `AGENTS.md`, `CLAUDE.md`, or other tool integrations.

## Default behavior

1. Before meaningful work, identify the main topic and call `query_second_brain`.
2. If keyword retrieval is thin, ambiguous, or concept-heavy, call `semantic_search`.
3. Use the returned wiki pages as primary context.
4. If fresher repo state or web facts conflict with the brain, say so explicitly and prefer the fresher source.
5. Near the end of a meaningful task, call `ingest_to_second_brain` once with a short title, durable content, `type: "conversation"`, tags, and entities.
6. Use `capture_to_second_brain` only for quick save cases where a full ingest is unnecessary.

## Skip conditions

Skip Second Brain calls when any of the following are true:

- the user is only greeting, acknowledging, or making small talk
- the request is a trivial ephemeral lookup with no durable value
- the user explicitly asks not to use the Second Brain for the task
- a duplicate ingest would add noise without new durable information

## Query heuristics

- Use short topic phrases, not the entire user prompt.
- Prefer project names, bug names, feature names, repo names, and concrete entities.
- Start with one focused query, then broaden only if needed.
- Prefer compressed wiki context over re-reading raw history.

## Ingest heuristics

- `title`: short slug-like task summary
- `content`: durable decisions, outputs, constraints, code changes, findings, and open questions
- `type`: `conversation`
- `tags`: 2 to 6 stable tags
- `entities`: people, tools, projects, files, or components that matter later
- Ingest once near the end of the meaningful turn, not after every tiny action

## Required tools

This skill assumes these MCP tools are already available globally:

- `query_second_brain`
- `semantic_search`
- `ingest_to_second_brain`
- `capture_to_second_brain`
- `read_second_brain_file`
- `get_second_brain_graph`
- `write_second_brain_file`
- `lint_second_brain`

If they are unavailable, add the global MCP server first and then continue.


## Backlinks
[[index]]
