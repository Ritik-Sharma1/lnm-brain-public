/**
 * U3 — Bitemporal facts.
 *
 * Adds (valid_from, valid_to, invalidated_by, superseded_reason) to semantic
 * observations only. Episodic events do not expire.
 *
 * Pipeline hook: after extractAndStoreFactsFromContent classifies a new
 * observation as memory_type=semantic, call resolveSemanticConflict() before
 * writing. It hybrid-searches for matching prior claims; if contradicted with
 * high confidence by an LLM judge, closes the prior's valid_to window and
 * emits a belief_change event.
 *
 * Conservative defaults:
 *   - AUTO_INVALIDATE_THRESHOLD = 0.85 (LLM contradiction confidence)
 *   - Below threshold: surface both with a `conflict_pending` flag; do not write.
 *   - Every invalidation gets a meta/belief-history/YYYY-MM-DD.jsonl line.
 *
 * Query semantics — exposed via new helper:
 *   filterByValidity(facts, asOf=null)  // null = now
 *
 * Wire that into ask_second_brain + query_second_brain BEFORE returning facts.
 */

const AUTO_INVALIDATE_THRESHOLD = 0.85;

/**
 * Resolve a new semantic claim against the existing index.
 * @param {object} env
 * @param {function} callRoleLLM
 * @param {object} newClaim  { id, subject, predicate, object, content, embedding? }
 * @param {function} hybridSearch  (query, topK) => [{id, summary, content, ...}]
 * @returns {Promise<{action: "write"|"invalidate-prior"|"flag-conflict", details: object}>}
 */
export async function resolveSemanticConflict(env, callRoleLLM, newClaim, hybridSearch) {
  // 1) Find prior claims similar to this one
  const query = `${newClaim.subject || ""} ${newClaim.predicate || ""} ${newClaim.object || newClaim.content || ""}`.trim();
  const candidates = await hybridSearch(query, 5).catch(() => []);
  const priorClaims = candidates.filter(c =>
    c.memory_type === "semantic" &&
    (c.valid_to === null || c.valid_to === undefined) &&
    c.id !== newClaim.id
  );
  if (priorClaims.length === 0) {
    return { action: "write", details: { reason: "no prior claim found" } };
  }

  // 2) For each top prior, ask LLM if it contradicts the new claim
  for (const prior of priorClaims.slice(0, 3)) {
    const verdict = await contradictionVerdict(env, callRoleLLM, prior, newClaim);
    if (verdict.contradicts && verdict.confidence >= AUTO_INVALIDATE_THRESHOLD) {
      // Close prior, write new
      const now = new Date().toISOString();
      const updated = {
        ...prior,
        valid_to: now,
        invalidated_by: newClaim.id,
        superseded_reason: verdict.reason,
        belief_change_at: now,
      };
      await env.VECTORS.put(`obs:meta:${prior.id}`, JSON.stringify(updated));

      // Append to belief-history journal
      await appendBeliefHistory(env, {
        at: now,
        prior_id: prior.id,
        prior_summary: prior.summary || prior.title,
        new_id: newClaim.id,
        new_summary: newClaim.content?.slice(0, 200) || newClaim.title,
        reason: verdict.reason,
        confidence: verdict.confidence,
      });

      return { action: "invalidate-prior", details: { prior_id: prior.id, verdict } };
    } else if (verdict.contradicts) {
      // Below threshold — flag, do not auto-invalidate
      return {
        action: "flag-conflict",
        details: { prior_id: prior.id, verdict, message: "below auto-invalidate threshold; surfacing both" },
      };
    }
  }

  return { action: "write", details: { reason: "no contradicting prior" } };
}

async function contradictionVerdict(env, callRoleLLM, prior, newClaim) {
  if (!env?.AI || !callRoleLLM) return { contradicts: false, confidence: 0, reason: "no LLM" };
  const priorText = prior.summary || prior.content || prior.title || "";
  const newText = newClaim.content || newClaim.title || "";
  const prompt = `Two claims about the same subject. Does the new one CONTRADICT the prior?
Output ONLY JSON: {"contradicts": true|false, "confidence": 0.0-1.0, "reason": "<one short sentence>"}

Prior (older):
${priorText.slice(0, 800)}

New (incoming):
${newText.slice(0, 800)}

Strict rules:
- "contradicts" = true only if both claims cannot be true at the same time.
- Updates / refinements / additions of detail are NOT contradictions.
- Default to false if unsure.`;

  try {
    const raw = await callRoleLLM(env, "extraction", [{ role: "user", content: prompt }], 120);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { contradicts: false, confidence: 0, reason: "no JSON" };
    const p = JSON.parse(m[0]);
    return {
      contradicts: !!p.contradicts,
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
      reason: String(p.reason || "").slice(0, 200),
    };
  } catch (e) {
    return { contradicts: false, confidence: 0, reason: `judge error: ${e.message}` };
  }
}

async function appendBeliefHistory(env, event) {
  // Stored in KV as a rolling list — keep last 500 events. Cron rotates to GitHub.
  try {
    const raw = await env.VECTORS.get("state:belief-history:recent");
    const list = raw ? JSON.parse(raw) : [];
    list.push(event);
    const capped = list.slice(-500);
    await env.VECTORS.put(
      "state:belief-history:recent",
      JSON.stringify(capped),
      { expirationTtl: 86400 * 90 }
    );
  } catch (e) {
    console.warn(`belief-history append failed: ${e.message}`);
  }
}

/**
 * Filter facts by validity window.
 * @param {Array<{valid_from?, valid_to?}>} facts
 * @param {Date|string|null} asOf  null = now
 */
export function filterByValidity(facts, asOf = null) {
  const t = asOf ? new Date(asOf).getTime() : Date.now();
  return facts.filter(f => {
    const vt = f.valid_to ? new Date(f.valid_to).getTime() : null;
    if (vt && vt <= t) return false;
    const vf = f.valid_from ? new Date(f.valid_from).getTime() : null;
    if (vf && vf > t) return false;
    return true;
  });
}

/**
 * GET /api/belief-history?limit=50
 * Returns the recent belief-change journal.
 */
export async function handleBeliefHistory(req, env) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "50", 10)));
  const raw = await env.VECTORS.get("state:belief-history:recent");
  const list = raw ? JSON.parse(raw) : [];
  const out = list.slice(-limit).reverse();
  return new Response(JSON.stringify({ count: out.length, events: out }, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
