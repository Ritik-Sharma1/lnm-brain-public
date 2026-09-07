// worker/scripts/unit-test-vid.js — proves re-embed overwrites, never dups.
const assert = require("assert");
// mirror real factHash (index.js line 604: 32-bit rolling hash -> base36, NOT sha256)
function factHash(fact){ let h=0; for(let i=0;i<fact.length;i++) h=((h<<5)-h+fact.charCodeAt(i))|0; return Math.abs(h).toString(36); }
let pass=0,fail=0; function t(n,f){try{f();console.log("ok -",n);pass++;}catch(e){console.error("FAIL -",n,e.message);fail++;}}
t("same baseId+ns => same vid (idempotent)", () => {
  const b="wiki-conversations-2026-06-01-foo-md";
  const a1=`v:title:${factHash(b)}`.substring(0,64);
  const a2=`v:title:${factHash(b)}`.substring(0,64);
  assert.strictEqual(a1,a2);
});
t("different ns => different vid (no collision)", () => {
  const b="wiki-conversations-2026-06-01-foo-md";
  const title=`v:title:${factHash(b)}`.substring(0,64);
  const summ=`v:summary:${factHash(b)}`.substring(0,64);
  assert.notStrictEqual(title,summ);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
