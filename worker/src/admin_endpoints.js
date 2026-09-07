/**
 * U1 admin endpoints.
 *
 * Wire these into the fetch router in index.js:
 *
 *   if (path === "/api/relabel-surface"   && method === "POST") return handleRelabelSurface(req, env);
 *   if (path === "/api/backfill-handoffs" && method === "POST") return handleBackfillHandoffs(req, env);
 *
 * No auth — same security posture as existing /ask, /search etc. (key check on
 * MCP endpoint, internal endpoints rely on URL being non-public). Add an
 * `x-admin-key` header check before going to prod with anything destructive.
 */

const SURFACES = ["claude-ai-web", "claude-code", "cowork", "gemini", "chatgpt-go", "claude-mobile", "other"];

/**
 * POST /api/relabel-surface
 * Body: { id: "obs-id", surface: "claude-code" }
 *
 * Rewrites obs:meta:{id}.surface, re-indexes under index:surface:{new}:..., and
 * removes the old index:surface:{old}:... key. Returns the updated record.
 */
export async function handleRelabelSurface(req, env) {
  if (!env?.VECTORS) return jsonErr("KV unavailable", 503);
  let body;
  try { body = await req.json(); } catch { return jsonErr("invalid JSON body", 400); }

  const id = String(body.id || "").trim();
  const surface = String(body.surface || "").toLowerCase().trim();
  if (!id) return jsonErr("id required", 400);
  if (!SURFACES.includes(surface)) {
    return jsonErr(`surface must be one of ${SURFACES.join(", ")}`, 400);
  }

  const raw = await env.VECTORS.get(`obs:meta:${id}`);
  if (!raw) return jsonErr(`obs not found: ${id}`, 404);
  const obs = JSON.parse(raw);
  const old = (obs.surface || "other").toLowerCase();
  if (old === surface) {
    return jsonOk({ id, surface, no_change: true });
  }

  // Update record
  obs.surface = surface;
  obs.surface_history = obs.surface_history || [];
  obs.surface_history.push({ from: old, to: surface, at: Date.now(), reason: body.reason || "manual-relabel" });
  await env.VECTORS.put(`obs:meta:${id}`, JSON.stringify(obs));

  // Re-index. Best-effort delete of old index entry (we can't easily find the
  // exact key without the timestamp; rely on the wildcard list+delete pattern).
  const tsMs = Date.parse(obs.timestamp) || Date.now();
  await env.VECTORS.put(`index:surface:${surface}:${tsMs}:${id}`, id);
  try {
    const oldKeys = await env.VECTORS.list({ prefix: `index:surface:${old}:` });
    for (const k of oldKeys.keys) {
      if (k.name.endsWith(`:${id}`)) await env.VECTORS.delete(k.name);
    }
  } catch (e) { /* non-fatal */ }

  return jsonOk({ id, surface, old, history_len: obs.surface_history.length });
}

/**
 * POST /api/backfill-handoffs
 * Body: { dry_run: true|false, limit: 20 }
 *
 * Walks state:session-handoff:list, for any handoff with empty state/next_action/trail,
 * derives content from obs:session:{session_id} (the bucket of obs in that day)
 * and patches the handoff record. Conservative: only fills empty fields, never
 * overwrites.
 */
export async function handleBackfillHandoffs(req, env) {
  if (!env?.VECTORS) return jsonErr("KV unavailable", 503);
  let body = {};
  try { body = await req.json(); } catch {}
  const dryRun = body.dry_run !== false;
  const limit = Math.max(1, Math.min(100, parseInt(body.limit || "20", 10)));

  const listRaw = await env.VECTORS.get("state:session-handoff:list");
  const ids = listRaw ? JSON.parse(listRaw) : [];
  const recent = ids.slice(-limit).reverse(); // newest first

  const patches = [];
  for (const id of recent) {
    const raw = await env.VECTORS.get(`obs:meta:${id}`);
    if (!raw) continue;
    const h = JSON.parse(raw);

    const needsState   = !h.state || String(h.state).trim().length < 4;
    const needsNext    = !h.next_action || String(h.next_action).trim().length < 4;
    const needsTrail   = !Array.isArray(h.trail) || h.trail.length === 0;
    if (!needsState && !needsNext && !needsTrail) continue;

    // Pull the session bucket for this handoff's date
    const sessionId = h.session_id || (h.timestamp ? h.timestamp.slice(0, 10) : null);
    if (!sessionId) continue;
    const sessRaw = await env.VECTORS.get(`obs:session:${sessionId}`);
    const obsIds = sessRaw ? JSON.parse(sessRaw) : [];

    // Derive simple state/next_action/trail from session contents
    const titles = [];
    for (const oid of obsIds.slice(-12)) {
      const oraw = await env.VECTORS.get(`obs:meta:${oid}`);
      if (!oraw) continue;
      const o = JSON.parse(oraw);
      if (o.id === h.id) continue;
      titles.push(o.title);
    }

    const derived = {};
    if (needsState && titles.length) {
      derived.state = `Session covered: ${titles.slice(0, 4).join("; ").slice(0, 280)}`;
    }
    if (needsNext) {
      derived.next_action = "(backfilled — original session ended without explicit next_action)";
    }
    if (needsTrail && titles.length) {
      derived.trail = titles.slice(-6);
    }
    patches.push({ id, sessionId, derived, missing: { needsState, needsNext, needsTrail } });

    if (!dryRun) {
      const updated = { ...h, ...derived, backfilled: true, backfilled_at: Date.now() };
      await env.VECTORS.put(`obs:meta:${id}`, JSON.stringify(updated));
    }
  }

  return jsonOk({ dry_run: dryRun, scanned: recent.length, patched: patches.length, patches });
}

function jsonOk(obj)        { return new Response(JSON.stringify(obj, null, 2), { headers: { "content-type": "application/json" } }); }
function jsonErr(msg, code) { return new Response(JSON.stringify({ error: msg }, null, 2), { status: code, headers: { "content-type": "application/json" } }); }
