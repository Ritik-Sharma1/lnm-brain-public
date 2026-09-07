// worker/scripts/unit-test-cosine.mjs — run: node scripts/unit-test-cosine.mjs
import assert from "node:assert";
import { cosineSim } from "../src/consolidation.js";

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); console.log("ok -", name); pass++; }catch(e){ console.error("FAIL -", name, e.message); fail++; } }
function near(a, b, eps = 1e-9){ assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`); }

t("identical vectors → 1", () => {
  near(cosineSim([1, 2, 3], [1, 2, 3]), 1);
});

t("orthogonal vectors → 0", () => {
  near(cosineSim([1, 0], [0, 1]), 0);
});

t("opposite vectors → -1", () => {
  near(cosineSim([1, 2], [-1, -2]), -1);
});

t("scale-invariant (direction only)", () => {
  near(cosineSim([2, 4, 6], [1, 2, 3]), 1);
});

t("zero vector → 0, never NaN (guarded denominator)", () => {
  const r = cosineSim([0, 0, 0], [1, 2, 3]);
  assert.ok(!Number.isNaN(r), "must not be NaN");
  assert.strictEqual(r, 0);
});

t("known value: [1,1,0] vs [1,0,0] = 1/sqrt(2)", () => {
  near(cosineSim([1, 1, 0], [1, 0, 0]), 1 / Math.sqrt(2));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
