#!/usr/bin/env node
// Reconciler pure-helper tests. Run: node scripts/unit-test-reconciler.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname,"..","worker","src","index.js"),"utf8");
function carve(name){
  const idx = src.search(new RegExp(`^(async\\s+)?function ${name}\\s*\\(`,"m"));
  if(idx===-1) throw new Error(name+" not found");
  let i=src.indexOf("{",idx),d=1;i++;
  while(d>0&&i<src.length){const c=src[i++];if(c==="{")d++;else if(c==="}")d--;}
  return src.slice(idx,i);
}
const FAILS=[];
function assert(c,m){console.log((c?"PASS  ":"FAIL  ")+m);if(!c)FAILS.push(m);}

// Task 1: hubKeyForPath
eval(carve("hubKeyForPath"));
assert(hubKeyForPath("wiki/conversations/2026-05-31-foo.md")==="2026-05","dated → YYYY-MM");
assert(hubKeyForPath("wiki/entities/ritik-sharma.md")==="_entities","undated entity → _entities");
assert(hubKeyForPath("handoffs/2026-05-17-handoff.md")==="2026-05","dated handoff → YYYY-MM");
assert(hubKeyForPath("wiki/topics/weird.md")==="_topics","undated topic → _topics");

// Task 2: hasIndexBacklink + ensureBacklinkBlock
eval(carve("hasIndexBacklink")); eval(carve("ensureBacklinkBlock"));
assert(hasIndexBacklink("foo [[index]] bar")===true,"detects [[index]]");
assert(hasIndexBacklink("no link")===false,"absence → false");
const a=ensureBacklinkBlock("body text","2026-05");
assert(a.includes("## Backlinks")&&a.includes("[[index]] · [[2026-05]]"),"appends backlink block w/ month");
assert(ensureBacklinkBlock("x [[index]] y","2026-05")==="x [[index]] y","idempotent: unchanged if present");
assert(!ensureBacklinkBlock("body",null).includes("· [[null]]"),"no month → no broken month link");

// Task 3: buildHubFile
eval(carve("buildHubFile"));
const hub=buildHubFile("2026-05",["2026-05-31-foo.md","2026-05-01-bar.md"]);
assert(hub.includes("- [[2026-05-01-bar]]")&&hub.includes("- [[2026-05-31-foo]]"),"lists both files, no .md");
assert(hub.indexOf("bar")<hub.indexOf("foo"),"sorted deterministically");
assert(hub.trimEnd().endsWith("[[index]]"),"ends with index backlink");
assert(hub.includes("type: monthly-index")||hub.includes("type: hub-index"),"has frontmatter type");
assert(buildHubFile("2026-05",["a.md"])===buildHubFile("2026-05",["a.md"]),"pure/deterministic");

// Task 4: buildIndexSection
eval(carve("buildIndexSection"));
const idx1=buildIndexSection("# Lnm-Brain Index\n",["2026-05","_entities"]);
assert(idx1.includes("## Indexes"),"adds ## Indexes");
assert(idx1.includes("[[wiki/_indexes/2026-05|2026-05]]")&&idx1.includes("[[wiki/_indexes/_entities|_entities]]"),"links all hubs");
const idx2=buildIndexSection(idx1,["2026-05","_entities"]);
assert(idx2===idx1,"idempotent: same hubs → unchanged");
const idx3=buildIndexSection(idx1,["2026-05","_entities","2026-06"]);
assert(idx3.includes("2026-06")&&(idx3.match(/## Indexes/g)||[]).length===1,"adds new hub, single Indexes section");

console.log(FAILS.length?`\n${FAILS.length} FAIL(S): ${FAILS.join(", ")}`:"\nALL PASS");
process.exit(FAILS.length?1:0);
