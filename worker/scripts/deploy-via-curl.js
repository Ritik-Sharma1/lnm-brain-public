#!/usr/bin/env node
// Fallback deploy through the Cloudflare REST API, using curl as the transport.
// Use it only when `npx wrangler deploy` fails with ETIMEDOUT talking to
// api.cloudflare.com (seen on some networks where Node's fetch can't connect but
// curl can). Normal installs should use `npx wrangler deploy`.
//
// Required env:
//   CLOUDFLARE_API_TOKEN   token with "Edit Cloudflare Workers" permission
//   CLOUDFLARE_ACCOUNT_ID  your account id (dashboard → Workers & Pages → right sidebar)
// Everything else (worker name, GITHUB_REPO, KV/D1/Vectorize ids, cron) is read from
// wrangler.toml. Override with LNM_WORKER_NAME, LNM_KV_ID, LNM_D1_ID, LNM_VECTORIZE_INDEX.
// Secrets are never sent: secrets already set with `wrangler secret put` are kept.
//
// Usage (from worker/):  node scripts/deploy-via-curl.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TOK = process.env.CLOUDFLARE_API_TOKEN;
const ACC = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!TOK || !ACC) { console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID first."); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
const tomlValue = (key) => { const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m")); return m ? m[1] : ""; };

const NAME = process.env.LNM_WORKER_NAME || tomlValue("name");
const KV_ID = process.env.LNM_KV_ID || tomlValue("id");
const D1_ID = process.env.LNM_D1_ID || tomlValue("database_id");
const VEC = process.env.LNM_VECTORIZE_INDEX || tomlValue("index_name");
const CRON = (toml.match(/crons\s*=\s*\[\s*"([^"]+)"/) || [])[1];
for (const [k, v] of Object.entries({ NAME, KV_ID, D1_ID, VEC })) {
  if (!v || v.startsWith("REPLACE_WITH")) { console.error(`${k} is not set — fill in wrangler.toml first (see INSTALL.md).`); process.exit(1); }
}

// Upload index.js plus every local module it imports (transitively).
const MAIN = "index.js";
const modules = [];
(function walk(file) {
  if (modules.includes(file)) return;
  modules.push(file);
  const code = fs.readFileSync(path.join(SRC, file), "utf8");
  for (const m of code.matchAll(/from\s+["']\.\/([\w.-]+\.js)["']/g)) walk(m[1]);
})(MAIN);

const bindings = [
  { type: "ai", name: "AI" },
  { type: "d1", name: "DB", id: D1_ID },
  { type: "plain_text", name: "GITHUB_BRANCH", text: tomlValue("GITHUB_BRANCH") || "main" },
  { type: "plain_text", name: "GITHUB_REPO", text: tomlValue("GITHUB_REPO") },
  { type: "vectorize", name: "VECTORIZE", index_name: VEC },
  { type: "kv_namespace", name: "VECTORS", namespace_id: KV_ID },
];
const metadata = {
  main_module: MAIN,
  compatibility_date: tomlValue("compatibility_date") || "2024-11-01",
  compatibility_flags: ["nodejs_compat"],
  bindings,
  observability: { enabled: true },
  keep_bindings: ["secret_text", "secret_key"],
};

// Multipart body built by hand (curl --form mangles the module content type).
const BOUNDARY = "----lnmdeploy" + Date.now();
const parts = [];
function pushPart(headers, body) {
  parts.push(Buffer.from(`--${BOUNDARY}\r\n${headers}\r\n\r\n`));
  parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
  parts.push(Buffer.from("\r\n"));
}
pushPart(`Content-Disposition: form-data; name="metadata"`, JSON.stringify(metadata));
for (const m of modules) {
  pushPart(`Content-Disposition: form-data; name="${m}"; filename="${m}"\r\nContent-Type: application/javascript+module`,
    fs.readFileSync(path.join(SRC, m)));
}
parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
const tmp = path.join(__dirname, ".deploy-body.tmp");
fs.writeFileSync(tmp, Buffer.concat(parts));

const API = `https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/${NAME}`;
function cf(method, url, args) {
  const out = execFileSync("curl", ["-s", "--max-time", "60", "-X", method, url, "-H", `Authorization: Bearer ${TOK}`, ...args],
    { maxBuffer: 10 * 1024 * 1024 }).toString();
  const j = JSON.parse(out);
  if (!j.success) throw new Error(`${method} ${url.replace(ACC, "<account>")} failed: ${JSON.stringify(j.errors)}`);
  return j.result;
}

try {
  console.log(`Uploading ${NAME}: ${modules.length} modules, ${bindings.length} bindings...`);
  const r = cf("PUT", API, ["-H", `Content-Type: multipart/form-data; boundary=${BOUNDARY}`, "--data-binary", `@${tmp}`]);
  if (CRON) cf("PUT", `${API}/schedules`, ["-H", "Content-Type: application/json", "--data", JSON.stringify([{ cron: CRON }])]);
  cf("POST", `${API}/subdomain`, ["-H", "Content-Type: application/json", "--data", JSON.stringify({ enabled: true })]);
  console.log("DEPLOY OK  id:", r?.id, " modified:", r?.modified_on);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}
