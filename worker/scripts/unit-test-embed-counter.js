// worker/scripts/unit-test-embed-counter.js
const assert = require("assert");
const { summarizeEmbedResult } = require("../src/embed-util.js");

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); console.log("ok -", name); pass++; }catch(e){ console.error("FAIL -", name, e.message); fail++; } }

t("counts multi + single vectors", () => {
  const r = summarizeEmbedResult([{ns:"title"},{ns:"summary"},{ns:"content:0"}], true);
  assert.strictEqual(r.vectors_written, 4);   // 3 multi + 1 single
  assert.strictEqual(r.embed_mode, "ok");
});
t("zero multi but single ok", () => {
  const r = summarizeEmbedResult([], true);
  assert.strictEqual(r.vectors_written, 1);
});
t("error path surfaces", () => {
  const r = summarizeEmbedResult(new Error("dim mismatch: got 384"), false);
  assert.strictEqual(r.vectors_written, 0);
  assert.strictEqual(r.embed_mode, "error");
  assert.match(r.error, /dim mismatch: got 384/);
});

const { assertVectorDims } = require("../src/embed-util.js");
t("assertVectorDims passes on 1024", () => {
  assertVectorDims([new Array(1024).fill(0)], 1024);
});
t("assertVectorDims throws on 384", () => {
  assert.throws(() => assertVectorDims([new Array(384).fill(0)], 1024), /dim mismatch.*got 384.*want 1024/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
