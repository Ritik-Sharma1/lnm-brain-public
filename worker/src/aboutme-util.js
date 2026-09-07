// worker/src/aboutme-util.js — pure, no bindings. Mirror logic also lives in
// index.js regenAboutMe (Workers ESM can't require this at runtime).

// Mechanical tokens that carry no behavioral signal — tool names, log scaffolding,
// dates, caveman-mode chatter. Clustering on these produced junk loops ("tool",
// "bash", "2026", hex session ids) instead of real patterns.
const NOISE_TOKENS = new Set([
  "the","a","an","and","or","to","of","for","in","on","my","is","plan","day",
  "tool","bash","edit","write","read","grep","mcp","this","that","with","from",
  "claude","code","second","brain","session","handoff","switch","mode","caveman",
  "ultra","lite","full","tell","about","latest","version","update","doing","something",
  "whenever","maximum","compression","search","semantic","keyword","base","directory",
  "users","skill","built","yesterday","now","can","you","please","want","need",
  "2024","2025","2026","2027","msg","obs","node","file","line","step","task",
]);

// A title is noise if it's an auto-captured tool log, a hex session id, or a
// timestamped capture-of-a-capture. These pollute pattern detection.
function isNoiseTitle(title) {
  const t = (title || "").toLowerCase();
  if (!t) return true;
  if (/\btool[-_ ]/.test(t)) return true;              // "2026-...-tool-bash-..."
  if (/\b[0-9a-f]{6,}\b/.test(t)) return true;          // hex session ids (61a68a2e)
  if (/^\d{4}-\d{2}-\d{2}[-: ]\d{2}/.test(t)) return true; // raw timestamp-led capture
  if (/mcp__/.test(t)) return true;                     // captured MCP call logs
  if (/^test\b/.test(t)) return true;                   // E2E test notes
  return false;
}

// Group MEANINGFUL observation titles into topic clusters by shared token.
// Noise titles are dropped before clustering.
function clusterTopics(observations) {
  const buckets = {};
  for (const o of observations) {
    if (isNoiseTitle(o.title)) continue;
    const toks = (o.title || "").toLowerCase().split(/[^a-z0-9]+/)
      .filter(w => w.length > 3 && !NOISE_TOKENS.has(w) && !/^\d+$/.test(w));
    for (const w of toks) (buckets[w] = buckets[w] || []).push(o.title);
  }
  return Object.entries(buckets)
    .map(([topic, titles]) => ({ topic, count: titles.length, titles }))
    .filter(x => x.count >= 2)
    .sort((a, b) => b.count - a.count);
}

// Adversarial: flag where recent actions contradict committed rules first
// (the real signal), then add a few genuine recurring loops. Caps loop noise.
function detectTensions(rules, recentActions) {
  const ruleTensions = [];
  const clean = recentActions.filter(a => !isNoiseTitle(a.title));
  for (const rule of rules) {
    const rl = rule.toLowerCase();
    const m = rl.match(/before (?:building|doing|automating)?\s*(\w[\w\s]{2,30})/);
    const guarded = m ? m[1].trim() : null;
    for (const a of clean) {
      const at = (a.title || "").toLowerCase();
      if (guarded && (at.includes("automat") || at.includes("routine") || at.includes("built")) &&
          rl.split(/\s+/).some(tok => tok.length > 4 && at.includes(tok))) {
        ruleTensions.push(`Contradiction — rule "${rule}" vs recent action "${a.title}"`);
      }
    }
  }
  // recurring-loop tension: top meaningful clusters only, capped at 5.
  const loops = clusterTopics(clean).filter(c => c.count >= 2).slice(0, 5)
    .map(c => `Recurring focus: "${c.topic}" (${c.count}x recent) — finishing it?`);
  return [...new Set([...ruleTensions, ...loops])];
}

function composeProfile({ identity = [], beliefs = [], active = [], tensions = [] }) {
  const sec = (h, items) => `## ${h}\n${items.length ? items.map(i => `- ${i}`).join("\n") : "_none_"}\n`;
  return [
    "# About Brain Owner — synthesized self-model",
    "",
    sec("Identity & Facts", identity),
    sec("Beliefs & Operating Rules", beliefs),
    sec("Active State", active),
    sec("Tensions / Open Loops", tensions),
  ].join("\n");
}

module.exports = { clusterTopics, detectTensions, composeProfile, isNoiseTitle };
