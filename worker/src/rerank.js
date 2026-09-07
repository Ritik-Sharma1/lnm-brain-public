/**
 * Cross-encoder reranking — Upgrade 4
 *
 * Replaces the existing LLM-as-reranker pattern in index.js with a true
 * cross-encoder (BAAI/bge-reranker-base) running on Cloudflare Workers AI.
 *
 * Why this is strictly better than LLM-rerank:
 *   - Cross-encoders are trained for relevance scoring. LLMs are not.
 *   - 5-10x cheaper (~0.01 neurons vs ~5 neurons per rerank call).
 *   - 3-5x faster (~80ms vs ~300-500ms).
 *   - Deterministic numeric score per pair → no JSON parsing, no retries.
 *
 * Inputs:
 *   env       — Worker env (needs env.AI binding)
 *   query     — original user query string
 *   candidates— array of objects, each MUST have `text` (the passage to score).
 *               Pass title + summary or full content depending on what exists.
 *   topK      — number of items to keep after rerank (default 7)
 *   opts      — { strict: boolean }  if true throw on error, else return input unchanged
 *
 * Output: same array shape as input, with `rerank_score` (0-1, higher = better)
 *         attached to each, sorted DESC, truncated to topK.
 *
 * Failure mode: if env.AI is missing or the model call fails, returns the
 *               first `topK` items of the input untouched. Never throws unless
 *               opts.strict === true.
 */
const RERANKER_MODEL = "@cf/baai/bge-reranker-base";
const MAX_PASSAGE_CHARS = 1200;   // truncate long docs — reranker has 512-token limit anyway
const MAX_CANDIDATES = 30;        // hard cap to control cost/latency

export async function crossEncoderRerank(env, query, candidates, topK = 7, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (!env?.AI) {
    if (opts.strict) throw new Error("crossEncoderRerank: env.AI not bound");
    return candidates.slice(0, topK);
  }
  if (!query || typeof query !== "string") {
    if (opts.strict) throw new Error("crossEncoderRerank: query required");
    return candidates.slice(0, topK);
  }

  const work = candidates.slice(0, MAX_CANDIDATES);
  const contexts = work.map(c => ({
    text: String(c.text || c.summary || c.content || c.title || c.name || "").slice(0, MAX_PASSAGE_CHARS),
  }));

  try {
    // Workers AI returns: { response: [{ id: <orig index>, score: <0-1> }, ...] }
    const res = await env.AI.run(RERANKER_MODEL, {
      query,
      contexts,
      top_k: Math.min(work.length, MAX_CANDIDATES),
    });

    if (!res?.response || !Array.isArray(res.response)) {
      if (opts.strict) throw new Error("crossEncoderRerank: bad response shape");
      return work.slice(0, topK);
    }

    // Attach scores back to original objects, preserving all original fields.
    const scored = res.response
      .filter(r => typeof r.id === "number" && r.id >= 0 && r.id < work.length)
      .map(r => ({ ...work[r.id], rerank_score: r.score }));

    // Add any items the reranker dropped (shouldn't happen with top_k=len, but defensive)
    const seen = new Set(scored.map((_, i) => i));
    for (let i = 0; i < work.length; i++) {
      if (!seen.has(i) && !scored.find(s => s === work[i])) {
        scored.push({ ...work[i], rerank_score: 0 });
      }
    }

    return scored
      .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
      .slice(0, topK);
  } catch (e) {
    console.warn(`crossEncoderRerank failed (non-fatal): ${e.message}`);
    if (opts.strict) throw e;
    return work.slice(0, topK);
  }
}

/**
 * Convenience: rerank objects shaped like the worker's hybrid results.
 * Builds the `text` field from (title || name) + summary, with sane fallbacks.
 */
export async function rerankHybridResults(env, query, results, topK = 7) {
  const withText = results.map(r => ({
    ...r,
    text: [
      r.title || r.name || r.path || "",
      r.snippet || r.summary || r.before_summary || r.after_summary || "",
    ].filter(Boolean).join(" — "),
  }));
  return crossEncoderRerank(env, query, withText, topK);
}
