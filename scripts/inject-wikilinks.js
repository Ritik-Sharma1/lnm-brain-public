#!/usr/bin/env node
/**
 * inject-wikilinks.js — Backfill [[index]] + [[YYYY-MM]] backlinks into every
 * markdown file under raw/, wiki/, handoffs/ so the Obsidian graph shows
 * relations instead of orphan clouds.
 *
 * Rules:
 *   - Every .md gets a `## Backlinks` section at end containing:
 *       [[index]] · [[YYYY-MM]]
 *   - YYYY-MM is parsed from filename prefix (e.g. 2026-05-17-foo.md → 2026-05)
 *     or from `created:` frontmatter as fallback.
 *   - index.md additionally gets a `## Monthly Indexes` section linking
 *     [[wiki/_indexes/YYYY-MM]] for every month that has session files.
 *   - Idempotent: skips files that already contain `## Backlinks`.
 *
 * Usage:
 *   node scripts/inject-wikilinks.js           # dry-run, prints plan
 *   node scripts/inject-wikilinks.js --apply   # writes files
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const TARGET_DIRS = ["raw", "wiki", "handoffs", "docs", "meta", "web", "graph"];
// Loose root-level .md files also get backlinked (except the hub index.md and
// machine-generated dotfiles). Anything new dropped at repo root joins the graph.
const ROOT_MD_SKIP = new Set(["index.md"]);

function rootMarkdownFiles() {
  return fs.readdirSync(ROOT)
    .filter(n => n.endsWith(".md") && !ROOT_MD_SKIP.has(n))
    .map(n => path.join(ROOT, n));
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function monthFromFile(filePath, content) {
  const base = path.basename(filePath);
  const m1 = base.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (m1) return `${m1[1]}-${m1[2]}`;
  const m2 = content.match(/^created:\s*(\d{4})-(\d{2})-\d{2}/m);
  if (m2) return `${m2[1]}-${m2[2]}`;
  return null;
}

function buildBacklinkBlock(month) {
  const links = ["[[index]]"];
  if (month) links.push(`[[${month}]]`);
  return `\n\n## Backlinks\n${links.join(" · ")}\n`;
}

function processFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("## Backlinks")) return { rel, action: "skip-existing" };
  const month = monthFromFile(filePath, content);
  const block = buildBacklinkBlock(month);
  const next = content.replace(/\s+$/, "") + block;
  if (APPLY) fs.writeFileSync(filePath, next);
  return { rel, action: APPLY ? "wrote" : "would-write", month: month || "(none)" };
}

function collectMonths(files) {
  const set = new Set();
  for (const f of files) {
    const m = monthFromFile(f, "");
    if (m) set.add(m);
  }
  return [...set].sort();
}

function patchRootIndex(months) {
  const indexPath = path.join(ROOT, "index.md");
  if (!fs.existsSync(indexPath)) return { rel: "index.md", action: "missing" };
  let content = fs.readFileSync(indexPath, "utf8");

  const monthBlock =
    `## Monthly Indexes\n` +
    months.map(m => `- [[wiki/_indexes/${m}|${m}]]`).join("\n") + "\n";

  if (content.includes("## Monthly Indexes")) {
    content = content.replace(/## Monthly Indexes[\s\S]*?(?=\n## |\n# |$)/, monthBlock);
  } else {
    content = content.replace(/\s+$/, "") + "\n\n" + monthBlock;
  }
  if (APPLY) fs.writeFileSync(indexPath, content);
  return { rel: "index.md", action: APPLY ? "patched-monthly" : "would-patch-monthly", months: months.length };
}

function sessionsForMonth(month, allFiles) {
  return allFiles
    .filter(f => path.basename(f).startsWith(`${month}-`) && f.includes(`${path.sep}wiki${path.sep}conversations${path.sep}`))
    .map(f => path.basename(f).replace(/\.md$/, ""))
    .sort();
}

function patchMonthlyIndexes(months, allFiles) {
  const dir = path.join(ROOT, "wiki", "_indexes");
  if (APPLY && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const results = [];
  for (const m of months) {
    const p = path.join(dir, `${m}.md`);
    const sessions = sessionsForMonth(m, allFiles);
    if (fs.existsSync(p)) {
      let content = fs.readFileSync(p, "utf8");
      if (content.includes("## Backlinks")) {
        results.push({ rel: path.relative(ROOT, p), action: "skip-existing" });
        continue;
      }
      content = content.replace(/\s+$/, "") + `\n\n## Backlinks\n[[index]]\n`;
      if (APPLY) fs.writeFileSync(p, content);
      results.push({ rel: path.relative(ROOT, p), action: APPLY ? "wrote-backlink" : "would-write-backlink" });
    } else {
      const lines = [
        "---",
        "type: monthly-index",
        `month: ${m}`,
        `sessions: ${sessions.length}`,
        "---",
        "",
        `# Session Index — ${m}`,
        "",
        `Auto-generated. ${sessions.length} sessions this month.`,
        "",
        "## Sessions",
        "",
        ...sessions.map(s => `- [[${s}]]`),
        "",
        "## Backlinks",
        "[[index]]",
        "",
      ].join("\n");
      if (APPLY) fs.writeFileSync(p, lines);
      results.push({ rel: path.relative(ROOT, p), action: APPLY ? "created" : "would-create", sessions: sessions.length });
    }
  }
  return results;
}

// Nucleus guard: [[index]] must resolve to exactly ONE file (root index.md).
// A second md whose basename lowercases to "index" anywhere in the vault would
// hijack [[index]] for nearby files (Obsidian resolves by nearest basename),
// splitting the LNM Brain nucleus. Fail loud so it never silently happens again.
function assertSingleNucleus() {
  const dirs = ["raw", "wiki", "handoffs", "docs", "meta", "web", "graph"];
  const hits = [];
  for (const d of dirs) {
    for (const f of walk(path.join(ROOT, d))) {
      if (path.basename(f).toLowerCase() === "index.md") hits.push(path.relative(ROOT, f));
    }
  }
  for (const n of fs.readdirSync(ROOT)) {
    if (n.toLowerCase() === "index.md") hits.push(n);
  }
  if (hits.length > 1) {
    console.error("NUCLEUS SPLIT — multiple files resolve to [[index]]:");
    hits.forEach(h => console.error("  " + h));
    console.error("Rename all but root index.md (e.g. _astrology-index.md). Aborting.");
    process.exit(1);
  }
}

function main() {
  assertSingleNucleus();
  const allFiles = [];
  for (const d of TARGET_DIRS) allFiles.push(...walk(path.join(ROOT, d)));
  allFiles.push(...rootMarkdownFiles());
  const results = allFiles.map(processFile);
  const months = collectMonths(allFiles);
  const monthlyResults = patchMonthlyIndexes(months, allFiles);
  const indexResult = patchRootIndex(months);

  const summary = results.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    mode: APPLY ? "APPLY" : "DRY-RUN",
    files_scanned: allFiles.length,
    summary,
    months_found: months,
    monthly_index_patched: monthlyResults,
    root_index: indexResult,
  }, null, 2));
}

main();
