/**
 * U2 — CoALA memory-type classifier.
 *
 * Four types per Princeton 2023 paper:
 *   - working    : context-window only, never written
 *   - episodic   : an event happened. ("deployed v7.9.0 at 14:12 IST")
 *   - semantic   : a belief/fact that should be true over time. ("Microsoft365Lifetime is a scam")
 *   - procedural : how-to / runbook. ("how to deploy the worker")
 *
 * Classifier = small LLM call wrapped around heuristic shortcuts to skip the
 * LLM in obvious cases. Caches verdicts on obs:meta so re-classification is
 * idempotent.
 *
 * Use:
 *   import { classifyMemoryType } from "./memory_type.js";
 *   const memType = await classifyMemoryType(env, callRoleLLM, {
 *     title, content, category, tags, entities, type
 *   });
 *
 * Call inside runIngestPipeline.asyncWork (after extractAndStoreFactsFromContent
 * since `category` is one of its inputs).
 *
 * Backfill: scripts/backfills/backfill_memory_type.py walks obs:recent and
 * fills obs:meta.memory_type for older records.
 */

const VALID_TYPES = ["working", "episodic", "semantic", "procedural"];

const CLASSIFIER_PROMPT = `Classify this observation into exactly one CoALA memory type. Output ONLY JSON.

Types:
  - episodic    : something that happened at a specific time (events, deploys, conversations, decisions made on date X)
  - semantic    : a fact or belief that is true over time (an entity is/has a property, a value, a relationship)
  - procedural  : how to do something (a runbook, a workflow, a sequence of steps)
  - working     : extremely rare — context-only scratch. Use only if nothing else fits.

Output: {"memory_type": "...", "confidence": 0.0-1.0, "reason": "<one short phrase>"}`;

/**
 * @returns {Promise<{memory_type:string, confidence:number, reason:string}>}
 */
export async function classifyMemoryType(env, callRoleLLM, obs) {
  // 1) Heuristic shortcuts — cheap, deterministic.
  const heur = heuristicMemoryType(obs);
  if (heur) return heur;

  // 2) LLM classifier (extraction-class — small, fast)
  if (!env?.AI || !callRoleLLM) {
    return { memory_type: "episodic", confidence: 0.4, reason: "no LLM, default episodic" };
  }

  const text = [
    `Title: ${obs.title || ""}`,
    `Category: ${obs.category || "conversation"}`,
    `Tags: ${(obs.tags || []).join(", ")}`,
    `Entities: ${(obs.entities || []).join(", ")}`,
    `Content (first 800 chars): ${(obs.content || "").slice(0, 800)}`,
  ].join("\n");

  try {
    const raw = await callRoleLLM(env, "extraction", [
      { role: "system", content: CLASSIFIER_PROMPT },
      { role: "user", content: text },
    ], 80);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in classifier response");
    const parsed = JSON.parse(m[0]);
    const t = String(parsed.memory_type || "").toLowerCase();
    if (!VALID_TYPES.includes(t)) throw new Error(`invalid type: ${t}`);
    return {
      memory_type: t,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reason: String(parsed.reason || "").slice(0, 120),
    };
  } catch (e) {
    console.warn(`classifyMemoryType failed: ${e.message}`);
    return { memory_type: "episodic", confidence: 0.3, reason: `fallback (${e.message})` };
  }
}

/**
 * Heuristic shortcuts. Return null if no strong signal — let LLM decide.
 */
function heuristicMemoryType(obs) {
  const title = (obs.title || "").toLowerCase();
  const tags = (obs.tags || []).map(t => t.toLowerCase());
  const ents = (obs.entities || []).map(e => e.toLowerCase());
  const cat = (obs.category || "").toLowerCase();
  const type = (obs.type || "").toLowerCase();

  // Procedural — explicit runbooks
  if (title.startsWith("how to ") || title.includes(" runbook") || title.includes("procedure")) {
    return { memory_type: "procedural", confidence: 0.95, reason: "title pattern matches procedural" };
  }
  if (tags.includes("procedure") || tags.includes("runbook") || tags.includes("how-to")) {
    return { memory_type: "procedural", confidence: 0.95, reason: "tagged procedural" };
  }
  if ((obs.wiki_path || "").includes("/procedures/")) {
    return { memory_type: "procedural", confidence: 0.99, reason: "lives in procedures/ dir" };
  }

  // v10 §A: project notes are living state documents, not events → semantic.
  if (type === "project") {
    return { memory_type: "semantic", confidence: 0.9, reason: "project note — long-lived state, not an event" };
  }

  // Episodic — events with a clear timestamp narrative
  if (cat === "bugfix" || cat === "deploy" || cat === "decision") {
    return { memory_type: "episodic", confidence: 0.85, reason: `category=${cat}` };
  }
  if (ents.includes("session-handoff")) {
    return { memory_type: "episodic", confidence: 0.95, reason: "session-handoff" };
  }
  if (type === "conversation") {
    return { memory_type: "episodic", confidence: 0.8, reason: "conversation log" };
  }

  // Semantic — fact category, instruction category from existing schema
  if (cat === "fact" || cat === "preference" || cat === "instruction") {
    return { memory_type: "semantic", confidence: 0.9, reason: `category=${cat}` };
  }

  return null;
}

export const MEMORY_TYPES = VALID_TYPES;
