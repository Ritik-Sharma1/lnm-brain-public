/**
 * Retrieval critic — light Upgrade 5 (companion to rerank).
 *
 * After rerank, ask a small LLM to grade whether the top-K passages actually
 * answer the question. Returns a structured verdict so callers can decide
 * to re-query, add a caveat, or surface low confidence.
 *
 * Output shape:
 *   {
 *     verdict: "Correct" | "Incorrect" | "Ambiguous",
 *     confidence: 0.0 - 1.0,
 *     reason: string,
 *     used_obs: number   // count of passages graded
 *   }
 *
 * Cost: 1 LLM call (~200 tokens out). Skip when results are empty or query is
 *       trivial — caller decides.
 */
const CRITIC_PROMPT = `You grade retrieved passages against a question.

Output ONLY valid JSON:
{"verdict": "Correct" | "Incorrect" | "Ambiguous", "confidence": 0.0-1.0, "reason": "<one short sentence>"}

Rules:
- "Correct"   = passages clearly contain a defensible answer.
- "Incorrect" = passages are off-topic or contradict the question's premise.
- "Ambiguous" = partial / weak / conflicting evidence.
- confidence is your certainty in the verdict, not in the answer itself.
- Be strict. Default to Ambiguous if unsure.`;

export async function gradeRetrieval(env, callRoleLLM, question, passages, opts = {}) {
  const fallback = { verdict: "Ambiguous", confidence: 0.3, reason: "critic skipped", used_obs: passages?.length || 0 };
  if (!env?.AI || !callRoleLLM) return fallback;
  if (!Array.isArray(passages) || passages.length === 0) {
    return { verdict: "Incorrect", confidence: 0.9, reason: "no passages retrieved", used_obs: 0 };
  }

  const docs = passages.slice(0, 7).map((p, i) => {
    const text = String(p.summary || p.text || p.content || p.title || p.name || "").slice(0, 600);
    return `[${i}] ${p.title || p.name || p.path || ""}\n${text}`;
  }).join("\n\n");

  const userPrompt = `Question: ${question}\n\nRetrieved passages:\n${docs}`;

  try {
    const raw = await callRoleLLM(env, "extraction", [
      { role: "system", content: CRITIC_PROMPT },
      { role: "user", content: userPrompt },
    ], 150);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const parsed = JSON.parse(m[0]);
    const v = ["Correct", "Incorrect", "Ambiguous"].includes(parsed.verdict) ? parsed.verdict : "Ambiguous";
    const c = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return { verdict: v, confidence: c, reason: String(parsed.reason || "").slice(0, 200), used_obs: passages.length };
  } catch (e) {
    console.warn(`gradeRetrieval failed (non-fatal): ${e.message}`);
    return fallback;
  }
}
