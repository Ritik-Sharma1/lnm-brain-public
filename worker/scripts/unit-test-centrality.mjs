// worker/scripts/unit-test-centrality.mjs — run: node scripts/unit-test-centrality.mjs
import assert from "node:assert";
import { rankEntitiesByCentrality } from "../src/triple-stats.js";

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); console.log("ok -", name); pass++; }catch(e){ console.error("FAIL -", name, e.message); fail++; } }

// ── rankEntitiesByCentrality: score = fact_count + 2*triple_count, sorted desc.
// Triples weighted 2x (structured relation = stronger connectedness signal than a free-text fact),
// mirroring the categoryBoost precedent of ranking structured data higher.
t("scores fact_count + 2*triple_count", () => {
  const metas = [{ slug: "a", name: "A", total_facts: 3 }];
  const triples = { a: 4 };
  const r = rankEntitiesByCentrality(metas, triples);
  assert.strictEqual(r[0].centrality_score, 3 + 2 * 4); // 11
  assert.strictEqual(r[0].fact_count, 3);
  assert.strictEqual(r[0].triple_count, 4);
  assert.strictEqual(r[0].entity, "A");
  assert.strictEqual(r[0].slug, "a");
});

t("sorts descending by centrality_score", () => {
  const metas = [
    { slug: "low", name: "Low", total_facts: 1 },   // score 1
    { slug: "high", name: "High", total_facts: 2 }, // score 2 + 2*5 = 12
    { slug: "mid", name: "Mid", total_facts: 4 },   // score 4 + 2*1 = 6
  ];
  const triples = { high: 5, mid: 1 };
  const r = rankEntitiesByCentrality(metas, triples);
  assert.deepStrictEqual(r.map(x => x.slug), ["high", "mid", "low"]);
});

t("entity with zero triples still ranked (triple_count 0)", () => {
  const metas = [{ slug: "x", name: "X", total_facts: 5 }];
  const r = rankEntitiesByCentrality(metas, {});
  assert.strictEqual(r[0].triple_count, 0);
  assert.strictEqual(r[0].centrality_score, 5);
});

t("missing total_facts treated as 0, never NaN", () => {
  const metas = [{ slug: "y", name: "Y" }]; // no total_facts
  const r = rankEntitiesByCentrality(metas, { y: 2 });
  assert.strictEqual(r[0].fact_count, 0);
  assert.strictEqual(r[0].centrality_score, 4); // 0 + 2*2
});

t("empty input → empty array, never undefined", () => {
  assert.deepStrictEqual(rankEntitiesByCentrality([], {}), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
