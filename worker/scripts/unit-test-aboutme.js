// worker/scripts/unit-test-aboutme.js
const assert = require("assert");
const { clusterTopics, detectTensions, composeProfile, isNoiseTitle } = require("../src/aboutme-util.js");
let pass=0,fail=0; function t(n,f){try{f();console.log("ok -",n);pass++;}catch(e){console.error("FAIL -",n,e.message);fail++;}}

t("isNoiseTitle catches tool logs / hex ids / timestamps", () => {
  assert.ok(isNoiseTitle("2026-06-01-22:00-tool-bash-61a68a"));
  assert.ok(isNoiseTitle("2026-06-01-02-35-capture-everything-61a68a2e"));
  assert.ok(isNoiseTitle("TEST v9.5.0 embed verify"));
  assert.ok(!isNoiseTitle("ExampleProject outreach plan"));
});

t("clusterTopics drops noise, keeps real topics", () => {
  const obs = [
    {title:"2026-06-01-tool-bash-61a68a"},{title:"2026-06-01-tool-edit-61a68a"},
    {title:"ExampleProject outreach plan"},{title:"ExampleProject pricing strategy"},
    {title:"ExampleProject tier 1 customers"},
  ];
  const c = clusterTopics(obs);
  assert.ok(!c.some(x => /tool|bash|edit|61a68a|2026/.test(x.topic)), "no noise tokens");
  assert.ok(c.some(x => /ExampleProject/i.test(x.topic)), "real topic kept");
});

t("detectTensions ranks contradictions before loops, no noise loops", () => {
  const rules = ["Do manual ExampleProject outreach BEFORE building automation"];
  const recent = [
    {title:"Built the 9am outreach routine"},
    {title:"2026-06-01-tool-bash-61a68a"},{title:"2026-06-01-tool-bash-61a68a"},
  ];
  const tensions = detectTensions(rules, recent);
  assert.match(tensions[0], /Contradiction/);
  assert.ok(!tensions.some(x => /tool|bash|61a68a/.test(x)), "no noise loop tensions");
});

t("clusterTopics groups recurring titles", () => {
  const obs = [
    {title:"ExampleProject outreach plan"},{title:"ExampleProject tier 1 customers"},
    {title:"ExampleProject pricing"},{title:"Idebenone dose"},
  ];
  const c = clusterTopics(obs);
  const sharp = c.find(x => /ExampleProject/i.test(x.topic));
  assert.ok(sharp && sharp.count >= 3, "ExampleProject loop detected");
});

t("detectTensions surfaces rule-vs-action contradiction (adversarial)", () => {
  const rules = ["Do manual ExampleProject Tier 1 outreach BEFORE building automation"];
  const recent = [{title:"Built the 9am outreach routine", ts:"2026-06-01"}];
  const tensions = detectTensions(rules, recent);
  assert.ok(tensions.length >= 1, "must surface a tension");
  assert.match(tensions.join(" "), /ExampleProject|automation|outreach|routine/i);
});

t("detectTensions NOT empty when planted loop exists", () => {
  const rules = ["Ship before polishing"];
  const recent = [{title:"Refactored polish pass again"},{title:"Another polish refactor"}];
  const tensions = detectTensions(rules, recent);
  assert.notStrictEqual(tensions.length, 0);
});

t("composeProfile always includes Tensions section, never empty when loops exist", () => {
  const md = composeProfile({
    identity:["Founder ExampleProject"], beliefs:["Ship first"],
    active:["open: ExampleProject outreach"],
    tensions:["Building automation before first manual sale"],
  });
  assert.match(md, /## Tensions/);
  assert.match(md, /automation before first manual sale/);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
