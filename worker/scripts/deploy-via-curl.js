#!/usr/bin/env node
// Deploy lnm-brain worker via CF REST API using curl as the transport.
// Reason: Node's undici fetch ETIMEDOUTs to api.cloudflare.com in this env,
// but curl reaches it fine. Wrangler is Node-based → blocked. This script
// assembles the multipart upload and shells out to curl.
//
// Env required: CLOUDFLARE_API_TOKEN
// Bindings are replicated from the live worker settings (secrets inherit).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ACC = "70ad91964c2a7e85159056d22b484c6c";
const TOK = process.env.CLOUDFLARE_API_TOKEN;
if (!TOK) { console.error("CLOUDFLARE_API_TOKEN not set"); process.exit(1); }

const SRC = path.join(__dirname, "..", "src");
const MAIN = "index.js";
const MODULES = ["index.js", "consolidation.js", "rerank.js", "critic.js", "memory_type.js", "bitemporal.js", "triple-stats.js", "self-model.js"];

// Bindings replicated from live settings. Secrets use inherit (no value sent).
const SECRETS = ["ADMIN_KEY","DEEPSEEK_API_Key","DRACARYS_API_Key","GITHUB_APP_ID","GITHUB_APP_PRIVATE_KEY","GITHUB_INSTALLATION_ID","GITHUB_TOKEN","GLM_4.7_API_Key","Minimax_M2.7_API_Key","MISTRAL_LARGE_API_Key","MISTRAL_NEMOTRON_API_Key","STEP_API_Key","TELEGRAM_TOKEN"];
const bindings = [
  ...SECRETS.map(name => ({ type: "inherit", name })),
  { type: "ai", name: "AI" },
  { type: "d1", name: "DB", id: "d333a609-4344-47b0-ae1c-6ccea167ef97" },
  { type: "plain_text", name: "GITHUB_BRANCH", text: "main" },
  { type: "plain_text", name: "GITHUB_REPO", text: "your-username/your-repo" },
  { type: "vectorize", name: "VECTORIZE", index_name: "lnm-brain-m3" },
  { type: "vectorize", name: "VECTORIZE_OLD", index_name: "lnm-brain-vectors" },
  { type: "kv_namespace", name: "VECTORS", namespace_id: "d842c3ef4aa74e89a70933d0aeeff8db" },
];

const metadata = {
  main_module: MAIN,
  compatibility_date: "2024-11-01",
  compatibility_flags: ["nodejs_compat"],
  bindings,
  observability: { enabled: true },
  // keep_bindings preserves any binding type not explicitly resent (belt+braces for secrets)
  keep_bindings: ["secret_text", "secret_key"],
};

// Build multipart body manually (curl --form mangles content-type for modules).
const BOUNDARY = "----lnmdeploy" + Date.now();
const parts = [];
function pushPart(headers, body) {
  parts.push(Buffer.from(`--${BOUNDARY}\r\n${headers}\r\n\r\n`));
  parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
  parts.push(Buffer.from("\r\n"));
}

// metadata part
pushPart(`Content-Disposition: form-data; name="metadata"`, JSON.stringify(metadata));
// module parts — each as application/javascript+module
for (const m of MODULES) {
  const content = fs.readFileSync(path.join(SRC, m));
  pushPart(
    `Content-Disposition: form-data; name="${m}"; filename="${m}"\r\nContent-Type: application/javascript+module`,
    content
  );
}
parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
const body = Buffer.concat(parts);

const tmp = path.join(__dirname, ".deploy-body.tmp");
fs.writeFileSync(tmp, body);

const url = `https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/lnm-brain`;
console.log(`Uploading ${body.length} bytes (${MODULES.length} modules, ${bindings.length} bindings)...`);

try {
  const out = execFileSync("curl", [
    "-s", "--max-time", "60", "-X", "PUT", url,
    "-H", `Authorization: Bearer ${TOK}`,
    "-H", `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
    "--data-binary", `@${tmp}`,
  ], { maxBuffer: 10 * 1024 * 1024 }).toString();
  fs.unlinkSync(tmp);
  const j = JSON.parse(out);
  if (!j.success) {
    console.error("DEPLOY FAILED:");
    console.error(JSON.stringify(j.errors, null, 2));
    process.exit(1);
  }
  console.log("DEPLOY OK");
  console.log("  id:", j.result?.id);
  console.log("  modified:", j.result?.modified_on);
  console.log("  startup_time_ms:", j.result?.startup_time_ms);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch {}
  console.error("curl error:", e.message);
  if (e.stdout) console.error(e.stdout.toString());
  process.exit(1);
}
