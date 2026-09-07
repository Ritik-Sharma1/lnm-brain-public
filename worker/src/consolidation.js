/**
 * U6 — Sleep-time consolidation.
 *
 * Two jobs added to handleCron, gated by IST hour:
 *
 *   - nightly at 3am IST  (UTC 21:30): cluster + distill + conflict-resolve
 *   - weekly  at 3am IST Sunday      : lint + belief review + weekly summary + eval
 *
 * Both are budget-aware: skip if neuron usage > 80% of daily cap, KV writes > 80%
 * of paid-tier cap. They log skipped runs to state:cron-skips for visibility.
 *
 * Wire by adding two calls in handleCron after the existing 6h heavy block:
 *
 *   if (isISTHour(now, 3)) await runNightlyConsolidation(env, ctx, callRoleLLM);
 *   if (isISTDayHour(now, 0, 3)) await runWeeklyConsolidation(env, ctx, callRoleLLM);
 *
 * Both rely on helpers already in index.js: readObservation, embedAndStore,
 * extractAndStoreFactsFromContent, getEntityFacts, updateRoutingIndex,
 * canAfford, getKVWriteCount, callRoleLLM.
 */

const NEURON_BUDGET_RATIO = 0.8;  // skip if usage >= 80% of daily cap
const KV_BUDGET_RATIO     = 0.8;
const NEURON_DAILY_CAP    = 7000; // matches health endpoint
const KV_DAILY_CAP        = 1000000;

const MIN_CLUSTER_SIZE = 3;
const COSINE_MERGE_THRESHOLD = 0.78;
// v10 §B: must match index.js EMBEDDING_MODEL (bge-m3, 1024-dim). Kept local —
// consolidation.js has no import from index.js.
const EMBEDDING_MODEL_CONSOLIDATION = "@cf/baai/bge-m3";

/**
 * @param {object} env
 * @param {ExecutionContext|undefined} ctx
 * @param {function} callRoleLLM
 */
export async function runNightlyConsolidation(env, ctx, callRoleLLM) {
  const job = "nightly-consolidation";
  if (!(await withinBudget(env, job))) return;

  const startedAt = Date.now();
  const stats = { clusters_built: 0, distilled_pages: 0, conflicts_flagged: 0, facts_reweighted: 0 };

  // 1) Pull last 24h observations
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recRaw = await env.VECTORS.get("obs:recent");
  const ids = recRaw ? JSON.parse(recRaw) : [];
  const recent = [];
  for (const id of ids) {
    const raw = await env.VECTORS.get(`obs:meta:${id}`);
    if (!raw) continue;
    const o = JSON.parse(raw);
    if (o.superseded_by || o.merged_into) continue;
    const ts = Date.parse(o.timestamp) || 0;
    if (ts < cutoff) continue;
    recent.push(o);
  }
  if (recent.length < MIN_CLUSTER_SIZE) {
    await logCronRun(env, job, { stats, note: `only ${recent.length} obs in 24h, skipping cluster`, ok: true });
    return;
  }

  // 2) Cluster by entity overlap + cosine on Vectorize embeddings
  const clusters = await buildClusters(env, recent);
  stats.clusters_built = clusters.length;

  // 3) Distill each cluster of size >= MIN_CLUSTER_SIZE
  for (const cluster of clusters) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue;
    try {
      const distilled = await distillCluster(env, callRoleLLM, cluster);
      if (distilled) {
        const date = new Date().toISOString().slice(0, 10);
        const slug = distilled.topic_slug || "distilled";
        const path = `wiki/distilled/${date}-${slug}.md`;
        // writeFile is defined in index.js — caller wires this. Here we expose
        // the payload and let index.js call its own writer.
        await env.VECTORS.put(
          `state:consolidation:pending:${date}-${slug}`,
          JSON.stringify({ path, content: distilled.content, cluster_ids: cluster.map(c => c.id) }),
          { expirationTtl: 86400 * 7 }
        );
        stats.distilled_pages++;
      }
    } catch (e) {
      console.warn(`distill cluster failed: ${e.message}`);
    }
  }

  // 4) Re-weight entity facts based on 24h reinforcement count
  try {
    const entityCounts = {};
    for (const o of recent) {
      for (const e of (o.entities || [])) {
        entityCounts[e] = (entityCounts[e] || 0) + 1;
      }
    }
    for (const [entity, count] of Object.entries(entityCounts)) {
      if (count < 2) continue; // single mentions don't move confidence
      await reweightEntityFacts(env, entity, count);
      stats.facts_reweighted++;
    }
  } catch (e) { console.warn(`reweight failed: ${e.message}`); }

  await logCronRun(env, job, { stats, elapsed_ms: Date.now() - startedAt, ok: true });
}

/**
 * Weekly job — runs on Sunday 3am IST.
 */
export async function runWeeklyConsolidation(env, ctx, callRoleLLM) {
  const job = "weekly-consolidation";
  if (!(await withinBudget(env, job))) return;

  const startedAt = Date.now();
  const stats = { orphans_flagged: 0, stale_beliefs: 0, weekly_summary_written: false };

  // 1) Lint: find orphans (facts with no obs reference in last 30d)
  try {
    const orphans = await findOrphanFacts(env);
    stats.orphans_flagged = orphans.length;
    await env.VECTORS.put(
      "state:weekly-orphans",
      JSON.stringify({ at: new Date().toISOString(), orphans: orphans.slice(0, 200) }),
      { expirationTtl: 86400 * 14 }
    );
  } catch (e) { console.warn(`orphan scan: ${e.message}`); }

  // 2) Stale beliefs: semantic facts > 90 days old, never re-referenced
  try {
    const stale = await findStaleBeliefs(env, 90);
    stats.stale_beliefs = stale.length;
    await env.VECTORS.put(
      "state:weekly-stale-beliefs",
      JSON.stringify({ at: new Date().toISOString(), count: stale.length, beliefs: stale.slice(0, 50) }),
      { expirationTtl: 86400 * 14 }
    );
  } catch (e) { console.warn(`stale belief scan: ${e.message}`); }

  // 3) Weekly summary — markdown payload that index.js writes
  try {
    const summary = await buildWeeklySummary(env, callRoleLLM);
    if (summary) {
      const week = isoWeek(new Date());
      await env.VECTORS.put(
        `state:consolidation:pending:weekly-${week}`,
        JSON.stringify({ path: `wiki/_weekly/${week}.md`, content: summary }),
        { expirationTtl: 86400 * 14 }
      );
      stats.weekly_summary_written = true;
    }
  } catch (e) { console.warn(`weekly summary: ${e.message}`); }

  await logCronRun(env, "weekly-consolidation", { stats, elapsed_ms: Date.now() - startedAt, ok: true });
}

// ────────── helpers ──────────

async function withinBudget(env, job) {
  try {
    const writesRaw = await env.VECTORS.get(`kv:writes:${new Date().toISOString().slice(0, 10)}`);
    const writes = writesRaw ? parseInt(writesRaw, 10) : 0;
    if (writes / KV_DAILY_CAP >= KV_BUDGET_RATIO) {
      await logCronRun(env, job, { skipped: true, reason: `kv writes ${writes}/${KV_DAILY_CAP}` });
      return false;
    }
    const neuronsRaw = await env.VECTORS.get(`neurons:${new Date().toISOString().slice(0, 10)}`);
    const neurons = neuronsRaw ? parseInt(neuronsRaw, 10) : 0;
    if (neurons / NEURON_DAILY_CAP >= NEURON_BUDGET_RATIO) {
      await logCronRun(env, job, { skipped: true, reason: `neurons ${neurons}/${NEURON_DAILY_CAP}` });
      return false;
    }
    return true;
  } catch { return true; } // fail-open
}

async function logCronRun(env, job, payload) {
  try {
    await env.VECTORS.put(
      `state:cron-log:${job}:latest`,
      JSON.stringify({ at: new Date().toISOString(), ...payload }),
      { expirationTtl: 86400 * 30 }
    );
  } catch {}
}

// v10 §B: pure cosine similarity between two equal-length vectors.
// Guarded denominator → returns 0 (never NaN) for a zero vector.
export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// v10 §B: embed each observation's text on the fly (title + first 2000 chars of
// content, matching embedAndStore's cap). Returns { [obsId]: vector }. Best-effort:
// any embed failure just omits that obs from the map → its cosine checks skip →
// falls back to entity-overlap-only for that obs. Vectorize point-ids are
// path-hashed (d:{factHash(path)}), NOT obs.id, so we cannot reuse stored vectors
// here without re-deriving paths; re-embedding is self-contained and correct.
async function embedObservations(env, obs) {
  const vectors = {};
  if (!env.AI) return vectors;
  await Promise.all(obs.map(async (o) => {
    try {
      const text = `${o.title || ""}\n${(o.content || "").substring(0, 2000)}`.trim();
      if (!text) return;
      const res = await env.AI.run(EMBEDDING_MODEL_CONSOLIDATION, { text: [text] });
      const v = res?.data?.[0];
      if (Array.isArray(v) && v.length) vectors[o.id] = v;
    } catch (e) { /* omit on failure → entity-overlap fallback for this obs */ }
  }));
  return vectors;
}

async function buildClusters(env, obs) {
  // Greedy union-find: merge two observations if they share >= 2 entities
  // (original signal) OR their embeddings are cosine-similar >= threshold
  // (v10 §B: catches semantically-related obs sharing 0-1 entities). The cosine
  // signal is fail-safe — if embedding is unavailable, `vectors` is empty and
  // every cosine check short-circuits, leaving today's exact entity-overlap behavior.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  let vectors = {};
  try { vectors = await embedObservations(env, obs); }
  catch (e) { console.warn(`buildClusters embed failed, entity-overlap only: ${e.message}`); }

  for (const o of obs) parent.set(o.id, o.id);
  for (let i = 0; i < obs.length; i++) {
    const eA = new Set((obs[i].entities || []).map(e => e.toLowerCase()));
    for (let j = i + 1; j < obs.length; j++) {
      const eB = new Set((obs[j].entities || []).map(e => e.toLowerCase()));
      let shared = 0;
      for (const e of eA) if (eB.has(e)) shared++;
      let merge = shared >= 2;
      if (!merge) {
        const vA = vectors[obs[i].id], vB = vectors[obs[j].id];
        if (vA && vB && cosineSim(vA, vB) >= COSINE_MERGE_THRESHOLD) merge = true;
      }
      if (merge) union(obs[i].id, obs[j].id);
    }
  }
  const groups = {};
  for (const o of obs) {
    const root = find(o.id);
    (groups[root] = groups[root] || []).push(o);
  }
  return Object.values(groups);
}

async function distillCluster(env, callRoleLLM, cluster) {
  const sample = cluster.slice(0, 10).map(o => `- ${o.title}\n  ${(o.before_summary || "").slice(0, 200)}`).join("\n");
  const entities = [...new Set(cluster.flatMap(o => o.entities || []))].slice(0, 10);
  const prompt = `You're consolidating a cluster of related observations from the user's Second Brain.
Output ONLY JSON: {"topic_slug": "kebab-case-topic", "title": "Short title", "summary": "3-5 sentences of distilled meaning, no fluff"}.

Cluster observations:
${sample}

Shared entities: ${entities.join(", ")}`;

  try {
    const raw = await callRoleLLM(env, "synthesis", [{ role: "user", content: prompt }], 400);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    const fm = `---
type: distilled
memory_type: semantic
created: ${new Date().toISOString().slice(0, 10)}
tags: [distilled, consolidation, ${entities.slice(0, 3).map(e => e.toLowerCase().replace(/\s+/g, "-")).join(", ")}]
entities: [${entities.map(e => `"${e}"`).join(", ")}]
cluster_size: ${cluster.length}
cluster_ids: [${cluster.map(c => `"${c.id}"`).join(", ")}]
---

# ${p.title}

${p.summary}

## Source observations

${cluster.map(c => `- [[${c.wiki_path?.replace(/\.md$/, "") || c.id}]] — ${c.title}`).join("\n")}

## Backlinks
[[index]] · [[${new Date().toISOString().slice(0, 7)}]]
`;
    return { topic_slug: String(p.topic_slug || "topic").toLowerCase().replace(/[^a-z0-9-]/g, "-"), content: fm };
  } catch (e) {
    console.warn(`distill: ${e.message}`);
    return null;
  }
}

async function reweightEntityFacts(env, entity, mentions24h) {
  // Bump last_reinforced + confidence for facts on this entity. Same pattern as
  // /force-reinforce but tuned to a small per-mention bump.
  const slug = entity.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const idxRaw = await env.VECTORS.get(`entity:${slug}:facts_index`);
  if (!idxRaw) return;
  const factKeys = JSON.parse(idxRaw);
  for (const fk of factKeys.slice(0, 10)) {
    const fr = await env.VECTORS.get(fk);
    if (!fr) continue;
    const f = JSON.parse(fr);
    f.count = (f.count || 1) + Math.min(mentions24h - 1, 3);
    f.last_reinforced = Date.now();
    f.confidence = Math.min(1, (f.confidence || 0.5) + 0.05 * Math.min(mentions24h - 1, 3));
    await env.VECTORS.put(fk, JSON.stringify(f));
  }
}

async function findOrphanFacts(env) {
  // A fact is "orphan" if last_reinforced > 30 days ago AND count <= 1
  const cutoff = Date.now() - 30 * 86400 * 1000;
  const orphans = [];
  let cursor = undefined;
  let scanned = 0;
  while (scanned < 2000) {
    const list = await env.VECTORS.list({ prefix: "entity:", limit: 1000, cursor });
    for (const k of list.keys) {
      if (!k.name.includes(":fact:")) continue;
      const raw = await env.VECTORS.get(k.name);
      if (!raw) continue;
      try {
        const f = JSON.parse(raw);
        if ((f.last_reinforced || 0) < cutoff && (f.count || 0) <= 1) {
          orphans.push({ key: k.name, fact: f.fact?.slice(0, 200), last: f.last_reinforced });
        }
      } catch {}
      scanned++;
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return orphans;
}

async function findStaleBeliefs(env, days) {
  const cutoff = Date.now() - days * 86400 * 1000;
  const stale = [];
  let cursor = undefined;
  let scanned = 0;
  while (scanned < 1000) {
    const list = await env.VECTORS.list({ prefix: "obs:meta:", limit: 1000, cursor });
    for (const k of list.keys) {
      const raw = await env.VECTORS.get(k.name);
      if (!raw) continue;
      try {
        const o = JSON.parse(raw);
        if (o.memory_type !== "semantic") continue;
        if (o.valid_to) continue;
        const vf = o.valid_from ? new Date(o.valid_from).getTime() : (Date.parse(o.timestamp) || 0);
        const lastRef = o.last_referenced || vf;
        if (vf < cutoff && lastRef < cutoff) {
          stale.push({ id: o.id, title: o.title, age_days: Math.round((Date.now() - vf) / 86400000) });
        }
      } catch {}
      scanned++;
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return stale.slice(0, 100);
}

async function buildWeeklySummary(env, callRoleLLM) {
  if (!callRoleLLM) return null;
  // Pull last 7 days of distilled pages from pending KV
  const list = await env.VECTORS.list({ prefix: "state:consolidation:pending:" });
  const recent = [];
  for (const k of list.keys.slice(-20)) {
    const raw = await env.VECTORS.get(k.name);
    if (!raw) continue;
    try { recent.push(JSON.parse(raw)); } catch {}
  }
  if (recent.length === 0) return null;

  const titles = recent.map(r => r.path.split("/").pop().replace(/\.md$/, "")).join("\n  - ");
  const prompt = `Summarise the week's distilled topics in 5-7 bullets. Be terse, no fluff.

Topics:
  - ${titles}`;
  const raw = await callRoleLLM(env, "synthesis", [{ role: "user", content: prompt }], 500);

  return `---
type: weekly-summary
memory_type: semantic
created: ${new Date().toISOString().slice(0, 10)}
tags: [weekly, consolidation]
---

# Week ${isoWeek(new Date())}

${raw}

## Source clusters

${recent.map(r => `- [[${r.path.replace(/\.md$/, "")}]]`).join("\n")}

## Backlinks
[[index]]
`;
}

function isoWeek(d) {
  const date = new Date(d.valueOf());
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

/**
 * Helpers exposed for index.js wiring.
 *   isISTHour(date, h)    — true if IST hour-of-day === h, within first 15 min
 *   isISTDayHour(d, dow, h) — true if IST day-of-week === dow AND hour === h
 */
export function isISTHour(date, hour) {
  const istMs = date.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() === hour && ist.getUTCMinutes() < 15;
}
export function isISTDayHour(date, dayOfWeek, hour) {
  const istMs = date.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCDay() === dayOfWeek && ist.getUTCHours() === hour && ist.getUTCMinutes() < 15;
}

/**
 * Reads pending consolidation payloads and flushes them to GitHub via writeFile
 * (caller passes writeFile). Call this from index.js cron AFTER runNightly /
 * runWeekly produced payloads.
 */
export async function flushPendingConsolidations(env, writeFile) {
  const list = await env.VECTORS.list({ prefix: "state:consolidation:pending:" });
  let written = 0;
  for (const k of list.keys) {
    const raw = await env.VECTORS.get(k.name);
    if (!raw) continue;
    try {
      const { path, content } = JSON.parse(raw);
      const ok = await writeFile(env, path, content, `consolidation: ${path.split("/").pop()}`);
      if (ok) {
        await env.VECTORS.delete(k.name);
        written++;
      }
    } catch (e) { console.warn(`flush ${k.name}: ${e.message}`); }
  }
  return written;
}
