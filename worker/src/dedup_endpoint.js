/**
 * U1c — Dedup pass.
 *
 * Endpoint: POST /api/dedup-scan?window_days=7&threshold=0.95&dry_run=true
 *
 * Walks obs:recent (cap 200), groups by 7-day window, fetches Vectorize
 * embeddings for each, computes pairwise cosine, and for any pair > threshold:
 *   - dry_run=true: log to state:dedup:proposals (no writes)
 *   - dry_run=false: mark the OLDER obs as superseded_by the NEWER, preserving
 *     bidirectional link via `merged_into` field.
 *
 * Does NOT delete. Marking-only — older still readable via direct id, but
 * filtered out of obs:recent, home-feed, list_recent, ask, query.
 *
 * Drop this function into index.js (anywhere after readObservation). Wire
 * a route in fetch handler:
 *
 *   if (path === "/api/dedup-scan") return handleDedupScan(req, env);
 *
 * Run it manually:
 *   curl -X POST 'https://lnm-brain.../api/dedup-scan?dry_run=true'
 *
 * Then inspect the proposals KV:
 *   curl 'https://lnm-brain.../api/dedup-proposals'
 *
 * Apply when satisfied:
 *   curl -X POST 'https://lnm-brain.../api/dedup-scan?dry_run=false'
 */

export async function handleDedupScan(req, env) {
  if (!env?.VECTORS || !env?.VECTORIZE) {
    return new Response(JSON.stringify({ error: "KV or Vectorize unavailable" }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(req.url);
  const windowDays = Math.max(1, parseInt(url.searchParams.get("window_days") || "7", 10));
  const threshold  = Math.max(0.5, Math.min(0.999, parseFloat(url.searchParams.get("threshold") || "0.95")));
  const dryRun     = url.searchParams.get("dry_run") !== "false";

  const recRaw = await env.VECTORS.get("obs:recent");
  const ids = recRaw ? JSON.parse(recRaw) : [];
  if (ids.length === 0) {
    return jsonOk({ scanned: 0, pairs_over_threshold: 0, dry_run: dryRun });
  }

  // Load obs:meta for every recent id. Skip already-superseded.
  const obsRecords = [];
  for (const id of ids) {
    const raw = await env.VECTORS.get(`obs:meta:${id}`);
    if (!raw) continue;
    const o = JSON.parse(raw);
    if (o.superseded_by || o.merged_into) continue;
    obsRecords.push(o);
  }

  // Group by IST date window (sliding 7-day buckets keyed on ISO yyyy-mm-dd)
  const windowMs = windowDays * 86400000;
  obsRecords.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));

  const proposals = [];
  for (let i = 0; i < obsRecords.length; i++) {
    const a = obsRecords[i];
    const aTs = Date.parse(a.timestamp) || 0;
    for (let j = i + 1; j < obsRecords.length; j++) {
      const b = obsRecords[j];
      const bTs = Date.parse(b.timestamp) || 0;
      if (bTs - aTs > windowMs) break; // sorted, no further pairs in window

      // Fetch both vectors. Vectorize ids = obsIdFromWikiPath result.
      // Some obs are raw-only and may not have a vector — skip silently.
      const vid_a = a.wiki_path ? a.wiki_path.replace(/[^a-z0-9]/gi, "-") : null;
      const vid_b = b.wiki_path ? b.wiki_path.replace(/[^a-z0-9]/gi, "-") : null;
      if (!vid_a || !vid_b) continue;

      let va, vb;
      try {
        const vres = await env.VECTORIZE.getByIds([vid_a, vid_b]);
        if (!vres || vres.length < 2) continue;
        const map = Object.fromEntries(vres.map(v => [v.id, v.values]));
        va = map[vid_a]; vb = map[vid_b];
      } catch { continue; }
      if (!va || !vb) continue;

      const sim = cosine(va, vb);
      if (sim >= threshold) {
        // Newer wins; older = merged
        const [older, newer] = aTs <= bTs ? [a, b] : [b, a];
        proposals.push({
          older_id: older.id,
          older_title: older.title,
          older_ts: older.timestamp,
          newer_id: newer.id,
          newer_title: newer.title,
          newer_ts: newer.timestamp,
          similarity: Number(sim.toFixed(4)),
        });
      }
    }
  }

  // Write proposals to KV always (so user can review even on dry_run)
  await env.VECTORS.put(
    "state:dedup:proposals",
    JSON.stringify({
      built_at: new Date().toISOString(),
      window_days: windowDays,
      threshold,
      proposals,
    }),
    { expirationTtl: 86400 * 30 }
  );

  if (!dryRun) {
    let applied = 0;
    for (const p of proposals) {
      const olderRaw = await env.VECTORS.get(`obs:meta:${p.older_id}`);
      if (!olderRaw) continue;
      const older = JSON.parse(olderRaw);
      if (older.superseded_by || older.merged_into) continue;
      older.merged_into = p.newer_id;
      older.merged_at = Date.now();
      older.merge_similarity = p.similarity;
      await env.VECTORS.put(`obs:meta:${p.older_id}`, JSON.stringify(older));

      // Add backlink on newer
      const newerRaw = await env.VECTORS.get(`obs:meta:${p.newer_id}`);
      if (newerRaw) {
        const newer = JSON.parse(newerRaw);
        newer.merged_from = newer.merged_from || [];
        if (!newer.merged_from.includes(p.older_id)) newer.merged_from.push(p.older_id);
        await env.VECTORS.put(`obs:meta:${p.newer_id}`, JSON.stringify(newer));
      }
      applied++;
    }
    return jsonOk({
      scanned: obsRecords.length, pairs_over_threshold: proposals.length,
      applied, dry_run: false, proposals,
    });
  }

  return jsonOk({
    scanned: obsRecords.length, pairs_over_threshold: proposals.length,
    dry_run: true, proposals,
    next_step: "POST same endpoint with dry_run=false to apply",
  });
}

export async function handleDedupProposals(req, env) {
  const raw = await env.VECTORS.get("state:dedup:proposals");
  if (!raw) return jsonOk({ proposals: [], note: "run /api/dedup-scan first" });
  return new Response(raw, { headers: { "content-type": "application/json" } });
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// jsonOk helper — assumes index.js has its own; if importing this file
// standalone, replace with a local copy.
function jsonOk(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
