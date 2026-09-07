#!/usr/bin/env node
/**
 * v9 unit tests — exercise the pure helpers (no network, no bindings) so we
 * can verify regex/extractors/RRF/FTS5-query-sanitiser before deploy.
 *
 * Run: node scripts/unit-test-v9-helpers.js
 * Exits non-zero on any failure.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "worker", "src", "index.js"), "utf8");

// Extract the helper functions by name from the worker source by eval'ing in a
// stub global scope. Keeps the helpers as the SINGLE source of truth.
const helperNames = [
  "VERDICT_LINE_RE",
  "extractVerdictBlocks",
  "extractRankingTriples",
  "rrfFuse",
  "normalizeSurface",
  "slugify",
  "entitySlug",
  "factHash",
  "_sanitizeFtsQuery",
  "withTimeout",
];

// Pull the snippets for each helper from the source file. We grep the
// declaration line and balance braces. Functions only.
function carve(name) {
  // const NAME = (regex const)
  const constRe = new RegExp(`^const ${name}\\s*=[^;]+;`, "m");
  const c = src.match(constRe);
  if (c) return c[0];
  // function declarations
  const fnIdx = src.search(new RegExp(`^(async\\s+)?function ${name}\\s*\\(`, "m"));
  if (fnIdx === -1) throw new Error(`${name} not found`);
  let i = src.indexOf("{", fnIdx);
  let depth = 1; i++;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(fnIdx, i);
}

const STOP_WORDS_SNIPPET = src.match(/const STOP_WORDS\s*=[^;]+;/)[0];
const SURFACES_SNIPPET = src.match(/const SURFACES\s*=[^;]+;/)[0];

// Build a sandbox program: paste helpers in order, then assertion block.
let program = "'use strict';\n";
program += STOP_WORDS_SNIPPET + "\n";
program += SURFACES_SNIPPET + "\n";
for (const n of helperNames) program += carve(n) + "\n";

let fails = [];
program += `
function assert(cond, msg) {
  if (!cond) { console.log("FAIL  " + msg); FAILS.push(msg); }
  else       { console.log("PASS  " + msg); }
}
const FAILS = [];

// 1) extractVerdictBlocks — podium + Niche-N
const sample = [
  "Some preamble line.",
  "🥇 Niche 1: Faceless Sales Copy — revenue engine",
  "🥈 Niche 2: AI Avatar Hooks — top-of-funnel",
  "🥉 Niche 3: Long-form Carousel — nurturing",
  "❌ Niche 4: Local SEO — saturated",
  "⏳ Niche 5: Notion Templates — waiting on signal",
  "",
  "End line.",
].join("\\n");
const blocks = extractVerdictBlocks(sample);
assert(blocks.length === 1, "extractVerdictBlocks finds exactly one block");
assert(blocks[0].split("\\n").length === 5, "extractVerdictBlocks preserves all 5 enumerated lines");
assert(blocks[0].includes("🥇 Niche 1: Faceless Sales Copy"), "extractVerdictBlocks preserves podium emoji + niche name verbatim");

// numbered list (Step N)
const stepsSample = "Step 1: install\\nStep 2: configure\\nStep 3: deploy\\n";
const stepsBlocks = extractVerdictBlocks(stepsSample);
assert(stepsBlocks.length === 1 && stepsBlocks[0].split("\\n").length === 3, "extractVerdictBlocks handles Step N");

// Singletons skipped (need ≥2 enumerated lines)
const single = "1. only one item here\\nrandom prose\\n";
assert(extractVerdictBlocks(single).length === 0, "extractVerdictBlocks skips single-line enumerations");

// 2) extractRankingTriples — Niche-N pattern + numbered pattern
const triples = extractRankingTriples(sample);
const rankTriples = triples.filter(t => t.predicate === "hasRank");
const niche3 = triples.filter(t => t.subject === "Niche-3");
assert(rankTriples.length >= 5, "extractRankingTriples emits ≥5 hasRank triples");
assert(niche3.some(t => t.predicate === "hasName" && t.object.includes("Long-form Carousel")), "Niche-3 hasName carries verbatim title");
assert(niche3.some(t => t.predicate === "hasRole" && t.object.includes("nurturing")), "Niche-3 hasRole carries role");

// 3) rrfFuse
const A = [{id:"a"},{id:"b"},{id:"c"}];
const B = [{id:"b"},{id:"d"},{id:"a"}];
const fused = rrfFuse([A.map(x=>({...x,_method:"sem"})), B.map(x=>({...x,_method:"kw"}))]);
assert(fused[0].id === "b" || fused[0].id === "a", "rrfFuse picks an item appearing in both lists first");
const b = fused.find(r => r.id === "b");
assert(b._methods.includes("sem") && b._methods.includes("kw"), "rrfFuse merges _methods across lists");

// 4) normalizeSurface
assert(normalizeSurface("claude-ai-web") === "claude-ai-web", "normalizeSurface accepts canonical");
assert(normalizeSurface("CLAUDE-AI-WEB") === "claude-ai-web", "normalizeSurface lowercases");
assert(normalizeSurface("bogus") === null, "normalizeSurface rejects unknown");
assert(normalizeSurface("") === null, "normalizeSurface rejects empty");

// 5) _sanitizeFtsQuery
assert(_sanitizeFtsQuery("Faceless Sales Copy").includes('"faceless"'), "_sanitizeFtsQuery emits quoted tokens");
const stopOnly = _sanitizeFtsQuery("a the of");
assert(stopOnly === null || stopOnly === "", "_sanitizeFtsQuery returns null/empty when only stop words");
assert(!/[^\\w\\s\\":()]/.test(_sanitizeFtsQuery("foo'bar; drop table--").replace(/"/g,'')), "_sanitizeFtsQuery strips SQL-control chars");

// 6) withTimeout — async helper
(async () => {
  // resolves before timeout → returns value
  const fast = await withTimeout(Promise.resolve(42), 500, "fallback");
  assert(fast === 42, "withTimeout returns value when promise resolves first");

  // times out → returns fallback
  const slow = await withTimeout(new Promise(r => setTimeout(() => r("late"), 300)), 50, "fallback");
  assert(slow === "fallback", "withTimeout returns fallback when promise outlasts ms");

  if (FAILS.length === 0) { console.log("\\nALL UNIT TESTS GREEN (" + 0 + " failures)"); process.exit(0); }
  console.log("\\n" + FAILS.length + " unit test failures:"); for (const f of FAILS) console.log("  - " + f);
  process.exit(1);
})();
`;

const tmp = path.join("/tmp", `v9-unit-${Date.now()}.js`);
fs.writeFileSync(tmp, program);
const r = require("child_process").spawnSync(process.argv[0], [tmp], { stdio: "inherit" });
fs.unlinkSync(tmp);
process.exit(r.status || 0);
