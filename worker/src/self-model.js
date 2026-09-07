/**
 * v10.2.x — generic self-model deepening helpers.
 *
 * The public template intentionally uses the neutral placeholder "Brain Owner".
 * A private deployment should parameterize this with the actual user's identity.
 * No personal profile data belongs in this public source.
 */

export const PINNED_CATEGORIES = new Set(["instruction", "preference", "behavioral", "identity"]);

export function isPinnedFact(f) {
  if (!f) return false;
  if (f.pinned === true) return true;
  if (PINNED_CATEGORIES.has(f.category)) return true;
  if ((f.count || 0) >= 3 && (f.confidence || 0) >= 0.6) return true;
  return false;
}

export function capFactIndexWithPins(keys, pinnedSet, keepRecent = 80) {
  const pinned = keys.filter(k => pinnedSet.has(k));
  const unpinned = keys.filter(k => !pinnedSet.has(k)).slice(-keepRecent);
  const keep = new Set([...pinned, ...unpinned]);
  return keys.filter(k => keep.has(k));
}

/**
 * Infer durable behavioral patterns from evidence in the owner's own content.
 * This is intentionally separate from explicit fact extraction so inferred
 * behavior can be distinguished from directly stated facts.
 */
export async function inferBehavioralPatterns(env, callRoleLLM, content, neuronGuard) {
  if (!env?.AI || !callRoleLLM) return [];
  if (neuronGuard && !(await neuronGuard())) return [];
  const inputText = String(content || "").substring(0, 12000);
  if (inputText.length < 200) return [];

  const prompt = `You are deepening a durable, personalized model of the Brain Owner by INFERRING how the owner operates from this content. Inference is REQUIRED, but only when supported by evidence.

Cover these SELF-DOMAINS only where evidenced:
- build: how the owner builds/codes — tools, sequence, quality bar, avoided approaches.
- design: visual/design preferences — layout, aesthetic, patterns liked or rejected.
- writing: writing and communication voice.
- client: how the owner communicates, sells, or collaborates.
- decision: how the owner decides — tradeoffs, risk posture, rejected options.
- habit: recurring habits and durable working preferences.

Rules:
- Emit a pattern only if the content genuinely evidences it. No filler or flattery.
- Each pattern is one durable present-tense sentence starting "Brain Owner ...".
- Also emit a compact triple {predicate, object} capturing the same relationship.
- Max 6 patterns. Avoid one-off events that do not generalize.

Content:
${inputText}

Return JSON only:
{"patterns":[{"domain":"writing","text":"Brain Owner ...","predicate":"writing_style","object":"..."}]}`;

  try {
    const raw = await callRoleLLM(env, "extraction", [
      { role: "system", content: "Model a user's operating style from evidence. Output clean JSON only." },
      { role: "user", content: prompt },
    ], 500);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    const pats = Array.isArray(parsed.patterns) ? parsed.patterns : [];
    const VALID_DOMAINS = new Set(["build", "design", "writing", "client", "decision", "habit"]);
    return pats
      .map(p => (typeof p === "string" ? { text: p } : p))
      .filter(p => p && typeof p.text === "string" && p.text.trim().length >= 12)
      .slice(0, 6)
      .map(p => ({
        text: p.text.trim(),
        category: "behavioral",
        domain: VALID_DOMAINS.has(p.domain) ? p.domain : "habit",
        pinned: true,
        triple: (p.predicate && p.object)
          ? { predicate: String(p.predicate).slice(0, 40), object: String(p.object).slice(0, 120) }
          : null,
      }));
  } catch (e) {
    console.warn("inferBehavioralPatterns:", e.message);
    return [];
  }
}

/** Build a reusable writing-style card from owner-authored samples only. */
export async function buildVoiceProfile(env, callRoleLLM, samples) {
  if (!env?.AI || !callRoleLLM) return null;
  const joined = (samples || []).filter(Boolean).join("\n---\n").substring(0, 10000);
  if (joined.length < 300) return null;

  const prompt = `Below are writing samples authored by the Brain Owner. Produce a STYLE CARD another AI can use to match this writing style.

Capture concretely:
- sentence length and rhythm;
- punctuation and formatting habits;
- vocabulary and register;
- opening and closing habits;
- recurring stylistic preferences and avoidances;
- tone.

Do not infer sensitive personal traits. Model writing style only.

Samples:
${joined}

Return JSON only:
{"voice_summary":"2-3 sentence style overview","rules":["do X","avoid Y"],"signature_phrases":["..."]}`;

  try {
    const raw = await callRoleLLM(env, "synthesis", [
      { role: "system", content: "Reverse-engineer writing style into a reusable style card. Output clean JSON only." },
      { role: "user", content: prompt },
    ], 600);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    const card = {
      voice_summary: String(p.voice_summary || "").slice(0, 800),
      rules: (Array.isArray(p.rules) ? p.rules : []).slice(0, 12).map(String),
      signature_phrases: (Array.isArray(p.signature_phrases) ? p.signature_phrases : []).slice(0, 12).map(String),
      built_at: new Date().toISOString(),
      sample_count: (samples || []).length,
    };
    await env.VECTORS.put("state:voice-profile:latest", JSON.stringify(card), { expirationTtl: 86400 * 60 });
    return card;
  } catch (e) {
    console.warn("buildVoiceProfile:", e.message);
    return null;
  }
}

export function renderVoiceProfileMd(card) {
  if (!card) return null;
  return `---
type: voice-profile
memory_type: semantic
created: ${card.built_at?.slice(0, 10) || ""}
tags: [voice, style, self-model, personalization]
entities: ["Brain Owner"]
---

# Brain Owner — Writing Voice

_Built from ${card.sample_count} owner-authored writing samples._

## Summary
${card.voice_summary}

## Rules
${card.rules.length ? card.rules.map(r => `- ${r}`).join("\n") : "_none_"}

## Signature phrases
${card.signature_phrases.length ? card.signature_phrases.map(s => `- \`${s}\``).join("\n") : "_none_"}

## Backlinks
[[index]] · [[about-owner]]
`;
}
