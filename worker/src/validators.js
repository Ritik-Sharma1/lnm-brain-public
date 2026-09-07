/**
 * U1 — Foundation validators.
 *
 * Two hard-fail validators called inside runIngestPipeline before any KV write.
 *
 *   1. validateSurface(input)
 *      - Rejects undefined/null/empty surface unless surface_explicit_other=true.
 *      - Rejects unknown surface strings (must be in SURFACES enum).
 *      - Returns the canonical normalized surface.
 *      - Throws Error with verbatim reason so caller sees real error, not silent
 *        "other" relabel. CLAUDE.md mandate: "surface is MANDATORY on every capture".
 *
 *   2. validateHandoff(input)
 *      - When entities contains "SESSION-HANDOFF", refuses write if state OR
 *      next_action OR trail is empty/missing.
 *      - The upgrade plan: "Empty handoffs are worse than no handoff because
 *        they signal the protocol ran and produced nothing — gaslighting your
 *        next session."
 *
 * Both throw on invalid input. runIngestPipeline must catch and return the
 * error message verbatim to the MCP caller (no swallow).
 */

const VALID_SURFACES = [
  "claude-ai-web",
  "claude-code",
  "cowork",
  "gemini",
  "chatgpt-go",
  "claude-mobile",
  "other",
];

export function validateSurface({ surface, surface_explicit_other }) {
  if (!surface || (typeof surface === "string" && surface.trim() === "")) {
    throw new Error(
      `[surface-validator] surface is MANDATORY on every capture. ` +
      `Pass one of: ${VALID_SURFACES.join(", ")}. ` +
      `Pass surface_explicit_other:true if you genuinely mean 'other'.`
    );
  }
  const lower = String(surface).toLowerCase().trim();
  if (!VALID_SURFACES.includes(lower)) {
    throw new Error(
      `[surface-validator] unknown surface "${surface}". ` +
      `Must be one of: ${VALID_SURFACES.join(", ")}.`
    );
  }
  if (lower === "other" && !surface_explicit_other) {
    throw new Error(
      `[surface-validator] surface="other" rejected without surface_explicit_other:true. ` +
      `Most "other" captures are bugs — set the real surface (claude-code, claude-ai-web, etc.) ` +
      `or set surface_explicit_other:true to confirm.`
    );
  }
  return lower;
}

/**
 * Check whether this capture is a SESSION-HANDOFF and, if so, demand a fully
 * populated payload. Returns silently for non-handoffs.
 */
export function validateHandoff({ entities, state, next_action, trail, title, type }) {
  const ents = Array.isArray(entities) ? entities : [];
  const isHandoff =
    ents.includes("SESSION-HANDOFF") ||
    (typeof title === "string" && /SESSION[-_ ]?HANDOFF/i.test(title));

  if (!isHandoff) return;

  const missing = [];
  if (!state || String(state).trim().length < 4) missing.push("state");
  if (!next_action || String(next_action).trim().length < 4) missing.push("next_action");
  if (!Array.isArray(trail) || trail.length === 0) missing.push("trail[]");

  if (missing.length > 0) {
    throw new Error(
      `[handoff-validator] SESSION-HANDOFF requires non-empty: ${missing.join(", ")}. ` +
      `Empty handoffs gaslight the next session — either fill them or do not tag SESSION-HANDOFF. ` +
      `(Plain notes are fine without these fields; remove "SESSION-HANDOFF" from entities to bypass.)`
    );
  }
}

export const SURFACES = VALID_SURFACES;
