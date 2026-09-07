#!/usr/bin/env node
/**
 * gen-entity-stubs.js — Walk every markdown file, extract [[Entity]] wikilinks,
 * create wiki/entities/<Entity>.md stub for each unresolved entity so the
 * Obsidian graph stops showing them as ghost orphan nodes.
 *
 * Rules:
 *   - Skip wikilinks that look like file paths (contain "/"), dates (YYYY-MM*),
 *     or wiki targets already resolved.
 *   - One stub per unique entity. Stub body: frontmatter + `# Name` +
 *     "Referenced N times across the brain." + `## Backlinks\n[[index]]`.
 *   - Idempotent: skip if entity stub already exists.
 *
 * Usage:
 *   node scripts/gen-entity-stubs.js           # dry-run
 *   node scripts/gen-entity-stubs.js --apply   # writes wiki/entities/*.md
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const SCAN_DIRS = ["raw", "wiki", "handoffs"];
const ENTITY_DIR = path.join(ROOT, "wiki", "entities");

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

function isExcluded(name) {
  // Already-resolved targets / file paths / date buckets
  if (name.includes("/")) return true;
  if (name.includes("|")) return true; // [[path|alias]] — handled separately
  if (/^\d{4}-\d{2}/.test(name)) return true; // YYYY-MM* (monthly indexes — already created)
  if (name === "index") return true;
  if (name.length > 80) return true; // huge strings, junk
  if (name.length < 2) return true;
  return false;
}

function sanitizeFilename(name) {
  // Obsidian-safe: strip chars illegal in macOS/GitHub paths
  return name.replace(/[\/\\:*?"<>|]/g, "-").trim();
}

function existingEntityStubs() {
  if (!fs.existsSync(ENTITY_DIR)) return new Set();
  return new Set(
    fs.readdirSync(ENTITY_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(/\.md$/, ""))
  );
}

function existingVaultFiles() {
  // Any .md file basename anywhere in vault — if a wikilink matches, it's resolved
  const set = new Set();
  for (const d of SCAN_DIRS) {
    for (const f of walk(path.join(ROOT, d))) {
      set.add(path.basename(f).replace(/\.md$/, ""));
    }
  }
  set.add("index");
  return set;
}

function main() {
  const allFiles = [];
  for (const d of SCAN_DIRS) allFiles.push(...walk(path.join(ROOT, d)));

  const counts = new Map(); // entity -> ref count
  for (const f of allFiles) {
    const content = fs.readFileSync(f, "utf8");
    for (const m of content.matchAll(/\[\[([^\[\]\n]+?)\]\]/g)) {
      let raw = m[1].trim();
      // Take alias side if present: [[path|alias]] -> use alias side as display, but link target is path
      if (raw.includes("|")) {
        const [target] = raw.split("|");
        raw = target.trim();
      }
      if (isExcluded(raw)) continue;
      counts.set(raw, (counts.get(raw) || 0) + 1);
    }
  }

  const resolved = existingVaultFiles();
  const stubs = existingEntityStubs();

  const toCreate = [];
  for (const [name, n] of counts) {
    const safe = sanitizeFilename(name);
    if (resolved.has(safe)) continue;       // already a real file somewhere
    if (stubs.has(safe)) continue;          // entity stub already exists
    toCreate.push({ name, safe, refs: n });
  }
  toCreate.sort((a, b) => b.refs - a.refs);

  if (APPLY) {
    if (!fs.existsSync(ENTITY_DIR)) fs.mkdirSync(ENTITY_DIR, { recursive: true });
    for (const e of toCreate) {
      const stub = [
        "---",
        "type: entity-stub",
        `name: ${e.name}`,
        `references: ${e.refs}`,
        `auto_generated: true`,
        "---",
        "",
        `# ${e.name}`,
        "",
        `Entity referenced ${e.refs} times across the Lnm-Brain. Auto-generated stub for graph coherence.`,
        "",
        "## Backlinks",
        "[[index]]",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(ENTITY_DIR, `${e.safe}.md`), stub);
    }
  }

  console.log(JSON.stringify({
    mode: APPLY ? "APPLY" : "DRY-RUN",
    unique_entities: counts.size,
    already_resolved: counts.size - toCreate.length,
    stubs_to_create: toCreate.length,
    top_20: toCreate.slice(0, 20),
  }, null, 2));
}

main();
