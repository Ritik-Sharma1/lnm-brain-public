# Second Brain Codex Plugin

This folder now contains an **actual Codex auto-layer bundle** for the Lnm-Brain Second Brain, plus the earlier transport reference file.

The bundle is intentionally isolated under `codex-plugin/second-brain/`. It does **not** modify the repository root's `AGENTS.md`, `CLAUDE.md`, or any existing tool integrations, so it will not disturb the repo's other connections.

## What Is In Here

- `.codex-plugin/plugin.json` — the real Codex plugin manifest
- `hooks.json` — lightweight auto-layer hooks
- `skills/second-brain-auto/SKILL.md` — default instruction layer for meaningful tasks
- `scripts/*.sh` — hook messages that nudge Codex to use the brain at the right moments
- `manifest.json` — companion transport and behavior reference file kept from the earlier draft
- `README.md` — install and behavior notes

## Auto Layer Strategy

The auto layer is designed to be **safe** and **non-disruptive**.

Instead of forcing raw network shell calls from hooks, it nudges Codex to use the already-registered Second Brain MCP tools:

- `SessionStart` hook:
  - reminds Codex that the Second Brain memory layer is active for the session
- `UserPromptSubmit` hook:
  - nudges Codex to call `query_second_brain` before meaningful work
- `PostToolUse` hook:
  - nudges Codex to call `ingest_to_second_brain` once after meaningful progress
- `second-brain-auto` skill:
  - reinforces the same behavior as a reusable instruction layer

This keeps the repo-side layer isolated and avoids interfering with other repo tooling.

## Important Design Choice

This plugin bundle **does not register another MCP server inside the plugin itself**.

That is intentional. Your Second Brain MCP server is better added once at the global Codex level:

```bash
codex mcp add second-brain --url "https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY"
```

By keeping MCP registration global and the auto layer separate, we avoid duplicate tool registrations or collisions with existing tool connections.

## What It Does

- Before meaningful tasks:
  - nudges Codex to query the Second Brain with the main topic
  - use compressed wiki results as primary context
  - fall back to `semantic_search` when keyword retrieval is thin
- After meaningful tasks:
  - nudges Codex to ingest durable outputs back into the brain once per meaningful turn
  - store `title`, `content`, `type`, `tags`, and `entities`
- Expects these 8 MCP tools to already exist globally:
  - `query_second_brain`
  - `semantic_search`
  - `capture_to_second_brain`
  - `ingest_to_second_brain`
  - `lint_second_brain`
  - `read_second_brain_file`
  - `get_second_brain_graph`
  - `write_second_brain_file`

## Install Flow

1. Register the global Second Brain MCP server in Codex.
2. Install or mirror this folder as a Codex plugin bundle.
3. Restart Codex.
4. Verify that:
   - the `second-brain` MCP tools are available
   - the plugin bundle loads
   - the hook nudges appear on session start, prompt submit, and after meaningful tool use

## Behavior Notes

- The hooks are **nudges**, not hard blockers.
- Trivial prompts such as greetings or one-off ephemeral lookups should skip query and ingest.
- Ingest should happen once near the end of a meaningful turn, not after every tiny action.
- If fresher repo or web truth conflicts with stored brain context, Codex should say so and use the fresher source.

## Connection Details

- Base URL: `https://your-worker-subdomain.workers.dev`
- MCP URL: `https://your-worker-subdomain.workers.dev/mcp?key=YOUR_API_KEY`
- Auth header: `x-api-key: YOUR_API_KEY`
- Query fallback auth: `?key=YOUR_API_KEY`

## Why This Does Not Disturb Other Repo Connections

- No root repo instruction files were changed.
- No existing platform integration docs were edited.
- No duplicate MCP registration is forced by the plugin bundle.
- The entire Codex auto layer lives in one isolated subfolder.


## Backlinks
[[index]]
