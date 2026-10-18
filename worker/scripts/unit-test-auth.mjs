// worker/scripts/unit-test-auth.mjs — run: node scripts/unit-test-auth.mjs
// Auth must fail closed: no API_KEY (or a placeholder one) locks every data route,
// and every route that reads or writes memory requires the key.
import assert from "node:assert";
import worker from "../src/index.js";

globalThis.fetch = async (u) => { throw new Error("network disabled in tests: " + u); };

const STRONG = "k_" + "9f2c4e7a1b3d5f60718293a4b5c6d7e8";
const BASE = "https://brain.example.workers.dev";

function kv() {
  const m = new Map();
  return {
    async get(k, t) { const v = m.get(k); if (v == null) return null; return t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
    keys: () => [...m.keys()],
  };
}
function env(extra = {}) { return { VECTORS: kv(), GITHUB_REPO: "someone/brain-data", GITHUB_BRANCH: "main", ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

async function call(e, path, { method = "GET", headers = {}, body } = {}) {
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body }), e, ctx);
  if ((res.headers.get("content-type") || "").includes("event-stream")) return { status: res.status, text: "", json: null };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}
const mcp = (e, headers = {}, qs = "") =>
  call(e, "/mcp" + qs, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: toolsList });

let pass = 0, fail = 0;
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after " + ms + "ms")), ms));
async function t(name, fn) { try { await Promise.race([fn(), timeout(5000)]); console.log("ok -", name); pass++; } catch (e) { console.error("FAIL -", name, e.message); fail++; } }

const LOCKED = ["/api/home-feed", "/api/list-recent", "/api/handoffs", "/api/latest-handoff",
  "/api/session_start_summary", "/api/health-watch", "/api/observation/obs-1",
  "/graph-internal", "/file?path=wiki/x.md", "/query-triples?entity=x", "/stats"];

await t("no API_KEY → MCP refuses with 503 + setup hint", async () => {
  const r = await mcp(env(), { "X-API-Key": "anything" });
  assert.equal(r.status, 503);
  assert.match(r.text, /API_KEY not configured/);
});
await t("no API_KEY → the old public default 'YOUR_API_KEY' does NOT work", async () => {
  const r = await mcp(env(), { "X-API-Key": "YOUR_API_KEY" });
  assert.notEqual(r.status, 200);
});
await t("placeholder API_KEY value is treated as not configured", async () => {
  for (const weak of ["YOUR_API_KEY", "<your-api-key>", "changeme", "short"]) {
    const r = await mcp(env({ API_KEY: weak }), { "X-API-Key": weak });
    assert.equal(r.status, 503, weak);
  }
});
await t("strong key: missing key → 401", async () => {
  const r = await mcp(env({ API_KEY: STRONG }));
  assert.equal(r.status, 401);
});
await t("strong key: wrong key → 401", async () => {
  const r = await mcp(env({ API_KEY: STRONG }), { "X-API-Key": STRONG + "x" });
  assert.equal(r.status, 401);
});
await t("strong key via X-API-Key header → tools/list", async () => {
  const r = await mcp(env({ API_KEY: STRONG }), { "X-API-Key": STRONG });
  assert.equal(r.status, 200);
  assert.ok(r.json.result.tools.length > 0);
});
await t("strong key via ?key= (Claude connector URL) → tools/list", async () => {
  const r = await mcp(env({ API_KEY: STRONG }), {}, "?key=" + STRONG);
  assert.equal(r.status, 200);
});
await t("strong key via Authorization: Bearer → tools/list", async () => {
  const r = await mcp(env({ API_KEY: STRONG }), { Authorization: "Bearer " + STRONG });
  assert.equal(r.status, 200);
});
await t("MCP SSE GET requires the key", async () => {
  const r = await call(env({ API_KEY: STRONG }), "/mcp");
  assert.equal(r.status, 401);
});
await t("memory-reading routes require the key", async () => {
  for (const p of LOCKED) {
    const r = await call(env({ API_KEY: STRONG }), p);
    assert.equal(r.status, 401, p + " returned " + r.status);
  }
});
await t("memory-reading routes refuse when API_KEY is unset", async () => {
  for (const p of LOCKED) {
    const r = await call(env(), p);
    assert.equal(r.status, 503, p + " returned " + r.status);
  }
});
await t("memory-reading routes work with the key", async () => {
  const r = await call(env({ API_KEY: STRONG }), "/api/home-feed", { headers: { "X-API-Key": STRONG } });
  assert.equal(r.status, 200);
});
await t("/health stays public for install checks", async () => {
  const r = await call(env(), "/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
});
await t("/health reports auth not configured when API_KEY unset", async () => {
  const r = await call(env(), "/health");
  assert.equal(r.json.auth, "not-configured");
  const ok = await call(env({ API_KEY: STRONG }), "/health");
  assert.equal(ok.json.auth, "configured");
});
await t("/health?deep=1 requires the key", async () => {
  const r = await call(env({ API_KEY: STRONG }), "/health?deep=1");
  assert.equal(r.status, 401);
});
await t("/admin/embed-dims requires ADMIN_KEY", async () => {
  const r = await call(env({ API_KEY: STRONG }), "/admin/embed-dims");
  assert.equal(r.status, 403);
});
await t("OAuth discovery paths return 404, not 401", async () => {
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
    const r = await call(env({ API_KEY: STRONG }), p);
    assert.equal(r.status, 404, p);
  }
});
await t("/telegram is off unless TELEGRAM_TOKEN is set", async () => {
  const r = await call(env({ API_KEY: STRONG }), "/telegram", { method: "POST", body: JSON.stringify({ message: { text: "hi", chat: { id: 1 } } }) });
  assert.equal(r.status, 404);
});
await t("/telegram rejects requests without the webhook secret", async () => {
  const e = env({ API_KEY: STRONG, TELEGRAM_TOKEN: "123:abc" });
  const r = await call(e, "/telegram", { method: "POST", body: JSON.stringify({ message: { text: "hi", chat: { id: 1 } } }) });
  assert.equal(r.status, 403);
  const wrong = await call(e, "/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "nope" }, body: "{}" });
  assert.equal(wrong.status, 403);
});
await t("/telegram ignores chats other than TELEGRAM_CHAT_ID", async () => {
  const secret = "tg_" + "0123456789abcdef0123";
  const send = (e, chat) => call(e, "/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ message: { text: "remember this", chat: { id: chat } } }) });
  const unset = env({ API_KEY: STRONG, TELEGRAM_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: secret });
  assert.equal((await send(unset, 42)).status, 200);
  assert.ok(!unset.VECTORS.keys().some(k => k.startsWith("obs:")), "wrote memory with TELEGRAM_CHAT_ID unset");
  const other = env({ API_KEY: STRONG, TELEGRAM_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_CHAT_ID: "7" });
  await send(other, 42);
  assert.ok(!other.VECTORS.keys().some(k => k.startsWith("obs:")), "wrote memory for a stranger's chat");
  const owner = env({ API_KEY: STRONG, TELEGRAM_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_CHAT_ID: "42" });
  await send(owner, 42);
  assert.ok(owner.VECTORS.keys().some(k => k.startsWith("obs:")), "owner's note was not saved");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
