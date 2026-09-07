// triple-stats.js — pure helpers for the compaction job (v9.7).
// Testable in isolation (no env/IO). Imported by index.js as an ESM module
// and uploaded as a worker module by deploy-via-curl.js (MODULES array).

// Count real triple rows from a KV key listing of `triple:*` keys.
// Storage: triple:{subjectSlug}:{predicateSlug} = a row;
//          triple:{subjectSlug}:index           = per-subject index (NOT a row).
export function countTriplesFromKeys(keys) {
  let triples = 0;
  const subjects = new Set();
  for (const k of keys || []) {
    const name = typeof k === "string" ? k : (k && k.name) || "";
    if (!name.startsWith("triple:")) continue;
    const parts = name.split(":"); // ["triple", subjectSlug, predicateSlug]
    if (parts.length < 3) continue;
    const pred = parts.slice(2).join(":");
    if (pred === "index") continue;
    triples++;
    subjects.add(parts[1]);
  }
  return { triples, subjects: subjects.size };
}

// Tool-call / log noise filename shape. These have ~zero retrieval value and
// should be PRUNED, not compressed — so lint must not flag them "uncompressed".
const TOOL_NOISE_RE = /(?:^|[/\-])tool-(?:bash|edit|write|read|mcp|glob|grep|task)\b/i;

export function isToolNoiseName(name) {
  const s = String(name || "");
  return TOOL_NOISE_RE.test(s);
}

// A raw/conversations file is an "uncompressed candidate" only if it is real
// content lacking a wiki twin. Tool-noise logs are excluded.
export function isUncompressedCandidate(name) {
  return !isToolNoiseName(name);
}

// SPEC §1 classifier: PRUNE / MERGE / KEEP for a raw/conversations filename.
//  - PRUNE: tool-call/log noise.
//  - KEEP : hand-authored — session-handoff, rule, dossier, or substantive titled doc.
//  - MERGE: leftover tiny per-message fragments, grouped by (date + session-hash).
const SESSION_HASH_RE = /-([0-9a-f]{6,8})\.md$/i;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const KEEP_RE = /(session-handoff|^.*-rule-|-rule-|dossier|copyos|brutal-reality|fb-ads|research|profile|about-)/i;

export function classifyRawFile(name) {
  const base = String(name || "").split("/").pop();
  const dateM = base.match(DATE_RE);
  const date = dateM ? dateM[1] : null;
  const sessM = base.match(SESSION_HASH_RE);
  const session = sessM ? sessM[1] : null;

  if (isToolNoiseName(base)) return { action: "PRUNE", reason: "tool-call-log", date, session };
  if (KEEP_RE.test(base))    return { action: "KEEP",  reason: "authored-doc",  date, session };

  // Fragment with a trailing session hash and no authored signal → MERGE.
  if (session) return { action: "MERGE", reason: "session-fragment", date, session };

  // Untitled / unclear and no session anchor → keep (safe default, never prune).
  return { action: "KEEP", reason: "default-keep", date, session };
}

// ── Centrality ranking (v10 §C, god-node surfacing) ──────────────────────────
// Pure scorer: rank entities by "how connected is this right now" using data the
// worker already owns — fact count (entity:{slug}:meta.total_facts) + triple count
// (triple:{slug}:* rows). Triples weighted 2x: a structured S-P-O relation is a
// stronger connectedness signal than a free-text fact, mirroring the categoryBoost
// precedent (index.js) of ranking structured data higher. No graph.json needed.
//   entityMetaList: [{ slug, name, total_facts }]
//   tripleCountsBySubject: { slug: count }
export function rankEntitiesByCentrality(entityMetaList, tripleCountsBySubject) {
  const counts = tripleCountsBySubject || {};
  return (entityMetaList || []).map(e => {
    const facts = e.total_facts || 0;
    const triples = counts[e.slug] || 0;
    return {
      entity: e.name,
      slug: e.slug,
      fact_count: facts,
      triple_count: triples,
      centrality_score: facts + 2 * triples,
    };
  }).sort((a, b) => b.centrality_score - a.centrality_score);
}
