// worker/scripts/unit-test-triple-stats.mjs — run: node scripts/unit-test-triple-stats.mjs
import assert from "node:assert";
import {
  countTriplesFromKeys,
  isUncompressedCandidate,
  classifyRawFile,
} from "../src/triple-stats.js";

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); console.log("ok -", name); pass++; }catch(e){ console.error("FAIL -", name, e.message); fail++; } }

// ── countTriplesFromKeys: lint must report a real triple count from triple:* KV keys.
// Stored as triple:{subject}:{predicate}; the per-subject index key triple:{subject}:index
// must NOT be counted as a triple row.
t("counts triple rows, excludes :index keys", () => {
  const keys = [
    { name: "triple:ritik-sharma:role" },
    { name: "triple:ritik-sharma:location" },
    { name: "triple:ritik-sharma:index" },
    { name: "triple:sharpsites:domain" },
    { name: "triple:sharpsites:index" },
  ];
  const r = countTriplesFromKeys(keys);
  assert.strictEqual(r.triples, 3);
  assert.strictEqual(r.subjects, 2);
});
t("zero keys → zero triples, never undefined", () => {
  const r = countTriplesFromKeys([]);
  assert.strictEqual(r.triples, 0);
  assert.strictEqual(r.subjects, 0);
});
t("ignores non-triple keys mixed in", () => {
  const keys = [
    { name: "entity:ritik:meta" },
    { name: "triple:ritik-sharma:role" },
    { name: "obs:meta:abc" },
  ];
  assert.strictEqual(countTriplesFromKeys(keys).triples, 1);
});

// ── isUncompressedCandidate: lint must STOP counting tool-call noise as "uncompressed".
t("tool-bash log is NOT an uncompressed candidate", () => {
  assert.strictEqual(isUncompressedCandidate("2026-05-09-17-30-tool-bash-c180dc.md"), false);
});
t("tool-mcp log is NOT a candidate", () => {
  assert.strictEqual(isUncompressedCandidate("2026-05-23-13-09-tool-mcp-claude-in-chrome-ab12cd.md"), false);
});
t("real handoff IS a candidate", () => {
  assert.strictEqual(isUncompressedCandidate("2026-05-20-session-handoff-v9-hybrid-retrieval.md"), true);
});
t("real knowledge doc IS a candidate", () => {
  assert.strictEqual(isUncompressedCandidate("2026-05-20-copyos-01-foundations-3-axioms.md"), true);
});

// ── classifyRawFile: PRUNE / MERGE / KEEP per SPEC §1.
t("tool-call logs classify PRUNE", () => {
  for (const n of [
    "2026-05-09-17-30-tool-bash-c180dc.md",
    "2026-05-09-17-29-tool-edit-c180dc.md",
    "2026-05-09-tool-write-aa11bb.md",
    "2026-05-23-tool-mcp-claude-in-chrome-ab12cd.md",
    "2026-05-23-tool-mcp-second-brain-ab12cd.md",
    "2026-05-24-tool-mcp-computer-use-screenshot-ab12cd.md",
  ]) assert.strictEqual(classifyRawFile(n).action, "PRUNE", n);
});
t("tiny msg fragment classifies MERGE with session hash", () => {
  const r = classifyRawFile("2026-05-23-13-09-now-based-on-the-giant-cloud-ea00b7d4.md");
  assert.strictEqual(r.action, "MERGE");
  assert.strictEqual(r.session, "ea00b7d4");
  assert.strictEqual(r.date, "2026-05-23");
});
t("session-handoff classifies KEEP", () => {
  assert.strictEqual(classifyRawFile("2026-05-20-session-handoff-v9-hybrid-retrieval.md").action, "KEEP");
});
t("rule doc classifies KEEP", () => {
  assert.strictEqual(classifyRawFile("2026-05-19-rule-auto-capture-handoff-every-message.md").action, "KEEP");
});
t("substantive knowledge doc classifies KEEP", () => {
  assert.strictEqual(classifyRawFile("2026-05-20-copyos-01-foundations-3-axioms-cialdini.md").action, "KEEP");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
