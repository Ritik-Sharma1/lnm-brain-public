#!/usr/bin/env node
/**
 * v9 integration test: capture → verify all 4 retrieval methods find it within
 * same session. Hits the live worker (or a wrangler dev instance).
 *
 * Usage:
 *   API_KEY=... BASE=https://your-worker-subdomain.workers.dev node scripts/integration-test-v9.js
 *
 * Exits non-zero on any assertion failure. Prints a punch-list at the end.
 */

const BASE = process.env.BASE || "https://your-worker-subdomain.workers.dev";
const KEY  = process.env.API_KEY || process.env.LNM_BRAIN_KEY;
if (!KEY) { console.error("API_KEY env required"); process.exit(2); }

const HEADERS = { "Content-Type": "application/json", "x-api-key": KEY };

const failures = [];
function assert(cond, msg) { if (!cond) failures.push(msg); console.log(`${cond?"PASS":"FAIL"}  ${msg}`); }

async function call(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...HEADERS, ...(init.headers||{}) } });
  const txt = await r.text();
  try { return { status: r.status, body: JSON.parse(txt) }; }
  catch { return { status: r.status, body: txt }; }
}

async function callMcp(name, args) {
  const r = await fetch(`${BASE}/mcp?key=${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  const text = j?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text; }
}

(async () => {
  console.log(`\n=== v9 integration test ===\nBASE=${BASE}\n`);

  const stamp = Date.now();
  const title = `v9-integration-test-faceless-sales-copy-${stamp}`;
  const content = `# Niche ranking decision

🥇 Niche 1: Faceless Sales Copy — revenue engine
🥈 Niche 2: AI Avatar Hooks — top-of-funnel
🥉 Niche 3: Long-form Carousel — nurturing
❌ Niche 4: Local SEO — saturated
⏳ Niche 5: Notion Templates — waiting on signal

This is the AUTHORITATIVE verdict for Q3 2026. Niche 3 is the revenue engine.
Lyle and Brain Owner agreed: focus first on Faceless Sales Copy.`;

  // 1. capture via MCP ingest_to_second_brain
  const ingest = await callMcp("ingest_to_second_brain", {
    title, content,
    surface: "claude-ai-web",
    tags: ["AUTHORITATIVE", "verdict", "v9-integration-test"],
    entities: ["Niche 3", "Faceless Sales Copy", "Brain Owner"],
  });
  console.log("ingest →", JSON.stringify(ingest).slice(0, 400));
  assert(ingest?.observation_id, "ingest returns observation_id");
  assert(ingest?.surface === "claude-ai-web", "ingest preserves surface=claude-ai-web (Bug 1)");
  assert(ingest?.verified_retrievable === true || ingest?.verified_indexed === true, "ingest verifies retrievable on write (Bug 3)");

  const id = ingest.observation_id;

  // 2. get_observation immediately — Bug 2
  const obs = await callMcp("get_observation", { id });
  assert(obs && !obs.error, `get_observation(${id}) succeeds immediately (Bug 2)`);
  assert(obs?.surface === "claude-ai-web", "get_observation returns surface=claude-ai-web");

  // 3. list_recent({surface:"claude-ai-web"}) — Bug 1
  const lr = await callMcp("list_recent", { surface: "claude-ai-web", limit: 30 });
  const found = (lr?.results || []).some(r => r.id === id);
  assert(found, "list_recent({surface:'claude-ai-web'}) returns the ingest (Bug 1)");

  // 4. keyword_search (D1 FTS5 if bound, else GH fallback)
  const ks = await callMcp("keyword_search", { query: "Faceless Sales Copy", limit: 10 });
  const ksHit = (ks?.results || []).some(r => r.id === id || (r.path || "").includes(title));
  assert(ksHit, "keyword_search('Faceless Sales Copy') returns it");

  // 5. semantic_search — Bug 3 (Vectorize ack)
  const ss = await callMcp("semantic_search", { query: "Faceless Sales Copy revenue engine", top_k: 8 });
  const ssHit = (ss?.results || []).some(r => (r.title || "").includes("faceless") || (r.path || "").includes(title));
  assert(ssHit, "semantic_search hits within same session (Bug 3)");

  // 6. recall_brain — hybrid
  const recall = await callMcp("recall_brain", { query: "top 5 niche verdict", limit: 10 });
  const recallHit = (recall?.results || []).filter(r => r.id === id || (r.title || "").includes("faceless"));
  assert(recallHit.length > 0, "recall_brain finds verdict via hybrid recall");
  if (recallHit[0]) assert((recallHit[0].provenance || []).length >= 1, "recall_brain returns provenance (≥1 method matched)");

  // 7. query_triples — Phase 8
  const tr = await callMcp("query_triples", { entity: "Niche-3" });
  assert((tr?.total || 0) >= 1, "query_triples('Niche-3') returns ≥1 rank triple");

  // 8. session_context — Phase 10
  const ctx = await callMcp("session_context", {});
  assert(ctx && !ctx.error, "session_context returns payload");
  console.log("session_context payload bytes:", JSON.stringify(ctx).length);
  assert(JSON.stringify(ctx).length < 8000, "session_context payload <8 KB (target <3KB lenient)");

  console.log("\n=== summary ===");
  if (failures.length === 0) { console.log("ALL GREEN"); process.exit(0); }
  console.log(`${failures.length} FAIL:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
})();
